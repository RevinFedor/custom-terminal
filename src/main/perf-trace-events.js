'use strict';

const { StringDecoder } = require('node:string_decoder');

// Chrome ReturnAsStream: one event per line inside a JSON array. This is not a
// general streaming JSON parser. Minified/multiline records fail explicitly.
// Decode bounded slices, discard oversize lines through newline, retain no text
// after finish. The optional byte limit is independent of the line/carry limit.
function createTraceLineReader({ onLine, maxCarryBytes = 65536, maxBytes = Infinity, traceEventsOnly = false }) {
  const carryCap = Number.isFinite(maxCarryBytes) ? Math.max(64, Math.min(65536, Math.floor(maxCarryBytes))) : 65536;
  const byteCap = maxBytes === Infinity ? Infinity : Math.max(0, Math.floor(maxBytes));
  const decoder = new StringDecoder('utf8');
  let carry = '', carryBytes = 0, discarding = false, done = false, traceClosed = false;
  const stats = { bytes: 0, acceptedBytes: 0, omittedBytes: 0, lines: 0,
    overlongLines: 0, incompleteTailBytes: 0, peakCarryBytes: 0, completeExport: false };
  function emit(line) {
    stats.lines++;
    if (!traceEventsOnly) { onLine(line); return; }
    if (traceClosed) return;
    const split = traceEventText(line);
    traceClosed = split.closed;
    if (split.text) onLine(split.text);
  }
  function text(value) {
    if (traceEventsOnly && traceClosed) return;
    let offset = 0;
    while (offset < value.length) {
      const newline = value.indexOf('\n', offset);
      const end = newline < 0 ? value.length : newline;
      if (!discarding) {
        const part = value.slice(offset, end), bytes = Buffer.byteLength(part);
        if (carryBytes + bytes > carryCap) {
          carry = ''; carryBytes = 0; discarding = true; stats.overlongLines++;
        } else {
          carry += part; carryBytes += bytes;
          stats.peakCarryBytes = Math.max(stats.peakCarryBytes, carryBytes);
        }
      }
      if (newline < 0) break;
      if (!discarding) emit(carry);
      carry = ''; carryBytes = 0; discarding = false; offset = newline + 1;
      if (traceEventsOnly && traceClosed) return;
    }
  }
  function buffer(value) {
    const take = Math.min(value.length, byteCap - stats.acceptedBytes);
    stats.acceptedBytes += take;
    for (let i = 0; i < take; i += 16384) text(decoder.write(value.subarray(i, Math.min(take, i + 16384))));
  }
  return {
    write(data) {
      if (done) return;
      const isText = typeof data === 'string';
      if (!isText && !Buffer.isBuffer(data)) throw new TypeError('trace chunk must be a Buffer or string');
      stats.bytes += isText ? Buffer.byteLength(data) : data.length;
      if (isText) {
        // Do not allocate an unbounded Buffer for a caller-owned string. Avoid
        // cutting a surrogate pair before converting each bounded piece.
        for (let i = 0; i < data.length && stats.acceptedBytes < byteCap;) {
          let end = Math.min(data.length, i + 8192);
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
          buffer(Buffer.from(data.slice(i, end))); i = end;
        }
      } else buffer(data);
      stats.omittedBytes = stats.bytes - stats.acceptedBytes;
    },
    finish(completeExport = false) {
      if (!done) {
        text(decoder.end());
        stats.completeExport = completeExport === true && stats.omittedBytes === 0;
        if (stats.completeExport && carry && !discarding) emit(carry);
        else stats.incompleteTailBytes = carryBytes;
        if (traceEventsOnly && !traceClosed) stats.completeExport = false;
        carry = ''; carryBytes = 0; done = true;
      }
      return { ...stats, carryLimitBytes: carryCap };
    },
  };
}

// The final Chrome event can share its line with ],"metadata":. Locate the
// closing object outside quoted/escaped strings; never parse export metadata
// (command lines, URLs, machine details), even if it mentions an event name.
function traceEventText(line) {
  const text = line.replace(/^\s*\{\s*"traceEvents"\s*:\s*\[/, '').trim();
  if (/^\]\s*(?:}|,|$)/.test(text)) return { text: '', closed: true };
  if (!text.startsWith('{')) return { text, closed: false };
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const tail = text.slice(i + 1).trim();
      if (/^\]\s*(?:}|,|$)/.test(tail)) return { text: text.slice(0, i + 1), closed: true };
      break;
    }
  }
  return { text, closed: false };
}

function parseTraceEventLine(text) {
  text = traceEventText(text).text.trim().replace(/,$/, '');
  return JSON.parse(text);
}

module.exports = { createTraceLineReader, parseTraceEventLine };
