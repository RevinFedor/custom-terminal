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
  // `backgroundTaskId` — текущее поле CLI (2.1.316) для фонового Bash. Пока
  // читались только `taskId`/`task_id`, у такого шелла ID оставался пустым, и
  // его собственный TaskStop ничего не закрывал: карточка висела «работает»
  // вечно, потому что сопоставление идёт именно по этому ID.
  const metadata = [part?.toolUseResult, record?.toolUseResult];
  for (const candidate of metadata) {
    const value = normalizeString(
      candidate?.taskId || candidate?.task_id || candidate?.backgroundTaskId);
    if (value) return value;
  }
  const text = claudeToolResultText(part);
  // Текст расписки CLI менял дважды: старое «moved to the background (ID: …)»
  // и нынешнее «Command running in background with ID: …». Metadata выше
  // остаётся главным источником, текст — запасным для старых транскриптов.
  const match = kind === 'monitor'
    ? /\bMonitor started \(task\s+([A-Za-z0-9_-]+)(?:,|\))/i.exec(text)
    : /\b(?:moved to (?:the )?background \(ID:\s*([A-Za-z0-9_-]+)\)|running in (?:the )?background with ID:\s*([A-Za-z0-9_-]+))/i.exec(text);
  return normalizeString(match?.[1] || match?.[2]);
}

module.exports = {
  claudeBackgroundTaskId,
  claudeToolResultText,
  isClaudeToolResultError,
};
