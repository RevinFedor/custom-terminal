const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTransferTicket } = require('./gt-editor-transfer-client');

test('parses only live GT Editor transfer tickets', () => {
  const live = Buffer.from(JSON.stringify({
    schema: 'gt-editor-file-transfer/v1',
    handoffId: 'handoff-1',
    expiresAt: Date.now() + 10_000,
  }));
  assert.equal(parseTransferTicket(live).handoffId, 'handoff-1');
  assert.equal(parseTransferTicket(Buffer.from('{bad')), null);
  assert.equal(parseTransferTicket(Buffer.from(JSON.stringify({ schema: 'other', handoffId: 'x' }))), null);
  assert.equal(parseTransferTicket(Buffer.from(JSON.stringify({
    schema: 'gt-editor-file-transfer/v1',
    handoffId: 'old',
    expiresAt: Date.now() - 1,
  }))), null);
});
