'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, user, answer, call, output, legacyRows, hashRoot } = require('./test-helpers/codex-root-fixture.cjs');
const { MARKER, writer, expected, fingerprint, fieldDigest, expectedField,
  observeInterval, assertBounded } = require('./test-helpers/codex-ingest-fixture.cjs');

for (const indexBytes of [0, 2048]) for (const chars of [1024, 16*1024, 256*1024]) {
  for (const kind of ['assistant', 'reasoning', 'user', 'arguments', 'output']) {
    test(`INGEST/${kind}/${chars}chars/index${indexBytes}: actual parser→reducer→checkpoint→view→credit full-content`, async t => {
      const f = fixture(t, { indexBytes, checkpointEvery: 2 }), write = writer(f.filePath, f.line), records = [];
      if (kind !== 'user') records.push(write.record(user('ordinary owner')));
      if (kind === 'assistant') records.push(write.record(answer(MARKER), chars));
      if (kind === 'reasoning') {
        records.push(write.record({ type: 'response_item', timestamp: '2026-10-22T00:00:00Z',
          payload: { type: 'reasoning', summary: [{ text: MARKER }] } }, chars));
        records.push(write.record(answer('answer after reasoning')));
      }
      if (kind === 'user') records.push(write.record(user(MARKER), chars));
      if (kind === 'arguments') records.push(write.record(call('one', 'read_file', { body: MARKER }), chars, { layers: 2 }));
      if (kind === 'output') {
        records.push(write.record(call('one')));
        records.push(write.record(output('one', MARKER), chars));
      }
      // Only small sentinel rows ever enter the legacy semantic oracle.
      const rows = legacyRows(f.sessionId, records);
      if (kind === 'user') rows[0].promptPresentationTransportHash = fingerprint(chars).slice(0, 16);
      const oracle = expected(rows, chars), leaf = expectedField(chars);
      const interval = await observeInterval(indexBytes, async hooks => {
        const result = await f.read(hooks);
        try {
          assert.deepEqual(await hashRoot(result), oracle);
          let cursor = result.entries.at(kind === 'user' ? 0 : 1);
          if (kind === 'arguments') cursor = cursor.field('actions').at(0).field('rawTool').field('args').field('body');
          else if (kind === 'output') cursor = cursor.field('actions').at(0).field('rawTool').field('result');
          else cursor = cursor.field(kind === 'reasoning' ? 'thinking' : 'content');
          assert.deepEqual(fieldDigest(cursor), leaf);
          assert.equal(result.readMetrics.canonicalReducerRouted, true);
          assert.equal(result.readMetrics.wholeLineStrings, 0);
          assert.equal(result.readMetrics.wholeRecordGraphs, 0);
          return { readMetrics: result.readMetrics, rootStats: result.rootStats, store: f.store.stats() };
        } finally { result.release(); }
      });
      assertBounded(interval);
      assert.ok(interval.ingestPhases.parse > 0);
      assert.ok(interval.audit.phases.feed > 0);
      assert.ok(interval.audit.phases.finalization > 0);
      t.diagnostic(JSON.stringify({ kind, chars, indexBytes, oracle, leaf, ...interval,
        qualification: 'Source JS conversion/import/cursor boundary evidence, NOT allocator/native/RSS acceptance' }));
    });
  }
}
