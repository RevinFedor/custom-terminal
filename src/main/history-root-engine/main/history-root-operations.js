'use strict';

// Explicit operations for semantic helpers shared with the native DTO path.
// No implicit property-key conversion, Object.keys or Array.from over owners.
const text = require('./history-paged-text');
const { projectionArenaOf } = require('./history-projection-arena');
const { stringifyPaged } = require('./history-paged-stringify');
function arenaOf(...values) {
  for (const value of values) {
    const arena = projectionArenaOf(value) || text.info(value)?.arena;
    if (arena) return arena;
  }
  return null;
}
function* keys(value) {
  const arena = projectionArenaOf(value);
  if (arena) yield* arena.keys(arena.owner(value));
  else if (value != null) for (const key in value) if (Object.hasOwn(value, key)) yield key;
}
function get(value, key) {
  const arena = projectionArenaOf(value);
  return arena ? arena.get(arena.owner(value), key) : value[key];
}
function* entries(value) { for (const key of keys(value)) yield [key, get(value, key)]; }
function operations(arena) {
  return {
    isText: text.isText, equal: text.equal, keys,
    parse: value => { if (text.isPagedText(value)) return text.parseJson(value); return JSON.parse(value); },
    stringify: value => stringifyPaged(value, arena),
    array: () => arena ? arena.make('array') : [],
    set: () => arena ? arena.make('set') : new Set(),
    assign: (...values) => arena ? arena.assign(...values) : Object.assign({}, ...values),
  };
}
function arrayFor(...values) { const arena = arenaOf(...values); return arena ? arena.make('array') : []; }
function mapFor(...values) { const arena = arenaOf(...values); return arena ? arena.make('map') : new Map(); }

module.exports = { arenaOf, keys, get, entries, operations, arrayFor, mapFor, stringifyPaged };
