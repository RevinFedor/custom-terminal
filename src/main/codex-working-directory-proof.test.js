'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { readCodexWorkingDirectoryProof } = require('./codex-working-directory-proof');
const settings = cwd => ({ type: 'event_msg', payload: { type: 'thread_settings_applied',
  thread_settings: { cwd, model: 'fixture-model', reasoning_effort: 'high' } } });
const line = value => JSON.stringify(value) + '\n';

async function fixture(t, extra = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-cwd-proof-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'fixture.jsonl');
  await fs.writeFile(filePath, line({ type: 'session_meta', payload: { id: 'source', cwd: '/a' } })
    + line(settings('/b')) + extra.map(line).join(''));
  const stat = await fs.stat(filePath);
  const before = { filePath, sessionId: 'source', size: stat.size, fileIdentity: stat.dev + ':' + stat.ino };
  return { dir, filePath, before, read: (overrides = {}) => readCodexWorkingDirectoryProof({
    findSessionFile: async () => ({ filePath }), sessionId: 'source', sourceSessionId: 'source', cwd: '/b', before, ...overrides,
  }) };
}

test('old matching cwd in copied history is NOT a new native launch proof', async t => {
  const f = await fixture(t); assert.equal((await f.read()).known, false);
  await fs.appendFile(f.filePath, line(settings('/b')));
  const result = await f.read(); assert.equal(result.known, true);
  assert.ok(result.recordByteOffset >= f.before.size);
});

test('latest incomplete/different native settings cannot borrow an older matching cwd', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.filePath, line(settings('/b')) + line({ type: 'event_msg', payload: {
    type: 'thread_settings_applied', thread_settings: { cwd: '/b', model: 'fixture-model' } } }));
  assert.equal((await f.read()).known, false);
  await fs.appendFile(f.filePath, line(settings('/c'))); assert.equal((await f.read()).known, false);
});

test('bounded native proof does not materialize a large user/tool line', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.filePath, line({ type: 'event_msg', payload: { type: 'fixture-output', text: 'x'.repeat(2 * 1024 * 1024) } })
    + line(settings('/b')));
  const result = await f.read(); assert.equal(result.known, true);
  assert.ok(result.bytesRead <= 64 * 1024 + 256 * 1024);
});

test('a proven direct child needs exact child metadata and destination settings', async t => {
  const f = await fixture(t);
  const child = path.join(f.dir, 'child.jsonl');
  await fs.writeFile(child, line({ type: 'session_meta', payload: { id: 'child', forked_from_id: 'source', cwd: '/b' } })
    + line(settings('/b')));
  assert.equal((await f.read({ sessionId: 'child', findSessionFile: async () => ({ filePath: child }) })).known, true);
  await fs.writeFile(child, line({ type: 'session_meta', payload: { id: 'child', forked_from_id: 'other', cwd: '/b' } })
    + line(settings('/b')));
  assert.equal((await f.read({ sessionId: 'child', findSessionFile: async () => ({ filePath: child }) })).known, false);
});

test('source replacement and mismatched metadata fail, original source stays unchanged', async t => {
  const f = await fixture(t), original = await fs.readFile(f.filePath);
  const replacement = path.join(f.dir, 'replacement');
  await fs.writeFile(replacement, original.toString() + line(settings('/b')));
  await fs.rename(replacement, f.filePath);
  assert.equal((await f.read()).known, false);
  assert.deepEqual((await fs.readFile(f.filePath)).subarray(0, original.length), original);
});
