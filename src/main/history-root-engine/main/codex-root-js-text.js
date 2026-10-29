'use strict';

// Bounded primitives used by the existing safe exec-literal reader. This is
// not a replacement JavaScript grammar or permission to execute rollout text.
const text = require('./history-paged-text');
const { createJsonNumber } = require('./history-json-number');
function identifier(value, from = 0) {
  const r = text.reader(value); let end = from;
  if (!/[A-Za-z_$]/.test(r.at(end) || '')) return null;
  while (/[A-Za-z0-9_$]/.test(r.at(++end) || '')) {}
  return { value: value.slice(from, end), end };
}
function exactIdentifier(value) {
  value = text.coerce(value || '').trim();
  const result = identifier(value);
  return result && result.end === value.length ? result.value : null;
}
function keyword(value, from) {
  const r = text.reader(value);
  for (const word of ['const','let','var']) if (value.startsWith(word, from)
    && !/[A-Za-z0-9_]/.test(r.at(from + word.length) || '')) return word;
  return null;
}
function number(value, from) {
  const r = text.reader(value); let at = from;
  if (r.at(at) === '-') at++;
  const begin = at;
  while (/[0-9]/.test(r.at(at) || '')) at++;
  let digits = at > begin;
  if (r.at(at) === '.') {
    at++; const fraction = at;
    while (/[0-9]/.test(r.at(at) || '')) at++;
    digits ||= at > fraction;
  }
  if (!digits) return null;
  if (r.at(at) === 'e' || r.at(at) === 'E') {
    const exponent = at++;
    if (r.at(at) === '+' || r.at(at) === '-') at++;
    const start = at; while (/[0-9]/.test(r.at(at) || '')) at++;
    if (at === start) at = exponent;
  }
  const decoder = createJsonNumber(); let offset = from;
  if (r.at(offset) === '-') { decoder.write('-'); offset++; }
  if (r.at(offset) === '.') decoder.write('0');
  for (const part of text.chunks(value, offset, at)) decoder.write(part);
  return { value: decoder.finish(), end: at };
}
function accumulator(value) {
  const arena = text.info(value)?.arena;
  if (!arena) { let out = ''; return { write: part => { out += part; }, finish: () => out }; }
  const writer = arena.store.leafWriter(); let buffer = '';
  const flush = () => { if (buffer) writer.write(buffer); buffer = ''; };
  return {
    write(part) { if (buffer.length + part.length > 128) flush(); buffer += part; },
    finish() { flush(); return text.fromRef(arena, writer.finish()); },
  };
}
module.exports = { identifier, exactIdentifier, keyword, number, accumulator };
