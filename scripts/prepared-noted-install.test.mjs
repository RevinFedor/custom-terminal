import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readPreparedInstall } from './prepared-noted-install.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-prepared-cut-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installedApp = path.join(root, 'Applications', 'Noted Terminal.app');
  const candidateApp = path.join(root, 'candidate', 'Noted Terminal.app');
  for (const app of [installedApp, candidateApp]) await fs.mkdir(path.join(app, 'Contents/Resources'), { recursive: true });
  await fs.writeFile(path.join(installedApp, 'Contents/Resources/app.asar'), 'old');
  await fs.writeFile(path.join(candidateApp, 'Contents/Resources/app.asar'), 'new');
  await fs.mkdir(path.join(root, 'src/main'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/main/owned.js'), 'owned source');
  const intentPath = path.join(root, 'intent.json');
  const intent = { version: 1, state: 'pending', candidateApp, expectedAsarSha256: sha('new'), baselineAsarSha256: sha('old'),
    sourcePins: [{ path: 'src/main/owned.js', sha256: sha('owned source') }] };
  await fs.writeFile(intentPath, JSON.stringify(intent), { mode: 0o600 });
  return { root, installedApp, candidateApp, intentPath, intent,
    read: nonce => readPreparedInstall(root, nonce || 'owned-job-1', { intentPath }) };
}
test('prepared cut is claimed once with exact baseline/candidate/Source pins and saved result', async t => {
  const f = await fixture(t), cut = await f.read();
  await cut.verify(f.installedApp); await cut.claim();
  await assert.rejects(f.read('other-job-2'), /already claimed/);
  await cut.finish({ ok: true, installed: true, launchRequested: true });
  assert.equal((JSON.parse(await fs.readFile(f.intentPath))).state, 'completed');
  assert.equal(await f.read(), null);
});
test('Source or baseline drift refuses prepared cut before claim', async t => {
  const f = await fixture(t), cut = await f.read();
  await fs.writeFile(path.join(f.root, 'src/main/owned.js'), 'new unrelated edit');
  await assert.rejects(cut.verify(f.installedApp), /Source pin changed/);
  assert.equal((JSON.parse(await fs.readFile(f.intentPath))).state, 'pending');
  await fs.writeFile(path.join(f.root, 'src/main/owned.js'), 'owned source');
  await fs.writeFile(path.join(f.installedApp, 'Contents/Resources/app.asar'), 'another install');
  await assert.rejects(cut.verify(f.installedApp), /baseline changed/);
});
test('changed intent cannot be claimed or overwritten by a stale owner', async t => {
  const f = await fixture(t), cut = await f.read();
  await fs.writeFile(f.intentPath, JSON.stringify({ ...f.intent, state: 'claimed', claimedBy: 'other' }));
  await assert.rejects(cut.claim(), /changed before claim/);
});
test('manual CURRENT build cannot consume a reserved cut and a failed cut stays blocked', async t => {
  const f = await fixture(t);
  await assert.rejects(readPreparedInstall(f.root, '', { intentPath: f.intentPath }), /external install owner/);
  const cut = await f.read(); await cut.claim(); await cut.finish({ ok: false, installed: false });
  await assert.rejects(f.read('other-job-2'), /failed/);
});
