import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const cancelled = error => error?.code === 'HISTORY_READ_CANCELLED' && error.name === 'AbortError';

test('D01 pre-aborted consumer issues neither read nor cancel', async () => {
  const controller = new AbortController(); controller.abort();
  const calls = [];
  await assert.rejects(readHistoryThroughIpc((...args) => { calls.push(args); },
    'agent-transcript:get-history', { toolType: 'codex' }, { signal: controller.signal }), cancelled);
  assert.deepEqual(calls, []);
});

test('D02 A abort releases only A; B with identical source keeps exact result', async () => {
  const a = new AbortController(), b = new AbortController(), calls = [], requests = [];
  const invoke = (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === 'agent-transcript:cancel-read') return Promise.resolve({ cancelled: true });
    const request = deferred(); requests.push(request); return request.promise;
  };
  const payload = { toolType: 'codex', tabId: 't', sessionId: 's' };
  const pa = readHistoryThroughIpc(invoke, 'agent-transcript:get-history', payload, { signal: a.signal });
  const pb = readHistoryThroughIpc(invoke, 'agent-transcript:get-history', payload, { signal: b.signal });
  const rejected = assert.rejects(pa, cancelled); a.abort(); await rejected;
  const ids = calls.slice(0, 2).map(call => call.payload.readDemandId);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(calls[2], { channel: 'agent-transcript:cancel-read', payload: { readDemandId: ids[0] } });
  const result = { success: true, entries: [{ uuid: 'all-content', content: 'x'.repeat(1024) }] };
  requests[1].resolve(result); assert.equal(await pb, result);
  // A's transport may finish after local release. Neither data nor V8 envelope
  // getters can be inspected by the abandoned consumer.
  requests[0].resolve(Object.defineProperty({}, '__notedHistoryTransport', { get() { throw Error('late decode'); } }));
  await tick(); b.abort(); assert.equal(calls.length, 3);
});

test('D03 response/abort same-turn race never decodes a released result', async () => {
  const controller = new AbortController(); let touched = 0;
  const result = Object.defineProperty({}, '__notedHistoryTransport', { get() { touched++; return 'invalid'; } });
  const invoke = channel => {
    if (channel === 'agent-transcript:cancel-read') return { cancelled: true };
    queueMicrotask(() => controller.abort()); return Promise.resolve(result);
  };
  await assert.rejects(readHistoryThroughIpc(invoke, 'agent-transcript:get-history', {}, { signal: controller.signal }), cancelled);
  assert.equal(touched, 0);
});

test('D04 synchronous admission abort plus throw is observed; no blind read retry', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(readHistoryThroughIpc(() => { calls++; controller.abort(); throw Error('admission failed'); },
    'agent-transcript:get-history', {}, { signal: controller.signal }), /admission failed/);
  await tick(); assert.equal(calls, 1);
});

test('D05 lost cancel ACK still releases local consumer and does not retry admission', async () => {
  const controller = new AbortController(), waiting = deferred(), calls = [];
  const invoke = (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === 'agent-transcript:cancel-read') return Promise.reject(Error('Main disconnected'));
    return waiting.promise;
  };
  const request = readHistoryThroughIpc(invoke, 'history:get-tool-payload', { payloadId: 'p' }, { signal: controller.signal });
  const check = assert.rejects(request, cancelled); controller.abort(); await check;
  waiting.reject(Error('late original transport error')); await tick(); assert.equal(calls.length, 2);
});

test('D06 actual useRehydratedPayload cleanup cancels, reopen retries, late A cannot overwrite B', async () => {
  const source = await readFile(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const useRehydratedPayload = (');
  const end = source.indexOf('\nconst HistoryToolCallPart =', start);
  assert.ok(start >= 0 && end > start);
  // Execute the complete actual hook body. Only React scheduler/hooks and IPC
  // transport delivery are substituted; this is not React/Electron acceptance.
  const code = stripTypeScriptTypes(source.slice(start, end) + '\nglobalThis.hook = useRehydratedPayload;');
  const context = { tabId: 'tab', toolType: 'codex', sessionId: 'session', cwd: '/own', payloadGeneration: 'g1' };
  const cache = new Map(), calls = [], pending = [];
  let hookRef, effect, forces = 0;
  const sandbox = {
    AbortController,
    React: { useContext: () => context, useReducer: () => [0, () => forces++] },
    HistoryPayloadContext: {},
    useRef: value => hookRef || (hookRef = { current: value }),
    useEffect: fn => { effect = fn; },
    historyPayloadCacheKey: (owner, ref) => [owner.sessionId, owner.payloadGeneration, ref.payloadId].join(':'),
    rehydratedPayloadCache: cache,
    rememberRehydratedPayload: (key, text) => cache.set(key, text),
    readHistoryThroughIpc,
    ipcRenderer: { invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel === 'agent-transcript:cancel-read') return Promise.resolve({ cancelled: true });
      const d = deferred(); pending.push(d); return d.promise;
    } },
  };
  vm.createContext(sandbox); vm.runInContext(code, sandbox);
  const ref = { payloadId: 'p1', totalChars: 4 };
  sandbox.hook('preview', ref, true); const releaseA = effect();
  assert.equal(hookRef.current.pending, true); releaseA();
  assert.equal(hookRef.current.pending, false);
  sandbox.hook('preview', ref, true); const releaseB = effect();
  assert.equal(pending.length, 2);
  assert.equal(calls[1].channel, 'agent-transcript:cancel-read');
  assert.equal(calls[1].payload.readDemandId, calls[0].payload.readDemandId);
  assert.notEqual(calls[2].payload.readDemandId, calls[0].payload.readDemandId);
  pending[1].resolve({ success: true, payload: 'BBBB', totalChars: 4 }); await tick();
  pending[0].resolve({ success: true, payload: 'AAAA', totalChars: 4 }); await tick();
  assert.equal(cache.get('session:g1:p1'), 'BBBB');
  assert.equal(hookRef.current.pending, false); assert.equal(hookRef.current.failed, false);
  releaseB(); assert.equal(calls.length, 3); assert.ok(forces >= 3);
});

test('D07 actual Timeline preview effect forwards signal and cancels on collapse', async () => {
  const source = await readFile(new URL('../components/Workspace/TimelineEntryPreview.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  useEffect(() => {\n    if (!expanded || !preview?.truncated || group) return;');
  const end = source.indexOf('\n\n  const answer =', start);
  assert.ok(start >= 0 && end > start);
  const waiting = deferred(); let callback, signal, applied = 0;
  const sandbox = { AbortController, expanded: true, preview: { truncated: true }, group: null,
    descriptorKey: 'descriptor', setFullResponse: value => { if (value) applied++; },
    props: { loadResponse(_preview, received) { signal = received; return waiting.promise; } },
    useEffect: fn => { callback = fn; },
  };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  const release = callback(); assert.equal(signal.aborted, false); release(); assert.equal(signal.aborted, true);
  waiting.resolve('full exact response'); await tick(); assert.equal(applied, 0);
});

test('D08 actual HistoryPanel flight and owner cleanup: same-owner join; A release; B survives late A finally', async () => {
  const source = await readFile(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const loadStart = source.indexOf('  const loadHistory = useCallback((isRefresh = false): Promise<boolean> => {');
  const loadEnd = source.indexOf('\n  // Callers defined ABOVE', loadStart);
  const cleanupEnd = source.indexOf('\n  }, [historyOwnerKey, historySnapshotOwner, fileRewriteEpoch, loadHistory,');
  const cleanupStart = source.lastIndexOf('    return () => {', cleanupEnd);
  assert.ok(loadStart >= 0 && loadEnd > loadStart && cleanupStart >= 0 && cleanupEnd > cleanupStart);
  const cleanupText = source.slice(cleanupStart, cleanupEnd).trim();
  assert.ok(cleanupText.endsWith('};'));
  const calls = [], pending = [];
  const invoke = (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === 'agent-transcript:cancel-read') return { cancelled: true };
    const d = deferred(); pending.push(d); return d.promise;
  };
  const sandbox = {
    AbortController, Promise, Date, useCallback: fn => fn,
    sessionId: 'session', tabId: 'tab', toolType: 'codex', historyOwnerKey: 'A',
    historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 1 },
    historyLoadFlightRef: { current: null }, historyDiag() {},
    deferredWarmRefreshCancelRef: { current: null },
    viewportPaintProbeRef: { current: { cancel() {} } },
    surfacePresentedProbeRef: { current: { cancel() {} } }, viewportPaintOwner: {},
    persistVolatileOverlay() {}, historySnapshotOwner: {},
    presentationEntriesRef: { current: [] }, promptHandoffMetaRef: { current: new Map() },
    suppressedPromptsRef: { current: new Map() }, generation: 1,
    historyOwnerDigest: key => key, ownerStartedAt: Date.now(),
    async runHistoryLoad(_refresh, signal) {
      try {
        await readHistoryThroughIpc(invoke, 'agent-transcript:get-history', {
          toolType: 'codex', sessionId: 'session', tabId: sandbox.historyOwnerKey,
        }, { signal });
        return true;
      } catch (error) { if (cancelled(error)) return false; throw error; }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(stripTypeScriptTypes(source.slice(loadStart, loadEnd)
    + '\nglobalThis.load = loadHistory;\nglobalThis.cleanup = '
    + cleanupText.slice('return '.length) + ';'), sandbox);
  const pa = sandbox.load(false);
  assert.equal(sandbox.load(false), pa);
  sandbox.cleanup();
  assert.equal(sandbox.historyOwnerGenerationRef.current, 2);
  sandbox.historyOwnerKey = 'B'; sandbox.historyOwnerKeyRef.current = 'B';
  const pb = sandbox.load(false), bFlight = sandbox.historyLoadFlightRef.current;
  assert.equal(await pa, false); assert.equal(sandbox.historyLoadFlightRef.current, bFlight);
  pending[0].resolve({ success: true, entries: [{ uuid: 'old' }] }); await tick();
  assert.equal(sandbox.historyLoadFlightRef.current, bFlight);
  pending[1].resolve({ success: true, entries: [{ uuid: 'new' }] });
  assert.equal(await pb, true); assert.equal(sandbox.historyLoadFlightRef.current, null);
  assert.equal(calls.filter(call => call.channel === 'agent-transcript:cancel-read').length, 1);
});

test('D09 renderer module boot2 cannot reuse boot1 demand under identical clock/counter', async t => {
  const beforeNow = Date.now, beforeCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let boot = 0;
  Date.now = () => 1;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => 'boot-' + (++boot) } });
  t.after(() => {
    Date.now = beforeNow;
    if (beforeCrypto) Object.defineProperty(globalThis, 'crypto', beforeCrypto); else delete globalThis.crypto;
  });
  const first = await import('./historyReadTransport.mjs?demand-test-boot=1');
  const second = await import('./historyReadTransport.mjs?demand-test-boot=2');
  const ids = [];
  const invoke = async (_channel, payload) => { ids.push(payload.readDemandId); return { success: true }; };
  await first.readHistoryThroughIpc(invoke, 'agent-transcript:get-history', {});
  await second.readHistoryThroughIpc(invoke, 'agent-transcript:get-history', {});
  assert.notEqual(ids[0], ids[1]);
});
