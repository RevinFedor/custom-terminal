'use strict';

function normalizeClaudeLocalCommandText(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseClaudeSettingWrapper(record) {
  const content = record?.message?.content;
  if (typeof content !== 'string') return null;
  const text = normalizeClaudeLocalCommandText(content);
  const name = (text.match(/<command-name>\/(model|effort)<\/command-name>/i)?.[1] || '')
    .trim()
    .toLowerCase();
  const value = (text.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1] || '')
    .trim()
    .toLowerCase();
  if (!name || !value || /\s/.test(value)) return null;
  return { kind: name, value };
}

function isConfirmedClaudeSettingStdout(record, setting) {
  const content = record?.message?.content;
  if (typeof content !== 'string' || !setting) return false;
  const text = normalizeClaudeLocalCommandText(content);
  if (setting.kind === 'model') {
    return /^<local-command-stdout>Set model to\b/i.test(text);
  }
  if (setting.kind === 'effort') {
    return /^<local-command-stdout>Set effort level to\b/i.test(text)
      && text.toLowerCase().includes('set effort level to ' + setting.value);
  }
  return false;
}

/**
 * Walk the same logical branch that Full History renders. Physical JSONL order
 * is not authoritative after Rewind: records from the abandoned future remain
 * on disk, while parentUuid/logicalParentUuid selects the live branch.
 */
function traceClaudeActiveBranch({
  recordMap,
  lastRecord,
  sessionBoundaries = [],
  log = () => {},
} = {}) {
  const activeBranch = [];
  let currentUuid = lastRecord?.uuid || null;
  const seen = new Set();
  let firstOrphanRecoveredFromUuid = null;

  while (currentUuid && !seen.has(currentUuid)) {
    seen.add(currentUuid);
    const record = recordMap?.get(currentUuid);
    if (!record) {
      let recovered = false;
      if (activeBranch.length > 0) {
        const lastAdded = activeBranch[0];
        if (
          lastAdded.type === 'system'
          && lastAdded.subtype === 'compact_boundary'
          && lastAdded.logicalParentUuid === currentUuid
        ) {
          if (
            lastAdded.parentUuid
            && recordMap.has(lastAdded.parentUuid)
            && !seen.has(lastAdded.parentUuid)
          ) {
            currentUuid = lastAdded.parentUuid;
            recovered = true;
          } else {
            let bestPred = null;
            for (const [uuid, entry] of recordMap) {
              if (seen.has(uuid)) continue;
              if (
                entry._fromFile === lastAdded._fromFile
                && entry._fileIndex < lastAdded._fileIndex
              ) {
                if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                  bestPred = entry;
                }
              }
            }
            if (bestPred) {
              currentUuid = bestPred.uuid;
              recovered = true;
            }
          }
        }

        if (!recovered) {
          let bestPred = null;
          for (const [uuid, entry] of recordMap) {
            if (seen.has(uuid)) continue;
            if (
              entry._fromFile === lastAdded._fromFile
              && typeof entry._fileIndex === 'number'
              && typeof lastAdded._fileIndex === 'number'
              && entry._fileIndex < lastAdded._fileIndex
            ) {
              if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
                bestPred = entry;
              }
            }
          }
          if (bestPred) {
            log(
              'CHAIN BREAK recovery: '
              + String(currentUuid).substring(0, 8)
              + ' missing, jumping to '
              + String(bestPred.uuid).substring(0, 8)
              + ' (fileIdx '
              + bestPred._fileIndex
              + ', type='
              + bestPred.type
              + ')'
            );

            let isPostCompactInit = false;
            if (lastAdded.type === 'attachment') {
              const predIdx = bestPred._fileIndex;
              for (const [, entry] of recordMap) {
                if (entry._fromFile !== bestPred._fromFile) continue;
                if (typeof entry._fileIndex !== 'number') continue;
                if (
                  entry._fileIndex < predIdx - 10
                  || entry._fileIndex > lastAdded._fileIndex
                ) continue;
                if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
                  isPostCompactInit = true;
                  break;
                }
              }
            }

            if (!isPostCompactInit && firstOrphanRecoveredFromUuid === null) {
              firstOrphanRecoveredFromUuid = lastAdded.uuid;
            }
            currentUuid = bestPred.uuid;
            recovered = true;
          }
        }
      }
      if (recovered) continue;
      break;
    }

    activeBranch.unshift(record);
    let nextUuid = record.logicalParentUuid || record.parentUuid;

    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const isDeadEnd = !nextUuid || seen.has(nextUuid) || !recordMap.has(nextUuid);
      if (isDeadEnd) {
        let bestPred = null;
        for (const [uuid, entry] of recordMap) {
          if (seen.has(uuid)) continue;
          if (
            entry._fromFile === record._fromFile
            && typeof entry._fileIndex === 'number'
            && typeof record._fileIndex === 'number'
            && entry._fileIndex < record._fileIndex
          ) {
            if (!bestPred || entry._fileIndex > bestPred._fileIndex) {
              bestPred = entry;
            }
          }
        }
        if (bestPred) {
          nextUuid = bestPred.uuid;
          log(
            'Compact passthrough: compact='
            + String(record.uuid).substring(0, 8)
            + ' fileIdx='
            + record._fileIndex
            + ' → predecessor='
            + String(bestPred.uuid).substring(0, 8)
            + ' fileIdx='
            + bestPred._fileIndex
          );
        }
      }
    }

    if (!nextUuid && sessionBoundaries.length > 0) {
      for (const [uuid, entry] of recordMap) {
        if (seen.has(uuid)) continue;
        if (
          entry._isBridge
          && entry.parentUuid
          && entry.sessionId !== record.sessionId
          && !seen.has(entry.parentUuid)
        ) {
          nextUuid = entry.parentUuid;
          break;
        }
      }
      if (!nextUuid && record.sessionId) {
        const boundary = sessionBoundaries.find(
          (item) => item.childSessionId === record.sessionId
        );
        if (boundary) {
          let parentLast = null;
          for (const [uuid, entry] of recordMap) {
            if (seen.has(uuid)) continue;
            if (entry._fromFile === boundary.parentSessionId) {
              if (!parentLast || entry._fileIndex > parentLast._fileIndex) {
                parentLast = entry;
              }
            }
          }
          if (parentLast) nextUuid = parentLast.uuid;
        }
      }
    }

    currentUuid = nextUuid;
  }

  return { activeBranch, firstOrphanRecoveredFromUuid };
}

function deriveConfirmedClaudeSettings(activeBranch) {
  const records = Array.isArray(activeBranch) ? activeBranch : [];
  const byUuid = new Map(
    records
      .filter((record) => record?.uuid)
      .map((record) => [record.uuid, record])
  );
  const result = {};

  for (const record of records) {
    const wrapper = byUuid.get(record?.parentUuid);
    const setting = parseClaudeSettingWrapper(wrapper);
    if (!setting || !isConfirmedClaudeSettingStdout(record, setting)) continue;
    const proofAt = Date.parse(record.timestamp || wrapper.timestamp || '');
    const proof = {
      value: setting.value,
      proofAt: Number.isFinite(proofAt) ? proofAt : 0,
      proofSessionId: record.sessionId || wrapper.sessionId || record._fromFile || null,
      wrapperUuid: wrapper.uuid,
      stdoutUuid: record.uuid,
    };
    if (setting.kind === 'model') result.model = proof;
    if (setting.kind === 'effort') result.effort = proof;
  }

  if (!result.model && !result.effort) return null;
  return result;
}

module.exports = {
  deriveConfirmedClaudeSettings,
  isConfirmedClaudeSettingStdout,
  normalizeClaudeLocalCommandText,
  parseClaudeSettingWrapper,
  traceClaudeActiveBranch,
};
