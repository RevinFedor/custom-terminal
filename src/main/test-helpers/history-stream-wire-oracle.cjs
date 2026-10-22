'use strict';
// Separate bounded synthetic oracle process. The measured Main/client process
// does not retain a second response graph. This file is never production code.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const [file, countText, bytesText, sessionId, receipt] = process.argv.slice(2);
const count = Number(countText), leafBytes = Number(bytesText);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 100);
assert.ok(Number.isInteger(leafBytes) && leafBytes <= 256 * 1024);
assert.ok(fs.statSync(file).size < 2 * 1024 * 1024, 'bounded own fixture only');
const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(entries.length, count);
const orderedIds = createHash('sha256'), content = createHash('sha256');
for (let i = 0; i < count; i++) {
  const row = entries[i], uuid = `codex-assistant-${sessionId}-${i}`;
  assert.equal(row.uuid, uuid); assert.equal(row.sessionId, sessionId);
  assert.equal(row.role, 'assistant'); assert.equal(row.content.length, leafBytes);
  assert.equal(row.content.slice(0, ('FULL-' + i + '-').length), 'FULL-' + i + '-');
  assert.ok(/^x*$/.test(row.content.slice(('FULL-' + i + '-').length)));
  orderedIds.update(uuid + '\n'); content.update(row.content);
}
fs.writeFileSync(receipt, JSON.stringify({ count, firstUuid: entries[0].uuid, lastUuid: entries.at(-1).uuid,
  orderedIdsSHA256: orderedIds.digest('hex'), contentSHA256: content.digest('hex'), contentBytes: count * leafBytes }));
