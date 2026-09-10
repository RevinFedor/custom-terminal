'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { proveEmptyClaudeRestore, isEmptyClaudeRestoreCurrent } = require('./claude-empty-restore');

async function fixture(t, value) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-empty-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'empty.jsonl');
  await fs.writeFile(file, value);
  return file;
}

for (const text of ['', '\n', JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }),
  '{"type":"mode","mode":"normal","sessionId":"81b97d0f-9f98-4f0e-a5a5-aba621b778d8"}\n'
    + '{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"81b97d0f-9f98-4f0e-a5a5-aba621b778d8"}\n',
  JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: {} } })]) {
  test('complete empty/startup metadata gets a file-revision-bound fresh proof: ' + JSON.stringify(text).slice(0,70), async t => {
    const file = await fixture(t, text);
    const proof = await proveEmptyClaudeRestore(file);
    assert.ok(proof);
    assert.equal(isEmptyClaudeRestoreCurrent(proof), true);
    await fs.appendFile(file, '\n' + JSON.stringify({ type: 'user', uuid: 'first', message: { content: 'new' } }));
    assert.equal(isEmptyClaudeRestoreCurrent(proof), false);
  });
}

for (const text of [
  '{"type":',
  JSON.stringify({ type: 'user', uuid: 'first', message: { content: 'keep' } }),
  JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: 'keep answer' } }),
  JSON.stringify({ type: 'summary', summary: 'keep compact' }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'keep draft' }),
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'keep pending' }),
  JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { file: {} } } }),
  JSON.stringify({ type: 'unknown-future-record' }),
  '\n'.repeat(65537),
  Buffer.from([0xff, 0xfe]),
]) {
  test('no fresh substitution for conversation, incomplete/unknown data, or oversized probe: ' + JSON.stringify(text).slice(0,70), async t => {
    assert.equal(await proveEmptyClaudeRestore(await fixture(t, text)), null);
  });
}
test('missing and replaced files never supply empty proof', async t => {
  const file = await fixture(t, '');
  const proof = await proveEmptyClaudeRestore(file);
  await fs.rename(file, file + '.old');
  await fs.writeFile(file, '');
  assert.equal(isEmptyClaudeRestoreCurrent(proof), false);
  assert.equal(await proveEmptyClaudeRestore(file + '.missing'), null);
});
