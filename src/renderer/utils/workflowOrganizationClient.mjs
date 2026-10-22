import {uiDragDiagnostic,uiDragActionId,uiDiagnosticAbsNow} from './uiPerformanceDiagnostics.mjs';
import { captureSpaceLayout, emptySpaceLayout } from './workspaceSpacesModel.mjs';
import { INBOX_WORKFLOW_ID } from './workflowMembership.mjs';
import { orderedWorkflows } from '../../shared/workflow-order.cjs';
import {newerWorkflowGroups} from './workflowGroupClient.mjs';
import {paneStripReleaseSnapshot} from './paneStripReleasePair.mjs';

export function isExactGroupCloseGuard(guard, tabId, mutationId) {
  return !!guard && guard.tabId === tabId && typeof guard.mutationId === 'string' && !!guard.mutationId.trim()
    && (mutationId == null || guard.mutationId === mutationId)
    && typeof guard.guardToken === 'string' && !!guard.guardToken.trim();
}

/** Startup owns bootstrap; an external Inbox request must not migrate a partial UI. */
export function waitForOrganizationReady(store) {
  const initial = store.getState();
  if (initial.organizationReady) return Promise.resolve();
  if (initial.organizationError) return Promise.reject(new Error(initial.organizationError));
  return new Promise((resolve,reject) => {
    let stop = () => {},finished = false;
    const check = state => {
      if (finished || !state.organizationReady && !state.organizationError) return;
      finished = true;stop();
      state.organizationReady ? resolve() : reject(new Error(state.organizationError));
    };
    stop = store.subscribe(check);
    if (finished) stop();else check(store.getState());
  });
}

/** Archive source identity and Main's reserved replacement are separate. */
export function archiveRestoreLeaseAddress(lease, namespace, expectedSourceTabId) {
  const entry = lease?.entry;
  const sourceTabId = entry?.tab_id ?? null;
  const targetTabId = entry?.restoreTargetTabId;
  const fail = code => {throw Object.assign(new Error(code),{code});};
  if (!entry || !Number.isSafeInteger(entry.id) || entry.id < 1) fail('archive_restore_entry_missing');
  if (expectedSourceTabId && sourceTabId !== expectedSourceTabId) fail('archive_restore_source_changed');
  if (typeof targetTabId !== 'string' || !targetTabId.trim()) fail('archive_restore_target_missing');
  if (entry.execution_subject_version === 2 && targetTabId !== sourceTabId) fail('archive_restore_subject_changed');
  const replacement = lease.replacement ?? null;
  if (replacement && (replacement.namespace !== namespace || replacement.historyId !== entry.id
    || replacement.sourceTabId !== sourceTabId || replacement.tabId !== targetTabId)) fail('archive_restore_replacement_changed');
  return {sourceTabId,targetTabId,replacement};
}

export function getHistoryTitleTarget(entry) {
  const codex = typeof entry.codex_session_id === 'string' && entry.codex_session_id;
  const claude = typeof entry.claude_session_id === 'string' && entry.claude_session_id;
  if (entry.command_type === 'codex' && codex) return {toolType:'codex',sessionId:codex};
  if (entry.command_type === 'claude' && claude) return {toolType:'claude',sessionId:claude};
  if (codex) return {toolType:'codex',sessionId:codex};
  if (claude) return {toolType:'claude',sessionId:claude};
  return null;
}

/** Generate once per immutable intent; an unknown rename ACK retries that name. */
export function createArchiveTitleRefresher({generateTitle,renameHistory}) {
  const requests = new Map();
  return async input => {
    const frozen = structuredClone(input),signature = JSON.stringify(frozen);
    let operation = requests.get(frozen.requestId);
    if (operation && operation.signature !== signature) throw new Error('archive_request_id_conflict');
    if (!operation) {
      operation = {signature,payload:(async () => {
        const target = getHistoryTitleTarget(frozen.record);
        if (!target) return {failure:'Обновление названия доступно для Claude/Codex'};
        const result = await generateTitle({...target,cwd:frozen.record.cwd,
          source:'GlobalTabArchive.refreshHistoryTitle',reason:'history-context-menu'});
        if (!result?.ok || !result.title) return {failure:result?.error || result?.reason || 'Не удалось получить название'};
        return {request:{...frozen,name:result.title}};
      })()};
      requests.set(frozen.requestId,operation);
    }
    let payload;
    try {payload = await operation.payload;}
    catch (error) {payload = {failure:error?.message || String(error)};}
    if (payload.failure) {
      requests.delete(frozen.requestId);
      return {success:false,disposition:'not-applied',message:payload.failure};
    }
    return renameHistory(structuredClone(payload.request));
  };
}

export function organizationProjection(snapshot, current) {
  if (snapshot?.publication?.version !== 1 || snapshot.publication.migrationVersion !== 1) throw new Error('workflow_publication_unavailable');
  const spaces = orderedWorkflows(snapshot.workflows,snapshot.publication).map(workflow => ({...workflow.metadata,id:workflow.id,kind:workflow.kind,
    organizationRevision:workflow.revision,projectIds:[],layout:workflow.layout}));
  const activeSpaceId = spaces.some(space => space.id === current.activeSpaceId) ? current.activeSpaceId
    : (spaces.find(space => space.kind !== 'inbox')?.id || INBOX_WORKFLOW_ID);
  const active = spaces.find(space => space.id === activeSpaceId);
  const tabWorkflowMembership = Object.fromEntries(snapshot.tabs.filter(tab => tab.membership)
    .map(tab => [tab.tabId,tab.membership]));
  const tabCatalog = Object.fromEntries(snapshot.tabs.map(tab => [tab.tabId,{tabId:tab.tabId,
    subjectVersion:tab.subjectVersion,executionSubject:tab.executionSubject,
    storageId:(tab.nativeRow || tab.legacyRow)?.id ?? null,
    physicalParentTabId:(tab.nativeRow || tab.legacyRow)?.parent_tab_id ?? null,
    namespace:tab.executionSubject?.executionNamespace || tab.executionSubject?.projectId || null,
    active:!!(tab.nativeRow || tab.legacyRow) && tab.nativeRow?.execution_archived !== 1,revision:tab.revision}]));
  const layout = {...emptySpaceLayout(),...(active?.layout || {})};
  if (!layout.splitPanes.length && !layout.activeSpaceTab) layout.splitPanes = [{windowId:activeSpaceId + ':initial',projectId:'__tab_catalog_v2__',tabId:''}];
  return {spaces,organizationWorkflowOrder:spaces.map(space=>space.id),activeSpaceId,...layout,tabWorkflowMembership,tabCatalog,
    organizationReady:true,organizationRevision:snapshot.publication.revision,
    organizationGeneration:snapshot.publication.generation,organizationError:null,
    organizationMigrationScopes:snapshot.migrationScopes || {},globalGroups:newerWorkflowGroups(current.globalGroups,snapshot.globalGroups)};
}

/** Follow a publication's order only if the local order still equals the last
 * accepted publication. A late read/ACK cannot erase a newer local drag. Keep
 * existing space objects (layouts, metadata drafts and MRU remain their own). */
export function reconcileWorkflowOrder(published, current, previousOrder, activeSpaceId) {
  const ids = current.map(space=>space.id);
  if (!Array.isArray(previousOrder) || JSON.stringify(ids)!==JSON.stringify(previousOrder)
    || activeSpaceId && !published.some(space=>space.id===activeSpaceId)) return current;
  const existing=new Map(current.map(space=>[space.id,space]));
  const ordered=published.map(space=>existing.get(space.id) || space);
  return ordered.length===current.length && ordered.every((space,index)=>space===current[index]) ? current : ordered;
}

export function organizationSnapshot(state) {
  const members = {...state.tabWorkflowMembership,...state.pendingTabWorkflowMembership};
  for (const tabId of Object.keys(state.tabCatalog || {}))
    if (!members[tabId]) throw new Error('workflow_incomplete_membership_snapshot:' + tabId);
  return {spaces:state.spaces.map((space,index) => ({...space,order:index,
    layout:space.id === state.activeSpaceId ? captureSpaceLayout(state) : space.layout})),
    tabWorkflowMembership:Object.fromEntries(Object.entries(members)
      .map(([tabId,member]) => {const {localReleaseMutationId,localReleaseQueued,localReleaseExpectedMembershipRevision,...value}=member;return [tabId,{...value,
        expectedMembershipRevision:localReleaseExpectedMembershipRevision
          ?? ((localReleaseMutationId||localReleaseQueued)?member.revision:state.tabWorkflowMembership[tabId]?.revision)}];})),
    ...paneStripReleaseSnapshot(state)};
}

/** Main's named rejection, including Electron's exact Error wrapper, proves
 * not-applied. A transport message merely quoting a code proves nothing. */
export function isOrganizationMutationNotApplied(error) {
  if(error?.disposition==='not-applied')return true;
  const name='workflow_(?:(?:drag_|group_|strip_groups_|strip_release_deferral_)[a-z_]+|revision_changed|membership_revision_changed|incomplete_membership_snapshot|membership_target_missing|space_identity_conflict|system_kind_reserved|id_exists|tab_unknown)';
  if(typeof error?.code==='string'&&new RegExp('^'+name+'$').test(error.code))return true;
  return new RegExp('^(?:Error: )?(?:Error invoking remote method [\\\'\\\"]workflow:mutate[\\\'\\\"]: Error: )?'+name+'$')
    .test(String(error?.message || ''));
}

/** Ordered Main mutations. A missing ACK is recovered with the exact same key. */
export function createOrganizationCommitter({invoke,getPublication,applyPublication,onError,now=uiDiagnosticAbsNow}) {
  let tail = Promise.resolve();
  let pending = 0;
  let unresolved = null;
  // Outstanding released intents already authorized by the caller. A failed
  // predecessor cannot discard their frozen payload. Generic save functions
  // do not enter this queue, and settled/rejected releases are removed at once.
  // Every queued step still uses this lane, apply(), and the existing journal.
  const released=[];
  const stage=(operation,value,extra={})=>{
    const owner=operation.releaseOwner || (operation.released?operation:null);
    if(!owner)return;
    owner.stage=value;
    try {owner.onStage?.({stage:value,mutationId:owner.mutationId || owner.request?.mutationId,
        request:owner.request?structuredClone(owner.request):null,
        ...(!owner.request&&owner.payload?{payload:structuredClone(owner.payload)}:{}),
        ...(owner.preflush?.request?{preparationRequest:structuredClone(owner.preflush.request)}:{}),
        continuationPending:!['accepted','not-applied'].includes(value),...extra});}
    catch(error){try{onError(error);}catch{}}
  };
  const rejectRelease=(operation,error)=>{
    const owner=operation.releaseOwner || (operation.released?operation:null);
    if(!owner)return;
    owner.failure=error;
    const at=released.indexOf(owner);if(at>=0)released.splice(at,1);
    stage(owner,'not-applied');
  };
  const pendingError=(error,operation)=>{
    const owner=operation?.releaseOwner || (operation?.released?operation:null);
    if(!owner)return error;
    // These local stage witnesses are not IPC authority or a new journal key.
    // They distinguish an unsent command's preparation from its own delivery.
    const witness={organizationContinuationPending:!owner.failure&&!owner.completed,
      organizationCommandStage:operation.releaseOwner || !owner.submitted?'preparation':'submitted',
      organizationMutationId:owner.mutationId || owner.request?.mutationId};
    try{return Object.assign(error,witness);}
    catch{return Object.assign(new Error(error?.message || String(error)),{
      code:error?.code,disposition:error?.disposition,cause:error,...witness});}
  };
  // Local scalar witnesses only. These never enter an immutable request or
  // journal fingerprint. One summary preserves the existing late-phase quota.
  const timingFor = (scope,operationKind) => {
    try {
      const gestureId=Object.getOwnPropertyDescriptor(scope || {},'gestureId')?.value;
      return typeof gestureId==='string' && gestureId ? {gestureId,operationKind,timingUnavailable:0}:null;
    } catch {return null;}
  };
  const mark = (timing,key) => {
    if(!timing)return;
    try {const value=now();if(Number.isFinite(value))timing[key]=value;else timing.timingUnavailable++;}
    catch {timing.timingUnavailable++;}
  };
  const summarize = (timing,accepted) => {
    if(!timing)return;
    mark(timing,'operationEndAbs');
    try {uiDragDiagnostic('commit-organization-timings',{...timing,accepted,reason:accepted?'completed':'failed'});}catch{}
  };
  const recover = async timing => {
    if(!unresolved&&!released.length)return null;
    if(timing)timing.recoveryMutationId=unresolved?.request?.mutationId || released[0]?.mutationId;
    mark(timing,'recoveryStartAbs');
    try {return await drain(timing);}finally{mark(timing,'recoveryEndAbs');}
  };
  const confirmed = (result,request) => result && result.success !== false && result.ok !== false
    && Number.isSafeInteger(result.revision) && result.revision >= request.expectedRevision
    && (result.generation == null || Number.isSafeInteger(result.generation) && result.generation >= 0)
    && (result.mutationId == null || result.mutationId === request.mutationId);
  const apply = async (operation,timing=null) => {
    let result = operation.result;
    if (!result) {
      try {
        if(operation.released){operation.submitted=true;stage(operation,'submitted');}
        if(operation.kind==='commitDrag')uiDragDiagnostic('commit-ipc-send',{gestureId:operation.request.gestureId,mutationId:operation.request.mutationId});
        mark(timing,'ipcSendAbs');
        result = await invoke('workflow:mutate',{kind:operation.kind || 'commitWorkspace',request:operation.request,
          ...((operation.kind==='commitDrag' || timing)?{diagnosticActionId:uiDragActionId(timing?.gestureId || operation.request.gestureId)}:{})});
        mark(timing,'ipcReplyAbs');
        if(operation.kind==='commitDrag')uiDragDiagnostic('commit-ipc-reply',{gestureId:operation.request.gestureId,mutationId:operation.request.mutationId,publicationRevision:result?.revision,generation:result?.generation,confirmed:confirmed(result,operation.request)});
        if (!confirmed(result,operation.request)) throw Object.assign(new Error('workflow_commit_unconfirmed'),{
          disposition:result?.mutationId === operation.request.mutationId ? result.disposition : undefined,
        });
      }
      catch (original) {
        mark(timing,'receiptReadStartAbs');
        result = await invoke('workflow:mutation',operation.request.mutationId).catch(() => null);
        mark(timing,'receiptReadEndAbs');
        if(operation.kind==='commitDrag')uiDragDiagnostic('commit-recovery-reply',{gestureId:operation.request.gestureId,mutationId:operation.request.mutationId,publicationRevision:result?.revision,generation:result?.generation,confirmed:confirmed(result,operation.request)});
        if (!confirmed(result,operation.request)) {
          // These named Main validation errors prove the transaction rejected.
          // Transport errors and missing ACK keep owning the same request.
          if (isOrganizationMutationNotApplied(original)) {
            if(unresolved===operation)unresolved=null;
            rejectRelease(operation,original);
          } else stage(operation,operation.releaseOwner?'preparation':'unknown');
          throw pendingError(original,operation);
        }
      }
      operation.result = result;
    }
    mark(timing,'publicationStartAbs');
    try {operation.publication = timing ? await applyPublication(result,operation.request,{gestureId:timing.gestureId})
      : await applyPublication(result,operation.request);}
    catch(error){stage(operation,operation.releaseOwner?'preparation':'unknown');throw pendingError(error,operation);}
    finally {mark(timing,'publicationEndAbs');}
    operation.completed=true;
    if (unresolved === operation) unresolved = null;
    if(operation.released)stage(operation,'accepted',{result:{...result,snapshot:operation.publication}});
    return result;
  };
  const drain = async timing => {
    let settled=null;
    while(unresolved || released.length) {
      if(unresolved) {
        const operation=unresolved;
        await (operation.withNamespaces?operation.withNamespaces(()=>apply(operation,timing)):apply(operation,timing));
        settled=operation;continue;
      }
      const operation=released[0];
      try {
        if(operation.isCurrent&&!operation.isCurrent())throw Object.assign(new Error('workflow_drag_cancelled'),{disposition:'not-applied'});
        if(operation.beforeSnapshot&&!operation.preflush) {
          const payload=typeof operation.beforeSnapshot==='function'?await operation.beforeSnapshot():operation.beforeSnapshot;
          operation.preflush={request:structuredClone({...payload,expectedRevision:getPublication().revision,
            mutationId:crypto.randomUUID()}),result:null,releaseOwner:operation};
          delete operation.beforeSnapshot;
        }
        if(operation.preflush&&!operation.preflush.completed) {
          unresolved=operation.preflush;stage(operation,'preparation');continue;
        }
        if(!operation.request) {
          operation.request=structuredClone({...operation.payload,expectedRevision:getPublication().revision,mutationId:operation.mutationId});
          operation.onPrepared?.(structuredClone(operation.request));
          delete operation.payload;
        }
        if(operation.kind==='commitDrag'&&operation.preflush)uiDragDiagnostic('commit-organization-flushed',{
          gestureId:operation.request.gestureId,mutationId:operation.request.mutationId});
        released.shift();unresolved=operation;
      } catch(error) {
        // No IPC for this release has occurred. A failed local preparation is
        // known not-applied; a prior UNKNOWN is handled in apply() above and
        // leaves this immutable queued continuation untouched.
        rejectRelease(operation,error);throw pendingError(error,operation);
      }
    }
    return settled;
  };
  const commit = (snapshot,{diagnostic,onPrepared,onStage}={}) => {
    const timing=timingFor(diagnostic,'commitWorkspace');
    const release=typeof snapshot!=='function'&&snapshot?.stripGroupReleases?.length
      ?{released:true,payload:structuredClone(snapshot),mutationId:crypto.randomUUID(),result:null,onPrepared,onStage}:null;
    mark(timing,'enqueueAbs');
    pending++;
    if(timing)timing.queueDepth=pending;
    const run = tail.then(async () => {
      let accepted=false;mark(timing,'laneStartAbs');
      try {
        // Unknown delivery owns the lane until the SAME immutable request is
        // recovered. A later edit never obtains a new key for that operation.
        if(release) {
          released.push(release);stage(release,'preparation');
          try {await recover(timing);}catch(error){
            if(!release.failure&&!release.submitted)stage(release,'preparation');
            throw pendingError(error,release);
          }
          if(release.failure)throw release.failure;
          accepted=true;return release.result;
        }
        if(unresolved||released.length)await recover(timing);
        mark(timing,'snapshotStartAbs');
        let payload;
        try {payload=typeof snapshot === 'function' ? await snapshot() : snapshot;}
        finally {mark(timing,'snapshotEndAbs');}
        if(timing)try {
          const spaces=Object.getOwnPropertyDescriptor(payload || {},'spaces')?.value;
          const members=Object.getOwnPropertyDescriptor(payload || {},'tabWorkflowMembership')?.value;
          if(Array.isArray(spaces))timing.workflowCount=spaces.length;
          if(members && typeof members==='object')timing.membershipCount=Object.keys(members).length;
        } catch {timing.timingUnavailable++;}
        const request = {...payload,expectedRevision:getPublication().revision,mutationId:crypto.randomUUID()};
        if(timing)timing.mutationId=request.mutationId;
        mark(timing,'cloneStartAbs');
        const operation = {request:structuredClone(request),result:null};
        onPrepared?.(structuredClone(operation.request));
        mark(timing,'cloneEndAbs');
        unresolved = operation;
        const result=await apply(operation,timing);accepted=true;return result;
      } finally {summarize(timing,accepted);}
    });
    tail = run.catch(error => {onError(error);}).finally(() => pending--);
    return run;
  };
  const runTask = task => {
    // An admitted operation may finish normally while this task waits behind
    // it. Keep that one operation as a per-task witness too; reading only
    // unresolved at execution time loses a newer selection on a delayed ACK.
    const queued = unresolved;
    pending++;
    const run = tail.then(async () => {
      const recovered=await recover();
      const settled = recovered || (queued?.result ? queued : null);
      // A caller may reconcile its still-live semantic intent only against the
      // exact admitted operation this lane just completed/recovered and
      // adopted. Do not expose
      // the lane's immutable request itself to a caller that could mutate it.
      return task(settled ? {recovered:{kind:settled.kind || 'commitWorkspace',
        request:structuredClone(settled.request),result:structuredClone(settled.result)}} : null);
    });
    tail = run.catch(error => onError(error)).finally(() => pending--);
    return run;
  };
  const command = (kind,request,{isCurrent=()=>true,beforeSnapshot,withNamespaces=operation=>operation(),onStage}={}) => {
    const timing=timingFor(request,kind);
    if(timing)timing.mutationId=request.mutationId;
    mark(timing,'cloneStartAbs');
    const frozen=structuredClone(request);
    const operation={kind,request:frozen,mutationId:frozen.mutationId,result:null,released:true,isCurrent,withNamespaces,onStage,
      ...(beforeSnapshot?{beforeSnapshot:typeof beforeSnapshot==='function'?beforeSnapshot:structuredClone(beforeSnapshot)}:{})};
    mark(timing,'cloneEndAbs');
    mark(timing,'enqueueAbs');
    pending++;
    if(timing)timing.queueDepth=pending;
    const run=tail.then(async()=>{
      let accepted=false;mark(timing,'laneStartAbs');
      try {
        released.push(operation);stage(operation,'preparation');
        try {await recover(timing);}catch(error){
          if(!operation.failure&&!operation.submitted)stage(operation,'preparation');
          throw pendingError(error,operation);
        }
        if(operation.failure)throw operation.failure;
        accepted=true;return {...operation.result,snapshot:operation.publication};
      } finally {summarize(timing,accepted);}
    });
    tail=run.catch(error=>onError(error)).finally(()=>pending--);
    return run;
  };
  // Presentation OPEN may wait for a previously admitted order without
  // creating a metadata write. The idle path stays synchronous; recovery and
  // ACK adoption still belong to this single lane, even if that UI goes away.
  const settle = () => pending || unresolved || released.length ? runTask(() => undefined) : null;
  return {commit,command,runTask,settle,flush:() => tail,pending:() => pending,
    pendingReleaseCount:()=>released.length+(unresolved?.released?1:0)};
}
