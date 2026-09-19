'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCodexAuditAddress } = require('./codex-audit-address');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-audit-address-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(filePath, 'immutable fixture');
  fs.truncateSync(filePath, 47037600); // sparse extent containing the mocked reader's source offset
  const record = { type: 'event_msg', payload: { type: 'user_message', message: 'same prompt' },
    timestamp: '2026-09-12T11:57:10.163Z', __line: 6937, __byteOffset: 47037454 };
  const rows = [{ type: 'session_meta', payload: { id: 'session-a' } }, record];
  return { filePath, record, rows, sessionId: 'session-a', hashText: promptAuditFingerprint,
    audit: { actualHash: promptAuditFingerprint('same prompt'), auditTimestamp: record.timestamp,
      sourceIdentity: 'codex-user-source-session-a-47037454' },
    readAddress: async () => ({ sessionId: 'session-a', record }) };
}
test('byte-addressed accepted send gets canonical reader UUID without History/renderer', async t => {
  const f = setup(t);
  assert.deepEqual(await resolveCodexAuditAddress(f), {
    entryUuid: 'codex-user-session-a-6937', sourceIdentity: f.audit.sourceIdentity, recordByteOffset: 47037454,
  });
});
test('resolver asks once for an exact locator rather than an older shared raw snapshot', async t => {
  const f = setup(t); let reads = 0;
  f.readAddress = async () => { reads++; return { sessionId: 'session-a', record: f.record }; };
  assert.equal((await resolveCodexAuditAddress(f)).entryUuid, 'codex-user-session-a-6937');
  assert.equal(reads, 1);
});
test('identical text at a different offset/session/timestamp is never guessed', async t => {
  const f = setup(t);
  for (const patch of [
    { sourceIdentity: 'codex-user-source-session-a-47037455' },
    { sourceIdentity: 'codex-user-source-other-session-47037454' },
    { auditTimestamp: '2026-09-12T11:57:11.163Z' },
    { actualHash: 'wrong' }, { recordByteOffset: 0 },
    { sourceIdentity: 'codex-user-source-session-a-unknown' },
  ]) assert.equal(await resolveCodexAuditAddress({ ...f, audit: { ...f.audit, ...patch } }), null);
});
test('replaced physical file and missing canonical line reject address enrichment', async t => {
  const f = setup(t);
  f.readAddress = async () => {
    const replacement = f.filePath + '.new'; fs.writeFileSync(replacement, 'replacement fixture');
    fs.renameSync(replacement, f.filePath); return { sessionId: 'session-a', record: f.record };
  };
  assert.equal(await resolveCodexAuditAddress(f), null);
  const valid = setup(t);
  valid.readAddress = async () => ({ sessionId: 'session-a', record: { ...valid.record, __line: undefined } });
  assert.equal(await resolveCodexAuditAddress(valid), null);
});
