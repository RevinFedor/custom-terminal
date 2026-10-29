'use strict';

// The JSON grammar used by the wire encoder, also used by semantic consumers
// which need JSON *text*. The result is a leaf, not a decoded graph/string.
// This function is synchronous inside one arena mutation and owns no lease
// beyond that mutation. Persistent/reopen consumers still use explicit leases.
const { HistoryPagedCursor, historyPagedJsonEvents } = require('./history-paged-store');
const text = require('./history-paged-text');

function* quote(chunks) {
  yield '"'; let high = '';
  for (const chunk of chunks) {
    for (let at = 0; at < chunk.length; at += 128) {
      let part = high + chunk.slice(at, at + 128); high = '';
      if (/[\uD800-\uDBFF]/.test(part.at(-1) || '')) { high = part.at(-1); part = part.slice(0, -1); }
      if (part) yield JSON.stringify(part).slice(1, -1);
    }
  }
  if (high) yield JSON.stringify(high).slice(1, -1);
  yield '"';
}
function* indent(depth, width) {
  yield '\n';
  for (let left = depth * width; left > 0; left -= 128) yield ' '.repeat(Math.min(128, left));
}
function stringifyPaged(value, arena, space = 0) {
  if (!arena) return JSON.stringify(value, null, space);
  arena.requireStep();
  const ref = arena.encode(value);
  if (ref.type === 'undefined') return undefined;
  const cursor = new HistoryPagedCursor(arena.store, ref, () => arena.assertOpen(), arena.owners, arena.imported);
  const width = Math.min(10, Math.max(0, Math.trunc(Number(space) || 0)));
  return text.build(arena, (function* () {
    let depth = 0, opened = false;
    for (const event of historyPagedJsonEvents(cursor, { stats: arena.metrics })) {
      if (event === '}' || event === ']') {
        depth--;
        if (width && !opened) yield* indent(depth, width);
        yield event; opened = false; continue;
      }
      if (opened) { if (width) yield* indent(depth, width); opened = false; }
      if (event === '{' || event === '[') { yield event; depth++; opened = true; continue; }
      if (event === ',') { yield ','; if (width) yield* indent(depth, width); continue; }
      if (event === ':') { yield width ? ': ' : ':'; continue; }
      if (typeof event === 'string') { yield event; continue; }
      if (event.text) { yield* quote(event.text.textChunks()); continue; }
      const scalar = event.scalar;
      if (typeof scalar === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
      yield JSON.stringify(scalar);
    }
  })());
}

module.exports = { stringifyPaged, quote };
