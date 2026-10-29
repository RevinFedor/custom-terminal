'use strict';
const crypto=require('node:crypto');
const {fingerprint}=require('./workflow-organization');
const {createSelectionStopSourceClock}=require('./workflow-selection-stop-source');
const copy=value=>JSON.parse(JSON.stringify(value));
const fail=code=>{throw Object.assign(Error(code),{code,statusCode:409});};
const id=value=>typeof value==='string'&&value.length>0&&value.trim()===value;
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).every(name=>names.includes(name));
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const diagnosticCode=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,95}$/.test(value)?value:null;
const diagnosticErrorCode=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,96}$/.test(value)?value:null;
const stopDiagnostic=(value,fallback)=>{
  const diagnostic={version:1,stage:diagnosticCode(value?.stage)||fallback.stage,
    reason:diagnosticCode(value?.reason)||fallback.reason};
  if(typeof value?.admitted==='boolean')diagnostic.admitted=value.admitted;
  for(const key of ['ownerChanged','launchChanged','scopeChanged']) {
    if(typeof value?.[key]==='boolean')diagnostic[key]=value[key];
    else if(Array.isArray(value?.[key])&&value[key].length<=24
      &&value[key].every(field=>typeof field==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field)))
      diagnostic[key]=[...value[key]];
  }
  const code=diagnosticErrorCode(value?.errorCode);if(code)diagnostic.errorCode=code;
  return diagnostic;
};

/** Arbitrary captured selection, NOT a global group. Uses the existing action
 * journal and exact file-close proof helpers. Physical Stop/Full remain Main
 * lifecycle owners. A started effect can only read its ORIGINAL receipt. */
class WorkflowSelectionRuntime {
  constructor({database,organization,groupActions,captureOwner,observe,stop,recoverRuntime,log=()=>{}}) {
    Object.assign(this,{database,db:database.db,organization,groupActions,captureOwner,observe,stop,recoverRuntime,log});
    this.flights=new Map();
    // Schema initialization belongs to this Main runtime, before effects.
    // Forward action journals do not acquire new source-observation tables.
    this.stopSourceClock={read:()=>fail('selection_stop_source_unavailable')};
    try {
      this.stopSourceClock=this.db.prepare('SELECT version FROM workflow_group_action_meta WHERE singleton=1').get()?.version===1
        ?createSelectionStopSourceClock(this.db):{read:()=>fail('selection_action_forward_version')};
    }catch{}
    // Only exact Main-produced positive receipts whose journal write failed.
    // One entry per unresolved target reservation; no observations or effects
    // are replayed. This volatile cache is deliberately NOT restart authority.
    this.pendingStopReceipts=new Map();
    this.closeActions=Object.create(groupActions);
    this.closeActions.command=mutationId=>this.closeCommand(mutationId);
    this.closeActions.signature=tabId=>this.signature(tabId);
    this.closeActions.assertCloseGuard=guard=>this.assertCloseGuard(guard);
    this.closeActions.prepareClose=(guard,snapshots)=>this.prepareClose(guard,snapshots);
    this.closeActions.finishClose=proof=>this.finishClose(proof);
  }
  writable() {
    if(this.db.prepare('SELECT version FROM workflow_group_action_meta WHERE singleton=1').get()?.version!==1)
      fail('selection_action_forward_version');
  }
  owns(mutationId) {
    const row=this.db.prepare('SELECT command_json FROM workflow_group_actions WHERE mutation_id=?').get(mutationId);
    return !!row&&JSON.parse(row.command_json).kind==='selection';
  }
  command(mutationId) {
    this.writable();
    const row=this.db.prepare('SELECT * FROM workflow_group_actions WHERE mutation_id=?').get(mutationId);
    if(!row)fail('selection_action_missing');
    const value=JSON.parse(row.command_json);
    if(value.kind!=='selection'||value.version!==1||!['stop','close'].includes(value.action)
      ||!Array.isArray(value.members)||!value.steps||value.mutationId!==mutationId)fail('selection_action_forward_version');
    return value;
  }
  write(value) {
    this.db.prepare('UPDATE workflow_group_actions SET command_json=? WHERE mutation_id=?')
      .run(JSON.stringify(value),value.mutationId);
  }
  update(mutationId,operation) {
    return this.db.transaction(()=>{const command=this.command(mutationId),result=operation(command);
      this.write(command);return result;}).immediate();
  }
  row(tabId) {
    const rows=this.db.prepare('SELECT * FROM tabs WHERE tab_id=? AND execution_archived=0').all(tabId);
    if(rows.length>1)fail('selection_action_execution_ambiguous');
    return rows[0]||null;
  }
  signature(tabId) {return this.groupActions.signature(tabId,this.row(tabId));}
  capture(tabId) {
    const tab=this.organization.getTab(tabId),row=this.row(tabId),publication=this.organization.getPublication();
    if(!tab?.executionResolved||!row||!tab.nativeRow||tab.nativeRow.id!==row.id||!tab.membership
      ||publication.version!==1||publication.migrationVersion!==1)fail('selection_action_capture_unknown');
    const execution=this.signature(tabId);
    if(!execution)fail('selection_action_capture_unknown');
    const namespace=execution.scope.executionNamespace||execution.scope.projectId;
    const runtimeOwner=this.captureOwner(tabId);
    if(!runtimeOwner?.mainInstanceId)fail('selection_action_capture_unknown');
    if(execution.tabType==='file'&&(runtimeOwner.terminalId||runtimeOwner.sdkOwnerId))fail('selection_action_file_runtime_unknown');
    return {tabId,namespace,execution,placementId:row.restore_placement_id||tabId,subject:copy(tab.executionSubject),membership:copy(tab.membership),
      generation:publication.generation,runtimeOwner,
      ...(execution.tabType==='file'?{fileFamily:this.groupActions.fileFamily(tabId)
        .map(row=>({row,signature:this.signature(row.tab_id)}))}:{})};
  }
  current(member,{archived=false,runtimeOwner=member.runtimeOwner,diagnostic=null}={}) {
    try {
      // Optional, body-free first-failure collector. Keep the original order,
      // short circuits and single capture; diagnostics never re-read an owner.
      if(diagnostic)diagnostic.component='publication';
      const pub=this.organization.getPublication();
      if(diagnostic)diagnostic.component='publication.version';
      if(pub.version!==1)return false;
      if(diagnostic)diagnostic.component='publication.migrationVersion';
      if(pub.migrationVersion!==1)return false;
      if(diagnostic)diagnostic.component='publication.generation';
      if(pub.generation!==member.generation)return false;
      if(diagnostic)diagnostic.component='membership';
      if(!same(this.organization.getMembership(member.tabId),member.membership))return false;
      if(archived)return true;
      if(diagnostic)diagnostic.component='capture';
      const now=this.capture(member.tabId);
      if(diagnostic)diagnostic.component='placementId';
      if(now.placementId!==member.placementId)return false;
      if(diagnostic)diagnostic.component='execution';
      if(!same(now.execution,member.execution))return false;
      if(diagnostic)diagnostic.component='subject';
      if(!same(now.subject,member.subject))return false;
      if(diagnostic)diagnostic.component='runtimeOwner';
      return same(now.runtimeOwner,runtimeOwner);
    }catch(error){
      if(diagnostic) {
        diagnostic.threw=true;
        try {const code=diagnosticErrorCode(error?.code);if(code)diagnostic.errorCode=code;}catch{}
      }
      return false;
    }
  }
  readStopScope(member) {
    const publication=this.organization.getPublication(),tab=this.organization.getTab(member.tabId);
    const row=this.row(member.tabId),now=this.capture(member.tabId);
    const workflow=this.organization.getWorkflow(now.membership.workflowId,{includeDeleted:true});
    if(publication.version!==1||publication.migrationVersion!==1
      ||!Number.isSafeInteger(publication.generation)||publication.generation<0
      ||!tab||!row||tab.nativeRow?.id!==row.id||!workflow||workflow.deletedGeneration
      ||![1,2].includes(tab.subjectVersion)||!Number.isSafeInteger(tab.revision)||!Number.isSafeInteger(workflow.revision))
      fail('selection_stop_scope_unknown');
    const storage={};
    for(const key of ['id','tab_id','project_id','execution_subject_version','execution_subject_id',
      'execution_namespace','execution_archived','cwd','command_type','restore_placement_id'])
      storage[key]=row[key]??null;
    return {version:1,generation:publication.generation,
      target:{publication:{version:publication.version,migrationVersion:publication.migrationVersion},
        tabRevision:tab.revision,subjectVersion:tab.subjectVersion,storage,sourceClock:this.stopSourceClock.read(member.tabId,row.id),workflow:copy(workflow),
        namespace:now.namespace,placementId:now.placementId,subject:copy(now.subject),membership:copy(now.membership),
        execution:{...copy(now.execution),runtime:null}},
      executionRuntime:copy(now.execution.runtime),runtimeOwner:copy(now.runtimeOwner)};
  }
  captureStopScope(member) {
    const read=()=>{
      if(!this.current(member))fail('selection_action_owner_changed');
      return this.readStopScope(member);
    };
    return this.db.inTransaction?read():this.db.transaction(read).immediate();
  }
  checkStopScope(member,scope,{runtimeOwner=member.runtimeOwner,matchExecutionRuntime}={}) {
    const rejected=(reason,changed)=>({current:false,reason,...(changed?{changed}:{})});
    try {
      const read=()=>{
        if(scope?.version!==1||!Number.isSafeInteger(scope.generation)||scope.generation<0)
          return rejected('selection_stop_scope_invalid');
        const now=this.readStopScope(member);
        if(now.generation<scope.generation)return rejected('selection_stop_publication_rewound');
        // Publication relaxation is limited to native v2 targets. The new
        // source clock does not expand legacy's existing generation permission.
        if(scope.target.subject.version!==2&&now.generation!==scope.generation)
          return rejected('selection_stop_publication_changed');
        if(!same(now.target.publication,scope.target.publication))return rejected('selection_stop_publication_changed');
        if(!same(now.runtimeOwner,runtimeOwner))return rejected('selection_stop_runtime_owner_changed');
        for(const key of ['tabRevision','subjectVersion','workflow','namespace','placementId','subject','membership','execution','sourceClock'])
          if(!same(now.target[key],scope.target[key]))return rejected('selection_stop_scope_'+key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())+'_changed',[key]);
        const beforeStorage=scope.target.storage,afterStorage=now.target.storage;
        const changed=Object.keys(beforeStorage).filter(key=>!same(beforeStorage[key],afterStorage[key]));
        if(changed.length||Object.keys(beforeStorage).length!==Object.keys(afterStorage).length)
          return rejected('selection_stop_scope_storage_changed',changed);
        // This adapter is Main-only, never an IPC-supplied claim. Its explicit
        // true is required; a Promise/truthy object cannot authorize retirement.
        const runtimeMatches=matchExecutionRuntime?matchExecutionRuntime(scope.executionRuntime,now.executionRuntime)===true
          :same(scope.executionRuntime,now.executionRuntime);
        return runtimeMatches?{current:true}:rejected('selection_stop_execution_runtime_changed');
      };
      return this.db.inTransaction?read():this.db.transaction(read).immediate();
    }catch(error){return {...rejected('selection_stop_scope_read_failed'),
      ...(diagnosticErrorCode(error?.code)?{errorCode:diagnosticErrorCode(error.code)}:{})};}
  }
  currentStopScope(member,scope,options) {return this.checkStopScope(member,scope,options).current;}
  pendingStopReceipt(mutationId,tabId) {
    const pending=this.pendingStopReceipts.get(tabId);
    return pending?.mutationId===mutationId?pending:null;
  }
  pruneCompletedStopReceipt(tabId) {
    const pending=this.pendingStopReceipts.get(tabId);
    if(!pending)return;
    const value=this.command(pending.mutationId),member=this.member(value,tabId),step=value.steps[tabId];
    if(value.action==='stop'&&step?.state==='completed'&&step.started===true
      &&fingerprint(member)===pending.memberHash&&same(step.receipt,pending.receipt))
      this.pendingStopReceipts.delete(tabId);
  }
  retainStopReceipt(mutationId,member,receipt) {
    const old=this.pendingStopReceipts.get(member.tabId),proof=copy(receipt),memberHash=fingerprint(member);
    if(old&&(old.mutationId!==mutationId||old.memberHash!==memberHash||!same(old.receipt,proof)))
      fail('selection_stop_retained_receipt_conflict');
    if(!old)this.pendingStopReceipts.set(member.tabId,{mutationId,memberHash,receipt:proof});
  }
  persistStopReceipt(mutationId,tabId) {
    const pending=this.pendingStopReceipt(mutationId,tabId);
    if(!pending)fail('selection_stop_retained_receipt_missing');
    const validate=current=>{
      const member=this.member(current,tabId),step=current.steps[tabId],actual=pending.receipt;
      if(current.action!=='stop'||fingerprint(member)!==pending.memberHash||!step?.started
        ||!['started','completed'].includes(step.state)||actual.version!==1||actual.completed!==true
        ||!same(actual.before,member.runtimeOwner)||step.state==='completed'&&!same(step.receipt,actual))
        fail('selection_stop_retained_receipt_changed');
      return step;
    };
    let phase='journal-read';
    try {
      // A commit can have succeeded before its caller saw an error. Recover
      // that exact durable result using reads even if all writes now fail.
      if(validate(this.command(mutationId)).state==='completed') {
        this.pendingStopReceipts.delete(tabId);
        return {success:true,completed:true,mutationId,tabId};
      }
      phase='journal-commit';
      const result=this.update(mutationId,current=>{
        const step=validate(current);
        if(step.state!=='completed') {
          step.state='completed';step.receipt=copy(pending.receipt);delete step.error;delete step.diagnostic;
          this.db.prepare("UPDATE workflow_group_close_steps SET state='completed' WHERE mutation_id=? AND tab_id=?").run(mutationId,tabId);
        }
        return {success:true,completed:true,mutationId,tabId};
      });
      this.pendingStopReceipts.delete(tabId);
      try {this.log('stop-settled',{mutationId,tabId,completed:true});}catch{}
      return result;
    }catch(error) {
      const diagnostic=stopDiagnostic({errorCode:error?.code},{stage:phase,reason:'selection_stop_receipt_commit_failed'});
      try {this.log('stop-held',{mutationId,tabId,error:'selection_stop_receipt_unknown',diagnostic});}catch{}
      return {success:false,pending:true,mutationId,tabId,error:'selection_stop_receipt_unknown',diagnostic};
    }
  }
  begin(request) {
    this.writable();
    if(!keys(request,['version','mutationId','action','members','origin'])||request.version!==1||!id(request.mutationId)
      ||!['stop','close'].includes(request.action)||!keys(request.origin,['workflowId','windowId'])
      ||!id(request.origin.workflowId)||request.origin.windowId!==null&&!id(request.origin.windowId)
      ||!Array.isArray(request.members)||!request.members.length
      ||request.members.some(row=>!keys(row,['projectId','tabId'])||!id(row.projectId)||!id(row.tabId))
      ||new Set(request.members.map(row=>row.tabId)).size!==request.members.length)fail('selection_action_request_invalid');
    const hash=fingerprint(request);
    return this.db.transaction(()=>{
      const old=this.db.prepare('SELECT request_hash FROM workflow_group_actions WHERE mutation_id=?').get(request.mutationId);
      if(old){if(old.request_hash!==hash)fail('selection_action_id_conflict');return this.receipt(request.mutationId);}
      this.organization.workflowRequired(request.origin.workflowId);
      const members=request.members.map(ref=>{
        const member=this.capture(ref.tabId);
        if(member.namespace!==ref.projectId||member.membership.workflowId!==request.origin.workflowId)
          fail('selection_action_capture_changed');
        return member;
      });
      const value={version:1,kind:'selection',action:request.action,mutationId:request.mutationId,
        origin:copy(request.origin),members,steps:{},
        archiveWatermark:this.db.prepare('SELECT COALESCE(MAX(id),0) id FROM tab_history').get().id};
      this.db.prepare('INSERT INTO workflow_group_actions VALUES(?,?,?,NULL)').run(value.mutationId,hash,JSON.stringify(value));
      this.log('admitted',{mutationId:value.mutationId,action:value.action,count:members.length});
      return this.receipt(value.mutationId);
    }).immediate();
  }
  effectiveMember(value,member) {
    let execution=member.execution;
    for(const receipt of value.executionAdvances?.[member.tabId]||[]) {
      const step=value.steps[receipt.stepTabId];
      if(receipt.version!==1||step?.state!=='completed'||step.finalized?.kind!=='canonical-close'
        ||receipt.before!==fingerprint(execution)||execution.visualParentTabId!==receipt.stepTabId
        ||receipt.execution?.visualParentTabId!=null
        ||!same({...receipt.execution,visualParentTabId:execution.visualParentTabId},execution))
        fail('selection_action_advance_unknown');
      execution=receipt.execution;
    }
    return execution===member.execution?member:{...member,execution};
  }
  member(value,tabId) {const member=value.members.find(row=>row.tabId===tabId);
    if(!member)fail('selection_action_member_not_requested');return this.effectiveMember(value,member);}
  receipt(mutationId) {
    const value=this.command(mutationId),results=value.members.map(member=>({tabId:member.tabId,namespace:member.namespace,
      state:value.steps[member.tabId]?.state||'admitted',
      ...(value.steps[member.tabId]?.error?{error:value.steps[member.tabId].error}:{}),
      ...(value.steps[member.tabId]?.diagnostic?{diagnostic:copy(value.steps[member.tabId].diagnostic)}:{})}));
    return {version:1,success:true,mutationId,action:value.action,completed:results.every(row=>row.state==='completed'),results};
  }
  reserve(value,member) {
    // No second effect under a new ID while an earlier exact target is UNKNOWN.
    // Read only target-indexed step candidates, NOT every archived command's
    // metadata/body into Main RAM for each selected member.
    for(const row of this.db.prepare(`SELECT a.mutation_id,a.command_json FROM workflow_group_close_steps s
      JOIN workflow_group_actions a ON a.mutation_id=s.mutation_id WHERE s.tab_id=? AND s.mutation_id<>?
      AND s.state IN ('prepared','selection-started')`).all(member.tabId,value.mutationId)) {
      const other=JSON.parse(row.command_json),step=other.kind==='selection'&&other.steps?.[member.tabId];
      if(step&&step.state!=='completed'&&step.started)fail('selection_action_target_in_progress:'+row.mutation_id);
    }
  }
  closeCommand(mutationId) {
    const value=this.command(mutationId);
    if(value.action!=='close')fail('selection_close_action_required');
    return {...value,kind:'close',members:value.members.map(member=>this.effectiveMember(value,member)),intent:{version:1,mutationId}};
  }
  guard(value,member) {
    const step=value.steps[member.tabId];
    if(!step?.guardToken)fail('selection_close_step_required');
    return {mutationId:value.mutationId,tabId:member.tabId,guardToken:step.guardToken};
  }
  checkGuard(guard) {
    if(!keys(guard,['mutationId','tabId','guardToken'])||!id(guard.mutationId)||!id(guard.tabId)||!id(guard.guardToken))
      fail('selection_close_guard_invalid');
    const value=this.command(guard.mutationId),member=this.member(value,guard.tabId),step=value.steps[guard.tabId];
    if(value.action!=='close'||!step||step.guardToken!==guard.guardToken||!['prepared','started','completed'].includes(step.state))
      fail('selection_close_guard_changed');
    return {value,member,step};
  }
  assertCloseGuard(guard,boundary) {
    const {member,step}=this.checkGuard(guard);
    const diagnostic={component:'started'};
    if(step.started&&member.execution.tabType!=='file'||!this.current(member,{diagnostic})) {
      // Static field names only: no compared values, IDs, paths or exception
      // messages. The refusal itself binds the boundary; no PASS log needed.
      try {this.log('close-guard-refused',{version:1,
        boundary:boundary==='before_process_observation'||boundary==='after_process_observation'?boundary:'unspecified',
        component:diagnostic.component,threw:diagnostic.threw===true,error:'selection_close_execution_changed',
        ...(diagnostic.errorCode?{errorCode:diagnostic.errorCode}:{})});}catch{}
      fail('selection_close_execution_changed');
    }
  }
  async step({mutationId,tabId}) {
    const key=JSON.stringify([mutationId,tabId]);
    if(this.flights.has(key))return this.flights.get(key);
    const promise=this.execute(mutationId,tabId).catch(error=>{
      this.log('held',{mutationId,tabId,error:String(error.code||error.message)});throw error;
    }).finally(()=>{if(this.flights.get(key)===promise)this.flights.delete(key);});
    this.flights.set(key,promise);return promise;
  }
  async execute(mutationId,tabId) {
    const value=this.command(mutationId),member=this.member(value,tabId),old=value.steps[tabId];
    if(old&&(!['prepared','started','completed'].includes(old.state)
      ||old.state==='started'&&old.started!==true))fail('selection_action_phase_unknown');
    if(value.action==='stop'&&this.pendingStopReceipt(mutationId,tabId))return this.persistStopReceipt(mutationId,tabId);
    if(old?.state==='completed')return {success:true,completed:true,mutationId,tabId};
    if(value.action==='close') {
      if(old?.started)return {success:true,completed:false,closeGuard:this.guard(value,member),pending:true};
      if(!this.current(member))fail('selection_action_owner_changed');
      return this.update(mutationId,current=>{
        const step=current.steps[tabId]||{state:'prepared',guardToken:crypto.randomUUID()};current.steps[tabId]=step;
        this.db.prepare("INSERT OR IGNORE INTO workflow_group_close_steps VALUES(?,?,?,'prepared')")
          .run(mutationId,tabId,step.guardToken);
        return {success:true,completed:false,closeGuard:this.guard(current,member)};
      });
    }
    if(old?.started)return {success:false,pending:true,error:'selection_stop_receipt_unknown',mutationId,tabId,
      ...(old.diagnostic?{diagnostic:copy(old.diagnostic)}:{})};
    if(!this.current(member))fail('selection_action_owner_changed');
    if(member.execution.tabType==='file')return this.update(mutationId,current=>{
      if(!this.current(member))fail('selection_action_owner_changed');
      current.steps[tabId]={state:'completed',receipt:{version:1,kind:'file-no-process',owner:member.runtimeOwner}};
      return {success:true,completed:true,mutationId,tabId};
    });
    // A read-only receipt may have observed a completed commit after a lost
    // commit ACK. Prune only that exact durable cached proof BEFORE a new Stop.
    this.pruneCompletedStopReceipt(tabId);
    const retained=this.pendingStopReceipts.get(tabId);
    if(retained&&retained.mutationId!==mutationId)fail('selection_stop_retained_receipt_conflict');
    // A known missing/forward/broken observer is a pre-effect rejection, not
    // an UNKNOWN physical attempt. Original started commands never reach here.
    const sourceBeforeObservation=this.stopSourceClock.read(tabId,this.row(tabId)?.id);
    let observation;
    try {observation=await this.observe(member);}catch{observation={known:false};}
    if(!this.current(member))fail('selection_action_owner_changed');
    if(observation?.known!==true)return {success:false,error:'selection_stop_process_unknown',mutationId,tabId};
    const acquired=this.update(mutationId,current=>{
      if(current.steps[tabId]?.started)return false;
      if(!this.current(member))fail('selection_action_owner_changed');
      // The first process observation is an await too. Preserve its original
      // source witness instead of recapturing an ABA after that await.
      const sourceNow=this.stopSourceClock.read(tabId,this.row(tabId)?.id);
      if(!same(sourceBeforeObservation,sourceNow))fail('selection_stop_scope_source_clock_changed');
      this.reserve(current,member);
      this.db.prepare("INSERT INTO workflow_group_close_steps VALUES(?,?,?,'selection-started')")
        .run(mutationId,tabId,crypto.randomUUID());
      current.steps[tabId]={state:'started',started:true};this.log('stop-started',{mutationId,tabId});return true;
    });
    if(!acquired)return this.execute(mutationId,tabId);
    // The attestation is produced ONLY by the existing Main Stop owner after
    // its actual result + exact owned retirement checks, never by IPC input.
    let actual,diagnostic;
    try {actual=await this.stop(member,observation,runtimeOwner=>this.current(member,{runtimeOwner}));}
    catch(error) {diagnostic=stopDiagnostic({errorCode:error?.code},{stage:'owner-call',reason:'selection_stop_owner_threw'});}
    if(actual?.version===1&&actual.completed===true&&same(actual.before,member.runtimeOwner)) {
      this.retainStopReceipt(mutationId,member,actual);
      return this.persistStopReceipt(mutationId,tabId);
    }
    diagnostic||=stopDiagnostic(actual?.diagnostic,{stage:'attestation',reason:'selection_stop_attestation_missing'});
    return this.update(mutationId,current=>{
      const step=current.steps[tabId];
      step.error='selection_stop_receipt_unknown';step.diagnostic=copy(diagnostic);
      try {this.log('stop-held',{mutationId,tabId,error:step.error,diagnostic});}catch{}
      return {success:false,pending:true,mutationId,tabId,error:step.error,diagnostic};
    });
  }
  archiveReplay(guard,request) {
    const {step}=this.checkGuard(guard);
    if(!step.started)return null;
    if(!step.archiveRequest||!same(step.archiveRequest,request))fail('selection_close_operation_changed');
    if(!step.archiveResult)fail('selection_close_archive_unknown');
    return copy(step.archiveResult);
  }
  startArchive(guard,request) {
    this.assertCloseGuard(guard);
    this.update(guard.mutationId,value=>{
      const member=this.member(value,guard.tabId);this.reserve(value,member);
      const step=value.steps[guard.tabId];
      if(!this.current(member)||step.started)fail('selection_close_execution_changed');
      Object.assign(step,{state:'started',started:true,archiveRequest:copy(request)});
      this.log('archive-started',{mutationId:value.mutationId,tabId:member.tabId});
    });
  }
  finishArchive(guard,result,root) {
    this.update(guard.mutationId,value=>{
      const step=value.steps[guard.tabId];
      if(result?.success!==true||!Number.isSafeInteger(result.historyId)) {
        step.error='selection_close_archive_unknown';return;
      }
      const archived=this.db.prepare('SELECT * FROM tab_history WHERE id=? AND tab_id=?').get(result.historyId,guard.tabId);
      if(!archived)fail('selection_close_archive_changed');
      step.archiveResult=copy(result);step.root=copy(archived);step.runtime={};
    });
  }
  runtimePort(guard) {
    const read=()=>{
      const {value,member,step}=this.checkGuard(guard);
      if(!step.archiveResult||!this.postArchiveCurrent(member,step))fail('selection_close_archive_unknown');
      const native=step.archiveResult.closeReceipt;
      if(native) {
        const actual=this.database.assertArchivedCloseReceipt(native);
        if(!same(actual.runtimeOwner,member.runtimeOwner)||!same(actual.groupCloseGuard,guard))fail('selection_close_runtime_owner_changed');
      }
      const history=this.db.prepare('SELECT * FROM tab_history WHERE id=? AND tab_id=?').get(step.archiveResult.historyId,member.tabId);
      if(!history)fail('selection_close_archive_changed');
      return {value,member,step,scope:{receipt:{version:1,mutationId:value.mutationId,tabId:member.tabId,
        historyId:history.id,namespace:member.namespace},root:step.root,runtimeOwner:member.runtimeOwner,groupCloseGuard:guard}};
    };
    return {
      assertArchivedCloseReceipt:()=>read().scope,
      readArchivedCloseIntent:()=>read().scope,
      archivedCloseRuntimeStep:(_receipt,phase,result)=>{
        if(result===undefined)return copy(read().step.runtime?.[phase]||null);
        return this.update(guard.mutationId,value=>{
          read();const runtime=value.steps[guard.tabId].runtime;
          if(runtime[phase])fail('selection_close_runtime_step_conflict');
          const native=value.steps[guard.tabId].archiveResult.closeReceipt;
          if(native)this.database.archivedCloseRuntimeStep(native,phase,result);
          runtime[phase]=copy(result);return result;
        });
      },
    };
  }
  closeState(guard) {
    const {member,step}=this.checkGuard(guard);
    if(!step.started)return {success:true,started:false};
    if(!step.archiveResult||!step.archiveRequest||!this.postArchiveCurrent(member,step))
      return {success:false,pending:true,error:'selection_close_archive_unknown'};
    this.runtimePort(guard).assertArchivedCloseReceipt();
    const killed=step.runtime?.['kill-settled'];
    if(killed&&!same(killed.afterOwner,this.captureOwner(member.tabId)))
      return {success:false,pending:true,error:'selection_close_runtime_owner_changed'};
    return {success:true,started:true,archiveRequest:copy(step.archiveRequest),archiveResult:copy(step.archiveResult),
      runtimeStopped:!!killed};
  }
  postArchiveCurrent(member,step) {
    if(!this.current(member,{archived:true}))return false;
    const tab=this.organization.getTab(member.tabId);
    if(!tab||!same(tab.executionSubject,member.subject))return false;
    // Native archive is inactive; legacy archive stays active until the exact
    // snapshot transaction. Neither permits a replaced SID/subject/relation.
    if(member.subject.version===2)return tab.nativeRow?.execution_archived===1;
    const now=this.signature(member.tabId);
    return !!now&&same({...now,runtime:null},{...member.execution,runtime:null});
  }
  async runtime(guard,event) {
    const {member,step}=this.checkGuard(guard);
    if(member.execution.tabType==='file')fail('selection_close_file_has_no_runtime');
    if(!step.archiveResult)fail('selection_close_archive_unknown');
    const port=this.runtimePort(guard);
    const recovered=await this.recoverRuntime(event,{recover:true,archiveRequest:{}},port,member);
    if(recovered.success!==true||recovered.runtimeStopped)return recovered;
    const state=this.checkGuard(guard).step;
    if(state.runtime?.['stop-admitted']&&!state.runtime?.['stop-settled'])
      return {success:false,pending:true,error:'selection_close_stop_unknown'};
    if(state.runtime?.['stop-settled']?.result?.success!==true&&!recovered.stopAbsent) {
      if(state.runtime?.['stop-admitted'])return {success:false,pending:true,error:'selection_close_stop_unknown'};
      if(!recovered.canContinue)return {success:false,pending:true,error:'selection_close_process_unknown'};
      const stopped=await this.recoverRuntime(event,{receipt:{},runtimeAction:'stop'},port,member);
      if(stopped.success!==true||stopped.runtimeStopped)return stopped;
    }
    return this.recoverRuntime(event,{receipt:{},runtimeAction:'kill'},port,member);
  }
  prepareClose(guard,snapshots) {
    const {value,member,step}=this.checkGuard(guard);
    if(!(step.archiveResult?this.postArchiveCurrent(member,step):this.current(member)))fail('selection_close_execution_changed');
    if(member.execution.tabType!=='file'&&(!step.archiveResult||snapshots.length&&!step.runtime?.['kill-settled']))
      fail('selection_close_runtime_not_retired');
    if(member.execution.tabType!=='file'&&snapshots.length
      &&!same(step.runtime['kill-settled'].afterOwner,this.captureOwner(member.tabId)))
      fail('selection_close_runtime_owner_changed');
    if(member.execution.tabType==='file'&&!step.started) {
      // This hook is INSIDE the existing save transaction, before any SQL write.
      this.reserve(value,member);step.started=true;step.state='started';this.write(value);
    }
    const advanceCandidates=[];
    if(snapshots.length)for(const frozen of value.members) {
      const selected=this.effectiveMember(value,frozen);
      if(selected.execution.tabType!=='file'&&selected.execution.visualParentTabId===member.tabId&&this.current(selected))
        advanceCandidates.push(selected);
    }
    return {...this.groupActions.prepareClose.call(this.closeActions,guard,snapshots),advanceCandidates};
  }
  finishClose(proof) {
    this.groupActions.finishClose.call(this.closeActions,proof);
    const {value,member,step}=this.checkGuard(proof.guard);
    if(this.signature(member.tabId))fail('selection_close_not_committed');
    if(member.execution.tabType!=='file'&&!step.runtime?.['kill-settled'])fail('selection_close_runtime_not_retired');
    step.state='completed';step.finalized={version:1,kind:'canonical-close',historyId:step.archiveResult?.historyId||null};
    // tabsAfterClose detaches a surviving ordinary visual child. The exact
    // before/after is proved INSIDE this same canonical save transaction.
    // Keep initial members immutable; only this receipt can advance the one
    // relation for a later explicitly selected child. Not a blanket rebase.
    for(const selected of proof.advanceCandidates||[]) {
      const now=this.signature(selected.tabId),row=this.row(selected.tabId);
      if(!now||now.visualParentTabId!=null||row.closed_visual_parent_tab_id!==member.placementId
        ||!same({...now,visualParentTabId:selected.execution.visualParentTabId},selected.execution)
        ||!same(this.captureOwner(selected.tabId),selected.runtimeOwner)
        ||!this.current(selected,{archived:true}))continue;
      value.executionAdvances||={};value.executionAdvances[selected.tabId]||=[];
      value.executionAdvances[selected.tabId].push({version:1,stepTabId:member.tabId,
        before:fingerprint(selected.execution),execution:now});
    }
    // The existing exact family proof can complete an explicitly selected file
    // removed by THIS parent close. It never includes ordinary visual AI children.
    for(const selected of value.members)if(selected.execution.tabType==='file'&&!this.signature(selected.tabId)) {
      const own=this.db.prepare('SELECT signature_json FROM workflow_group_file_closes WHERE mutation_id=? AND tab_id=?')
        .get(value.mutationId,selected.tabId);
      const manifest=step.archiveResult&&this.db.prepare('SELECT manifest_json FROM workflow_archived_file_links WHERE history_id=?')
        .get(step.archiveResult.historyId);
      const proven=own&&same(JSON.parse(own.signature_json),selected.execution)
        ||manifest&&JSON.parse(manifest.manifest_json).files.some(file=>file.tab_id===selected.tabId
          &&same(this.groupActions.signature(selected.tabId,file),selected.execution));
      if(proven&&this.current(selected,{archived:true}))value.steps[selected.tabId]={state:'completed',
        finalized:{version:1,kind:'owned-file-family',parentTabId:member.tabId}};
    }
    this.write(value);this.log('close-finalized',{mutationId:value.mutationId,tabId:member.tabId});
    this.db.prepare("UPDATE workflow_group_close_steps SET state='completed' WHERE mutation_id=? AND tab_id=?")
      .run(value.mutationId,member.tabId);
  }
  ack({mutationId,tabId}) {
    if(this.pendingStopReceipt(mutationId,tabId))return this.persistStopReceipt(mutationId,tabId);
    const value=this.command(mutationId),member=this.member(value,tabId),step=value.steps[member.tabId];
    // No renderer success/absent/history heuristic can manufacture this marker.
    return step?.state==='completed'?{success:true,completed:true,mutationId,tabId}
      :{success:false,pending:true,mutationId,tabId,error:'selection_action_receipt_unknown',
        ...(step?.diagnostic?{diagnostic:copy(step.diagnostic)}:{})};
  }
}

module.exports={WorkflowSelectionRuntime};
