// Runs the REAL comparison function that now gates local-prompt republication
// (sliced out of HistoryPanel.tsx and compiled with esbuild), then replays the
// exact status sequences captured in production.log.
//
// Why this exists: one Send publishes the same row many times. In the
// 31.10 log, handoff `project-send:e5ba5ada` produced 15 LOCAL_APPEND events
// and `sending` alone repeated 6 times for one handoff; 38 of 124 events
// (31%) carried a status the row already had. Every repeat returned a NEW
// array from setEntries, so all History subscribers re-rendered and the
// grouping memo was re-entered inside the same task — the 77-134ms long tasks
// the user reported as "scroll lags a couple of seconds after pressing Enter".
//
// The gate must suppress ONLY no-op republications. Dropping a real
// transition would freeze a card on `sending` forever, so the sequences below
// are the real ones, and each asserts the surviving transition count.
//
// Run: node --experimental-strip-types --test \
//   src/renderer/components/Workspace/historyLocalAppendIdempotence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const require = createRequire(resolve(REPO, 'package.json'));
const { transformSync } = require('esbuild');

const sourcePath = process.env.NOTED_TEST_HISTORY_SOURCE || resolve(HERE, 'HistoryPanel.tsx');
const source = readFileSync(sourcePath, 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

// ---- slice the real comparison chain out of the panel ----------------------
const from = source.indexOf('const historyEntryPresentationEqual = ');
assert.ok(from > 0, 'historyEntryPresentationEqual must exist');
const to = source.indexOf('const retainStableHistoryEntryReferences', from);
assert.ok(to > from, 'comparison function must be sliceable');
const code = transformSync(source.slice(from, to), { loader: 'ts' }).code;

// Collaborators the sliced function calls. These are deliberately simple:
// the test pins the STATUS/field chain, and the chip/image helpers have their
// own callers elsewhere. Each one still distinguishes different inputs, so a
// real change in those fields is never silently reported as equal.
const sandbox = {
  recordTimes: { historyRecordTimeEqual: (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) },
  historySourceIdentityAliasesEqual: (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null),
  haveSameComposerChips: (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []),
  haveSamePromptImageRefs: (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []),
  historyActionPresentationEqual: (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null),
  module: { exports: {} },
};
vm.createContext(sandbox);
vm.runInContext(code + '\nmodule.exports = historyEntryPresentationEqual;', sandbox);
const presentationEqual = sandbox.module.exports;
assert.equal(typeof presentationEqual, 'function');

// ---- the gate itself, sliced out of the updater ---------------------------
// Not a hand-written mirror: the real `if (...) return prev;` text is cut from
// the panel and executed. A mirror would keep passing if the gate were
// disabled in the source, which is exactly the weakness this file exists to
// avoid (see the sibling historyMountWaveDrain.test.cjs header).
const gateFrom = source.indexOf('// One send publishes the same row many times');
assert.ok(gateFrom > 0, 'the gate must carry its explanatory comment');
const gateTo = source.indexOf('if (!publishHistoryRows(nextEntries', gateFrom);
assert.ok(gateTo > gateFrom, 'the gate must sit directly before publishHistoryRows');
const gateCode = transformSync(
  `export const gate = (prev, nextEntries, existingIndex, historyEntryPresentationEqual) => {
     ${source.slice(gateFrom, gateTo)}
     return nextEntries;
   };`, { loader: 'ts' }).code;
const gateSandbox = { module: { exports: {} }, exports: {} };
vm.createContext(gateSandbox);
vm.runInContext(gateCode.replace('export const gate =', 'module.exports.gate ='), gateSandbox);
const gate = gateSandbox.module.exports.gate;
assert.equal(typeof gate, 'function', 'gate must compile');

function publishLocalAppend(prev, next, existingIndex) {
  const result = gate(prev, next, existingIndex, presentationEqual);
  return { entries: result, published: result !== prev };
}

const row = (overrides = {}) => ({
  uuid: 'u1', role: 'queued', timestamp: '2026-10-31T18:09:46.011Z', recordTime: null,
  content: 'продолжай работу далее', queueStatus: 'preparing', handoffId: 'h1',
  statusAtSend: 'unknown', statusChangedAt: 1000, actions: [], ...overrides,
});

// Replays one handoff: each event rebuilds the row from the incoming status,
// exactly as the updater's prev.map does, then goes through the gate.
function replay(statuses, { changedAtPerEvent = false } = {}) {
  let entries = [row({ queueStatus: statuses[0] })];
  let published = 0;
  statuses.slice(1).forEach((queueStatus, index) => {
    const next = entries.map(candidate => ({
      ...candidate, queueStatus,
      ...(changedAtPerEvent ? { statusChangedAt: 2000 + index } : {}),
    }));
    const result = publishLocalAppend(entries, next, 0);
    entries = result.entries;
    if (result.published) published++;
  });
  return { published, final: entries[0].queueStatus };
}

test('source: the gate is wired into the local-append updater', () => {
  const marker = source.indexOf('historyEntryPresentationEqual(prev[existingIndex], nextEntries[existingIndex])');
  assert.ok(marker > 0, 'local append must compare the republished row before publishing');
  const window = squash(source.slice(marker - 900, marker + 700));
  assert.match(window, /return prev;/, 'an equal republication must return the previous array');
  assert.match(window, /publishHistoryRows\(nextEntries/, 'a changed row must still reach publishHistoryRows');
  // Identity guards must stay AHEAD of the cheap comparison: a foreign owner is
  // rejected regardless of how the row looks.
  const ownerGuard = source.lastIndexOf('getLocalPromptMetaOwner(promptHandoffMetaRef.current.get(handoffId)) !== localOwner', marker);
  assert.ok(ownerGuard > 0 && ownerGuard < marker, 'owner identity guard must precede the equality gate');
});

test('real sequence project-send:e5ba5ada — repeats suppressed, transitions kept', () => {
  // Captured 31.10 18:09:46-18:10:20 UTC: 15 events, 5 distinct statuses.
  const statuses = ['application-queued', 'sending', 'sending', 'preparing', 'sending', 'sending',
    'sending', 'audit-pending', 'queued', 'queued', 'sent', 'sent', 'sent', 'sent', 'sent'];
  const { published, final } = replay(statuses);
  assert.equal(final, 'sent', 'the card must end on the status the provider reported');
  // 14 republications after the first event. Distinct transitions:
  // →sending →preparing →sending →audit-pending →queued →sent = 6.
  // The other 8 repeat a status the row already carries and are suppressed.
  assert.equal(published, 6, 'exactly the real transitions publish');
});

test('real sequence run-after-pq — delivery-unknown is a transition, not a repeat', () => {
  const statuses = ['preparing', 'preparing', 'application-queued', 'sending', 'sending',
    'preparing', 'delivery-unknown', 'sending'];
  const { published, final } = replay(statuses);
  assert.equal(final, 'sending');
  assert.equal(published, 5, 'delivery-unknown must survive the gate');
});

test('a repeat that carries a NEW statusChangedAt still publishes', () => {
  // The same status with a new change timestamp is a real update: the card
  // shows elapsed time from it. Suppressing it would freeze that readout.
  const { published } = replay(['sending', 'sending', 'sending'], { changedAtPerEvent: true });
  assert.equal(published, 2, 'a changed timestamp is not a no-op');
});

test('mutation control: without the gate every repeat publishes', () => {
  const statuses = ['sending', 'sending', 'sending', 'sending'];
  let entries = [row({ queueStatus: 'sending' })];
  let published = 0;
  for (let index = 1; index < statuses.length; index++) {
    entries = entries.map(candidate => ({ ...candidate, queueStatus: statuses[index] }));
    published++; // no gate
  }
  assert.equal(published, 3, 'control: ungated republication count');
  assert.equal(replay(statuses).published, 0, 'gated: the same input publishes nothing');
});

test('fields that must never be swallowed', () => {
  const base = row({ queueStatus: 'sending' });
  const changes = {
    applicationQueuePosition: 3,
    applicationQueueId: 'q-9',
    sendAttemptId: 'attempt-2',
    statusReason: 'provider-busy',
    deliveryStatus: 'confirmed',
    auditHash: 'abc123',
    sourceIdentity: 'claude:019ff',
    recordByteOffset: 4096,
    sessionId: '30ea154d',
    content: 'отредактированный текст',
    promptChips: [{ id: 'c1' }],
    imagePaths: [{ id: 'i1' }],
    semanticTags: ['plan'],
  };
  for (const [field, value] of Object.entries(changes)) {
    const next = [{ ...base, [field]: value }];
    const result = publishLocalAppend([base], next, 0);
    assert.equal(result.published, true, `a change in ${field} must publish`);
  }
  // And the no-op case, with a fresh object identity (the updater always
  // rebuilds the row, so reference equality alone would never fire).
  const unchanged = publishLocalAppend([base], [{ ...base }], 0);
  assert.equal(unchanged.published, false, 'an identical rebuild must not publish');
});

test('a first append (no existing row) always publishes', () => {
  const prev = [];
  const next = [row({ queueStatus: 'preparing' })];
  assert.equal(publishLocalAppend(prev, next, -1).published, true);
});

test('a reordered queue publishes even when every row is equal', () => {
  const a = row({ uuid: 'a', handoffId: 'ha', queueStatus: 'application-queued' });
  const b = row({ uuid: 'b', handoffId: 'hb', queueStatus: 'application-queued' });
  const result = publishLocalAppend([a, b], [b, a], 0);
  assert.equal(result.published, true, 'queue reordering changes presentation order');
});
