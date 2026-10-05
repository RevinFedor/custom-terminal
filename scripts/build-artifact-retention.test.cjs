'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const R = require('./lib/build-artifact-retention.cjs');
const noReferences = async () => ({ commands: [], paths: [] });
const noAudit = { record: async () => {} };
async function fixture(t) {
  const created = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'build-retention-test-'));
  const dir = await fs.promises.realpath(created);
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}
function group(base, name = 'probe-20260901') {
  return path.join(base, 'Library/Application Support/sc-desktop/test-artifacts', name);
}
async function app(dir, value = 'test-asar') {
  await fs.promises.mkdir(path.join(dir, 'Contents/Resources'), { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.noted.retention-test</string></dict></plist>');
  await fs.promises.writeFile(path.join(dir, 'Contents/Resources/app.asar'), value);
  return dir;
}
async function item(root, file, kind = 'app-bundle') {
  const id = await R.identity(file);
  return { root, path: file, kind, dev: id.dev, ino: id.ino };
}
test('old scan finds binaries but preserves DB, source snapshots, receipts and symlinks', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'candidate/Voice Record.app'));
  await fs.promises.writeFile(path.join(root, 'installed.json'), '{}');
  await fs.promises.writeFile(path.join(root, 'library.db'), 'REAL DATA');
  await fs.promises.mkdir(path.join(root, 'source-snapshot'), { recursive: true });
  await app(path.join(root, 'source-snapshot/Voice Record.app'));
  const other = await app(path.join(base, 'outside/SC Desktop.app'));
  await fs.promises.symlink(path.dirname(other), path.join(root, 'linked'));
  const plan = await R.planOldArtifacts({ home: base, beforeDate: '2026-10-01' });
  assert.deepEqual(plan.targets.map(x => x.path), [pkg]);
  await R.applyTargets(plan.targets, { audit: noAudit, probe: noReferences });
  assert.equal(fs.existsSync(pkg), false);
  for (const name of ['installed.json', 'library.db', 'source-snapshot/Voice Record.app']) assert.equal(fs.existsSync(path.join(root, name)), true);
  assert.equal(fs.existsSync(other), true);
});
test('fresh dated group and explicit preservation are not cleanup candidates', async t => {
  const base = await fixture(t), old = group(base), fresh = group(base, 'study-20261005');
  const keep = await app(path.join(old, 'Voice Record.app'));
  await app(path.join(fresh, 'Voice Record.app'));
  assert.equal((await R.planOldArtifacts({ home: base, beforeDate: '2026-10-01', preserve: [keep] })).targets.length, 0);
});
test('prepared marker wins over the old directory date and survives sweeps', async t => {
  const base = await fixture(t), root = group(base);
  await app(path.join(root, 'candidate/Voice Record.app'));
  await R.markPrepared(root, 'stage-test');
  const plan = await R.planOldArtifacts({ home: base, beforeDate: '2026-10-01' });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skipped[0].reason, 'prepared-or-unverified');
});
test('invalid marker stops scan rather than interpreting it as no protection', async t => {
  const base = await fixture(t), root = group(base);
  await app(path.join(root, 'Voice Record.app'));
  await fs.promises.writeFile(path.join(root, R.MARKER), '{broken');
  await assert.rejects(R.planOldArtifacts({ home: base, beforeDate: '2026-10-01' }));
});
test('working generation references protect binaries even when their file is closed', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'Voice Record.app'));
  const result = await R.applyTargets([await item(root, pkg)], { audit: noAudit, probe: async () => ({ commands: ['node test.cjs ' + root], paths: [] }) });
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped[0].reason, 'in-use');
  assert.equal(fs.existsSync(pkg), true);
});
test('unavailable process/open-file probe never authorizes deletion', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'Voice Record.app'));
  await assert.rejects(R.applyTargets([await item(root, pkg)], { audit: noAudit, probe: async () => { throw Error('lsof unavailable'); } }));
  assert.equal(fs.existsSync(pkg), true);
});
test('audit failure refuses removal', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'Voice Record.app'));
  await assert.rejects(R.applyTargets([await item(root, pkg)], { probe: noReferences, audit: { record: async () => { throw Error('disk full'); } } }));
  assert.equal(fs.existsSync(pkg), true);
});
test('replacement during audit await is not deleted under old identity', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'Voice Record.app'));
  const target = await item(root, pkg);
  await assert.rejects(R.applyTargets([target], { probe: noReferences, audit: { record: async e => {
    if (e.status === 'attempt') { await fs.promises.rename(pkg, pkg + '.saved'); await app(pkg, 'NEW'); }
  } } }), /replaced/);
  assert.equal(fs.readFileSync(path.join(pkg, 'Contents/Resources/app.asar'), 'utf8'), 'NEW');
});
test('broad roots and mislabeled database directories are forbidden', async t => {
  const base = await fixture(t), pkg = await app(path.join(base, 'Voice Record.app'));
  await assert.rejects(R.applyTargets([await item(base, pkg)], { audit: noAudit, probe: noReferences }), /Forbidden/);
  const root = group(base), data = path.join(root, 'database');
  await fs.promises.mkdir(data, { recursive: true });
  await fs.promises.writeFile(path.join(data, 'package.json'), '{}');
  await assert.rejects(R.applyTargets([await item(root, data, 'unpacked-app')], { audit: noAudit, probe: noReferences }), /Unproven/);
});
test('symlink substitution is rejected without following to the external bundle', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'Voice Record.app'));
  const target = await item(root, pkg), other = await app(path.join(base, 'outside/Voice Record.app'));
  await fs.promises.rename(pkg, pkg + '.saved');
  await fs.promises.symlink(other, pkg);
  await assert.rejects(R.applyTargets([target], { audit: noAudit, probe: noReferences }), /non-symlink/);
  assert.equal(fs.existsSync(other), true);
});
test('two newest rollback packages per product survive an old sweep', async t => {
  const base = await fixture(t), all = [];
  for (const day of ['01', '02', '03', '04']) all.push(await app(path.join(group(base, 'probe-202609' + day), 'backup/Voice Record.app')));
  const plan = await R.planOldArtifacts({ home: base, beforeDate: '2026-10-01' });
  assert.deepEqual(plan.targets.map(x => x.path).sort(), all.slice(0, 2).sort());
});
test('successful exact package proof prunes duplicates but keeps rollback and receipts', async t => {
  const base = await fixture(t), root = group(base), installed = await app(path.join(base, 'Applications/Voice Record.app'), 'NEW');
  const candidate = await app(path.join(root, 'candidate/Voice Record.app'), 'NEW');
  const retired = await app(path.join(root, 'retired/Voice Record.app'), 'OLD');
  const backup = await app(path.join(root, 'backup/Voice Record.app'), 'OLD');
  const contents = path.join(root, 'contents');
  await fs.promises.mkdir(contents); await fs.promises.writeFile(path.join(contents, 'package.json'), '{}');
  await fs.promises.writeFile(path.join(root, 'installed.json'), '{}');
  const expected = crypto.createHash('sha256').update('NEW').digest('hex');
  const result = await R.cleanupVerifiedDeployment({ root, installedApp: installed, expectedAsar: expected, candidate, retired, backup, contents, audit: noAudit, probe: noReferences });
  assert.equal(result.removed.length, 3);
  for (const p of [installed, backup, path.join(root, 'installed.json')]) assert.equal(fs.existsSync(p), true);
});
test('changed installed package keeps candidate and rollback for recovery', async t => {
  const base = await fixture(t), root = group(base), installed = await app(path.join(base, 'Applications/Voice Record.app'), 'OTHER');
  const candidate = await app(path.join(root, 'candidate/Voice Record.app')), backup = await app(path.join(root, 'backup/Voice Record.app'));
  await assert.rejects(R.cleanupVerifiedDeployment({ root, installedApp: installed, expectedAsar: 'f'.repeat(64), candidate, backup, audit: noAudit, probe: noReferences }), /proof changed/);
  assert.equal(fs.existsSync(candidate), true); assert.equal(fs.existsSync(backup), true);
});
test('private test close removes only proven dist, never evidence/profile/source', async t => {
  const base = await fixture(t), root = group(base);
  for (const name of ['dist', 'profile', 'source', 'screenshots']) await fs.promises.mkdir(path.join(root, name), { recursive: true });
  await R.markPrepared(root, 'translator-private-build');
  const result = await R.cleanupPrivateBuild(root, { audit: noAudit, probe: noReferences });
  assert.deepEqual(result.removed, [path.join(root, 'dist')]);
  for (const name of ['profile', 'source', 'screenshots']) assert.equal(fs.existsSync(path.join(root, name)), true);
});
test('fresh prepared child in a historical parent is protected', async t => {
  const base = await fixture(t), root = group(base), child = path.join(root, 'deployment/final');
  await app(path.join(child, 'candidate/Voice Record.app'));
  await R.markPrepared(child, 'stage-test');
  const plan = await R.planOldArtifacts({ home: base, beforeDate: '2026-10-01' });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skipped.some(x => x.path === child), true);
});
test('a preparation started after planning is not deleted', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'candidate/Voice Record.app'));
  const plan = await R.planOldArtifacts({ home: base, beforeDate: '2026-10-01' });
  await R.markPrepared(root, 'stage-test');
  const result = await R.applyTargets(plan.targets, { audit: noAudit, probe: noReferences });
  assert.equal(result.removed.length, 0);
  assert.equal(fs.existsSync(pkg), true);
});
test('in-place package edits invalidate the deletion proof', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'candidate/Voice Record.app'));
  const plan = await R.planOldArtifacts({ home: base, beforeDate: '2026-10-01' });
  await fs.promises.writeFile(path.join(pkg, 'Contents/Resources/app.asar'), 'CHANGED PACKAGE');
  await assert.rejects(R.applyTargets(plan.targets, { audit: noAudit, probe: noReferences }), /contents changed/);
  assert.equal(fs.existsSync(pkg), true);
});
test('automatic sweep never treats an unmarked prepared legacy package as garbage', async t => {
  const base = await fixture(t), root = group(base), pkg = await app(path.join(root, 'candidate/Voice Record.app'));
  const plan = await R.planOldArtifacts({ home: base, now: Date.parse('2030-01-05T00:00:00Z') });
  assert.equal(plan.targets.length, 0);
  assert.equal(fs.existsSync(pkg), true);
});
test('automatic legacy cleanup requires an exact parent installation receipt', async t => {
  const base = await fixture(t), root = group(base), dir = path.join(root, 'deployment');
  const installedCandidate = await app(path.join(dir, 'candidate/Voice Record.app'));
  const preparedElsewhere = await app(path.join(root, 'next-phase/candidate/Voice Record.app'));
  await fs.promises.writeFile(path.join(dir, 'installed.json'), JSON.stringify({ installedAt: Date.parse('2026-09-01'), asar: 'a'.repeat(64) }));
  const plan = await R.planOldArtifacts({ home: base, now: Date.parse('2030-01-05T00:00:00Z') });
  assert.deepEqual(plan.targets.map(t => t.path), [installedCandidate]);
  assert.equal(fs.existsSync(preparedElsewhere), true);
});
