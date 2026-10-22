'use strict';
const { randomUUID } = require('node:crypto');
const activity = require('../shared/build-install-activity.cjs');

// One order for IPC/SSE/GET projections. It does not alter installer revisions,
// persistent callback intent, delivery receipts or completion authority.
function createBuildInstallPresentation({ owner, epoch = randomUUID() }) {
  let revision = 0;
  const project = (status, tabId = null) => {
    const snapshot = owner.snapshot(), projection = { epoch, revision: ++revision };
    const entries = snapshot.entries.filter(entry => !tabId || entry.source.tabId === tabId).map(entry => {
      const job = status.jobs.find(job => activity.ownedJob(entry, job));
      return { ...entry, projection, inheritedActive: activity.inherited(entry, job, status),
        canCancelContinuation: owner.canCancelConfirmedWait(entry, job, status) };
    });
    const jobs = status.jobs.map(job => ({ ...job, projection,
      continuation: entries.find(entry => activity.ownedJob(entry, job)) || null }));
    // A retained guard must never be an invisible wait just because its older
    // installer job has fallen out of the owner's bounded history.
    for (const entry of entries) if (activity.pending(entry) && !jobs.some(job => activity.ownedJob(entry, job))) {
      jobs.push({ id: entry.jobId || 'continuation:' + entry.requestId, requestId: entry.requestId,
        revision: 0, startedAt: entry.createdAt, running: false, phase: 'finished', ok: null,
        returnTo: entry.source, continuation: entry, projection });
    }
    return { ...status, projection, jobs, continuationsKnown: true, continuations: entries };
  };
  return { project };
}
module.exports = { createBuildInstallPresentation };
