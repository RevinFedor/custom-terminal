'use strict';

// Waiting for proof is a completion guard, not evidence of running work.
const SETTLED = new Set(['continued', 'ended-without-callback', 'cancelled']);
const pending = entry => !!entry && !SETTLED.has(entry.state);
function ownedJob(entry, job) {
  const source = job?.returnSource || job?.returnTo;
  return !!entry && !!job && entry.requestId === job.requestId && entry.jobId === job.id
    && source?.tabId === entry.source?.tabId && source?.sessionId === entry.source?.sessionId;
}
function inherited(entry, job, snapshot) {
  return pending(entry) && snapshot?.known === true && snapshot.stale === false
    && ownedJob(entry, job) && job.running === true;
}
function confirmedReturn(entry, job, record) {
  const audit = record?.auditIdentity;
  return ownedJob(entry, job) && job.running === false && job.phase === 'finished'
    && job.installOutcomeUnknown !== true && job.callback?.status === 'sent'
    && record?.state === 'confirmed' && record.tabId === entry.source.tabId
    && record.handoffId === 'build-install-return:' + job.id
    && record.provider === entry.source.toolType && record.sessionId === entry.source.sessionId
    && audit?.attemptId === record.attemptId && audit.sessionId === record.sessionId
    && !!(audit.entryUuid || audit.sourceIdentity);
}
function olderProjection(previous, incoming) {
  if (!previous?.projection) return false;
  if (!incoming?.projection) return true;
  return previous.projection.epoch === incoming.projection.epoch
    && incoming.projection.revision < previous.projection.revision;
}
module.exports = { pending, ownedJob, inherited, confirmedReturn, olderProjection };
