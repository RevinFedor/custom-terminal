'use strict';

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
  return {
    kind: match[1].toLowerCase(),
    value: match[2].trim().toLowerCase(),
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
    ? normalizeClaudeLocalCommandText(argsMatch[1]).toLowerCase()
    : '';

  if (
    text.startsWith('<command-name>/' + target.kind + '</command-name>')
    && commandArgs === target.value
  ) {
    return 'wrapper';
  }
  if (target.kind === 'effort' && parseClaudeEffortStdout(record) === target.value) return 'stdout-success';
  if (target.kind === 'model' && /^<local-command-stdout>Set model to\b/i.test(text)) {
    return 'stdout-success';
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
} = {}) {
  const target = parseClaudeStartupSlashCommand(command);
  if (!target) return { success: false, reason: 'unsupported-command' };

  const source = Array.isArray(records) ? records : [];
  const minTs = Number(afterMs) > 0 ? Number(afterMs) - 1000 : 0;
  const exactSessionId = String(sessionId || '').trim() || null;
  const wrapperUuids = new Set();
  let wrapperSeen = false;
  let stdoutSeen = false;
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

    if (kind === 'wrapper') {
      wrapperSeen = true;
      if (record?.uuid) wrapperUuids.add(record.uuid);
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
    };
    if (kind === 'stdout-success') {
      return {
        ...base,
        success: true,
        reason: 'jsonl-stdout',
      };
    }
    const outputText = readClaudeLocalCommandRecordText(record);
    return {
      ...base,
      success: false,
      terminal: true,
      reason: 'command-output-rejected',
      failureCode: classifyClaudeLocalCommandFailureCode(outputText),
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
