'use strict';

const { createHash } = require('node:crypto');
const fail = code => { throw Object.assign(Error(code), { code, statusCode: 409 }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][\w:.-]{0,179}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Separate from the legacy CLI capture and from a read-only interruption report.
// Only the app-owned receiver supplies the captured Main identity.
function voiceInstallBinding(raw) {
  const source = raw?.source;
  if (raw?.version !== 1 || !id(raw.requestId) || !id(raw.jobId) || !sha(raw.requestHash)
    || raw.requestHashVersion !== 2 || raw.operationId !== 'voice-force-' + raw.jobId
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,119}$/.test(raw.operationId)
    || raw.maintenanceOperationId !== 'install:noted:' + raw.jobId
    || raw.callbackHandoffId !== 'build-install-return:' + raw.jobId
    || !Number.isInteger(raw.sourceMainPid) || raw.sourceMainPid < 1
    || typeof raw.sourceInstanceId !== 'string' || !raw.sourceInstanceId
    || !source?.tabId || !source.projectId || !source.sessionId
    || !['claude', 'codex'].includes(source.toolType)
    || source.expectedTarget?.toolType !== source.toolType
    || source.expectedTarget?.sessionId !== source.sessionId) fail('voice_install_binding_invalid');
  const value = { version: 1, requestId: raw.requestId, requestHash: raw.requestHash, requestHashVersion: 2,
    jobId: raw.jobId, operationId: raw.operationId, maintenanceOperationId: raw.maintenanceOperationId,
    callbackHandoffId: raw.callbackHandoffId, sourceMainPid: raw.sourceMainPid, sourceInstanceId: raw.sourceInstanceId,
    source: JSON.parse(JSON.stringify(source)) };
  const bindingDigest = digest(value);
  if (raw.bindingDigest != null && raw.bindingDigest !== bindingDigest) fail('voice_install_binding_changed');
  return { ...value, bindingDigest };
}
function sameVoiceInstallBinding(a, b) {
  try { return voiceInstallBinding(a).bindingDigest === voiceInstallBinding(b).bindingDigest; }
  catch { return false; }
}
function assertVoiceInstallJob(binding, job, stage) {
  const value = voiceInstallBinding(binding);
  if (!job || job.id !== value.jobId || job.requestId !== value.requestId
    || job.requestHash !== value.requestHash || job.requestHashVersion !== 2
    || job.force !== true || job.autoContinueInterruptedTabs !== true
    || digest(job.returnSource) !== digest(value.source)
    || job.returnTo?.notifyOnSuccess === false) fail('voice_install_job_changed');
  if (job.autoContinue?.binding && !sameVoiceInstallBinding(value, job.autoContinue.binding)) fail('voice_install_binding_changed');
  if (stage === 'register' && (!job.running || job.cancelled || job.buildStartedAt)) fail('voice_install_registration_closed');
  if (stage === 'capture' && (!job.running || job.cancelled || !job.autoContinue?.quitAuthorizedAt
    || !sameVoiceInstallBinding(value, job.autoContinue.binding))) fail('voice_install_capture_not_authorized');
  if (stage === 'activate') {
    const result = job.installResult;
    if (result?.protocol !== 1 || result.nonce !== value.jobId || result.force !== true) fail('voice_install_recovery_not_authorized');
    const installed = result?.protocol === 1 && result.nonce === value.jobId && result.force === true
      && result.installed === true && result.launchRequested === true;
    const reopened = result?.recovery?.status === 'previous-app-reopened';
    if (job.running || (!installed && !reopened)
      || result?.maintenance?.operationId !== value.maintenanceOperationId
      || result.maintenance.complete !== true) fail('voice_install_recovery_not_authorized');
  }
  return value;
}
module.exports = { voiceInstallBinding, sameVoiceInstallBinding, assertVoiceInstallJob };
