'use strict';

const {
  normalizeClaudeLocalCommandText,
  readClaudeLocalCommandRecordText,
} = require('./claude-startup-slash-proof');
const { parseClaudeSettingObservation } = require('./claude-setting-observation');

function parseClaudeSettingWrapper(record) {
  // Idle commands use user.message.content; commands accepted while a turn
  // runs use system/local_command.content. Read the same two carriers as the
  // exact command proof, retaining the direct wrapper -> stdout requirement.
  const text = readClaudeLocalCommandRecordText(record);
  if (!text) return null;
  const name = (text.match(/<command-name>\/(model|effort)<\/command-name>/i)?.[1] || '')
    .trim()
    .toLowerCase();
  const value = (text.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1] || '')
    .trim();
  if (!name || (value && /\s/.test(value))) return null;
  // An interactive `/model` or `/effort` picker deliberately writes an empty
  // command-args wrapper. The exact chosen value belongs to its direct stdout
  // child, so an empty value is a valid pending wrapper rather than noise.
  return { kind: name, value: name === 'effort' ? value.toLowerCase() || null : value || null };
}

function parseConfirmedClaudeSettingStdout(record, setting) {
  const observed = setting && parseClaudeSettingObservation(record, setting);
  return setting && observed?.kind === setting.kind ? observed.actualValue : null;
}

function isConfirmedClaudeSettingStdout(record, setting) {
  return !!parseConfirmedClaudeSettingStdout(record, setting);
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
    const confirmedValue = parseConfirmedClaudeSettingStdout(record, setting);
    if (!setting || !confirmedValue) continue;
    const observation = parseClaudeSettingObservation(record, setting);
    const proofAt = Date.parse(record.timestamp || wrapper.timestamp || '');
    const proof = {
      value: confirmedValue,
      requestedValue: setting.value,
      observed: observation?.observed || null,
      requestSatisfied: observation?.requestSatisfied ?? null,
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

/**
 * Effort is a process-local setting, not a conversational-branch setting.
 * Claude writes local slash commands beside the normal parentUuid chain; once
 * the next ordinary turn lands, that local-command pair may no longer be an
 * ancestor of the active conversation even though it still controls the same
 * live process. Read the latest exact wrapper -> stdout pair from the physical
 * session records and let the runtime-generation projection below decide
 * whether that proof belongs to the current process.
 */
function deriveLatestConfirmedClaudeRuntimeEffort(records, { sessionId = null } = {}) {
  const values = Array.isArray(records) ? records : Array.from(records || []);
  const byUuid = new Map(
    values
      .filter((record) => record?.uuid)
      .map((record) => [record.uuid, record])
  );
  const expectedSessionId = String(sessionId || '').trim() || null;
  let latest = null;

  for (let order = 0; order < values.length; order += 1) {
    const record = values[order];
    const wrapper = byUuid.get(record?.parentUuid);
    const setting = parseClaudeSettingWrapper(wrapper);
    const confirmedValue = parseConfirmedClaudeSettingStdout(record, setting);
    if (setting?.kind !== 'effort' || !confirmedValue) continue;
    const proofAt = Date.parse(record.timestamp || wrapper.timestamp || '');
    const proofSessionId = record.sessionId || wrapper.sessionId || record._fromFile || null;
    if (expectedSessionId && proofSessionId && proofSessionId !== expectedSessionId) continue;
    const candidate = {
      value: confirmedValue,
      proofAt: Number.isFinite(proofAt) ? proofAt : 0,
      proofSessionId,
      wrapperUuid: wrapper.uuid,
      stdoutUuid: record.uuid,
      fileIndex: Number.isFinite(Number(record._fileIndex)) ? Number(record._fileIndex) : -1,
      order,
    };
    if (!latest
      || candidate.proofAt > latest.proofAt
      || (candidate.proofAt === latest.proofAt && candidate.fileIndex > latest.fileIndex)
      || (
        candidate.proofAt === latest.proofAt
        && candidate.fileIndex === latest.fileIndex
        && candidate.order > latest.order
      )) {
      latest = candidate;
    }
  }

  if (!latest) return null;
  const { fileIndex: _fileIndex, order: _order, ...proof } = latest;
  return proof;
}

/**
 * `/effort` is explicitly process-local in Claude Code (its confirmation says
 * "this session only"). JSONL therefore proves what an older runtime used, not
 * what a newly resumed process is using. Keep the historical fact for History,
 * but expose it as current only when the proof belongs to this exact live launch
 * generation and was written after its accepted shell boundary.
 */
function projectConfirmedClaudeSettingsForRuntime(result, runtimeScope = null) {
  const source = result && typeof result === 'object' ? result : {};
  const historicalEffort = source.effort || null;
  const generation = String(runtimeScope?.generation || '').trim() || null;
  const runtimeStartedAt = Number(runtimeScope?.startedAt || 0);
  const runtimeSessionId = String(runtimeScope?.sessionId || '').trim() || null;
  const proofSessionId = String(source.effortProofSessionId || '').trim() || null;
  const proofAt = Number(source.effortProofAt || 0);
  const sessionMatches = !runtimeSessionId || !proofSessionId
    || runtimeSessionId === proofSessionId;
  const effortCurrentRuntime = !!historicalEffort
    && runtimeScope?.processAlive === true
    && !!generation
    && runtimeStartedAt > 0
    && proofAt >= runtimeStartedAt
    && sessionMatches;

  return {
    ...source,
    effortHistorical: historicalEffort,
    effort: effortCurrentRuntime ? historicalEffort : null,
    effortCurrentRuntime,
    runtimeGeneration: generation,
    runtimeStartedAt: runtimeStartedAt > 0 ? runtimeStartedAt : null,
  };
}

module.exports = {
  deriveConfirmedClaudeSettings,
  deriveLatestConfirmedClaudeRuntimeEffort,
  isConfirmedClaudeSettingStdout,
  normalizeClaudeLocalCommandText,
  parseClaudeSettingWrapper,
  projectConfirmedClaudeSettingsForRuntime,
  traceClaudeActiveBranch,
};
