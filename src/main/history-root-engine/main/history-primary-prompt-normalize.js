'use strict';

// Exact CURRENT normalizeHistoryPromptIdentityText over the frozen selected
// String(value || ''). Every scalar stays in the quota-owned paged store.
// Cursor offsets are UTF16; the only resident lookahead is the reader's 128
// units. Web-image URL/title grammar keeps its native 8192-unit boundary.
// This projection is a read proof, never an attachment or Send authority.
async function normalizePrimaryPromptIdentity({ ref, store, reader, pieces, write, step, find, replace }) {
  const removed = await write((async function* () {
    let from = 0;
    for (;;) {
      const start = await find(ref, '<system-reminder>', from);
      if (start < 0) break;
      const end = await find(ref, '</system-reminder>', start + 17);
      if (end < 0) break;
      yield* pieces(ref, from, start); from = end + 18;
    }
    yield* pieces(ref, from);
  })());
  const clean = await replace(await replace(removed, '[200~'), '~]');
  const white = value => value !== undefined && /\s/u.test(value);
  const line = value => value === '\r' || value === '\n';
  const horizontal = value => value === ' ' || value === '\t';
  async function word(r, at, expected, end = r.length) {
    if (at + expected.length > end) return false;
    for (let index = 0; index < expected.length; index++) {
      await step();
      if (r.at(at + index).toLowerCase() !== expected[index]) return false;
    }
    return true;
  }
  // Same candidate start and lastIndex transitions as
  // collectPromptWebImageReferences, with unbounded alt text kept as offsets.
  async function* webReferences(value) {
    const r = reader(value);
    for (let at = 0; at < r.length;) {
      await step();
      const start = at++;
      if (r.at(start - 1) === '\\') continue;
      let cursor;
      if (r.at(start) === '!' && r.at(start + 1) === '[') {
        cursor = start + 2;
        while (cursor < r.length && r.at(cursor) !== ']' && !line(r.at(cursor))) { cursor++; await step(); }
        if (r.at(cursor) !== ']') continue;
        cursor++;
      } else if (await word(r, start, '[image]')) cursor = start + 7;
      else continue;
      if (r.at(cursor++) !== '(') continue;
      while (horizontal(r.at(cursor))) { cursor++; await step(); }
      const angle = r.at(cursor) === '<';
      if (angle) cursor++;
      const urlStart = cursor;
      if (await word(r, cursor, 'https://')) cursor += 8;
      else if (await word(r, cursor, 'http://')) cursor += 7;
      else continue;
      // A failed candidate resumes at the end of its matched prefix, except
      // the explicit URL-cap branch in the native owner.
      at = cursor;
      cursor = urlStart;
      let depth = 0;
      const limit = Math.min(r.length, urlStart + 8192);
      for (; cursor < limit; cursor++) {
        await step(); const char = r.at(cursor);
        if (char === '\\' && cursor + 1 < limit && !line(r.at(cursor + 1))) { cursor++; continue; }
        if (line(char) || (angle ? char === '>' : white(char))) break;
        if (!angle && char === '(') depth++;
        if (!angle && char === ')') { if (depth === 0) break; depth--; }
      }
      const urlEnd = cursor;
      if (cursor >= limit) { at = cursor; continue; }
      if (depth > 0 || urlEnd === urlStart) continue;
      if (angle) { if (r.at(cursor) !== '>') continue; cursor++; }
      const beforeSpace = cursor;
      while (cursor < limit && horizontal(r.at(cursor))) { cursor++; await step(); }
      if (cursor > beforeSpace && (r.at(cursor) === '"' || r.at(cursor) === "'")) {
        const quote = r.at(cursor++);
        while (cursor < limit && r.at(cursor) !== quote && !line(r.at(cursor))) {
          await step(); if (r.at(cursor) === '\\') cursor++; cursor++;
        }
        if (r.at(cursor) !== quote) continue;
        cursor++;
        while (cursor < limit && horizontal(r.at(cursor))) { cursor++; await step(); }
      }
      if (cursor >= limit || r.at(cursor) !== ')') continue;
      at = cursor + 1;
      yield { start, end: at };
    }
  }
  async function markerEnd(r, start, end, mode) {
    const prefix = mode === 'image' ? '[image' : '[' + mode + ':';
    if (!await word(r, start, prefix, end)) return -1;
    let at = start + prefix.length;
    if (mode === 'image') {
      if (r.at(at) === ']') return at + 1;
      const beforeSpace = at;
      while (at < end && white(r.at(at))) { at++; await step(); }
      if (at === beforeSpace) return -1;
      if (r.at(at) === '#') at++;
      const digits = at;
      while (at < end && /[0-9]/.test(r.at(at))) { at++; await step(); }
      return at > digits && at < end && r.at(at) === ']' ? at + 1 : -1;
    }
    // \s*[^\]\r\n]+?\s*: initial/trailing whitespace may include a
    // newline, but a newline cannot split non-whitespace body characters.
    let eligible = false;
    while (at < end && white(r.at(at))) {
      if (!line(r.at(at))) eligible = true;
      at++; await step();
    }
    if (r.at(at) === ']') return eligible ? at + 1 : -1;
    const body = at;
    while (at < end && r.at(at) !== ']' && !line(r.at(at))) { at++; await step(); }
    if (at === body) return -1;
    while (at < end && white(r.at(at))) { at++; await step(); }
    return at < end && r.at(at) === ']' ? at + 1 : -1;
  }
  async function replaceMarkers(value, mode) {
    const r = reader(value);
    return write((async function* () {
      let from = 0, at = 0;
      while (at < r.length) {
        await step();
        if (r.at(at) !== '[') { at++; continue; }
        const end = await markerEnd(r, at, r.length, mode);
        if (end < 0) { at++; continue; }
        yield* pieces(value, from, at); yield ' [Image] '; from = at = end;
      }
      yield* pieces(value, from);
    })());
  }
  async function mappedSlice(from, to) {
    const selected = await write(pieces(clean, from, to));
    return replaceMarkers(await replaceMarkers(await replaceMarkers(selected, 'imagepath'), 'imageerror'), 'image');
  }
  const mapped = await write((async function* () {
    let from = 0;
    for await (const reference of webReferences(clean)) {
      yield* pieces(await mappedSlice(from, reference.start));
      yield* pieces(clean, reference.start, reference.end); from = reference.end;
    }
    yield* pieces(await mappedSlice(from, store.json(clean.id).totalChars));
  })());
  // trim() before image mapping cannot change a matched reference or marker;
  // the final collapse/trim is exactly equivalent and avoids an extra copy.
  return write((async function* () {
    let nonempty = false, space = false, output = '';
    for await (const chunk of pieces(mapped)) for (const char of chunk) {
      await step();
      if (white(char)) { if (nonempty) space = true; continue; }
      if (space) output += ' ';
      space = false; nonempty = true; output += char;
      if (output.length >= 128) { yield output; output = ''; }
    }
    if (output) yield output;
  })());
}

module.exports = { normalizePrimaryPromptIdentity };
