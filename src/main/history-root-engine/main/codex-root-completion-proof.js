'use strict';

// The own-child fallback keeps its existing 64KiB tail and verdict policy.
// It reads that tail into the same paged JSON parser before a line/String/AST
// exists. A forward scan retains only the latest decisive verdict, equivalent
// to the native reader's reverse scan. The raw-tail fallback is also a leaf.
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { createPagedJsonProjection } = require('./history-paged-json');
const text = require('./history-paged-text');

function marker(value, key, expected) {
  const quoted = '"' + key + '"', r = text.reader(value);
  for (let at = value.indexOf(quoted); at >= 0; at = value.indexOf(quoted, at + 1)) {
    let end = at + quoted.length;
    while (/\s/.test(r.at(end) || '')) end++;
    if (r.at(end++) !== ':') continue;
    while (/\s/.test(r.at(end) || '')) end++;
    if (value.startsWith('"' + expected + '"', end)) return true;
  }
  return false;
}

function readRootedCompletionProof({ rooted: arena, filePath, toolType, notBefore }, limit, inspect) {
  arena.requireStep();
  let fd, parser = null, raw = null;
  const endBuild = arena.store.beginBuild();
  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) return { finished: false, completedAt: 0 };
    fd = fs.openSync(filePath, 'r');
    const length = Math.min(limit, stat.size), start = stat.size - length;
    const buffer = Buffer.alloc(64), decoder = new StringDecoder('utf8');
    raw = Number(notBefore) > 0 ? null : arena.store.leafWriter();
    let verdict = null, cursor = 0;
    const finish = end => {
      if (!parser) return;
      const result = parser.finish(end); parser = null;
      if (!result.lease) return;
      try {
        const next = inspect(arena.own(result.lease.cursor()), toolType, notBefore);
        if (next) verdict = next;
      } finally { result.lease.release(); }
    };
    while (cursor < length) {
      const wanted = Math.min(buffer.length, length - cursor);
      buffer.fill(0);
      fs.readSync(fd, buffer, 0, wanted, start + cursor);
      const bytes = buffer.subarray(0, wanted);
      if (raw) raw.write(decoder.write(bytes));
      let from = 0;
      while (from < bytes.length) {
        const newline = bytes.indexOf(10, from), end = newline < 0 ? bytes.length : newline;
        if (!parser && end > from) parser = createPagedJsonProjection(arena.store);
        if (parser && end > from) parser.write(bytes.subarray(from, end), cursor + from);
        if (newline < 0) break;
        finish(cursor + end); from = end + 1;
      }
      cursor += wanted;
      arena.metrics.ownProofReadBytes = (arena.metrics.ownProofReadBytes || 0) + wanted;
      arena.metrics.ownProofMaxReadBytes = Math.max(arena.metrics.ownProofMaxReadBytes || 0, wanted);
    }
    finish(cursor);
    let tail = '';
    if (raw) { raw.write(decoder.end()); tail = text.fromRef(arena, raw.finish()); raw = null; }
    if (verdict) return verdict;
    const finished = Number(notBefore) > 0 ? false : toolType === 'codex'
      ? marker(tail, 'type', 'task_complete') || marker(tail, 'phase', 'final_answer')
      : marker(tail, 'stop_reason', 'end_turn');
    return { finished, completedAt: 0 };
  } catch (error) {
    if (String(error?.code || '').startsWith('history_')) throw error;
    return { finished: false, completedAt: 0 };
  } finally {
    parser?.abort();
    // Writers contain only bounded metadata; unfinished pages are collectable.
    endBuild();
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
module.exports = { readRootedCompletionProof, marker };
