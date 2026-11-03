'use strict';

const { parseClaudeSettingObservation } = require('./claude-setting-observation');

function normalizeClaudeLocalCommandText(value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapClaudeLocalCommandOutput(value) {
  const normalized = normalizeClaudeLocalCommandText(value);
  const wrapped = normalized.match(
    /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/i,
  );
  return normalizeClaudeLocalCommandText(wrapped?.[2] ?? normalized);
}

function classifyClaudeLocalCommandFailureCode(value) {
  const message = unwrapClaudeLocalCommandOutput(value);
  if (/^API error:\s*429\b/i.test(message) || /"type"\s*:\s*"rate_limit_error"/.test(message)) {
    return 'claude_rate_limit';
  }
  if (
    /oauth refresh token is no longer valid/i.test(message)
    || /login expired/i.test(message)
    || /run \/login to re-authenticate/i.test(message)
  ) {
    return 'claude_auth_expired';
  }
  return 'claude_startup_setting_rejected';
}

function parseClaudeStartupSlashCommand(command) {
  const match = String(command || '').trim().match(/^\/(model|effort)\s+(.+)$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  return {
    kind,
    // Effort is a closed provider enum. A model argument may be a custom,
    // case-sensitive runtime ID; lowering it merges two different commands.
    value: kind === 'effort' ? match[2].trim().toLowerCase() : match[2].trim(),
  };
}

function readClaudeLocalCommandRecordText(record) {
  const content = typeof record?.message?.content === 'string'
    ? record.message.content
    : record?.content;
  return typeof content === 'string'
    ? normalizeClaudeLocalCommandText(content)
    : '';
}

function parseClaudeEffortStdout(record) {
  const text = readClaudeLocalCommandRecordText(record);
  const match = text.match(/^<local-command-stdout>Set effort level to\s+([a-z-]+)\b/i);
  return String(match?.[1] || '').toLowerCase() || null;
}

function classifyClaudeStartupSlashRecord(record, target) {
  const text = readClaudeLocalCommandRecordText(record);
  if (!text || !target) return null;
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  const commandArgs = argsMatch
    ? normalizeClaudeLocalCommandText(argsMatch[1])
    : '';

  if (text.startsWith('<command-name>/' + target.kind + '</command-name>')) {
    if ((target.kind === 'effort' ? commandArgs.toLowerCase() : commandArgs) === target.value) {
      return 'wrapper';
    }
    // Claude can record the command under DIFFERENT args than the ones we
    // submitted. Observed 02.11, tab b765ffed534b: we sent
    // `/model claude-sonnet-5[1m]`, and the transcript shows
    // `<command-args>claude-opus-5[1m]` with stdout "Set model to `Opus 5` …
    // ANTHROPIC_MODEL is set to `Opus 5.5`" — the environment variable wins
    // over the picker. Requiring an exact args match made this wrapper
    // invisible, so the paired stdout had no parent to attach to and the whole
    // proof ended as `wrapper-not-found`: "не подтверждено", when in truth the
    // command WAS answered and answered with a different model.
    // Accept it as our wrapper when nothing else can own it: same kind, and
    // Main already bound this scan to one exact command checkpoint
    // (afterMs + sessionId, often wrapperUuid). The stdout comparison below
    // still decides success, so a foreign value reports
    // `command-applied-different`, never a false success.
    //
    // ONE exception, and it is the reason this is not just a looser match:
    // when the args differ only by case, the args are the whole evidence.
    // `/model VendorCase` answered by `<command-args>vendorcase` with stdout
    // `Set model to VendorCase` would compare EQUAL at the stdout stage and
    // silently confirm a command we never sent that way. Custom model IDs are
    // case-sensitive, so that pair stays unowned exactly as before.
    if (target.kind !== 'effort' && commandArgs.toLowerCase() === String(target.value).toLowerCase()) {
      return null;
    }
    return 'wrapper-other-args';
  }
  const observation = parseClaudeSettingObservation(record, target);
  if (observation && observation.kind === target.kind) {
    return observation.requestSatisfied === false ? 'stdout-different' : 'stdout-success';
  }
  if (/^<local-command-(?:stdout|stderr)>/i.test(text)) return 'stdout-terminal';
  return null;
}

/**
 * Proves one exact startup command from one exact Claude session.
 *
 * The wrapper record identifies the submitted command. Its direct child is
 * the command's outcome. A matching success child advances startup; any other
 * paired stdout/stderr is an explicit rejection. Unrelated local-command
 * output, even at the same timestamp, cannot close this proof.
 */
function scanClaudeStartupSlashRecords(records, command, {
  afterMs = 0,
  sessionId = null,
  wrapperUuid = null,
} = {}) {
  const target = parseClaudeStartupSlashCommand(command);
  if (!target) return { success: false, reason: 'unsupported-command' };

  const source = Array.isArray(records) ? records : [];
  // This pure classifier is not write admission. Main supplies one bound pair
  // from its physical command checkpoint; time is only a legacy read filter.
  const minTs = Number(afterMs) > 0 ? Number(afterMs) : 0;
  const exactSessionId = String(sessionId || '').trim() || null;
  const wrapperUuids = new Set();
  let wrapperSeen = false;
  let stdoutSeen = false;
  let argsDiverged = false;
  let latestTs = 0;
  let latestKind = null;

  for (const record of source) {
    if (exactSessionId && String(record?.sessionId || '') !== exactSessionId) {
      continue;
    }
    const timestampMs = Date.parse(record?.timestamp || '');
    if (minTs > 0 && (!Number.isFinite(timestampMs) || timestampMs < minTs)) continue;
    const kind = classifyClaudeStartupSlashRecord(record, target);
    if (!kind) continue;
    latestTs = Number.isFinite(timestampMs) ? timestampMs : latestTs;
    latestKind = kind;

    if (kind === 'wrapper' || kind === 'wrapper-other-args') {
      if (wrapperUuid && record?.uuid !== wrapperUuid) continue;
      wrapperSeen = true;
      if (record?.uuid) wrapperUuids.add(record.uuid);
      // A wrapper recorded under other args is ours only by position, so note
      // it: the outcome below must read as "applied something else", not as a
      // confirmation of what we asked for.
      if (kind === 'wrapper-other-args') argsDiverged = true;
      continue;
    }

    stdoutSeen = true;
    if (!record?.parentUuid || !wrapperUuids.has(record.parentUuid)) continue;
    const base = {
      sessionId: exactSessionId || record?.sessionId || null,
      timestamp: record?.timestamp || null,
      wrapperSeen: true,
      stdoutSeen: true,
      wrapperUuid: record.parentUuid,
      stdoutUuid: record?.uuid || null,
      ...(argsDiverged ? { wrapperArgsDiverged: true } : {}),
    };
    const observation = parseClaudeSettingObservation(record, target);
    if (kind === 'stdout-success') {
      return {
        ...base,
        ...observation,
        success: true,
        reason: 'jsonl-stdout',
      };
    }
    const outputText = readClaudeLocalCommandRecordText(record);
    return {
      ...base,
      ...(observation || {}),
      success: false,
      terminal: true,
      reason: observation?.requestSatisfied === false ? 'command-applied-different' : 'command-output-rejected',
      failureCode: observation?.requestSatisfied === false ? 'claude_setting_applied_different'
        : classifyClaudeLocalCommandFailureCode(outputText),
      // The JSONL transport envelope is evidence, not user-facing error text.
      // Keeping it here produced copied incidents whose first line started
      // with `<local-command-stdout>` and hid the actual recovery action.
      outputPreview: unwrapClaudeLocalCommandOutput(outputText).slice(0, 300),
      outputText: unwrapClaudeLocalCommandOutput(outputText),
    };
  }

  return {
    success: false,
    reason: stdoutSeen ? 'stdout-unmatched' : 'stdout-not-found',
    sessionId: exactSessionId,
    wrapperSeen,
    stdoutSeen,
    latestTs,
    latestKind,
  };
}

module.exports = {
  classifyClaudeLocalCommandFailureCode,
  classifyClaudeStartupSlashRecord,
  normalizeClaudeLocalCommandText,
  parseClaudeStartupSlashCommand,
  parseClaudeEffortStdout,
  readClaudeLocalCommandRecordText,
  scanClaudeStartupSlashRecords,
  unwrapClaudeLocalCommandOutput,
};
