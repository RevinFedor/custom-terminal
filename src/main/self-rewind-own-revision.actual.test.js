'use strict';
// `rewind_self` on a Claude tab always failed with `stale_transcript_revision`.
// Production 02.11, tab 685a08aa97eb, session 7fd3327b, operation
// self-rewind-to-iter13-20261102-v1:
//
//   11:12:19.179  the tab reads /timeline and takes revision e9e2bb3c…
//   11:12:19.258  Claude appends 2538 bytes to the very same file
//   11:13:16.084  rewind_self is called with that revision
//   11:13:17.042  stale_transcript_revision — history untouched
//
// This is structural, not bad luck. A self rewind is issued BY the session
// that is writing the file: between reading the revision and calling the
// tool it necessarily produces more records (its own reasoning, its tool
// calls, the retained context it is required to author). The whole-file
// fingerprint it quotes is stale by construction — which is also why the tab
// resorted to fetching it over raw HTTP: no MCP tool exposes it.
//
// The fingerprint is not what protects the rewrite. The executor itself
// checks the revision ONLY while preparing (`selectSavedHistoryTarget(...,
// true)`), and deliberately NOT at rewrite or write time (`..., false`),
// where it instead proves the exact target record hash and that the file was
// not replaced under it — after Stop, when the file no longer grows.
//
// So for a SELF rewind the whole-file revision is dropped: the caller
// addresses the message, the app proves the rest. For `rewind_history`
// against another tab it stays mandatory — there a third party really can
// edit the transcript in between.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeSavedHistoryRequest } = require('./saved-history-operation');

const base = () => ({
  operationId: 'self-rewind-to-iter13-20261102-v1',
  kind: 'rewind',
  expectedSessionId: '7fd3327b-ba53-43e7-a88c-a63dd713ea14',
  targetUuid: 'cf78c887-cb70-47b4-b392-91ac7f08ae14',
  toolType: 'claude',
});

const selfRewind = () => ({
  retainedContext: 'что сделано и что осталось',
  expectedContextRevision: 43,
  expectedContextSnapshot: 'rctx1.eyJ2ZXJzaW9uIjoxfQ.sig',
});

test('a self rewind no longer requires the whole-file revision', () => {
  // Pre-fix this threw history_revision_required and the tab could never
  // satisfy it, because its own writing invalidated every token it read.
  const request = normalizeSavedHistoryRequest('T', { ...base(), selfRewind: selfRewind() });
  assert.equal(request.expectedContentRevision, null);
  assert.equal(request.targetUuid, 'cf78c887-cb70-47b4-b392-91ac7f08ae14',
    'the message address is what the caller supplies');
  assert.ok(request.selfRewind, 'it is still a self rewind');
});

test('a revision supplied by a self rewind is still honoured, never discarded', () => {
  const token = 'e9e2bb3cd62e80b9751cdc74d6ecc72f2498c0d056aea6818f0f0a6c3de09f90';
  const request = normalizeSavedHistoryRequest('T',
    { ...base(), expectedContentRevision: token, selfRewind: selfRewind() });
  assert.equal(request.expectedContentRevision, token,
    'an explicitly passed token must still be checked, not silently dropped');
});

test('rewinding ANOTHER tab still requires the revision', () => {
  // No selfRewind payload = rewind_history against some other conversation,
  // where a third party can genuinely edit the transcript in between.
  assert.throws(() => normalizeSavedHistoryRequest('T', base()),
    /history_revision_required/);
});

test('Codex keeps its own rules in both directions', () => {
  const codex = { ...base(), toolType: 'codex' };
  // Codex never required it.
  assert.equal(normalizeSavedHistoryRequest('T', codex).expectedContentRevision, null);
  assert.equal(normalizeSavedHistoryRequest('T',
    { ...codex, selfRewind: selfRewind() }).expectedContentRevision, null);
});

test('a composite target still needs its exact coordinates', () => {
  // Dropping the whole-file fingerprint must not weaken entryRef identity:
  // a composite row is addressed by physical session + raw uuid + revision.
  assert.throws(() => normalizeSavedHistoryRequest('T', {
    ...base(), selfRewind: selfRewind(),
    targetEntryRef: { physicalSessionId: 'P', rawUuid: 'R' },
  }), /history_target_partial_identity/);
});

test('every other self-rewind requirement is unchanged', () => {
  for (const [label, patch] of [
    ['no retained context', { retainedContext: '   ' }],
    ['no context revision', { expectedContextRevision: undefined }],
    ['empty snapshot', { expectedContextSnapshot: '' }],
  ]) {
    assert.throws(() => normalizeSavedHistoryRequest('T',
      { ...base(), selfRewind: { ...selfRewind(), ...patch } }),
    /self_rewind_request_invalid/, label + ' must still fail');
  }
  // And the target identity itself is still mandatory.
  assert.throws(() => normalizeSavedHistoryRequest('T',
    { ...base(), targetUuid: '', selfRewind: selfRewind() }),
  /history_target_identity_required/);
});

test('the rewrite phase never relied on this revision anyway', () => {
  // The proof that dropping it removes no real guard: the executor checks the
  // revision only while preparing, and proves the exact record instead at the
  // two points that actually write.
  const source = fs.readFileSync(path.join(__dirname, 'saved-history-operation.js'), 'utf8');
  assert.match(source, /selectSavedHistoryTarget\(sourceTimeline, mutationSpec, !spec\.repairOfOperationId\)/,
    'prepare checks the revision');
  assert.match(source, /const target = selectSavedHistoryTarget\(timeline, mutationSpec, false\);/,
    'rewrite does not');
  assert.match(source, /selectSavedHistoryTarget\(\{ success: true, entries \}, mutationSpec, false\)/,
    'the write guard does not either');
  // What the write guard uses instead, after Stop, when the file is frozen.
  assert.match(source, /hash\(current\.records\.find\(record => record\?\.uuid === target\.uuid\)\) !== lease\.rawTargetHash/);
  assert.match(source, /current\.revision\.token !== loaded\.revision\.token/);
});
