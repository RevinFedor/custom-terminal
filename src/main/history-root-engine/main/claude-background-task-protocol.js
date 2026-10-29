'use strict';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function claudeToolResultText(part) {
  const value = part?.content ?? part?.result;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function isClaudeToolResultError(part) {
  return part?.is_error === true || part?.isError === true;
}

// Claude stores the background task identity in the tool-result metadata on
// current builds and in the acceptance text on older builds. Both are exact
// provider receipts for this one tool_use; arbitrary surrounding prose is
// never inspected.
function claudeBackgroundTaskId(record, part, kind) {
  const metadata = [part?.toolUseResult, record?.toolUseResult];
  for (const candidate of metadata) {
    const value = normalizeString(candidate?.taskId || candidate?.task_id);
    if (value) return value;
  }
  const text = claudeToolResultText(part);
  const match = kind === 'monitor'
    ? /\bMonitor started \(task\s+([A-Za-z0-9_-]+)(?:,|\))/i.exec(text)
    : /\bmoved to (?:the )?background \(ID:\s*([A-Za-z0-9_-]+)\)/i.exec(text);
  return normalizeString(match?.[1]);
}

module.exports = {
  claudeBackgroundTaskId,
  claudeToolResultText,
  isClaudeToolResultError,
};
