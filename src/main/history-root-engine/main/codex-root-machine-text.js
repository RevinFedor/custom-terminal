'use strict';

const text = require('./history-paged-text');
const white = char => /\s/.test(char);
const lineBreak = char => char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
const digit = char => char >= '0' && char <= '9';
const word = char => /[a-zA-Z0-9_]/.test(char);
function* units(value, from = 0) {
  let offset = from;
  for (const part of text.chunks(value, from)) for (let at = 0; at < part.length; at++) {
    yield { char: part[at], offset: offset++ };
  }
}

function numericPrefix(value, from) {
  const scan = units(value, from);
  try {
    let next = scan.next();
    if (next.done || !white(next.value.char)) return null;
    do { next = scan.next(); } while (!next.done && white(next.value.char));
    if (next.done || !digit(next.value.char)) return null;
    const start = next.value.offset;
    do { next = scan.next(); } while (!next.done && digit(next.value.char));
    return { start, end: next.done ? value.length : next.value.offset,
      next: next.done ? '' : next.value.char };
  } finally { scan.return?.(); }
}

// Exact grammar of the existing header-only filters. The middle can be any
// number of characters; only a prefix, digit boundary and suffix are tested.
function outputHeader(value, kind) {
  if (!(value.endsWith('\nOutput:') || value.endsWith('\nOutput:\n'))) return false;
  if (kind === 'settled') {
    const prefix = 'Script running with cell ID';
    if (!value.startsWith(prefix)) return false;
    const id = numericPrefix(value, prefix.length);
    return !!id && !word(id.next);
  }
  const prefix = kind === 'completed' ? 'Script completed' : 'Script running';
  return value.startsWith(prefix) && !word(value.charAt(prefix.length));
}

// /^\s*Script running with cell ID\s+(\d+)\s*$/m, over leaves. The ID may
// itself be large: it remains a leaf slice and an exact paged map key.
function cellId(value) {
  const prefix = 'Script running with cell ID';
  let blankPrefix = true;
  for (const { char, offset } of units(value)) {
    if (blankPrefix && char === 'S' && value.startsWith(prefix, offset)) {
      const found = numericPrefix(value, offset + prefix.length);
      if (found) {
        let valid = true;
        for (const next of units(value, found.end)) {
          if (lineBreak(next.char)) break;
          if (!white(next.char)) { valid = false; break; }
        }
        if (valid) return text.slice(value, found.start, found.end);
      }
    }
    blankPrefix = lineBreak(char) || blankPrefix && white(char);
  }
  return null;
}

module.exports = { outputHeader, cellId };
