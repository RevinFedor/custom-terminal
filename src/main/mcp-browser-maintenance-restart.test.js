'use strict';
// Actual host/protocol + private durable journals. The Main activation receipt
// is controlled; no installed hub, browser, provider or production storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const p = require('./research-host-protocol.cjs');
const { createBrowserHost } = require('./mcp-browser-maintenance');

async function fixture(t, { commit = true } = {}) {
  const parent = process.env.SC_OWN_HOST_FIXTURE_ROOT
    || path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'host-restart-private-'));
  const ingressFile = path.join(root, 'ingress.json');
  const f = { version: 1, fenceId: 'private-fence', barrierId: 'private:completed',
    revision: 1, scope: ['private-browser'], expectedMainRelease: 'private-release',
    expectedExtensionRelease: 'private-release' };
  f.digest = p.digest(f);
  const ingress = { version: 1, storeEpoch: 'private-ingress-epoch',
    fences: [{ ...f, state: 'held' }] };
  p.atomic(ingressFile + '.initialized', { version: 1, storeEpoch: ingress.storeEpoch });
  p.atomic(ingressFile, ingress);
  const entry = path.join(root, 'browser', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// private inert Browser binding\n');
  fs.writeFileSync(path.join(path.dirname(entry), 'host-contract.json'), JSON.stringify({
    version: 1, kind: 'sc-browser', entry: 'index.js', files: { 'index.js': p.hashFile(entry) },
  }));
  const options = { hostId: 'private-noted', port: 1, ingressFile,
    root: path.join(root, 'hosts'), configurationDigest: p.digest({ configuration: 'same' }),
    definitions: { browser: { command: 'node', args: [entry] } } };
  let host = createBrowserHost(options);
  const initial = host.current();
  const identity = { barrierId: f.barrierId, migrationId: 'private:cut' };
  await host.prepare(identity);
  const receipt = await host.cut(identity);
  const releaseDigest = p.digest({ release: 'committed' });
  Object.assign(ingress.fences[0], { state: 'released', releasedRevision: 2, releaseDigest });
  p.atomic(ingressFile, ingress);
  const plan = { version: 1, ...identity, barrierRevision: 1, ingressEpoch: ingress.storeEpoch,
    fenceId: f.fenceId, fenceDigest: f.digest, phase: 'retired',
    receiptDigest: p.digest([receipt]), hosts: [{
      hostId: initial.hostId, generation: initial.generation, process: initial.process,
      configurationDigest: initial.configurationDigest,
      ingressAuthorityDigest: p.validateIngressAuthority(initial.ingressAuthority), port: 1,
    }], activationPermit: { version: 1, barrierId: f.barrierId, releaseDigest,
      workers: [{ instanceId: 'private-browser', runtimeId: 'private-runtime', connectionId: 'private-connection' }],
      nativeJournalStoreEpoch: 'private-native-epoch', nativeCoverageDigest: p.digest({ native: true }),
      committed: false } };
  const plans = p.openJournal(path.join(root, 'research-host-plans.json'), { version: 1, plans: [plan] });
  await host.release(identity);
  function editPlan(edit) {
    const data = plans.load(); edit(data.plans[0]); plans.save(data);
  }
  if (commit) editPlan(value => { value.activationPermit.committed = true; });
  t.after(() => { host.close(); plans.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    options, ingress, ingressFile, initial, receipt, editPlan,
    get host() { return host; },
    restart(overrides = {}) { host.close(); host = createBrowserHost({ ...options, ...overrides }); return host; },
    editHost(edit) {
      host.close();
      const writer = p.openJournal(host.file);
      try { const value = writer.load(); edit(value); writer.save(value); } finally { writer.close(); }
      host = createBrowserHost(options);
    },
  };
}

test('completed activation remains usable through repeated same-authority host restarts', async t => {
  const f = await fixture(t);
  assert.equal(f.host.status().held, false);
  const previousReceipt = f.host.current().holds[0].receipt;
  for (let i = 0; i < 3; i++) {
    f.restart();
    assert.notEqual(f.host.current().generation, f.initial.generation);
    assert.equal(f.host.status().held, false);
    assert.deepEqual(f.host.status().heldBarrierIds, []);
    assert.equal(f.host.assertEntry('browser').kind, 'cooperative');
    assert.deepEqual(f.host.current().holds[0].receipt, previousReceipt);
  }
});

test('restart cannot release activation whose final Main commit never happened', async t => {
  const f = await fixture(t, { commit: false });
  f.restart();
  assert.equal(f.host.status().held, true);
  assert.throws(() => f.host.assertEntry('browser'), { code: 'RESEARCH_MAINTENANCE_HELD' });
});

test('changed configuration does not inherit the historical activation', async t => {
  const f = await fixture(t);
  f.restart({ configurationDigest: p.digest({ configuration: 'changed' }) });
  assert.equal(f.host.status().held, true);
  assert.throws(() => f.host.assertEntry('browser'), { code: 'RESEARCH_MAINTENANCE_HELD' });
});

for (const [name, edit] of [
  ['missing ancestor', host => { host.lineage = []; }],
  ['wrong ancestor process', host => { host.lineage[0].process.birth += ':different'; }],
  ['missing local retirement receipt', host => { host.holds[0].receipt = null; }],
  ['changed local release receipt', host => { host.holds[0].release.receiptId = 'different'; }],
  ['unreleased local hold', host => { host.holds[0].state = 'retired'; }],
]) test(name + ' stays held across restart', async t => {
  const f = await fixture(t); f.restart(); f.editHost(edit);
  assert.equal(f.host.status().held, true);
  assert.throws(() => f.host.assertEntry('browser'), { code: 'RESEARCH_MAINTENANCE_HELD' });
});

for (const [name, edit] of [
  ['uncommitted permit', plan => { plan.activationPermit.committed = false; }],
  ['wrong release', plan => { plan.activationPermit.releaseDigest = p.digest('different'); }],
  ['wrong native proof', plan => { plan.activationPermit.nativeCoverageDigest = ''; }],
  ['wrong fence', plan => { plan.fenceDigest = p.digest('different'); }],
  ['wrong epoch', plan => { plan.ingressEpoch = 'different'; }],
  ['wrong enrolled process', plan => { plan.hosts[0].process.birth += ':different'; }],
  ['wrong ingress authority', plan => { plan.hosts[0].ingressAuthorityDigest = p.digest('different'); }],
]) test(name + ' cannot authorize a successor', async t => {
  const f = await fixture(t); f.editPlan(edit); f.restart();
  assert.equal(f.host.status().held, true);
  assert.throws(() => f.host.assertEntry('browser'), { code: 'RESEARCH_MAINTENANCE_HELD' });
});

test('a later active maintenance still blocks a previously activated successor', async t => {
  const f = await fixture(t); f.restart();
  const next = { version: 1, barrierId: 'private:next', fenceId: 'private-next-fence',
    revision: 1, scope: ['private-browser'], expectedMainRelease: 'private-release',
    expectedExtensionRelease: 'private-release' };
  f.ingress.fences.push({ ...next, digest: p.digest(next), state: 'held' });
  p.atomic(f.ingressFile, f.ingress);
  assert.equal(f.host.status().held, true);
  assert.throws(() => f.host.assertEntry('browser'), { code: 'RESEARCH_MAINTENANCE_HELD' });
});

test('an unresolved post-activation child spawn cannot be forgotten by restarting the host', async t => {
  const f = await fixture(t);
  const env = {};
  const childId = f.host.beforeSpawn('browser', env);
  const previous = f.host.current();
  assert.equal(previous.children.find(c => c.childId === childId).state, 'spawning');
  assert.throws(() => f.restart(), { code: 'research_host_child_manifest_unavailable' });
  const retained = p.readJournal(f.host.file);
  assert.deepEqual(retained.children, previous.children);
  assert.deepEqual(retained.holds, previous.holds);
});
