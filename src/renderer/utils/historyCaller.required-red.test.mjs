// Required negative controls, expected to stay RED until the actual caller
// return/retention contract changes. These are NOT skipped/todo or OOM probes.
// The invoked IPC server is substituted; actual renderer helper/hook is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('REQUIRED-RED C01 full positional Promise caller has no three-row resident bound', async () => {
  const observed = [];
  for (const count of [1, 10, 100]) {
    const result = await readHistoryThroughIpc(async () => ({ success: true,
      entries: Array.from({ length: count }, (_, i) => ({ uuid: 'u' + i, content: 'x'.repeat(64) })),
    }), 'agent-transcript:get-history', { toolType: 'codex', dehydrate: true });
    // Incremental oracle: no second complete entries/ID graph is retained.
    const expected = createHash('sha256'), actual = createHash('sha256');
    for (let i = 0; i < count; i++) expected.update('u' + i + '\n');
    for (const row of result.entries) actual.update(row.uuid + '\n');
    assert.equal(actual.digest('hex'), expected.digest('hex'));
    observed.push({ records: count, residentRows: result.entries.length });
  }
  console.log('[CallerBound] ' + JSON.stringify({ case: 'C01', observed, requiredResidentRows: 3 }));
  assert.ok(observed.every(value => value.residentRows <= 3),
    'actual Promise result remains the complete positional array; three-row bounded caller migration is unfinished');
});

test('REQUIRED-RED C02 actual payload hook owns one whole selected field after read', async () => {
  const source = await readFile(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const useRehydratedPayload = (');
  const end = source.indexOf('\nconst HistoryToolCallPart =', start);
  assert.ok(start >= 0 && end > start);
  const code = stripTypeScriptTypes(source.slice(start, end) + '\nglobalThis.hook = useRehydratedPayload;');
  const observed = [];
  for (const bytes of [1024, 16 * 1024, 256 * 1024]) {
    const cache = new Map(); let ref, effect;
    const context = { toolType: 'codex', sessionId: 's', payloadGeneration: 'g' };
    const sandbox = { AbortController,
      React: { useContext: () => context, useReducer: () => [0, () => {}] }, HistoryPayloadContext: {},
      useRef: value => ref || (ref = { current: value }), useEffect: fn => { effect = fn; },
      historyPayloadCacheKey: () => 'exact-g-p', rehydratedPayloadCache: cache,
      rememberRehydratedPayload: (key, text) => cache.set(key, text), readHistoryThroughIpc,
      ipcRenderer: { async invoke(channel) {
        assert.equal(channel, 'history:get-tool-payload');
        return { success: true, payload: 'x'.repeat(bytes), totalChars: bytes };
      } },
    };
    vm.createContext(sandbox); vm.runInContext(code, sandbox);
    sandbox.hook('preview', { payloadId: 'p', totalChars: bytes }, true); const release = effect();
    await tick(); const text = cache.get('exact-g-p'); assert.equal(text.length, bytes);
    const expected = createHash('sha256'), block = Buffer.alloc(1024, 120);
    for (let offset = 0; offset < bytes; offset += block.length) expected.update(block);
    assert.equal(createHash('sha256').update(text).digest('hex'), expected.digest('hex'));
    observed.push({ leafBytes: bytes, retainedBytes: Buffer.byteLength(text) }); release();
  }
  console.log('[CallerBound] ' + JSON.stringify({ case: 'C02', observed, requiredResidentFieldBytes: 3 * 1024 }));
  assert.ok(observed.every(value => value.retainedBytes <= 3 * 1024),
    'actual CBToolCallPart/Think/compact String consumer plus payload cache has no bounded field viewport yet');
});
