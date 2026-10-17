'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalSourceTicket, verifyCanonicalSourceSpan, canonicalRecordFingerprint } = require('./codex-canonical-source-proof');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-point-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'synthetic.jsonl'), bytes = Buffer.from('{"type":"response_item","text":"😀 source"}\n');
  fs.writeFileSync(filePath, bytes);
  let current = true;
  const ticket = canonicalSourceTicket({ filePath, stat: fs.statSync(filePath), start: 0, bytes,
    isCurrent: () => current });
  return { filePath, bytes, ticket, revoke: () => current = false };
}

test('point proof is complete-record bounded and survives an ordinary prior append', async t => {
  const f = fixture(t); fs.appendFileSync(f.filePath, '{}\n');
  assert.deepEqual(await verifyCanonicalSourceSpan(f.ticket, () => true), { ok: true, bytes: f.bytes.length });
  assert.equal(f.ticket.recordDigest, canonicalRecordFingerprint({ type: 'response_item', text: '😀 source', __line: 99 }));
});

test('point proof rejects rewrite-with-growth DURING the actual FD read', async t => {
  const f = fixture(t); let once = false;
  const io = { ...fs.promises, open: async (...args) => {
    const fd = await fs.promises.open(...args);
    return { stat: () => fd.stat(), close: () => fd.close(), read: async (...readArgs) => {
      const result = await fd.read(...readArgs);
      if (!once) { once = true; fs.appendFileSync(f.filePath, '{}\n'); }
      return result;
    } };
  } };
  const result = await verifyCanonicalSourceSpan(f.ticket, () => true, { io });
  assert.equal(result.ok, false); assert.equal(result.reason, 'source-changed-during-verification');
});

test('same inode changed prefix rejects the full raw digest, not just semantic prose', async t => {
  const f = fixture(t), changed = Buffer.from(f.bytes);
  changed[2] = 'z'.charCodeAt(0); fs.writeFileSync(f.filePath, changed);
  assert.equal((await verifyCanonicalSourceSpan(f.ticket, () => true)).reason, 'record-digest-mismatch');
});

test('known source ABA revokes even byte-equal records; incomplete and multiline ranges are not tickets', async t => {
  const f = fixture(t); f.revoke();
  assert.equal((await verifyCanonicalSourceSpan(f.ticket, () => true)).reason, 'source-ticket-revoked');
  assert.equal(canonicalSourceTicket({ filePath: f.filePath, stat: fs.statSync(f.filePath), start: 0,
    bytes: f.bytes.subarray(0, -1), isCurrent: () => true }), null);
  assert.equal(canonicalSourceTicket({ filePath: f.filePath, stat: fs.statSync(f.filePath), start: 0,
    bytes: Buffer.concat([f.bytes, f.bytes]), isCurrent: () => true }), null);
});
