// SOURCE regression: full current-payload witness work must not scale with
// historical field/chunk guards. Actual owner/model/client/producer run with
// synthetic rows, private Node SQLite and in-process IPC; this is not timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { HistoryPrimaryRootReadModel, historyPrimaryLiveClaimFingerprint } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryPrimaryLiveCoverageOwner } from '../src/renderer/utils/historyPrimaryLiveCoverageOwner.mjs';
import { readHistoryThroughIpc } from '../src/renderer/utils/historyReadTransport.mjs';
const require = createRequire(import.meta.url), crypto = require('node:crypto');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
let hashes = 0, payloadVisits = 0;
const countedCrypto = { ...crypto, createHash(...args) {
  hashes += 1;
  const hash = crypto.createHash(...args), update = hash.update.bind(hash);
  hash.update = (value, ...options) => {
    // This finite fixture has exactly one 1024-character x payload. Canonical
    // signed-text integrity hashes are necessary and must not be counted as
    // rereading that current live payload.
    if (value instanceof Uint8Array && value.length === 2048
      && value[0] === 120 && value[1] === 0 && value[2046] === 120 && value[2047] === 0) payloadVisits += 1;
    return update(value, ...options);
  };
  return hash;
} };
globalThis.window = { require: name => name === 'node:crypto' ? countedCrypto : require(name) };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

test('full live witness work stays bounded across historical row/chunk guards', async () => {
  const results = [];
  for (const count of [0, 1, 4, 8]) {
    const entries = Array.from({ length: count }, (_, i) => ({ role: 'assistant', uuid: 'canonical-' + i,
      sourceIdentity: 'source-' + i, sessionId: 's', content: 'complete canonical text' }));
    const fixture = await createPrimaryAddressFixture(null, { entries });
    const model = new HistoryPrimaryRootReadModel((channel, payload) => channel === 'agent-transcript:cancel-read'
      ? { success: true } : fixture.invoke(channel, payload), { ...fixture.transport, readHistoryThroughIpc });
    model.windowDiagnostic = () => {};
    let owner;
    try {
      await model.open({ ...fixture.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
        grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] } });
      const item = { role: 'assistant', uuid: 'live-only', sourceIdentity: 'missing', sessionId: 's', content: 'x'.repeat(1024) };
      let fold = { ownerKey: 'owner', entries: [item] }, calls = 0;
      const errors = [], commit = { root: model, dataSubject: model.getReceiptDataSubject(), ownerKey: 'owner', generation: 1 };
      const liveCommit = { ...commit, live: fold, entries: fold.entries, fingerprints: fold.entries.map(historyPrimaryLiveClaimFingerprint) };
      owner = createHistoryPrimaryLiveCoverageOwner({
        readCurrent: () => ({ root: model, live: fold, ownerKey: 'owner', generation: 1, commit, liveCommit }),
        fingerprint: value => { calls += 1; return historyPrimaryLiveClaimFingerprint(value); },
        publish: remaining => { if (remaining !== fold.entries) fold = { ownerKey: 'owner', entries: remaining }; return fold; },
        onError: error => errors.push(error),
      });
      hashes = 0; payloadVisits = 0;
      assert.equal(await owner.readUnmatched('owner'), true);
      assert.deepEqual(errors, []); assert.deepEqual(fold.entries, [item]);
      assert(calls <= 32, 'owner full payload witness work grew with historical guards: ' + calls);
      assert(payloadVisits > 0, 'payload instrumentation positive control');
      assert(payloadVisits <= 16, 'model/owner full live payload visits grew with historical guards: ' + payloadVisits);
      results.push({ canonicalRows: count, liveClaims: 1, contentUTF16: item.content.length,
        ownerFingerprints: calls, payloadVisits, allDigestsIncludingHistoricalIntegrity: hashes });
    } finally { owner?.dispose(); await model.close(); fixture.close(); }
  }
  console.log('LIVE_HASH_COST_BOUND ' + JSON.stringify({ node: process.version, results }));
});

test('final inherited live coercion cannot return proof after reentrant model cleanup', async () => {
  const fixture = await createPrimaryAddressFixture(null, { entries: [{ role: 'assistant', uuid: 'canonical',
    sessionId: 's', sourceIdentity: 'covered', content: 'finite complete body' }] });
  const model = new HistoryPrimaryRootReadModel((channel, payload) => channel === 'agent-transcript:cancel-read'
    ? { success: true } : fixture.invoke(channel, payload), { ...fixture.transport, readHistoryThroughIpc });
  model.windowDiagnostic = () => {};
  let cleanup, coercions = 0;
  try {
    await model.open({ ...fixture.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
      grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] } });
    const identity = [], prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, 'join', { value() {
      coercions += 1;
      if (coercions === 2) cleanup = model.close();
      return 'covered';
    } });
    Object.setPrototypeOf(identity, prototype);
    const entry = { role: 'assistant', uuid: 'live', sessionId: 's', sourceIdentity: identity, content: 'current' };
    entry.self = entry;
    await assert.rejects(model.readLiveIdentityCoverage([entry]), { code: 'HISTORY_READ_CANCELLED' });
    assert.equal(coercions, 2); assert.equal(model.closed, true); assert.equal(model.view, null);
  } finally { await cleanup; await model.close(); fixture.close(); }
});
