'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  codexContextPctFromTokenInfo,
  codexContextObservationFromRecord,
  readLatestCodexContextObservation,
} = require('./codex-context-usage');

function tokenCount(used, windowSize = 1000) {
  return {
    type: 'event_msg',
    timestamp: '2026-08-23T14:41:21.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: used },
        model_context_window: windowSize,
      },
    },
  };
}

test('Codex context uses the latest request and accepts authoritative zero', () => {
  assert.equal(codexContextPctFromTokenInfo(tokenCount(830).payload.info), 83);
  assert.equal(codexContextPctFromTokenInfo(tokenCount(0).payload.info), 0);
  assert.equal(codexContextPctFromTokenInfo({
    total_token_usage: { total_tokens: 999999 },
    model_context_window: 1000,
  }), null, 'cumulative billing usage is not context occupancy');
});

test('a compact boundary invalidates every older token count', () => {
  assert.deepEqual(codexContextObservationFromRecord({
    type: 'compacted',
    timestamp: '2026-08-23T14:40:59.000Z',
    payload: { replacement_history: [] },
  }), {
    kind: 'invalidated',
    reason: 'compacted',
    timestamp: '2026-08-23T14:40:59.000Z',
  });
  assert.equal(codexContextObservationFromRecord({
    type: 'event_msg', payload: { type: 'context_compacted' },
  }), null, 'telemetry is not the durable compact boundary');
});

test('tail seed returns compact until a newer token_count replaces it', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-context-tail-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  const line = (record) => JSON.stringify(record) + '\n';
  await fs.promises.writeFile(filePath,
    line(tokenCount(830))
    + line({
      type: 'compacted',
      timestamp: '2026-08-23T14:40:59.000Z',
      payload: { replacement_history: [{ role: 'user', content: 'x'.repeat(512 * 1024) }] },
    })
    + line({ type: 'event_msg', payload: { type: 'context_compacted' } }));

  const invalidated = await readLatestCodexContextObservation(filePath);
  assert.equal(invalidated.kind, 'invalidated');
  assert.equal(invalidated.reason, 'compacted');

  await fs.promises.appendFile(filePath, line(tokenCount(120)));
  const refreshed = await readLatestCodexContextObservation(filePath);
  assert.equal(refreshed.kind, 'value');
  assert.equal(refreshed.contextPct, 12);
});

test('bounded tail never mistakes a pre-compact token count for current state', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-context-budget-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  await fs.promises.writeFile(filePath,
    JSON.stringify(tokenCount(900)) + '\n'
    + JSON.stringify({ type: 'compacted', payload: { summary: 'x'.repeat(64 * 1024) } }) + '\n');
  const result = await readLatestCodexContextObservation(filePath, { maxBytes: 1024 });
  assert.equal(result.kind, 'unknown');
  assert.notEqual(result.contextPct, 90);
});
