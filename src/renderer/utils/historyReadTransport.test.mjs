import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { serialize } from 'node:v8';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';
const require = createRequire(import.meta.url);

test('desktop decodes full, delta, rewrite and unchanged responses with exact values', async t => {
  const previous = globalThis.window; globalThis.window = { require };
  t.after(() => { globalThis.window = previous; });
  for (const result of [
    { success: true, entries: [{ uuid: 'u', content: '🌏\ud800', thinking: undefined }], revision: { token: 't' } },
    { success: true, delta: true, changedEntries: [], order: ['u'] },
    { success: true, rewriteDelta: true, carriedEntries: [{ sourceUuid: 'a', uuid: 'b' }] },
    { success: true, unchanged: true },
  ]) {
    const decoded = await readHistoryThroughIpc(async (_channel, payload) => {
      assert.equal(payload.readTransport, 'v8-1');
      return { __notedHistoryTransport: 'v8-1', data: new Uint8Array(serialize(result)) };
    }, 'agent-transcript:get-history', { toolType: 'codex' });
    assert.deepEqual(decoded, result);
  }
});

test('legacy main and non-Electron/non-Codex clients retain object transport', async t => {
  const previous = globalThis.window; t.after(() => { globalThis.window = previous; });
  globalThis.window = undefined;
  const expected = { success: true, entries: [] };
  assert.equal(await readHistoryThroughIpc(async (_c, p) => { assert.equal(p.readTransport, undefined); return expected; },
    'agent-transcript:get-history', { toolType: 'codex' }), expected);
  globalThis.window = { require };
  assert.equal(await readHistoryThroughIpc(async () => expected, 'agent-transcript:get-history', { toolType: 'codex' }), expected);
  assert.equal(await readHistoryThroughIpc(async (_c, p) => { assert.equal(p.readTransport, undefined); return expected; },
    'claude:get-full-history', { toolType: 'claude' }), expected);
});
