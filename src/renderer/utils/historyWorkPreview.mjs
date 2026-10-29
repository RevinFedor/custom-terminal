// Limit parsing and transport work BEFORE the Markdown renderer. The visible
// line is clipped by its own width, independently of the full source text.
export const HISTORY_WORK_PREVIEW_MAX_CHARS = 512;

export function boundedHistoryWorkToolPart(value) {
  if (typeof value !== 'string' || !value.length) return '';
  let end = Math.min(value.length, 128);
  if (end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end).replace(/\s+/g, ' ').trim() + (end < value.length ? '…' : '');
}

export function boundedHistoryWorkMarkdown(value, sourceTruncated = false) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let end = Math.min(value.length, HISTORY_WORK_PREVIEW_MAX_CHARS);
  if (end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  let text = value.slice(0, end);
  const truncated = sourceTruncated || end < value.length;
  if (!text.trim()) return truncated ? '…' : '';
  // Streaming or a bounded excerpt can stop inside an inline emphasis. Close
  // unmatched formatting only in this view so **/__/~~ do not flash as raw
  // syntax; fenced code keeps its literal contents and the stored text is untouched.
  if (!/^\s{0,3}(`{3,}|~{3,})/.test(text)) {
    const stack = [];
    let codeTicks = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '`') {
        let count = 1;
        while (text[i + count] === '`') count++;
        if (codeTicks === 0) codeTicks = count;
        else if (codeTicks === count) codeTicks = 0;
        i += count - 1;
        continue;
      }
      if (codeTicks) continue;
      const token = text.slice(i, i + 2);
      if (token !== '**' && token !== '__' && token !== '~~') continue;
      if (stack.at(-1) === token) stack.pop(); else stack.push(token);
      i++;
    }
    if (codeTicks) text += '`'.repeat(codeTicks);
    while (stack.length) text += stack.pop();
  }
  return text + (truncated ? '…' : '');
}
