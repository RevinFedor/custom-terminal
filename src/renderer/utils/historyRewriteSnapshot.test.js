'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');
let api;
test.before(async () => {
  const built = await esbuild.build({ stdin: {
    contents: `export * from './historyRewriteSnapshot'; export * from './historySnapshotCache'; export * from './historyReadingAnchor';`,
    resolveDir: __dirname,
  }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const loaded = new Module(path.join(__dirname, 'rewrite-test.cjs'), module);
  loaded.filename = path.join(__dirname, 'rewrite-test.cjs');
  loaded._compile(built.outputFiles[0].text, loaded.filename);
  api = loaded.exports;
});
const receipt = { schema: 'codex-rewrite-prefix-v1', sourceSessionId: 'parent', sessionId: 'child', records: [
  { source: { __line: 1, __byteOffset: 150 }, target: { __line: 1, __byteOffset: 300 } },
] };
const old = () => ({ uuid: 'codex-assistant-parent-1', sourceIdentity: 'codex-assistant-source-parent-150',
  sessionId: 'parent', role: 'assistant', content: 'Read me', actions: [{ tool: '__raw__', rawTool: { toolUseId: 'call:0', args: { command: 'pwd' }, result: 'ok' } }] });
const next = () => ({ ...old(), uuid: 'codex-assistant-child-1', sessionId: 'child', sourceIdentity: 'codex-assistant-source-child-300' });

test('retained row gets new physical addresses and keeps equal tools by reference', () => {
  const before = old();
  const result = api.reuseHistoryRewriteRows([before], [next()], receipt);
  assert.equal(result.entries[0].actions, before.actions);
  assert.equal(result.entries[0].sessionId, 'child');
  assert.equal(result.entries[0].rewriteRenderKey, 'source:codex-assistant-source-parent-150');
  assert.equal(before.sessionId, 'parent');
  assert.ok(result.unchanged.has(next().uuid));
  const refreshed = api.carryHistoryRewriteRenderKeys(result.entries, [next()]);
  assert.equal(refreshed[0].rewriteRenderKey, result.entries[0].rewriteRenderKey);
});

test('changed prefix dependency and removed rows never inherit painted-content proof', () => {
  const changed = { ...next(), content: 'different result' };
  const result = api.reuseHistoryRewriteRows([old()], [changed,
    { ...next(), uuid: 'codex-assistant-child-7' }], receipt);
  assert.equal(result.unchanged.size, 0);
  assert.equal(result.entries[1].rewriteRenderKey, undefined);
  assert.equal(result.entries[0].content, 'different result');
});

test('rewrite delta translates exact carried identities, preserves actions and rejects incomplete/forged orders', () => {
  const before = old();
  const result = { rewriteReceipt: receipt, order: [next().uuid], carriedEntries: [{ sourceUuid: before.uuid, uuid: next().uuid }], changedEntries: [] };
  const applied = api.applyHistoryRewriteDelta([before], result);
  assert.equal(applied.entries[0].actions, before.actions);
  assert.equal(applied.entries[0].sourceIdentity, next().sourceIdentity);
  assert.throws(() => api.applyHistoryRewriteDelta([before], { ...result, order: [] }), /incomplete_rewrite_delta_order/);
  assert.throws(() => api.applyHistoryRewriteDelta([before], { ...result, carriedEntries: [{ sourceUuid: before.uuid, uuid: 'other' }] }), /invalid_rewrite_delta_carry/);
});

test('inPlace file generation replaces positional identity; append and copy-on-write do not', () => {
  const before = { ownerKey: 'tab/session', value: 'disk:inode-A' };
  assert.equal(api.historyFileWasReplaced(before, 'tab/session', 'disk:inode-B'), true);
  assert.equal(api.historyFileWasReplaced(before, 'tab/session', 'disk:inode-A'), false);
  assert.equal(api.historyFileWasReplaced(before, 'tab/new-session', 'disk:inode-B'), false);
  assert.equal(api.historyFileWasReplaced({ ownerKey: 'tab/session', value: '' }, 'tab/session', 'disk:inode-B'), false);
  const ref = { payloadId: 'compact:physical-line-2' };
  const context = { toolType: 'codex', sessionId: 'same-session', payloadGeneration: 'disk:inode-A' };
  assert.notEqual(api.historyPayloadCacheKey(context, ref), api.historyPayloadCacheKey({ ...context, payloadGeneration: 'disk:inode-B' }, ref));
  assert.notEqual(api.historyPayloadCacheKey(context, { ...ref, recordLine: 1 }), api.historyPayloadCacheKey(context, { ...ref, recordLine: 9 }));
});


test('watcher physical identity is selected independently from the opaque payload generation', () => {
  const revision = { sources: [
    { sessionId: 'parent', filePath: '/parent', fileIdentity: '1:99', linkKind: 'jsonl' },
    { sessionId: 'child', filePath: '/child', fileIdentity: '1:2', linkKind: 'end' },
  ] };
  const ownerKey = 'tab/child';
  const physical = { ownerKey, value: api.historySnapshotFileIdentity(revision, 'child') };
  const generation = { ownerKey, value: '1:2:opaque-worker-epoch:3' };
  assert.equal(physical.value, '1:2');
  assert.equal(api.historyFileWasReplaced(physical, ownerKey, '1:2'), false, 'an append notification keeps the surface');
  assert.equal(api.historyFileWasReplaced(physical, ownerKey, '1:3'), true, 'atomic replacement still invalidates the physical document');
  assert.equal(api.historyFileWasReplaced(generation, ownerKey, '1:2:opaque-worker-epoch:4'), true, 'same-inode rewrite changes the content generation');
  assert.equal(api.historySnapshotFileIdentity(revision, 'missing'), '');
  assert.equal(api.historySnapshotFileIdentity(revision, 'child', '/foreign'), '');
  assert.equal(api.historySnapshotFileIdentity(null, 'child'), '');
  assert.equal(api.historySnapshotFileIdentity({ sources: [...revision.sources, revision.sources[1]] }, 'child'), '');
});

test('equal previews cannot prove a payload whose producer is outside the retained prefix', () => {
  const before = { ...old(), thinking: 'same preview', thinkingRef: { payloadId: 'thinking:codex-assistant-parent-1', totalChars: 20_000, recordLine: 7 } };
  const after = { ...next(), thinking: 'same preview', thinkingRef: { payloadId: 'thinking:codex-assistant-child-1', totalChars: 20_000, recordLine: 7 } };
  assert.equal(api.reuseHistoryRewriteRows([before], [after], receipt).unchanged.size, 0);
  assert.throws(() => api.applyHistoryRewriteDelta([before], {
    rewriteReceipt: receipt, order: [after.uuid], changedEntries: [], carriedEntries: [{ sourceUuid: before.uuid, uuid: after.uuid }],
  }), /checkpoint_coordinate_outside_prefix/);
});

async function prepare({ badReceipt = false, painted = true } = {}) {
  const tabId = 'rewrite-' + Math.random();
  const from = { tabId, toolType: 'codex', sessionId: 'parent', cwd: '/fixture' };
  const to = { ...from, sessionId: 'child' };
  const revision = { token: 'old-token', context: JSON.stringify({ rowWindowRequest: { centerUuid: null, radius: 20, alwaysHydrateTail: 5 } }) };
  api.historySnapshotCache.set(from, { entries: [old()], revision });
  const unregister = api.registerHistoryRewriteCapture(api.makeHistorySnapshotKey(from), () => ({
    listKey: 'physical-1', geometryTick: 2, painted,
    anchor: { uuid: old().uuid, offsetPx: 44, followBottom: false },
  }));
  const publish = await api.prepareHistoryRewriteSnapshot({ ...to, sourceSessionId: 'parent', invoke: async (_channel, request) => {
    assert.equal(request.rewriteFrom.revision.token, 'old-token');
    assert.equal(request.hydrate.centerUuid, old().uuid);
    return { success: true, entries: [next()], revision: { sessionId: 'child', cwd: '/fixture', token: 'new-token' },
      rewriteReceipt: badReceipt ? null : receipt };
  } });
  return { from, to, publish, unregister };
}

test('CAS preparation does not publish; commit preserves the exact visible reader', async () => {
  const f = await prepare();
  try {
    assert.equal(api.historySnapshotCache.peek(f.to), undefined);
    assert.equal(f.publish(), true);
    const snapshot = api.historySnapshotCache.peek(f.to);
    assert.equal(snapshot.rewrite.listKey, 'physical-1');
    assert.equal(snapshot.rewrite.anchorPreserved, true);
    assert.equal(api.getHistoryReadingAnchor(f.to.tabId + ':child').offsetPx, 44);
  } finally { f.unregister(); }
});

test('hidden owner retains physical list but must prove paint when shown', async () => {
  const f = await prepare({ painted: false });
  try { assert.ok(f.publish()); assert.equal(api.historySnapshotCache.peek(f.to).rewrite.anchorPreserved, false); }
  finally { f.unregister(); }
});

test('late response cannot replace a newer source window; missing receipt stays cold', async () => {
  const f = await prepare();
  try {
    api.historySnapshotCache.set(f.from, { entries: [old()], revision: 'newer' });
    assert.equal(f.publish(), false);
    assert.equal(api.historySnapshotCache.peek(f.to), undefined);
  } finally { f.unregister(); }
  const invalid = await prepare({ badReceipt: true });
  assert.equal(invalid.publish, null);
  invalid.unregister();
});
