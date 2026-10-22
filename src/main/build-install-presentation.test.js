'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBuildInstallPresentation } = require('./build-install-presentation');
const activity = require('../shared/build-install-activity.cjs');
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
  assert.match(ui.buildInstallPresentation(result.jobs[0]).label, /подтверждения продолжения/);
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
