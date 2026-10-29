'use strict';
const text = require('./history-paged-text');
const ops = require('./history-root-operations');
const { createJsonNumber } = require('./history-json-number');
const terminator = char => char === '\r' || char === '\n' || char === '\u2028' || char === '\u2029';
function lines(value) {
  const result = ops.arrayFor(value);
  for (const line of text.splitLiteral(value, '\n')) result.push(line);
  return result;
}
function* headers(value) {
  const r = text.reader(value);
  let from = 0;
  while (from <= value.length) {
    let end = from; while (end < value.length && !terminator(r.at(end))) end++;
    for (const kind of ['Add', 'Update', 'Delete']) {
      const prefix = '*** ' + kind + ' File: ';
      if (value.startsWith(prefix, from) && end > from + prefix.length) {
        yield { kind, filePath: value.slice(from + prefix.length, end).trim(), bodyStart: end, headerStart: from };
        break;
      }
    }
    from = end + 1;
  }
}
function unifiedHeader(line) {
  if (!text.isPagedText(line)) return /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
  const r = text.reader(line); let at = 0;
  const literal = value => { if (!line.startsWith(value, at)) return false; at += value.length; return true; };
  const digits = () => {
    const start = at; while (/[0-9]/.test(r.at(at) || '')) at++;
    if (start === at) return null;
    const number = createJsonNumber(); for (const part of text.chunks(line, start, at)) number.write(part);
    return number.finish();
  };
  if (!literal('@@ -')) return null;
  const oldStart = digits(); if (oldStart === null) return null;
  let oldCount = null, newCount = null;
  if (literal(',')) { oldCount = digits(); if (oldCount === null) return null; }
  if (!literal(' +')) return null;
  const newStart = digits(); if (newStart === null) return null;
  if (literal(',')) { newCount = digits(); if (newCount === null) return null; }
  if (!literal(' @@')) return null;
  // JavaScript's final $ may precede one final line terminator, or CRLF.
  while (at < line.length && !terminator(r.at(at))) at++;
  if (at < line.length && !(at === line.length - 1
    || at === line.length - 2 && r.at(at) === '\r' && r.at(at + 1) === '\n')) return null;
  return [null, oldStart, oldCount, newStart, newCount];
}
module.exports = { lines, headers, unifiedHeader };
