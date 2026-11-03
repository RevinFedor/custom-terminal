// A prompt sent into a busy tab was drawn TWICE for 57 seconds: the local
// SENT card and Claude's own row for the same message. Production 02.11,
// tab 16b18cfdeba5, handoff mvz5b8ea-gzs3aq:
//
//   10:58:23.642  QUEUE_CONSUMED  — the send is settled
//   10:58:23.808  the card reaches `sent`; Claude's row is not visible yet
//   10:59:20.309  deferred full reread
//   10:59:20.317  LOCAL_RETIRED_BY_CANONICAL  ← 57 seconds late
//
// The retirement check added on 01.11 lives in the handoff subscription, so
// it only runs when the CARD changes. By the time Claude writes its own row
// the card is already settled and nothing re-runs the check — the duplicate
// survived until the deferred reread, which is exactly the wait the 01.11
// fix was meant to remove.
//
// The repair runs the same check when live rows arrive. This suite pins the
// decision it makes; the production wiring is asserted at the bottom.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, '..', 'components', 'Workspace', 'HistoryPanel.tsx'), 'utf8');

const SESSION = '7a336e55-48a0-40dd-88e3-7ae18d102f3a';
const QUEUE_IDENTITY = 'claude-queue:offset:' + SESSION + ':12833824';
const CARRIER_UUID = '44c50d1e-26b2-42d4-8d65-d4b739824d96';

// Claude's own row, exactly as the live projection produced it for this
// prompt (verified by replaying the real reducer over the real transcript:
// the queued_command carrier inherits the queue row's sourceIdentity).
const canonicalRow = {
  uuid: CARRIER_UUID, role: 'user', queueStatus: 'sent', content: 'оке ищи',
  sessionId: SESSION, sourceIdentity: QUEUE_IDENTITY,
};

const settledHandoff = {
  handoffId: 'mvz5b8ea-gzs3aq', queueStatus: 'sent',
  providerQueueProof: { sourceIdentity: QUEUE_IDENTITY },
  auditProof: null, sendOperationKey: 'history:tab:mvz5b8ea-gzs3aq', sendAttemptId: 'a1',
};

// The decision the panel now makes when live rows arrive.
const retire = (rows, handoffs, isLocal = () => false) => {
  const canonical = rows.filter((entry) => !isLocal(entry)
    && (entry.role === 'user' || entry.role === 'queued'));
  if (canonical.length === 0) return [];
  const retired = [];
  for (const record of handoffs) {
    if (record.queueStatus !== 'sent') continue;
    const proof = record.auditProof || record.providerQueueProof;
    const sourceIdentity = proof?.sourceIdentity || '';
    const entryUuid = record.auditProof?.entryUuid || '';
    if (!sourceIdentity && !entryUuid) continue;
    if (canonical.some((entry) => (
      (!!sourceIdentity && historyEntryHasExactIdentity(entry, sourceIdentity))
      || (!!entryUuid && historyEntryHasExactIdentity(entry, entryUuid))
    ))) retired.push(record.handoffId);
  }
  return retired;
};

test('the card retires the moment Claude\'s own row arrives', () => {
  assert.deepEqual(retire([canonicalRow], [settledHandoff]), ['mvz5b8ea-gzs3aq'],
    'pre-fix nothing ran here and the duplicate waited for the reread');
});

test('an audited send retires by its record uuid too', () => {
  const byUuid = { ...settledHandoff, providerQueueProof: null,
    auditProof: { entryUuid: CARRIER_UUID } };
  assert.deepEqual(retire([{ ...canonicalRow, sourceIdentity: undefined }], [byUuid]),
    ['mvz5b8ea-gzs3aq']);
});

test('nothing retires without the exact identity', () => {
  // A different record of the same prompt text.
  assert.deepEqual(retire([{ ...canonicalRow,
    sourceIdentity: 'claude-queue:offset:' + SESSION + ':99999', uuid: 'other' }],
    [settledHandoff]), []);
  // The card's own local row is never its own proof.
  assert.deepEqual(retire([{ ...canonicalRow, isLocal: true }], [settledHandoff],
    (entry) => entry.isLocal === true), []);
  // Assistant and service rows are not prompt carriers.
  assert.deepEqual(retire([{ ...canonicalRow, role: 'assistant' }], [settledHandoff]), []);
  // A send with no proof at all keeps waiting for the reread, as before.
  assert.deepEqual(retire([canonicalRow],
    [{ ...settledHandoff, providerQueueProof: null, auditProof: null }]), []);
});

test('an unsettled send is never retired early', () => {
  for (const queueStatus of ['preparing', 'sending', 'application-queued',
    'audit-pending', 'delivery-unknown', 'queued']) {
    assert.deepEqual(retire([canonicalRow], [{ ...settledHandoff, queueStatus }]), [],
      queueStatus + ' is still in flight and must keep its card');
  }
});

test('each settled send retires only against its own row', () => {
  const second = {
    handoffId: 'mvz5cdpe-gxo753', queueStatus: 'sent',
    providerQueueProof: { sourceIdentity: 'claude-queue:offset:' + SESSION + ':12900000' },
    auditProof: null, sendOperationKey: 'k2', sendAttemptId: 'a2',
  };
  assert.deepEqual(retire([canonicalRow], [settledHandoff, second]), ['mvz5b8ea-gzs3aq'],
    'the second prompt has no visible row yet and keeps its card');
});

test('wired: live rows run the retirement, bound to this exact attempt', () => {
  const helper = panel.indexOf('const retireLocalPromptsCoveredByCanonicalRows = useCallback(');
  assert.ok(helper > 0, 'the helper exists');
  // Bounded by the helper's own end, not a byte count: a comment added
  // inside it used to push the asserted lines past a fixed window.
  const body = panel.slice(helper, panel.indexOf('const queueMergeIntents', helper));
  assert.match(body, /record\.queueStatus !== 'sent'/, 'only a settled send');
  assert.match(body, /!isLocalPromptEntry\(entry\)/, 'its own card is not proof');
  assert.match(body, /historyEntryHasExactIdentity/, 'exact identity, not text');
  assert.match(body, /consumeLocalPromptEntry\(record\.handoffId, 'canonical-row-already-visible'/);
  assert.match(body, /operationKey: record\.sendOperationKey, attemptId: record\.sendAttemptId/,
    'the removal is bound to this exact attempt');

  // It must run where the live projection commits Claude's rows.
  const call = panel.indexOf('retireLocalPromptsCoveredByCanonicalRows(projected)');
  assert.ok(call > 0, 'the live projection calls it');
  const commit = panel.lastIndexOf('setLiveEntries(projected);', call);
  assert.ok(commit > 0 && call - commit < 800, 'right after the rows become visible');

  // The 01.11 check in the handoff subscription stays: a card that settles
  // AFTER the row is already visible still retires immediately.
  assert.match(panel, /if \(identity\.sourceIdentity && record\.queueStatus === 'sent'\) \{/);
});

// 02.11, second occurrence (tab 1ccc61c912ae, handoff mvzciw0f-9247op).
// The first fix hooked the retirement to the LIVE projection only. When the
// canonical prompt arrives through a server refresh instead — a long turn
// finishes and the reread brings it — nothing retired the local card, and the
// user saw the duplicate for 78 s (appended 14:20:15, retired 14:21:33 by the
// deferred reread). Both arrival paths must retire it.
test('a canonical row arriving through the server refresh also retires the local card', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)),
    '..', 'components', 'Workspace', 'HistoryPanel.tsx'), 'utf8');
  const calls = source.split('retireLocalPromptsCoveredByCanonicalRows(').length - 1;
  assert.ok(calls >= 2, 'both the live-event and the server-refresh path must call it, found ' + calls);
  // The refresh path: scheduled off the reducer, guarded by the owner check.
  const refresh = source.slice(source.indexOf('REFRESH_LOCALS'), source.indexOf('A settled refresh may replace'));
  assert.match(refresh, /queueMicrotask\(\(\) => \{/,
    'it must not run inside the state reducer');
  assert.ok(refresh.includes('if (isCurrentOwner()) retireLocalPromptsCoveredByCanonicalRows(newEntries);'),
    'and must retire against the merged rows, under the same owner guard');
});
