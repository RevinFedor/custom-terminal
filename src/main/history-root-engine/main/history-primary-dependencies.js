'use strict';

// Committed prompt/timing/topology witnesses include captured ancestor context.
// Exact trigger attestation permits scoped foreign-write invalidation; unknown
// schemas retain the conservative database witness. Local writes/rollback and
// uncommitted state never acquire a reusable token by a missing version row.
const { getCodexProcessActionOwnershipRevision } = require('./codex-process-action-ownership');
const { readPrimarySidecarWitness } = require('./history-primary-sidecar-witness');
const local = require('./history-primary-compat/src/renderer/utils/primaryLocalCompat.ts.cjs');
const MAX_SESSIONS = 16;
function capturePrimaryDependencies(service, canonical, sessions, options = {}) {
  const manager=service.promptPresentationStore || null, connection=manager?.db || null;
  if (!Array.isArray(sessions) || sessions.length>MAX_SESSIONS) return {known:false,reason:'runtime-dependency-limit'};
  const versions=manager?readPrimarySidecarWitness(connection,sessions,options.tabId,options):null;
  if (manager&&!versions) return {known:false,reason:'committed-sidecar-witness-unavailable'};
  let sourceCurrent=true;
  const current=service.codexData?._api?.isCodexSourceSnapshotCurrent;
  try { if(typeof current==='function')sourceCurrent=current(canonical.sourceSnapshot)===true; }
  catch { return {known:false,reason:'source-witness-unavailable'}; }
  return Object.freeze({known:true,service,manager,connection,versions,sourceCurrent,
    runtime:getCodexProcessActionOwnershipRevision(sessions)});
}
function comparePrimaryDependencies(before,after) {
  if(!before?.known||!after?.known)return {ok:false,reason:before?.reason||after?.reason||'dependency-witness-unavailable',requiredClass:'semantic'};
  if(!before.sourceCurrent||!after.sourceCurrent)return {ok:false,reason:'source-authority-changed',requiredClass:'source'};
  if(before.service!==after.service||before.manager!==after.manager||before.connection!==after.connection)
    return {ok:false,reason:'sidecar-owner-changed',requiredClass:'semantic'};
  if(before.runtime!==after.runtime)return {ok:false,reason:'runtime-ownership-changed',requiredClass:'semantic'};
  if(before.versions?.mode!==after.versions?.mode||before.versions?.values.length!==after.versions?.values.length
    ||before.versions?.values.some((n,i)=>n!==after.versions.values[i]))
    return {ok:false,reason:'sidecar-database-changed',requiredClass:'semantic'};
  return {ok:true};
}
function primaryTimeWindow(locals,from,to) {
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<from||!Array.isArray(locals))
    return {known:false,reason:'merge-clock-unwitnessed'};
  let notAfter=Number.MAX_SAFE_INTEGER;
  for(const entry of locals) {
    if(!local.isLocalPromptEntry(entry)||!['failed','cancelled'].includes(entry.queueStatus)
      ||local.historyPromptFailureHasRecoveryOwner(entry))continue;
    const base=entry.statusChangedAt||entry.optimisticAt||Date.parse(entry.timestamp||'');
    // Legacy fallback-to-now is reevaluated by the original helper each time;
    // do not invent a reusable expiry for it or coerce malformed timestamps.
    if(typeof base!=='number'||!Number.isFinite(base)||!base)return {known:false,reason:'local-ttl-unwitnessed'};
    const expiry=base+local.HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS;
    if(!Number.isSafeInteger(expiry))return {known:false,reason:'local-ttl-unwitnessed'};
    if(expiry>from)notAfter=Math.min(notAfter,expiry);
  }
  return Object.freeze({known:true,notBefore:to,notAfter});
}
function checkPrimaryTime(window,now=Date.now()) {
  if(!window?.known)return {ok:false,reason:window?.reason||'merge-clock-unwitnessed',requiredClass:'semantic'};
  if(!Number.isSafeInteger(now)||now<window.notBefore)return {ok:false,reason:'merge-clock-regressed',requiredClass:'semantic'};
  if(now>=window.notAfter)return {ok:false,reason:'local-ttl-boundary',requiredClass:'semantic'};
  return {ok:true};
}
module.exports={capturePrimaryDependencies,comparePrimaryDependencies,primaryTimeWindow,checkPrimaryTime,MAX_SESSIONS};
