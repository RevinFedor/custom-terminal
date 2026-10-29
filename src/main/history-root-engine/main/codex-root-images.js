'use strict';

// Addressed implementation of codex-prompt-audit's image-carrier grammar.
// Captures are UTF-16 ranges, collections use the existing arena. Unknown or
// malformed markup stays literal. No image/path text is opened as a file.
const text = require('./history-paged-text');
const { createJsonNumber } = require('./history-json-number');
const white = char => !!char && /\s/.test(char);
const digit = char => !!char && char >= '0' && char <= '9';

function scan(value) {
  const read = text.reader(value); let at = 0;
  return {
    get at() { return at; }, set at(next) { at = next; }, char: () => read.at(at),
    literal(marker) {
      const start = at;
      for (const char of marker) if ((read.at(at++) || '').toLowerCase() !== char.toLowerCase()) { at = start; return false; }
      return true;
    },
    spaces(required = false) { const start = at; while (white(read.at(at))) at++; return !required || at > start; },
    optionalQuote() { if (read.at(at) === '"' || read.at(at) === "'") at++; },
    digits() { const start = at; while (digit(read.at(at))) at++; return at > start ? { from: start, to: at } : null; },
    image(numberRequired = false) {
      const start = at;
      if (!this.literal('[Image')) return null;
      let slot = null;
      if (white(read.at(at))) {
        this.spaces(); if (read.at(at) === '#') at++;
        slot = this.digits(); if (!slot) { at = start; return null; }
      }
      if (read.at(at++) !== ']' || numberRequired && !slot) { at = start; return null; }
      return { start, end: at, slot };
    },
    path(bare) {
      const start = at, quote = read.at(at);
      if (!bare && (quote === '"' || quote === "'")) {
        at++; const from = at;
        while (at < value.length && read.at(at) !== quote) at++;
        if (at === value.length || at === from) { at = start; return null; }
        return { from, to: at++ };
      }
      const from = at;
      while (at < value.length && !white(read.at(at)) && read.at(at) !== '>') at++;
      return at > from ? { from, to: at } : null;
    },
  };
}
function providerAt(value, start, selfClosing = false) {
  const s = scan(value); s.at = start;
  if (!s.literal('<image') || !s.spaces(true) || !s.literal('name')) return null;
  s.spaces(); if (!s.literal('=')) return null; s.spaces(); s.optionalQuote();
  const name = s.image(); if (!name) return null; s.optionalQuote();
  if (!s.spaces(true) || !s.literal('path')) return null;
  s.spaces(); if (!s.literal('=')) return null; s.spaces(); const pathStart = s.at;
  // The original regex tries quoted alternatives, then a bare path. The bare
  // branch also admits quote characters when a quoted alternative fails.
  for (const bare of [false, true]) {
    s.at = pathStart; let path = s.path(bare); if (!path) continue;
    if (selfClosing && bare && text.equalRange(value, path.to - 1, '/')) {
      path = { from: path.from, to: path.to - 1 }; s.at--;
      if (path.to === path.from) continue;
    }
    s.spaces();
    if (selfClosing) {
      if (!s.literal('/')) continue; s.spaces();
      if (s.literal('>')) return { start, end: s.at, path, nameSlot: name.slot, bodySlot: null };
      continue;
    }
    if (!s.literal('>')) continue; s.spaces();
    let body = null;
    if (!s.literal('<<ImageDisplayed>>')) { body = s.image(); if (!body) continue; }
    s.spaces(); if (!s.literal('</image')) continue; s.spaces();
    if (!s.literal('>')) continue;
    return { start, end: s.at, path, nameSlot: name.slot, bodySlot: body?.slot || null };
  }
  return null;
}
function* providers(value, selfClosing = false) {
  for (let at = text.indexOfAsciiIgnoreCase(value, '<image'); at >= 0;) {
    const block = providerAt(value, at, selfClosing);
    if (block) yield block;
    at = text.indexOfAsciiIgnoreCase(value, '<image', block ? block.end : at + 1);
  }
}
function* imageSlots(value, numbered = false) {
  const s = scan(value);
  for (let at = text.indexOfAsciiIgnoreCase(value, '[Image'); at >= 0;) {
    s.at = at; const match = s.image(numbered);
    if (match) yield match;
    at = text.indexOfAsciiIgnoreCase(value, '[Image', match ? match.end : at + 1);
  }
}
const capture = (value, range) => range ? value.slice(range.from, range.to) : '';
function slotNumber(value, range) {
  if (!range) return null;
  const number = createJsonNumber(); for (const part of text.chunks(value, range.from, range.to)) number.write(part);
  return number.finish();
}
function replaceRanges(arena, value, matches, replacement) {
  const iterator = matches[Symbol.iterator](), first = iterator.next();
  if (first.done) return value;
  return text.build(arena, (function* () {
    let from = 0, current = first;
    try {
      while (!current.done) {
        const match = current.value;
        yield* text.chunks(value, from, match.start);
        const next = replacement(match);
        if (next === null) yield* text.chunks(value, match.start, match.end);
        else yield* text.chunks(next);
        from = match.end; current = iterator.next();
      }
      yield* text.chunks(value, from);
    } finally { iterator.return?.(); }
  })());
}
function collapseAdjacent(arena, value) {
  function* matches() {
    const s = scan(value);
    for (let at = text.indexOfAsciiIgnoreCase(value, '[Image'); at >= 0;) {
      s.at = at; const first = s.image(true);
      let second = null;
      if (first) { s.spaces(); second = s.image(true); }
      if (second && text.equal(capture(value, first.slot), capture(value, second.slot))) {
        yield { start: at, end: second.end, firstEnd: first.end }; at = second.end;
      } else at++;
      at = text.indexOfAsciiIgnoreCase(value, '[Image', at);
    }
  }
  return replaceRanges(arena, value, matches(), match => value.slice(match.start, match.firstEnd));
}
function createRootImages(arena) {
  const map = () => arena.make('map'), array = () => arena.make('array');
  function paths(payload) {
    const result = array();
    for (const values of [payload?.local_images, payload?.images]) if (Array.isArray(values)) {
      for (const value of values) if (text.isText(value)) { const path = value.trim(); if (path) result.push(path); }
    }
    return result;
  }
  function normalize(value, imagePaths = [], allow = false) {
    if (!text.includesAsciiIgnoreCase(value, '<image') && !text.includesAsciiIgnoreCase(value, '[image')) return value;
    const allowed = map();
    for (const value of imagePaths) if (text.isText(value)) {
      const path = value.trim(); if (path) allowed.set(path, (allowed.get(path) || 0) + 1);
    }
    if (!allowed.size && !allow) return value;
    const without = replaceRanges(arena, value, providers(value), () => ' '), referenced = map(), used = map();
    for (const match of imageSlots(without, true)) {
      const slot = capture(without, match.slot); referenced.set(slot, (referenced.get(slot) || 0) + 1);
    }
    const normalized = replaceRanges(arena, value, providers(value), block => {
      const slot = capture(value, block.nameSlot), bodySlot = capture(value, block.bodySlot);
      if (slot && bodySlot && !text.equal(slot, bodySlot)) return null;
      const path = capture(value, block.path), count = used.get(path) || 0;
      const admitted = (allowed.get(path) || 0) > count;
      if (allowed.size && !admitted) return null;
      if (!allowed.size && !allow) return null;
      if (admitted) used.set(path, count + 1);
      if (slot && (referenced.get(slot) || 0) > 0) {
        referenced.set(slot, referenced.get(slot) - 1); return ' ';
      }
      return text.concat([' [Image', slot ? text.concat([' #', slot], '', arena) : '', '] '], '', arena);
    });
    return collapseAdjacent(arena, normalized);
  }
  function refs(record, raw) {
    const result = map(); let index = 0;
    for (const path of paths(record?.payload)) {
      index++; if (path.startsWith('/')) result.set(index, { id: index, path });
    }
    for (const block of providers(raw)) {
      const name = slotNumber(raw, block.nameSlot), body = slotNumber(raw, block.bodySlot), id = name || body;
      const path = capture(raw, block.path);
      if ((name === null || body === null || name === body) && id > 0 && path.startsWith('/') && !result.has(id)) {
        result.set(id, { id, path });
      }
    }
    const values = array(); for (const value of result.values()) values.push(value); return values;
  }
  function merge(primary = [], companion = []) {
    const result = map();
    for (const list of [primary, companion]) for (const ref of list || []) {
      if (ref?.id > 0 && ref.path && !result.has(ref.id)) result.set(ref.id, ref);
    }
    const values = array(); for (const value of result.values()) values.push(value); return values;
  }
  function* pathMarkers(value, label) {
    const marker = '[' + label + ':';
    const r = text.reader(value);
    for (let at = text.indexOfAsciiIgnoreCase(value, marker); at >= 0;) {
      let end = at + marker.length;
      // Greedy \s* may backtrack into the required body. Exactly one or more
      // non-] CR LF characters must occur after some such whitespace prefix.
      let leading = end, whiteBody = false;
      while (white(r.at(leading))) { if (r.at(leading) !== '\r' && r.at(leading) !== '\n') whiteBody = true; leading++; }
      end = leading;
      while (end < value.length && r.at(end) !== ']' && r.at(end) !== '\r' && r.at(end) !== '\n') end++;
      const body = end > leading || whiteBody;
      while (white(r.at(end))) end++;
      const valid = r.at(end) === ']' && body;
      if (valid) { yield { start: at, end: end + 1 }; at = end + 1; } else at++;
      at = text.indexOfAsciiIgnoreCase(value, marker, at);
    }
  }
  function slots(value) {
    let result = normalize(value, [], true);
    result = replaceRanges(arena, result, providers(result, true), () => ' [Image] ');
    for (const label of ['imagePath', 'imageError', 'image']) {
      result = replaceRanges(arena, result, pathMarkers(result, label), () => ' [Image] ');
    }
    result = replaceRanges(arena, result, imageSlots(result), () => ' [Image] ');
    return text.build(arena, (function* () {
      let any = false, pending = false;
      for (const part of text.chunks(result)) {
        let out = '';
        for (const char of part) {
          if (white(char)) { pending = any; continue; }
          if (pending) out += ' '; pending = false; any = true; out += char;
        }
        if (out) yield out;
      }
    })());
  }
  function hasMarker(value) {
    if (!imageSlots(value).next().done) return true;
    for (const label of ['imagePath', 'imageError', 'image']) if (!pathMarkers(value, label).next().done) return true;
    return false;
  }
  return { paths, normalize, refs, merge, slots, hasMarker };
}
module.exports = { createRootImages, providers, imageSlots };
