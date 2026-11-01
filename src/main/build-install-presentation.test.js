'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBuildInstallPresentation } = require('./build-install-presentation');
const activity = require('../shared/build-install-activity.cjs');
const { createBuildInstallStatus } = require('./build-install-status');
const entry = () => ({ requestId: 'I', jobId: 'J', fingerprint: 'F', state: 'waiting-callback-turn',
  source: { tabId: '753', projectId: 'P', sessionId: 'S' }, createdAt: 1 });
const job = patch => ({ id: 'J', requestId: 'I', running: false, phase: 'finished', cancelled: true,
  callback: { status: 'sent' }, returnTo: { tabId: '753', sessionId: 'S' }, ...patch });
function fixture() {
  const entries = [entry()];
  const owner = { snapshot: () => ({ known: true, entries: JSON.parse(JSON.stringify(entries)) }),
    canCancelConfirmedWait: (e, j, s) => s.known && !s.stale && activity.ownedJob(e, j) && !j.running };
  return { entries, projector: createBuildInstallPresentation({ owner, epoch: 'main' }) };
}
test('observed terminal-installer case remains visible with an honest static proof wait', async () => {
  const h = fixture(), result = h.projector.project({ version: 1, known: true, stale: false, jobs: [job()] }, '753');
  assert.equal(result.continuations.length, 1); assert.equal(result.continuations[0].inheritedActive, false);
  assert.equal(activity.pending(result.continuations[0]), true);
  const ui = await import('../renderer/utils/buildInstallPresentation.mjs');
  assert.equal(ui.buildInstallVisibleInDock(result.jobs[0]), true);
  assert.equal(ui.buildInstallPresentation(result.jobs[0]).label, 'Установка отменена');
  assert.equal(ui.buildInstallPresentation(result.jobs[0]).spinning, false);
});
test('real running installer stays inherited; stale, foreign and absent owners are not fabricated activity', () => {
  const h = fixture();
  assert.equal(h.projector.project({ known: true, stale: false, jobs: [job({ running: true })] }).continuations[0].inheritedActive, true);
  for (const status of [{ known: true, stale: true, jobs: [job({ running: true })] },
    { known: true, stale: false, jobs: [job({ running: true, requestId: 'foreign' })] },
    { known: true, stale: false, jobs: [] }]) {
    const r = h.projector.project(status);
    assert.equal(r.continuations[0].inheritedActive, false);
    assert.ok(r.jobs.some(j => j.continuation?.requestId === 'I'), 'unknown retained wait stays visible');
  }
});
test('new cancellation projection beats an older startup snapshot without changing installer revision', async () => {
  const h = fixture(), status = { known: true, stale: false, jobs: [job({ revision: 24 })] };
  const old = h.projector.project(status, '753');
  h.entries[0].state = 'cancelled';
  const fresh = h.projector.project(status, '753');
  const ui = await import('../renderer/utils/buildInstallPresentation.mjs');
  const rows = ui.mergeBuildInstallJobs([], fresh.jobs, '753');
  assert.equal(ui.mergeBuildInstallJobs(rows, old.jobs, '753'), rows);
  assert.equal(rows[0].continuation.state, 'cancelled');
  assert.equal(rows[0].revision, 24);
});

test('actual global status publication removes both cancelled ghost cards without deleting history or a sibling wait', async () => {
  const entries = ['recent', 'old', 'sibling'].map((id, i) => ({ ...entry(), requestId: id,
    jobId: 'J' + i, source: { tabId: i === 2 ? 'other' : '753', sessionId: 'S' }, state: 'waiting-callback-turn' }));
  const jobs = entries.map(e => ({ ...job(), id: e.jobId, requestId: e.requestId, revision: 24,
    startedAt: 1, returnTo: e.source }));
  const owner = { snapshot: () => ({ entries }), canCancelConfirmedWait: () => false };
  const project = createBuildInstallPresentation({ owner, epoch: 'same-main' });
  const client = createBuildInstallStatus({ token: () => 'private', read: () => ({ version: 1, jobs }) });
  const ui = await import('../renderer/utils/buildInstallPresentation.mjs');
  const initial = project.project({ ...client.snapshot('753'), known: true, stale: false }, '753');
  assert.equal(initial.jobs.filter(ui.buildInstallVisibleInDock).length, 2);
  entries[0].state = entries[1].state = 'cancelled';
  const fresh = project.project({ ...client.snapshot(), known: true, stale: false });
  const rows = ui.mergeBuildInstallJobs(initial.jobs, fresh.jobs, '753');
  assert.equal(rows.length, 2, 'the completed records remain in History');
  assert.equal(rows.filter(ui.buildInstallVisibleInDock).length, 0);
  assert.equal(entries[2].state, 'waiting-callback-turn');
  assert.equal(fresh.jobs.find(j => j.id === 'J2').continuation.state, 'waiting-callback-turn');
  assert.equal(ui.mergeBuildInstallJobs(rows, initial.jobs, '753'), rows, 'old publication cannot revive either ghost');
});

test('one request moves from source reservation to its Job without a second dock card, then cancels once', async () => {
  const { createBuildInstallContinuations } = require('./build-install-continuation');
  const ui = await import('../renderer/utils/buildInstallPresentation.mjs');
  let saved; const source = { tabId: '753', projectId: 'P', sessionId: 'S', toolType: 'codex' };
  const owner = createBuildInstallContinuations({ read: () => saved, write: value => { saved = value; }, receipts: () => ({ list: () => [] }) });
  owner.reserve({ requestId: 'I', source });
  const projector = createBuildInstallPresentation({ owner, epoch: 'one-main' });
  const first = projector.project({ version: 1, known: true, stale: false, jobs: [] });
  let rows = ui.mergeBuildInstallJobs([], first.jobs, '753', first.continuations);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'continuation:I');
  const sibling = { id: 'sibling-J', requestId: 'sibling-I', returnTo: source, running: true, startedAt: 3 };
  rows = ui.mergeBuildInstallJobs(rows, [sibling], '753');
  owner.reserve({ requestId: 'I', jobId: 'J', source });
  const running = projector.project({ version: 1, known: true, stale: false, jobs: [job({ running: true, cancelled: false, callback: { status: 'pending' }, startedAt: 1 })] });
  rows = ui.mergeBuildInstallJobs(rows, running.jobs, '753', running.continuations);
  assert.equal(rows.filter(j => j.requestId === 'I').length, 1, 'same request has one real Job row');
  assert.equal(rows.find(j => j.requestId === 'I').id, 'J');
  owner.cancelRequest({ tabId: '753', requestId: 'I', id: 'J' });
  const stopped = projector.project({ version: 1, known: true, stale: false, jobs: [job({ requestCancelledAt: 10, startedAt: 1 })] });
  rows = ui.mergeBuildInstallJobs(rows, stopped.jobs, '753', stopped.continuations);
  assert.equal(rows.filter(j => j.requestId === 'I' && ui.buildInstallVisibleInDock(j)).length, 0);
  assert.strictEqual(rows.find(j => j.id === sibling.id), sibling, 'unrelated installer stays untouched');
  rows = ui.mergeBuildInstallJobs(rows, first.jobs, '753', first.continuations);
  assert.equal(rows.filter(j => j.requestId === 'I').length, 1, 'late placeholder cannot return');
});

test('a terminal continuation settles its retained card even if the bounded installer cache omitted the job', async () => {
  const ui = await import('../renderer/utils/buildInstallPresentation.mjs');
  const e = entry(), projector = createBuildInstallPresentation({ owner: { snapshot: () => ({ entries: [e] }), canCancelConfirmedWait: () => false }, epoch: 'one-main' });
  const first = projector.project({ known: true, stale: false, jobs: [] });
  let rows = ui.mergeBuildInstallJobs([], first.jobs, '753', first.continuations);
  assert.equal(rows.filter(ui.buildInstallVisibleInDock).length, 1);
  e.state = 'cancelled';
  const cancelled = projector.project({ known: true, stale: false, jobs: [] });
  rows = ui.mergeBuildInstallJobs(rows, cancelled.jobs, '753', cancelled.continuations);
  assert.equal(rows.length, 1, 'history is retained');
  assert.equal(rows[0].continuation.state, 'cancelled');
  assert.equal(rows.filter(ui.buildInstallVisibleInDock).length, 0);
  assert.strictEqual(ui.mergeBuildInstallJobs(rows, first.jobs, '753', first.continuations), rows, 'old pending cannot revive a settled row');
});

test('placeholder aliasing requires the same fingerprint, source, request and compatible Job binding', async () => {
  const ui = await import('../renderer/utils/buildInstallPresentation.mjs');
  const source = { tabId: '753', sessionId: 'S' }, projection = { epoch: 'main', revision: 1 };
  const e = { requestId: 'I', fingerprint: 'F', source, state: 'waiting-install', projection };
  const old = { id: 'continuation:I', requestId: 'I', returnTo: source, running: false, continuation: e, projection };
  for (const patch of [{ fingerprint: 'other' }, { source: { ...source, sessionId: 'foreign' } }, { requestId: 'other' }]) {
    const current = { id: 'J', requestId: 'I', returnTo: source, running: true, projection: { epoch: 'main', revision: 2 },
      continuation: { ...e, jobId: 'J', ...patch } };
    assert.equal(ui.mergeBuildInstallJobs([old], [current], '753').length, 2, JSON.stringify(patch));
  }
  const unknown = ui.mergeBuildInstallJobs([old], [], '753', []);
  assert.strictEqual(unknown[0], old, 'absence is not cancellation evidence');
  const foreign = { ...e, state: 'cancelled', fingerprint: 'foreign', projection: { epoch: 'main', revision: 2 } };
  assert.strictEqual(ui.mergeBuildInstallJobs([old], [], '753', [foreign])[0], old);
});
