'use strict';
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const p = require('./research-host-protocol.cjs');

function createBrowserHost({ hostId, port, definitions, configurationDigest, ingressFile = p.INGRESS,
  root = p.HOSTS, log = () => {} } = {}) {
  if (!p.id(hostId)) p.fail('research_host_identity_invalid');
  const dir = path.join(root, hostId), file = path.join(dir, 'host.json');
  const self = p.processIdentity(process.pid), generation = randomUUID();
  const journal = p.openJournal(file, { version: 1, hostId, generation, process: self, port,
    configurationDigest, ingressAuthority: p.createIngressAuthority(ingressFile),
    ingressEpoch: null, ingressBasis: [], children: [], holds: [], lineage: [], coverage: 'enrolled_only' });
  let state = journal.load();
  let authorityDigest;
  try {
    if (state.hostId !== hostId) p.fail('research_host_identity_changed');
    authorityDigest = p.validateIngressAuthority(state.ingressAuthority, ingressFile);
    ingressFile = state.ingressAuthority.file;
    // A child can observe the first file-first hold before this host receives
    // prepare. Recover that durable epoch; a restarted host cannot forget it.
    for (const child of state.children) {
      if (child.ingressAuthorityDigest !== authorityDigest) p.fail('research_host_ingress_authority_required');
      let snapshot;
      try { snapshot = p.readJournal(path.join(dir, 'children', child.childId + '.json')); }
      catch (error) { if (error.code === 'ENOENT') p.fail('research_host_child_manifest_unavailable'); throw error; }
      if (p.validateIngressAuthority(snapshot.ingressAuthority) !== authorityDigest
        || snapshot.childId !== child.childId || snapshot.hostId !== hostId
        || snapshot.generation !== child.generation) p.fail('research_host_child_manifest_invalid');
      if (snapshot.ingressEpoch !== null && !p.id(snapshot.ingressEpoch)) p.fail('research_host_ingress_epoch_required');
      if (state.ingressEpoch && snapshot.ingressEpoch && state.ingressEpoch !== snapshot.ingressEpoch) p.fail('research_ingress_storage_invalid');
      p.readBoundIngress(snapshot.ingressAuthority, snapshot.ingressEpoch, snapshot.ingressBasis);
      state.ingressEpoch ||= snapshot.ingressEpoch;
    }
    const ingress = p.readBoundIngress(state.ingressAuthority, state.ingressEpoch, state.ingressBasis);
    state.ingressEpoch = ingress.storeEpoch; state.ingressBasis = p.ingressBasis(ingress);
    if (state.generation !== generation) state.lineage.push({ generation: state.generation, process: state.process });
    state.generation = generation; state.process = self; state.port = port; state.configurationDigest = configurationDigest;
    journal.save(state);
  } catch (error) { journal.close(); throw error; }
  const tokenFile = path.join(dir, 'auth.json');
  let auth = p.read(tokenFile, true);
  if (!auth) { auth = { version: 1, token: randomBytes(32).toString('hex') }; p.atomic(tokenFile, auth); }
  if (!/^[a-f0-9]{64}$/.test(auth.token || '')) p.fail('research_host_auth_invalid');
  let chain = Promise.resolve();
  const serial = run => { const next = chain.catch(() => {}).then(run); chain = next; return next; };
  function current() {
    const value = journal.load();
    if (value.generation !== generation || !p.sameProcess(value.process, self)) p.fail('research_host_replaced');
    if (p.validateIngressAuthority(value.ingressAuthority, ingressFile) !== authorityDigest) p.fail('research_host_ingress_authority_changed');
    return value;
  }
  function readIngress(value = current()) {
    const ingress = p.readBoundIngress(value.ingressAuthority, value.ingressEpoch, value.ingressBasis);
    const basis = p.ingressBasis(ingress);
    if (value.ingressEpoch !== ingress.storeEpoch || p.digest(value.ingressBasis) !== p.digest(basis)) {
      value.ingressEpoch = ingress.storeEpoch; value.ingressBasis = basis; journal.save(value);
    }
    return ingress;
  }
  function assertEntry(name) {
    const def = definitions[name], descriptor = p.binding(name, def);
    if (!descriptor) return null;
    const value = current(), ingress = readIngress(value);
    p.assertIngressOpen(ingress);
    if (p.hostHeld(value, ingressFile)) p.fail('RESEARCH_MAINTENANCE_HELD');
    return descriptor;
  }
  function beforeSpawn(name, childEnv) {
    const descriptor = assertEntry(name);
    if (!descriptor || descriptor.kind !== 'cooperative') return null;
    const value = current(), childId = randomUUID();
    value.children.push({ childId, name, generation, bindingDigest: descriptor.bindingDigest,
      contractDigest: descriptor.contractDigest, ingressAuthorityDigest: authorityDigest, state: 'spawning', process: null });
    journal.save(value);
    Object.assign(childEnv, { SC_BROWSER_HOST_FILE: file, SC_BROWSER_HOST_GENERATION: generation,
      SC_BROWSER_CHILD_ID: childId, SC_BROWSER_CONTRACT_DIGEST: descriptor.contractDigest,
      SC_BROWSER_INGRESS_AUTHORITY_DIGEST: authorityDigest });
    assertEntry(name); return childId;
  }
  function afterSpawn(childId, proc) {
    if (!childId) return;
    const value = current(), row = value.children.find(c => c.childId === childId);
    const pin = p.processIdentity(proc.pid);
    if (!row || !pin || pin.parentPid !== process.pid) p.fail('research_host_child_owner_unproven');
    row.process = pin; row.state = 'spawned'; journal.save(value);
  }
  const childFile = child => path.join(dir, 'children', child.childId + '.json');
  function childSnapshot(child) {
    if (!child.process) p.fail('research_host_spawn_outcome_unknown');
    const value = p.readJournal(childFile(child));
    if (value.protocol !== 'sc-browser-host-v1' || value.childId !== child.childId || value.hostId !== hostId
      || value.generation !== child.generation || !p.sameProcess(value.process, child.process)
      || value.contractDigest !== child.contractDigest || value.bindingDigest !== child.bindingDigest
      || p.validateIngressAuthority(value.ingressAuthority) !== authorityDigest || child.ingressAuthorityDigest !== authorityDigest
      || !Array.isArray(value.helpers) || !Array.isArray(value.attempts) || !Array.isArray(value.nativeReceipts)) p.fail('research_host_child_manifest_invalid');
    return value;
  }
  function assertHold(hold) {
    const value = current(), f = readIngress(value).fences.find(f => f.barrierId === hold.barrierId);
    if (f?.state !== 'held') p.fail('research_host_fence_not_held');
    if (f.digest !== hold.fenceDigest || f.fenceId !== hold.fenceId || f.revision !== hold.barrierRevision
      || hold.ingressAuthorityDigest !== authorityDigest || value.configurationDigest !== hold.configurationDigest) p.fail('research_host_fence_changed');
    const local = value.holds.find(h => h.barrierId === hold.barrierId);
    if (!local || local.migrationId !== hold.migrationId || local.state === 'released') p.fail('research_host_hold_changed');
    return value;
  }
  function prepare(input) { return serial(() => {
    if (!p.id(input.barrierId) || !p.migrationId(input.migrationId)) p.fail('research_host_identity_required');
    const value = current(), f = readIngress(value).fences.find(f => f.barrierId === input.barrierId);
    if (f?.state !== 'held') p.fail('research_host_fence_not_held');
    const previous = value.holds.find(h => h.barrierId === input.barrierId);
    if (previous) {
      if (previous.migrationId !== input.migrationId) p.fail('research_host_hold_conflict');
      assertHold(previous); return structuredClone(previous);
    }
    const unsupported = Object.entries(definitions).filter(([name, def]) => p.binding(name, def)?.kind === 'unsupported').map(([name]) => name);
    // Commit the hold even for unsupported owners. No subsequent start/restart
    // may exploit an unavailable adapter or a Main-offline interval.
    const hold = { version: 1, barrierId: input.barrierId, migrationId: input.migrationId,
      barrierRevision: f.revision, fenceId: f.fenceId, fenceDigest: f.digest,
      hostId, preparedGeneration: generation, configurationDigest, ingressAuthorityDigest: authorityDigest, scope: f.scope,
      childIds: value.children.filter(c => c.state !== 'retired').map(c => c.childId),
      unsupported, state: 'held', receipt: null };
    value.holds.push(hold); journal.save(value); log('[MCPHub] Browser maintenance held');
    return structuredClone(hold);
  }); }
  function cut(input) { return serial(async () => {
    let value = current();
    const hold = value.holds.find(h => h.barrierId === input.barrierId && h.migrationId === input.migrationId);
    if (!hold) p.fail('research_host_hold_required');
    if (hold.receipt) return structuredClone(hold.receipt); // lost ACK: immutable SAME receipt
    assertHold(hold);
    if (hold.unsupported.length) p.fail('research_host_adapter_required', { bindings: hold.unsupported });
    const children = hold.childIds.map(id => value.children.find(c => c.childId === id));
    // Validate all manifests before the first signal. A partial cut cannot reopen.
    for (const child of children) {
      const manifest = childSnapshot(child);
      // A multiplexed Browser process is one retirement unit. A narrower
      // profile fence cannot authorize termination of another profile's work.
      const targets = [...manifest.attempts.map(a => a.target), ...manifest.nativeReceipts.map(r => r.receipt?.target)].filter(Boolean);
      if (targets.some(target => !hold.scope.includes(target.instanceId))) p.fail('research_host_scope_incomplete');
    }
    const manifests = [], retired = [];
    for (const child of children) {
      await p.retire(child.process, () => assertHold(hold));
      // Child cannot append/spawn now. A pre-termination snapshot is not final.
      const snapshot = childSnapshot(child);
      for (const helper of snapshot.helpers) {
        if (!helper.process || helper.state !== 'spawned') p.fail('research_host_helper_spawn_unknown');
        await p.retire(helper.process, () => assertHold(hold));
        retired.push(helper.process);
      }
      manifests.push(snapshot); retired.push(child.process);
    }
    value = assertHold(hold);
    for (const pin of retired) if (p.processIdentity(pin.pid)) p.fail('research_host_retirement_changed');
    // Full immutable no-replay carry is host-owned. No provider/job state mutation.
    const receipt = { version: 1, receiptId: randomUUID(), hostId, generation,
      barrierId: hold.barrierId, migrationId: hold.migrationId, barrierRevision: hold.barrierRevision,
      fenceId: hold.fenceId, fenceDigest: hold.fenceDigest, configurationDigest, ingressAuthorityDigest: authorityDigest,
      manifestDigest: p.digest(manifests), manifests, retired, coverage: 'enrolled_only',
      disposition: 'host_local_execution_authority_retired', remoteOutcome: 'unchanged', replayPermission: false };
    const saved = value.holds.find(h => h.barrierId === hold.barrierId);
    saved.receipt = receipt; saved.state = 'retired';
    for (const child of value.children) if (hold.childIds.includes(child.childId)) child.state = 'retired';
    journal.save(value); return structuredClone(receipt);
  }); }
  function release(input) { return serial(() => {
    const value = current(), hold = value.holds.find(h => h.barrierId === input.barrierId && h.migrationId === input.migrationId);
    if (!hold?.receipt) p.fail('research_host_retirement_required');
    if (hold.ingressAuthorityDigest !== authorityDigest) p.fail('research_host_ingress_authority_changed');
    const f = readIngress(value).fences.find(f => f.barrierId === hold.barrierId);
    if (f?.state !== 'released' || f.fenceId !== hold.fenceId || f.digest !== hold.fenceDigest
      || f.releasedRevision !== hold.barrierRevision + 1) p.fail('research_host_release_unproven');
    const plans = p.readJournal(path.join(path.dirname(ingressFile), 'research-host-plans.json'));
    const plan = plans.plans.find(v => v.barrierId === hold.barrierId && v.migrationId === hold.migrationId);
    const permit = plan?.activationPermit;
    if (plan?.fenceDigest !== hold.fenceDigest || permit?.version !== 1 || permit.barrierId !== hold.barrierId
      || permit.releaseDigest !== f.releaseDigest || !Array.isArray(permit.workers) || !permit.workers.length
      || !permit.nativeJournalStoreEpoch || !/^[a-f0-9]{64}$/.test(permit.nativeCoverageDigest || '')
      || !plan.hosts.some(h => h.hostId === hostId && h.generation === generation && h.configurationDigest === configurationDigest
        && h.ingressAuthorityDigest === authorityDigest)) p.fail('research_host_activation_permit_required');
    if (hold.state === 'release_ready') {
      if (hold.release.releaseDigest !== f.releaseDigest) p.fail('research_host_release_changed');
      return hold.release;
    }
    hold.state = 'release_ready'; hold.release = { version: 1, hostId, receiptId: hold.receipt.receiptId,
      barrierId: hold.barrierId, migrationId: hold.migrationId, releaseDigest: f.releaseDigest, replayPermission: false };
    journal.save(value); return hold.release;
  }); }
  async function handle(req, res) {
    if (!req.url?.startsWith('/mcp/_browser-maintenance')) return false;
    const reply = (status, out) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return true; };
    if (!p.authorized(req, auth.token)) return reply(403, { ok: false, code: 'research_host_auth_required' });
    try {
      if (req.method === 'GET' && req.url === '/mcp/_browser-maintenance') return reply(200, { ok: true, ...current() });
      let chunks = [], size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2048) p.fail('research_host_body_too_large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks));
      if (req.method !== 'POST' || input.version !== 1 || input.hostId !== hostId || input.generation !== generation
        || Object.keys(input).some(k => !['version', 'hostId', 'generation', 'barrierId', 'migrationId'].includes(k))) p.fail('research_host_identity_only');
      const action = { '/mcp/_browser-maintenance/prepare': prepare, '/mcp/_browser-maintenance/cut': cut,
        '/mcp/_browser-maintenance/release': release }[req.url];
      if (!action) p.fail('research_host_route_invalid');
      return reply(200, { ok: true, hostId, generation, result: await action(input) });
    } catch (error) { return reply(409, { ok: false, code: error.code || 'research_host_unavailable',
      replayPermission: false, ...(error.detail ? { detail: error.detail } : {}) }); }
  }
  function status() {
    try { const value = current(), ingress = readIngress(value); return { version: 1, hostId, generation, coverage: 'enrolled_only',
      ingressAuthority: value.ingressAuthority, ingressEpoch: value.ingressEpoch, ingressBasis: value.ingressBasis,
      held: ingress.fences.some(f => f.state === 'held') || p.hostHeld(value, ingressFile),
      heldBarrierIds: [...new Set([...ingress.fences.filter(f => f.state === 'held').map(f => f.barrierId),
        ...value.holds.filter(h => h.state !== 'released').map(h => h.barrierId)])] }; }
    catch (error) { return { version: 1, hostId, held: true, code: error.code || 'research_host_unavailable' }; }
  }
  return { assertEntry, beforeSpawn, afterSpawn, prepare, cut, release, handle, status, file, current, close: journal.close };
}
module.exports = { createBrowserHost };
