// One portable Noted-owned snapshot codec for the three hosts. A snapshot is never a
// live session, delivery receipt, or permission to Send/Resume/Fork.
export const TERMINAL_MESSAGE_MIME = 'application/x-noted-terminal-message-reference';
export const TERMINAL_MESSAGE_HTML_PREFIX = '<!--noted-terminal-message-reference:';
export const TERMINAL_MESSAGE_HTML_ATTRIBUTE = 'data-noted-terminal-message-reference';
const MAX_SNAPSHOT_CHARS = 1024 * 1024;
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
const id = (value, max = 4096) => {
  const result = text(value, max);
  return result && !/[\s\p{Cc}\p{Cf}]/u.test(result) ? result : null;
};
export function normalizeTerminalMessageTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const tabId = id(value.tabId, 1024), messageId = id(value.messageId), sessionId = id(value.sessionId);
  if (!tabId || !messageId || !sessionId || !['claude', 'codex', 'gemini'].includes(value.provider)) return null;
  const optional = {};
  if (Number.isSafeInteger(value.terminalInstancePid) && value.terminalInstancePid > 0) optional.terminalInstancePid = value.terminalInstancePid;
  for (const field of ['physicalSessionId', 'rawUuid', 'viewOwnerSessionId', 'transcriptSegmentId', 'sourceIdentity', 'handoffId']) {
    if (value[field] != null) { const next = id(value[field]); if (!next) return null; optional[field] = next; }
  }
  const iteration = Number.isSafeInteger(value.iteration) && value.iteration > 0 ? value.iteration : null;
  return { tabId, messageId, sessionId, provider: value.provider, ...optional,
    tabName: text(value.tabName, 512) || 'Terminal', iteration,
    messageTimestamp: text(value.messageTimestamp, 128) || null,
    timeLabel: text(value.timeLabel, 128) || null,
    role: text(value.role, 64) || null };
}
export function makeTerminalMessageSnapshot(detailsText, source, referenceId) {
  const target = normalizeTerminalMessageTarget(source);
  if (!target || typeof detailsText !== 'string' || !detailsText.length
    || detailsText.length > MAX_SNAPSHOT_CHARS || typeof referenceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(referenceId)) return null;
  return { version: 1, kind: 'noted-terminal-message', referenceId, source: target, detailsText };
}
export function normalizeTerminalMessageSnapshot(value, expectedText) {
  if (value?.version !== 1 || value.kind !== 'noted-terminal-message') return null;
  const result = makeTerminalMessageSnapshot(value.detailsText, value.source, value.referenceId);
  return result && (expectedText === undefined || expectedText === result.detailsText) ? result : null;
}
export function terminalMessageLabel(value) {
  const source = value.source || value;
  // timeLabel is the saved local clock, not a UTC input to reinterpret on Copy
  // or in another host. Compact only its visible seconds; keep the snapshot exact.
  const timeLabel = typeof source.timeLabel === 'string'
    ? source.timeLabel.replace(/(\b\d{1,2}:\d{2}):\d{2}(?:[.,]\d+)?(?=$|[^\d])/g, '$1') : null;
  return [source.tabName || 'Terminal', source.iteration ? `Итерация ${source.iteration}` : null, timeLabel]
    .filter(Boolean).join(' · ');
}
export function terminalMessageClipboard(detailsText, source, referenceId) {
  const snapshot = makeTerminalMessageSnapshot(detailsText, source, referenceId);
  if (!snapshot) return { text: detailsText };
  const encoded = encodeURIComponent(JSON.stringify(snapshot)).replace(/'/g, '%27');
  const escaped = detailsText.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return { text: detailsText, html: `<pre ${TERMINAL_MESSAGE_HTML_ATTRIBUTE}="${encoded}">${escaped}</pre>` };
}
export function readTerminalMessageClipboard(data, expectedText) {
  if (!data?.getData || typeof expectedText !== 'string') return null;
  let encoded;
  try {
    const direct = data.getData(TERMINAL_MESSAGE_MIME);
    if (direct && direct.length <= MAX_SNAPSHOT_CHARS * 8) return normalizeTerminalMessageSnapshot(JSON.parse(direct), expectedText);
    const html = data.getData('text/html');
    if (typeof html !== 'string' || html.length > MAX_SNAPSHOT_CHARS * 8) return null;
    const attribute = html.match(/\bdata-noted-terminal-message-reference\s*=\s*(["'])(.*?)\1/is);
    if (attribute) return normalizeTerminalMessageSnapshot(JSON.parse(decodeURIComponent(attribute[2])), expectedText);
    const start = html.indexOf(TERMINAL_MESSAGE_HTML_PREFIX);
    if (start < 0) return null;
    const from = start + TERMINAL_MESSAGE_HTML_PREFIX.length, end = html.indexOf('-->', from);
    if (end < 0) return null;
    encoded = html.slice(from, end);
    return normalizeTerminalMessageSnapshot(JSON.parse(decodeURIComponent(encoded)), expectedText);
  } catch { return null; } // malformed richer data leaves the original text intact
}
// Persistent GT document form: Details stay readable. Character-count framing
// permits literal closing tags/newlines in Details without truncating the body.
export function buildTerminalMessageBlock(value) {
  const snapshot = normalizeTerminalMessageSnapshot(value);
  if (!snapshot) return null;
  const { detailsText, ...metadata } = snapshot;
  const encoded = encodeURIComponent(JSON.stringify({ ...metadata, detailsChars: detailsText.length }));
  if (encoded.length > 12000) return null;
  return `<noted-message-reference data="${encoded}">\n${detailsText}\n</noted-message-reference>`;
}
export function collectTerminalMessageBlocks(documentText) {
  const result = [], header = /<noted-message-reference data="([^"\n]{1,12000})">\n/g;
  let acceptedEnd = -1;
  for (const match of String(documentText || '').matchAll(header)) {
    if (match.index < acceptedEnd) continue;
    try {
      const metadata = JSON.parse(decodeURIComponent(match[1]));
      if (!Number.isSafeInteger(metadata.detailsChars) || metadata.detailsChars < 1 || metadata.detailsChars > MAX_SNAPSHOT_CHARS) continue;
      const bodyStart = match.index + match[0].length, bodyEnd = bodyStart + metadata.detailsChars;
      const footer = '\n</noted-message-reference>';
      // Even an incomplete/unknown outer envelope owns its literal body. Do
      // not turn a well-formed-looking example inside that body into a link.
      acceptedEnd = Math.min(documentText.length, bodyEnd + footer.length);
      if (documentText.slice(bodyEnd, bodyEnd + footer.length) !== footer) continue;
      const snapshot = normalizeTerminalMessageSnapshot({ ...metadata, detailsText: documentText.slice(bodyStart, bodyEnd) });
      if (snapshot) result.push({ from: match.index, to: acceptedEnd, snapshot });
    } catch {}
  }
  return result;
}
export function expandTerminalMessageBlocks(value) {
  let result = String(value || '');
  for (const block of collectTerminalMessageBlocks(result).reverse()) result = result.slice(0, block.from) + block.snapshot.detailsText + result.slice(block.to);
  return result;
}
