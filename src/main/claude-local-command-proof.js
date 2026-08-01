'use strict';

function normalizeClaudeLocalCommandCarrier(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function isExplicitClaudeCompactCarrier(candidate) {
  const text = normalizeClaudeLocalCommandCarrier(candidate?.text);
  if (text === '/compact') return true;
  return /^<command-name>\/compact<\/command-name>\s*<command-message>compact<\/command-message>/i
    .test(text);
}

function isClaudeCompactLifecycleCarrier(candidate) {
  const text = normalizeClaudeLocalCommandCarrier(candidate?.text);
  if (candidate?.record?.isCompactSummary === true) return true;
  return /^<local-command-(?:stdout|stderr)>[\s\S]*<\/local-command-(?:stdout|stderr)>$/i
    .test(text);
}

/**
 * PTY output saying "Compacting conversation" is not ownership proof: Claude
 * prints the same frame for explicit `/compact` and automatic context
 * compaction. Only the latest prompt carrier in this launch generation may
 * promote that output to an explicit local-command lifecycle.
 */
function selectLatestClaudeManualCompactIntent(candidates, { notBeforeMs = 0 } = {}) {
  const source = Array.isArray(candidates) ? candidates : [];
  let latest = null;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const candidate = source[index];
    if (isExplicitClaudeCompactCarrier(candidate)) {
      latest = candidate;
      break;
    }
    // Claude appends local-command output and may rewrite a compact summary
    // around the exact command carrier.  Those records are the same local
    // command lifecycle, not a newer user intent.  A real ordinary prompt is
    // still a hard boundary and prevents an older /compact from being reused.
    if (isClaudeCompactLifecycleCarrier(candidate)) continue;
    return { proven: false, reason: 'latest-prompt-is-not-compact', candidate };
  }
  if (!latest) return { proven: false, reason: 'no-prompt-carrier' };
  const timestampMs = Date.parse(String(latest?.record?.timestamp || ''));
  if (!Number.isFinite(timestampMs)) {
    return { proven: false, reason: 'compact-timestamp-unavailable', candidate: latest };
  }
  if (Number(notBeforeMs) > 0 && timestampMs < Number(notBeforeMs)) {
    return { proven: false, reason: 'compact-before-launch-generation', candidate: latest };
  }
  return {
    proven: true,
    reason: 'latest-prompt-is-explicit-compact',
    candidate: latest,
    timestampMs,
  };
}

function claudeCompactRecordContent(record) {
  if (typeof record?.message?.content === 'string') return record.message.content;
  if (typeof record?.content === 'string') return record.content;
  return '';
}

/**
 * PTY completion text is only a hint. It belongs to a local command when the
 * exact terminal/session/launch/input generation captured at submit is still
 * current. A later prompt (including one that triggers auto-compaction) moves
 * the input revision and therefore cannot complete an older watcher.
 */
function classifyClaudeLocalCommandOwner(owner, current) {
  if (!owner || !current) return { matches: false, reason: 'owner-unavailable' };
  if (owner.terminal !== current.terminal) {
    return { matches: false, reason: 'terminal-changed' };
  }
  if (owner.sessionId !== current.sessionId) {
    return { matches: false, reason: 'session-changed' };
  }
  if (owner.generation !== current.generation) {
    return { matches: false, reason: 'launch-generation-changed' };
  }
  if (Number(owner.inputRevision) !== Number(current.inputRevision)) {
    return { matches: false, reason: 'input-generation-changed' };
  }
  return { matches: true, reason: 'exact-owner-current' };
}

/**
 * Classify a transcript record observed after an explicit `/compact` submit.
 * Automatic compact boundaries belong to a different turn and must not
 * complete an older local-command watcher.
 */
function classifyClaudeCompactWatcherRecord(record) {
  if (!record || typeof record !== 'object') {
    return { terminal: false, success: false, reason: 'not-a-record' };
  }
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    const trigger = String(record?.compactMetadata?.trigger || '').toLowerCase();
    if (trigger === 'auto') {
      return { terminal: false, success: false, reason: 'auto-compact-boundary' };
    }
    return { terminal: true, success: true, reason: 'compact_boundary' };
  }
  if (record.type === 'user' && record.isCompactSummary === true) {
    const trigger = String(record?.compactMetadata?.trigger || '').toLowerCase();
    if (trigger === 'auto') {
      return { terminal: false, success: false, reason: 'auto-compact-summary' };
    }
    return { terminal: true, success: true, reason: 'compact_summary' };
  }

  const content = claudeCompactRecordContent(record);
  const isLocalCommandStdout = content.includes('<local-command-stdout>');
  const isLocalCommandStderr = content.includes('<local-command-stderr>');
  if (!isLocalCommandStdout && !isLocalCommandStderr) {
    return { terminal: false, success: false, reason: 'unrelated-record' };
  }
  if (isLocalCommandStdout && /Compaction canceled\.?/i.test(content)) {
    return { terminal: true, success: false, reason: 'compact-cancelled' };
  }
  if (isLocalCommandStdout && /Not enough messages to compact\.?/i.test(content)) {
    return { terminal: true, success: false, reason: 'compact-not-enough-messages' };
  }
  if (
    isLocalCommandStderr
    && /Error during compaction:/i.test(content)
  ) {
    return { terminal: true, success: false, reason: 'compact-provider-error' };
  }
  if (isLocalCommandStdout && /\bCompacted\b/i.test(content)) {
    return { terminal: true, success: true, reason: 'compact_stdout' };
  }
  return { terminal: false, success: false, reason: 'unrelated-local-command-output' };
}

module.exports = {
  classifyClaudeLocalCommandOwner,
  classifyClaudeCompactWatcherRecord,
  isClaudeCompactLifecycleCarrier,
  isExplicitClaudeCompactCarrier,
  normalizeClaudeLocalCommandCarrier,
  selectLatestClaudeManualCompactIntent,
};
