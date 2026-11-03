// A prompt typed while Claude is working is settled through QUEUE_CONSUMED,
// not through a canonical user-record audit. The full History reread is
// deliberately deferred while the turn runs, so nothing reconciled the local
// SENT card with Claude's own row and the user saw the SAME message twice,
// both "sent". Production 01.11.2026, tab 1ccc61c912ae, handoff mvxh37m5-6r7ucv:
//   06:52:34.668  QUEUE_CONSUMED operation=remove source=claude-queue:offset:…:31653423
//   06:52:34.828  Timeline settle hasSourceIdentity=1   ← card has the proof
//   (no LOCAL_REMOVE for 9 minutes)
//   07:01:48.567  DURABLE_PRESENTATION_ACK applied=1     ← only the reread retired it
//
// The fix retires the card as soon as the canonical row carrying that exact
// identity is visible (live stream or committed cut). These are the real
// identity/adoption primitives that decision uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';
import { matchesHistoryPromptAdoption } from './historyPromptPresentation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, '..', 'components', 'Workspace', 'HistoryPanel.tsx'), 'utf8');

const SESSION = 'be82a19d-4a26-4263-b32a-e91477e1cd17';
const QUEUE_IDENTITY = 'claude-queue:offset:' + SESSION + ':31653423';
const CARRIER_UUID = '7eac16ff-d57a-4a6d-b5b5-50b8a0061652';

// Claude's own row exactly as the real projection produced it (verified by
// replaying ipc/claude-data.js over the real transcript: the queued_command
// carrier inherits the queue row's sourceIdentity).
const canonicalRow = {
  uuid: CARRIER_UUID,
  role: 'user',
  content: 'Продолжаю работу…',
  queueStatus: 'sent',
  sessionId: SESSION,
  sourceIdentity: QUEUE_IDENTITY,
  timestamp: '2026-11-01T06:52:33.161Z',
};

// What the confirmed receipt gave the local card.
const settledIdentity = {
  sourceIdentity: QUEUE_IDENTITY,
  auditEntryUuid: undefined,
  auditTimestamp: '2026-11-01T06:52:33.218Z',
};

// The decision the panel now makes before appending its own SENT card.
const canonicalVisible = (rows, identity, isLocal = () => false) => rows.some((entry) => (
  !isLocal(entry)
  && (entry.role === 'user' || entry.role === 'queued')
  && (historyEntryHasExactIdentity(entry, identity.sourceIdentity)
    || (!!identity.auditEntryUuid && historyEntryHasExactIdentity(entry, identity.auditEntryUuid)))
));

test('a queue-settled send is retired by the canonical row that is already visible', () => {
  assert.equal(canonicalVisible([canonicalRow], settledIdentity), true,
    'pre-fix nothing checked this, so a second SENT card was appended');
  // Same proof the deferred reread uses — this only moves the moment.
  assert.equal(matchesHistoryPromptAdoption({
    role: canonicalRow.role,
    normalizedText: canonicalRow.content,
    timestamp: canonicalRow.timestamp,
    sessionId: canonicalRow.sessionId,
    sourceIdentity: canonicalRow.sourceIdentity,
  }, {
    normalizedText: canonicalRow.content,
    localAt: Date.now(),
    requiresAuditIdentity: true,
    auditTimestamp: settledIdentity.auditTimestamp,
    auditSessionId: SESSION,
    sourceIdentity: settledIdentity.sourceIdentity,
    queueStatus: 'sent',
  }), true);
});

test('nothing is retired without the exact identity', () => {
  // Same text, different record: both prompts must stay visible.
  assert.equal(canonicalVisible([{ ...canonicalRow, sourceIdentity: 'claude-queue:offset:' + SESSION + ':99999', uuid: 'other' }],
    settledIdentity), false);
  // The card's own local row never counts as the canonical carrier.
  assert.equal(canonicalVisible([{ ...canonicalRow, isLocal: true }], settledIdentity,
    (entry) => entry.isLocal === true), false);
  // Assistant/compact rows are not prompt carriers.
  assert.equal(canonicalVisible([{ ...canonicalRow, role: 'assistant' }], settledIdentity), false);
  // No proof at all: the deferred reread stays the only owner.
  assert.equal(canonicalVisible([canonicalRow], { sourceIdentity: '', auditEntryUuid: undefined }), false);
});

test('an entryUuid-only confirmation also retires its card', () => {
  const byUuid = { ...canonicalRow, sourceIdentity: undefined };
  assert.equal(canonicalVisible([byUuid], { sourceIdentity: '', auditEntryUuid: CARRIER_UUID }), true);
});

test('wired: the panel retires the card before appending, only for a confirmed send', () => {
  const start = panel.indexOf("if (identity.sourceIdentity && record.queueStatus === 'sent') {");
  assert.ok(start > 0, 'the retirement check exists');
  const body = panel.slice(start, start + 1400);
  assert.match(body, /liveProjectionRef\.current\.entries/, 'live stream counts');
  assert.match(body, /committedHistoryEntriesRef\.current\.entries/, 'committed cut counts');
  assert.match(body, /!isLocalPromptEntry\(entry\)/, 'its own card is not proof');
  assert.match(body, /historyEntryHasExactIdentity/, 'exact identity, not text');
  assert.match(body, /consumeLocalPromptEntry\(record\.handoffId, 'canonical-row-already-visible'/);
  assert.match(body, /operationKey: record\.sendOperationKey, attemptId: record\.sendAttemptId/,
    'the removal is bound to this exact attempt');
  // It must run before the append that creates the duplicate.
  assert.ok(start < panel.indexOf('appendLocalPromptEntry(record.text, record.queueStatus, {', start));
});
