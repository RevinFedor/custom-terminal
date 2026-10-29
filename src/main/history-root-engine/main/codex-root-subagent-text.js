'use strict';
const text = require('./history-paged-text');
const white = char => /\s/.test(char || '');
function afterMarker(value, marker, suffix, insensitive = false) {
  const r = text.reader(value);
  const find = (from = 0) => insensitive ? text.indexOfAsciiIgnoreCase(value, marker, from) : value.indexOf(marker, from);
  for (let start = find(); start >= 0; start = find(start + 1)) {
    let at = start + marker.length; while (white(r.at(at))) at++;
    const equal = insensitive
      ? text.indexOfAsciiIgnoreCase(value, suffix, at) === at : value.startsWith(suffix, at);
    if (equal) return { start, at: at + suffix.length };
  }
  return null;
}
function finalAnswer(value) {
  if (!afterMarker(value, 'Message Type:', 'FINAL_ANSWER', true)) return null;
  const r = text.reader(value);
  for (let at = value.indexOf('Payload:'); at >= 0; at = value.indexOf('Payload:', at + 1)) {
    let cursor = at + 8, newline = -1;
    while (white(r.at(cursor))) { if (r.at(cursor) === '\n' && newline < 0) newline = cursor; cursor++; }
    if (newline >= 0) return value.slice(newline + 1).trim();
  }
  return value.trim();
}
function notificationBody(value) {
  const start = value.indexOf('<subagent_notification>');
  if (start < 0) return null;
  const from = start + '<subagent_notification>'.length, end = value.indexOf('</subagent_notification>', from);
  return end > from ? value.slice(from, end) : value;
}
function notificationOutcome(value) {
  const r = text.reader(value);
  const quoted = afterMarker(value, '"completed"', ':');
  let complete = !!quoted;
  if (!complete) for (let at = text.indexOfAsciiIgnoreCase(value, 'status'); at >= 0; at = text.indexOfAsciiIgnoreCase(value, 'status', at + 1)) {
    let end = at + 6; while (end < value.length && !/[а-яa-z]/i.test(r.at(end))) end++;
    if (text.indexOfAsciiIgnoreCase(value, 'completed', end) === end) { complete = true; break; }
  }
  let captured;
  if (complete) for (let at = value.indexOf('"completed"'); at >= 0; at = value.indexOf('"completed"', at + 1)) {
    let end = at + 11; while (white(r.at(end))) end++;
    if (r.at(end++) !== ':') continue; while (white(r.at(end))) end++;
    if (r.at(end++) !== '"') continue;
    const from = end;
    for (; end < value.length; end++) {
      const char = r.at(end);
      if (char === '"') { captured = value.slice(from, end); break; }
      if (char === '\\') {
        const escaped = r.at(++end);
        if (!escaped || /[\r\n\u2028\u2029]/.test(escaped)) break;
      }
    }
    if (captured !== undefined) break;
  }
  return { complete, captured, interrupted: text.includesAsciiIgnoreCase(value, 'interrupted')
    || text.includesAsciiIgnoreCase(value, 'errored') };
}
module.exports = { finalAnswer, notificationBody, notificationOutcome };
