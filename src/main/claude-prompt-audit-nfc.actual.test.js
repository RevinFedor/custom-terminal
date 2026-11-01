'use strict';

// Claude normalizes a submitted prompt to Unicode NFC before it records it or
// reports it to UserPromptSubmit. macOS hands out file paths in NFD, so a
// prompt containing a dragged/pasted path with a Cyrillic or accented letter
// reaches Claude one code unit LONGER than Claude records it.
//
// Incident 2026-10-31, tab 029152fbe588, handoff mvwj1obz-x6tcv2 (proved from
// the real transcript c83ff64f):
//   14:59:32.562  our Enter while Claude was busy
//   14:59:32.624  queue-operation enqueue  (Claude accepted it, 62ms later)
//   14:59:33.932  type:user — the message, 583 chars
//   PasteAudit expected 584 chars, hash 82053fb5b81e2fae — never matched
// Only `й` in `…/Downloads/временный промпт.md` differed: the draft carried
// `и`+U+0306, Claude wrote U+0439. The delivered message stayed CONFIRMING
// forever and held the input slot, so the next send sat in IN APP QUEUE.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  claudeAuditTextMatches,
  selectClaudePendingPromptAudit,
} = require('./claude-prompt-audit');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

// The exact shape of the incident, reconstructed from the transcript: the
// recorded (NFC) text, and the draft the History composer pasted (NFD path).
const RECORDED = "В конце вот этот вот файл '/Users/fedor/Downloads/временный промпт.md'"
  + '  — Короче, вот его содержимое, ставишь и отправишь.';
const DRAFT = RECORDED.replace('временный', 'временный')
  .replace('временный', 'временны' + 'й');

function auditFor(text) {
  return {
    expectedText: text,
    expectedLen: text.length,
    expectedHash: promptAuditFingerprint(text),
    providerAcceptedText: null,
    providerAcceptedLen: null,
    providerAcceptedHash: null,
    finished: false,
    preSubmitBoundary: { available: true, transcriptPath: '/t.jsonl', fileSize: 100 },
  };
}

test('the fixture reproduces the incident: one code unit apart, different hashes', () => {
  assert.notEqual(DRAFT, RECORDED);
  assert.equal(DRAFT.length, RECORDED.length + 1, 'the decomposed й is one code unit longer');
  assert.equal(DRAFT.normalize('NFC'), RECORDED, 'and canonically the very same text');
  assert.notEqual(promptAuditFingerprint(DRAFT), promptAuditFingerprint(RECORDED));
});

test('a prompt Claude recorded in NFC is recognised as the delivered NFD draft', () => {
  assert.equal(claudeAuditTextMatches(auditFor(DRAFT), RECORDED), true,
    'the transcript record and the UserPromptSubmit text both arrive in NFC');
});

test('the queue/transcript selection now finds the delivered record', () => {
  const audit = auditFor(DRAFT);
  const candidate = {
    text: RECORDED, byteOffset: 5877063, transcriptPath: '/t.jsonl',
    record: { type: 'user', uuid: 'u-1', timestamp: '2026-10-31T14:59:33.932Z' },
  };
  const selection = selectClaudePendingPromptAudit([audit], [candidate], {
    classify: () => ({ causal: true, reason: 'record-after-byte-boundary' }),
  });
  assert.ok(selection, 'before the fix this returned null and the audit timed out');
  assert.equal(selection.candidate, candidate);
});

test('canonical equivalence never matches a different prompt', () => {
  const audit = auditFor(DRAFT);
  for (const other of [
    RECORDED.replace('промпт', 'проект'),          // a different word
    RECORDED + ' ',                                  // trailing space is real content
    RECORDED.slice(0, -1),                           // truncated
    RECORDED.replace('й', 'и'),                      // й vs и are different letters
    'Совсем другое сообщение',
  ]) {
    assert.equal(claudeAuditTextMatches(audit, other), false, JSON.stringify(other.slice(-20)));
  }
});

test('an ordinary prompt keeps the exact comparison as its only authority', () => {
  const plain = 'Ordinary ASCII prompt, no normalization at all.';
  assert.equal(claudeAuditTextMatches(auditFor(plain), plain), true);
  assert.equal(claudeAuditTextMatches(auditFor(plain), plain + '.'), false);
});

test('a stored text that no longer hashes to the audit identity grants nothing', () => {
  // Defence against a mutated/foreign object: the canonical path trusts
  // expectedText only while it still hashes to expectedHash/expectedLen.
  const audit = auditFor(DRAFT);
  audit.expectedText = RECORDED;          // tampered: no longer the audited text
  assert.equal(claudeAuditTextMatches(audit, RECORDED), false);
  const missing = auditFor(DRAFT);
  delete missing.expectedText;            // a restored audit without its text
  assert.equal(claudeAuditTextMatches(missing, RECORDED), false,
    'without the stored text there is no basis for a canonical match');
});

test('Claude merging several queued messages into one record still settles the first', () => {
  // The queued-while-busy path: Claude can merge queued messages into one user
  // record. The audited prompt must be recognised as its prefix in NFC too.
  const { selectClaudeLiveQueueSettlementAudits } = require('./claude-prompt-audit');
  assert.equal(typeof selectClaudeLiveQueueSettlementAudits, 'function');
  const audit = auditFor(DRAFT);
  const merged = RECORDED + '\nвторое сообщение из очереди';
  // The exact (non-canonical) prefix check fails on the raw strings…
  assert.equal(merged.startsWith(DRAFT), false);
  // …and the canonical forms agree, which is what the matcher now compares.
  assert.equal(merged.normalize('NFC').startsWith(DRAFT.normalize('NFC')), true);
  assert.equal(audit.expectedText.length, audit.expectedLen);
});
