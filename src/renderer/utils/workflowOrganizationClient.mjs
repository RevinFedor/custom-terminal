import {uiDragDiagnostic,uiDragActionId} from './uiPerformanceDiagnostics.mjs';
import { captureSpaceLayout, emptySpaceLayout } from './workspaceSpacesModel.mjs';
import { INBOX_WORKFLOW_ID } from './workflowMembership.mjs';
import { orderedWorkflows } from '../../shared/workflow-order.cjs';
import {newerWorkflowGroups} from './workflowGroupClient.mjs';

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
      .map(([tabId,member]) => [tabId,{...member,expectedMembershipRevision:state.tabWorkflowMembership[tabId]?.revision}]))};
}

/** Ordered Main mutations. A missing ACK is recovered with the exact same key. */
export function createOrganizationCommitter({invoke,getPublication,applyPublication,onError}) {
  let tail = Promise.resolve();
  let pending = 0;
  let unresolved = null;
  const confirmed = (result,request) => result && result.success !== false && result.ok !== false
    && Number.isSafeInteger(result.revision) && result.revision >= request.expectedRevision
    && (result.generation == null || Number.isSafeInteger(result.generation) && result.generation >= 0)
    && (result.mutationId == null || result.mutationId === request.mutationId);
  const apply = async operation => {
    let result = operation.result;
    if (!result) {
      try {
        if(operation.kind==='commitDrag')uiDragDiagnostic('commit-ipc-send',{gestureId:operation.request.gestureId,mutationId:operation.request.mutationId});
        result = await invoke('workflow:mutate',{kind:operation.kind || 'commitWorkspace',request:operation.request,
          ...(operation.kind==='commitDrag'?{diagnosticActionId:uiDragActionId(operation.request.gestureId)}:{})});
        if(operation.kind==='commitDrag')uiDragDiagnostic('commit-ipc-reply',{gestureId:operation.request.gestureId,mutationId:operation.request.mutationId,publicationRevision:result?.revision,generation:result?.generation,confirmed:confirmed(result,operation.request)});
        if (!confirmed(result,operation.request)) throw Object.assign(new Error('workflow_commit_unconfirmed'),{
          disposition:result?.mutationId === operation.request.mutationId ? result.disposition : undefined,
        });
      }
      catch (original) {
        result = await invoke('workflow:mutation',operation.request.mutationId).catch(() => null);
        if(operation.kind==='commitDrag')uiDragDiagnostic('commit-recovery-reply',{gestureId:operation.request.gestureId,mutationId:operation.request.mutationId,publicationRevision:result?.revision,generation:result?.generation,confirmed:confirmed(result,operation.request)});
        if (!confirmed(result,operation.request)) {
          // These named Main validation errors prove the transaction rejected.
          // Transport errors and missing ACK keep owning the same request.
          if (original?.disposition === 'not-applied'
            || /workflow_(drag_|group_|revision_changed|membership_revision_changed|incomplete_membership_snapshot|membership_target_missing|space_identity_conflict|system_kind_reserved|id_exists|tab_unknown)/.test(String(original?.code || original?.message || original)))
            unresolved = null;
          throw original;
        }
      }
      operation.result = result;
    }
    operation.publication = await applyPublication(result);
    if (unresolved === operation) unresolved = null;
    return result;
  };
  const commit = snapshot => {
    pending++;
    const run = tail.then(async () => {
      // Unknown delivery owns the lane until the SAME immutable request is
      // recovered. A later edit never obtains a new key for that operation.
      if (unresolved) await apply(unresolved);
      const request = {...(typeof snapshot === 'function' ? snapshot() : snapshot),expectedRevision:getPublication().revision,mutationId:crypto.randomUUID()};
      const operation = {request:structuredClone(request),result:null};
      unresolved = operation;
      return apply(operation);
    });
    tail = run.catch(error => {onError(error);}).finally(() => pending--);
    return run;
  };
  const runTask = task => {
    pending++;
    const run = tail.then(async () => {if (unresolved) await apply(unresolved); return task();});
    tail = run.catch(error => onError(error)).finally(() => pending--);
    return run;
  };
  const command = (kind,request,{isCurrent=()=>true}={}) => {
    const frozen=structuredClone(request);
    pending++;
    const run=tail.then(async()=>{
      if(unresolved)await apply(unresolved);
      if(!isCurrent())throw Object.assign(new Error('workflow_drag_cancelled'),{disposition:'not-applied'});
      const operation={kind,request:frozen,result:null};unresolved=operation;
      const result=await apply(operation);
      return {...result,snapshot:operation.publication};
    });
    tail=run.catch(error=>onError(error)).finally(()=>pending--);
    return run;
  };
  return {commit,command,runTask,flush:() => tail,pending:() => pending};
}
