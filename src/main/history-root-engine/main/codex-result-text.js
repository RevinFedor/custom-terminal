'use strict';

const MAX_RESULT_CHARS = 250000;
// Detach slices: V8 sliced strings can otherwise retain a multi-MB JSON line.
const detached = value => Buffer.from(value, 'utf16le').toString('utf16le');
function summarizeResultText(value) {
  const text = String(value || '').trim();
  return { length: text.length,
    head: detached(text.slice(0, MAX_RESULT_CHARS)),
    tail: detached(text.slice(-MAX_RESULT_CHARS)) };
}

// Shared by batch and streaming proof. Middle blocks need only their length
// once the requested result is truncated; the original first/final excerpts
// and full character count remain identical to the batch projection.
function projectResultText(samples, maxChars = 8000, maxLimit = 16000) {
  const values = samples.filter(value => value.length > 0);
  if (!values.length) return { assistantText: '', assistantChars: 0, truncated: false };
  const limit = Math.max(500, Math.min(maxLimit, Number(maxChars) || 8000));
  const length = values.reduce((sum, value) => sum + value.length, 0) + (values.length - 1) * 2;
  if (length <= limit) {
    return { assistantText: values.map(value => value.head).join('\n\n'), assistantChars: length, truncated: false };
  }
  const first = values[0], last = values.at(-1);
  const firstLimit = values.length === 1
    ? Math.floor(limit * 0.4) : Math.min(Math.floor(limit * 0.35), first.length);
  const lastLimit = Math.max(0, limit - firstLimit - 3);
  return { assistantText: first.head.slice(0, firstLimit).trimEnd()
      + '\n…\n' + last.tail.slice(-lastLimit).trimStart(),
    assistantChars: length, truncated: true };
}

module.exports = { summarizeResultText, projectResultText, MAX_RESULT_CHARS };
