'use strict';

// Finite SOURCE fixture. Its only substitution is the already parsed canonical
// input and the in-process IPC bridge. Preparation/live/local/grouping, SQLite
// pages, independent leases, read-plane and shared client are actual functions.
// It neither reads a user's rollout nor starts Electron/provider/DB services.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..'), MAIN = path.join(ROOT, 'src/main/history-root-engine/main');
const { HistoryPagedStore } = require(path.join(MAIN, 'history-paged-store'));
const { HistoryProjectionArena } = require(path.join(MAIN, 'history-projection-arena'));
const { forkFrozenCanonical } = require(path.join(MAIN, 'history-frozen-canonical'));
const { createPrimaryHistoryPresentation } = require(path.join(MAIN, 'history-primary-presentation'));
const { forkPrimaryHistoryView } = require(path.join(MAIN, 'history-primary-semantic-bundle'));
const { HistoryRootReadPlane } = require(path.join(MAIN, 'history-root-read-plane'));

async function createPrimaryAddressFixture(t, { entries = [], sessionId = 's', cwd = '/finite', tabId = 't', service = {},
  Database = require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER || './history-node-sqlite.cjs') } = {}) {
  const shared = await import(pathToFileURL(path.join(ROOT, 'src/shared/history-root-read-client.mjs')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-primary-address-v46-'));
  const store = new HistoryPagedStore({ filename: path.join(directory, 'pages.sqlite'), Database,
    pageBytes: 1024, residentPages: 3, indexBytes: 2048, sqlCacheKiB: 8, diskBytes: 28 * 1024 ** 2 });
  const sources = [], calls = [], errors = [], consumerKey = 'finite-address-fixture';
  let source, generation = 0, closed = false, activeSignal = null;
  const publish = value => {
    const arena = new HistoryProjectionArena(store);
    try { return arena.step(() => arena.publish(value)); } finally { arena.close(); }
  };
  const setEntries = next => {
    const root = publish(next), metadata = publish({ sessionId, cwd });
    let released = false;
    const raw = { success: true, representation: 'codex-canonical-root-v1', root, entries: root.cursor(),
      sessionMeta: metadata.cursor(), mode: generation ? 'append' : 'rebuild', readMetrics: { canonicalRows: next.length },
      sourceSnapshot: { filePath: '/finite/rollout.jsonl', sessionId, size: ++generation, mtimeMs: generation,
        ctimeMs: generation, fileIdentity: 'finite:1', sourceGeneration: 'generation-' + generation, linkKind: 'end' },
      release() { if (released) return; released = true; root.release(); metadata.release(); } };
    try { source = forkFrozenCanonical(store, raw); sources.push(source); } finally { raw.release(); }
    return source;
  };
  setEntries(entries);
  const plane = new HistoryRootReadPlane({ store,
    projectHistory: async () => forkFrozenCanonical(store, source),
    prepareResult: async (raw, payload, control) => {
      const input = payload.primaryPresentation || {};
      const primary = await createPrimaryHistoryPresentation(store, raw, { service, control, payload: { ...payload,
        localEntries: input.localEntries ?? payload.localEntries ?? [], liveEntries: input.liveEntries ?? payload.liveEntries ?? [],
        liveToolResults: input.liveToolResults ?? payload.liveToolResults ?? [], rewindPreview: input.rewindPreview ?? payload.rewindPreview ?? null,
        grouping: input.grouping ?? payload.grouping, captionSelections: input.captionSelections ?? payload.captionSelections ?? [],
        settingsPresentationKeys: input.settingsPresentationKeys ?? payload.settingsPresentationKeys ?? [] } });
      let released = false;
      return { ...raw, root: primary.root, entries: primary.headerCursor, primaryPresentation: primary,
        readProfile: 'history-primary-v1', canonicalEntryCount: primary.canonicalEntryCount,
        semanticSnapshotComplete: true, semanticRevisionToken: primary.semanticRevisionToken, viewRevisionToken: primary.viewRevisionToken,
        release() { if (released) return; released = true; try { primary.close(); } finally { raw.release(); } } };
    },
    forkPrimaryResult: (parent, payload, control) => forkPrimaryHistoryView(store, parent, { service, payload, control }),
  });
  const makeControl = signal => {
    const assertCurrent = () => { if (signal?.aborted) throw Object.assign(new Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' }); };
    return { signal, assertCurrent,
      async checkpoint() { assertCurrent(); await new Promise(resolve => setImmediate(resolve)); assertCurrent(); } };
  };
  const invoke = async (channel, payload) => {
    const control = makeControl(activeSignal), options = { consumerKey, control };
    calls.push({ channel, kind: payload?.kind, mode: payload?.mode, offset: payload?.offset, leaseId: payload?.leaseId });
    try {
      if (channel === 'agent-transcript:get-history') return await plane.open(payload, options);
      if (channel === 'agent-transcript:read-page') return await plane.readPage(payload, options);
      if (channel === 'agent-transcript:fork-read-leaf') return payload.encoding === 'history-entry-body-borrow-v1'
        ? plane.forkBodyBorrow(payload, options)
        : payload.encoding === 'history-primary-prepared-presentation-v1'
        ? await plane.forkPreparedPresentation(payload, options)
        : payload.encoding === 'history-display-unit-v8-v1'
        ? await plane.forkViewUnit(payload, options)
        : payload.encoding === 'history-canonical-consumer-text-v1'
          ? await plane.forkCanonicalConsumerValue(payload, options) : plane.forkLeaf(payload, options);
      if (channel === 'agent-transcript:release-read-root') return plane.release(payload, { consumerKey });
      throw Object.assign(new Error('TEST_UNEXPECTED_MUTATION_CHANNEL'), { code: 'TEST_UNEXPECTED_MUTATION_CHANNEL' });
    } catch (error) { errors.push(error); return { success: false, error: error.code || 'TEST_SOURCE_ERROR',
      ...(Number.isSafeInteger(error.minimumCreditBytes) ? { minimumCreditBytes: error.minimumCreditBytes } : {}) }; }
  };
  const transport = {
    async openHistoryRootThroughIpc(fn, channel, payload, options = {}) {
      const result = await fn(channel, payload);
      if (!result?.success) return { kind: 'legacy', result };
      const header = shared.checkedHistoryRootOpenHeader(result, { sessionId: payload.sessionId });
      const reader = new shared.HistoryRootClient(fn, header.root, options);
      return { kind: 'root', header, root: header.root, reader };
    },
    async readHistoryThroughIpc(fn, channel, payload, { signal } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' });
      return fn(channel, payload);
    },
  };
  const payload = { toolType: 'codex', sessionId, cwd, tabId, readProfile: 'history-primary-v1', primaryRequestClass: 'source' };
  const open = options => transport.openHistoryRootThroughIpc(invoke, 'agent-transcript:get-history', { ...payload, ...options },
    { pageBytes: 65536, pageItems: 3 });
  const close = () => {
    if (closed) return; closed = true;
    let failed = false, primary;
    try {
      plane.close(); for (const held of sources) held.release();
      assert.equal(store.stats().leases, 0); assert.equal(store.stats().activeBuilders, 0);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n, 0);
      let complete = false;
      for (let n = 0; n < 100000; n++) if (store.collectStep(128).complete) { complete = true; break; }
      assert(complete, 'finite final collection');
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pages').get().n, 0);
      assert(store.stats().peakCachedPages <= 3); assert(store.stats().peakIndexBytes <= 2048);
    } catch (error) { failed = true; primary = error; }
    try { store.close(); }
    catch (error) {
      if (failed) {
        try { console.error('[HistoryPrimaryAddressFixture] store close failed after teardown error', error); } catch {}
      }
      else { failed = true; primary = error; }
    }
    // Keep both the original failure and the failed private database. Removing
    // that directory is only the successful-fixture path, after native close.
    if (failed) throw primary;
    fs.rmSync(directory, { recursive: true });
  };
  t?.after(close);
  return { store, plane, invoke, transport, open, payload, calls, errors, consumerKey, setEntries,
    get source() { return source; }, setSignal(signal) { activeSignal = signal; }, close };
}

module.exports = { createPrimaryAddressFixture };
