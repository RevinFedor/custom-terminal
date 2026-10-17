'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cloneProjectionGraphAsync, measureProjectionGraphBytes } = require('./codex-projection-checkpoint');

for (const kind of ['array', 'map', 'set']) test('large primitive ' + kind + ' yields inside the container and preserves aliases', async () => {
  const values = Array.from({ length: 10001 }, (_, i) => i);
  const container = kind === 'map' ? new Map(values.map(i => [i, i])) : kind === 'set' ? new Set(values) : values;
  const source = { a: container, b: container };source.self = source;
  let serviced = false;setImmediate(() => { serviced = true; });
  const result = await cloneProjectionGraphAsync(source);
  assert.equal(serviced, true, 'one primitive container must not monopolize a whole clone');
  assert.equal(result.value.a, result.value.b);assert.equal(result.value.self, result.value);
  assert.notEqual(result.value.a, source.a);assert.deepEqual(result.value.a, source.a);
});

for (const kind of ['array', 'map', 'set']) test('measurement yields within primitive ' + kind + ' without changing exact accounting', async () => {
  const values = Array.from({ length: 10001 }, (_, i) => i);
  const container = kind === 'map' ? new Map(values.map(i => [i, i])) : kind === 'set' ? new Set(values) : values;
  const source = { a: container, b: container }; source.self = source;
  let serviced = false; setImmediate(() => { serviced = true; });
  assert.equal(await measureProjectionGraphBytes(source), 48 + 48 + values.length * (kind === 'map' ? 16 : 8));
  assert.equal(serviced, true);
  assert.equal(source.a, source.b);
});
