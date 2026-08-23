'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveCodexWriterInspection } = require('./codex-runtime-observation');

test('59 read consumers reuse one event-owned fact and run zero physical reconciles', async () => {
  let reconciles = 0;
  const projection = { status: 'adopted', sessionId: 'writer-a' };
  const results = await Promise.all(Array.from({ length: 59 }, () => (
    resolveCodexWriterInspection({
      projectedInspection: projection,
      reconcile: async () => {
        reconciles += 1;
        return { status: 'adopted', sessionId: 'writer-a' };
      },
    })
  )));
  assert.equal(reconciles, 0);
  assert.equal(results.every((result) => result.source === 'event-projection'), true);

  const destructive = await resolveCodexWriterInspection({
    projectedInspection: projection,
    forceWriterReconcile: true,
    reconcile: async () => {
      reconciles += 1;
      return { status: 'adopted', sessionId: 'writer-a' };
    },
  });
  assert.equal(reconciles, 1);
  assert.equal(destructive.source, 'fresh-reconcile');
});
