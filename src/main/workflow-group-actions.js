'use strict';
const crypto=require('node:crypto');
const {fingerprint}=require('./workflow-organization');
const {executionScopeForRow}=require('../shared/workflow-organization.cjs');
const fail=code=>{throw Object.assign(new Error(code),{code,statusCode:409});};
const clean=value=>JSON.parse(JSON.stringify(value));

/** Frozen explicit group actions; retries cannot include newly joined tabs. */
class WorkflowGroupActions {
  constructor({database,organization,groups,captureExecution=()=>null}) {
    Object.assign(this,{database,db:database.db,organization,groups,captureExecution});
    const existing=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_group_action_meta' AND type='table'").get();
    if(existing && this.db.prepare('SELECT version FROM workflow_group_action_meta WHERE singleton=1').get()?.version!==1)return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_group_action_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO workflow_group_action_meta VALUES(1,1);
      CREATE TABLE IF NOT EXISTS workflow_group_actions(mutation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,command_json TEXT NOT NULL,response_json TEXT);
      CREATE TABLE IF NOT EXISTS workflow_group_close_steps(mutation_id TEXT NOT NULL,tab_id TEXT NOT NULL,guard_token TEXT NOT NULL,
        state TEXT NOT NULL,PRIMARY KEY(mutation_id,tab_id));
      CREATE TABLE IF NOT EXISTS workflow_group_file_closes(mutation_id TEXT NOT NULL,tab_id TEXT NOT NULL,
        signature_json TEXT NOT NULL,files_json TEXT NOT NULL,PRIMARY KEY(mutation_id,tab_id));
      CREATE TABLE IF NOT EXISTS workflow_group_close_revisions(mutation_id TEXT NOT NULL,step_tab_id TEXT NOT NULL,
        tab_id TEXT NOT NULL,namespace TEXT NOT NULL,storage_id INTEGER NOT NULL,from_revision INTEGER NOT NULL,
        to_revision INTEGER NOT NULL,signature_json TEXT NOT NULL,PRIMARY KEY(mutation_id,step_tab_id,tab_id));
      CREATE TABLE IF NOT EXISTS workflow_group_close_storage_ids(mutation_id TEXT NOT NULL,step_tab_id TEXT NOT NULL,
        tab_id TEXT NOT NULL,namespace TEXT NOT NULL,from_id INTEGER NOT NULL,to_id INTEGER NOT NULL,
        signature_json TEXT NOT NULL,PRIMARY KEY(mutation_id,step_tab_id,tab_id));`);
  }
  writable() {
    if(this.db.prepare('SELECT version FROM workflow_group_action_meta WHERE singleton=1').get()?.version!==1)fail('group_action_forward_version');
    this.groups.writable();
  }
  signature(tabId, row=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(tabId)) {
    if(!row || row.execution_archived===1)return null;
    const owner=this.database.getAppState('conversation-owner.v1:'+tabId);
    return clean({scope:executionScopeForRow(row),claudeSessionId:row.claude_session_id,codexSessionId:row.codex_session_id,
      tabType:row.tab_type,filePath:row.file_path,parentTabId:row.parent_tab_id,visualParentTabId:row.visual_parent_tab_id,
      geminiSessionId:row.gemini_session_id,
      ownerToken:owner && (owner.reason!=='first-observation' || owner.checkpoint || owner.send || owner.transition)?owner.token:null,
      runtime:this.captureExecution(tabId)});
  }
  command(mutationId) {
    this.writable();
    const row=this.db.prepare('SELECT * FROM workflow_group_actions WHERE mutation_id=?').get(mutationId);
    if(!row)fail('group_action_missing');
    return {row,...JSON.parse(row.command_json)};
  }
  begin(request) {
    this.writable();request=clean(request);
    const {kind,groupId,intent,members}=request;
    if(!['move','close'].includes(kind) || intent?.version!==1 || !intent.mutationId
      || !Array.isArray(members) || !members.length || new Set(members.map(member=>member.tabId)).size!==members.length)fail('group_action_request_invalid');
    const signature=fingerprint(request);
    const command=this.db.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM workflow_group_actions WHERE mutation_id=?').get(intent.mutationId);
      if(old) {
        if(old.request_hash!==signature)fail('group_action_id_conflict');
        return {command:JSON.parse(old.command_json),response:old.response_json && JSON.parse(old.response_json)};
      }
      const publication=this.groups.read(),group=this.groups.group(groupId);
      if(publication.revision!==intent.expectedRevision || group.revision!==intent.expectedGroupRevision)fail('group_action_revision_changed');
      const actual=Object.keys(publication.tabGroups).filter(tabId=>publication.tabGroups[tabId]===groupId && this.signature(tabId));
      if(fingerprint(actual.sort())!==fingerprint(members.map(member=>member.tabId).sort()))fail('group_action_members_changed');
      const ids=new Set(actual);
      if(kind==='move') {
        let changed=true;
        const rows=this.db.prepare('SELECT * FROM tabs WHERE execution_archived=0').all();
        while(changed) {
          changed=false;
          for(const row of rows)if(!ids.has(row.tab_id) && (ids.has(row.parent_tab_id)
            || row.tab_type==='file' && ids.has(row.visual_parent_tab_id))) {ids.add(row.tab_id);changed=true;}
        }
      }
      const frozen=Array.from(ids,tabId=>{
        const execution=this.signature(tabId);
        if(!execution)fail('group_action_member_not_active');
        const member=members.find(member=>member.tabId===tabId);
        const namespace=execution.scope.executionNamespace || execution.scope.projectId;
        if(member && (member.namespace || member.projectId)!==namespace)fail('group_action_namespace_changed');
        const membership=this.organization.getMembership(tabId);
        if(!membership)fail('group_action_membership_missing');
        return {tabId,namespace,execution,expectedMembershipRevision:membership.revision,
          ...(execution.tabType==='file'?{fileFamily:this.fileFamily(tabId).map(row=>({row,signature:this.signature(row.tab_id)}))}:{})};
      });
      if(kind==='move')this.organization.workflowRequired(request.workflowId);
      const value={kind,groupId,workflowId:request.workflowId || null,intent,members:frozen,
        expectedRevision:this.organization.getPublication().revision,
        archiveWatermark:this.db.prepare('SELECT COALESCE(MAX(id),0) id FROM tab_history').get().id};
      this.db.prepare('INSERT INTO workflow_group_actions VALUES(?,?,?,NULL)').run(intent.mutationId,signature,JSON.stringify(value));
      return {command:value,response:null};
    }).immediate();
    if(command.response)return command.response;
    if(kind==='move') {
      const value=command.command;
      // The organization operation and its stable receipt have one owner. A
      // pending action recovers this exact command after a crash/lost ACK.
      const moved=this.organization.moveTabs({mutationId:'group-move:'+intent.mutationId,workflowId:value.workflowId,
        expectedRevision:value.expectedRevision,members:value.members.map(member=>({tabId:member.tabId,expectedMembershipRevision:member.expectedMembershipRevision}))});
      const result={success:true,completed:true,mutationId:intent.mutationId,tabIds:moved.tabIds,...moved};
      this.db.prepare('UPDATE workflow_group_actions SET response_json=? WHERE mutation_id=?').run(JSON.stringify(result),intent.mutationId);
      return result;
    }
    return {success:true,mutationId:intent.mutationId,completed:false};
  }
  closureProven(command,member) {
    if(this.signature(member.tabId))return false;
    const fileProof=this.db.prepare('SELECT signature_json FROM workflow_group_file_closes WHERE mutation_id=? AND tab_id=?')
      .get(command.intent.mutationId,member.tabId);
    if(fileProof && fingerprint(JSON.parse(fileProof.signature_json))===fingerprint(member.execution))return true;
    // Native inactive identity survives close; legacy file rows use the exact
    // archive attachment manifest rather than name/path/time heuristics.
    const history=this.db.prepare('SELECT * FROM tab_history WHERE tab_id=? AND id>? ORDER BY id DESC').all(member.tabId,command.archiveWatermark);
    if(history.some(row=>fingerprint(executionScopeForRow(row))===fingerprint(member.execution.scope)
      && (row.codex_session_id || null)===(member.execution.codexSessionId || null)
      && (row.claude_session_id || null)===(member.execution.claudeSessionId || null)
      && (row.gemini_session_id || null)===(member.execution.geminiSessionId || null)))return true;
    const manifests=this.db.prepare('SELECT manifest_json FROM workflow_archived_file_links WHERE history_id>?').all(command.archiveWatermark);
    return manifests.some(row=>JSON.parse(row.manifest_json).files.some(file=>file.tab_id===member.tabId
      && fingerprint(executionScopeForRow(file))===fingerprint(member.execution.scope)));
  }
  step({mutationId,tabId}) {
    const command=this.command(mutationId);
    if(command.kind!=='close')fail('group_close_action_required');
    const member=command.members.find(member=>member.tabId===tabId);
    if(!member)fail('group_close_member_not_requested');
    const old=this.db.prepare('SELECT * FROM workflow_group_close_steps WHERE mutation_id=? AND tab_id=?').get(mutationId,tabId);
    if(old?.state==='completed' || this.closureProven(command,member))return this.ack({mutationId,tabId});
    if(fingerprint(this.signature(tabId))!==fingerprint(member.execution))fail('group_close_execution_changed');
    const guardToken=old?.guard_token || crypto.randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO workflow_group_close_steps VALUES(?,?,?,'prepared')").run(mutationId,tabId,guardToken);
    return {success:true,completed:false,closeGuard:{mutationId,tabId,guardToken}};
  }
  assertCloseGuard({mutationId,tabId,guardToken}) {
    const command=this.command(mutationId),member=command.members.find(member=>member.tabId===tabId);
    const step=this.db.prepare('SELECT * FROM workflow_group_close_steps WHERE mutation_id=? AND tab_id=?').get(mutationId,tabId);
    if(!member || !step || step.state!=='prepared' || step.guard_token!==guardToken
      || fingerprint(this.signature(tabId))!==fingerprint(member.execution))fail('group_close_execution_changed');
  }
  prepareFileClose(guard,snapshots) {
    this.assertCloseGuard(guard);
    const row=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(guard.tabId);
    if(row?.tab_type!=='file')fail('group_file_close_required');
    const command=this.command(guard.mutationId),member=command.members.find(item=>item.tabId===guard.tabId);
    const family=member.fileFamily;
    if(!family?.length)fail('group_file_close_frozen_family_required');
    const files=this.fileFamily(guard.tabId),seen=new Set(files.map(file=>file.tab_id));
    if(fingerprint(files.map(file=>file.tab_id).sort())!==fingerprint(family.map(item=>item.row.tab_id).sort()))fail('group_file_close_family_changed');
    for(const expected of family) {
      const current=files.find(file=>file.tab_id===expected.row.tab_id);
      if(!current || current.tab_type!=='file' || current.id!==this.fileStorageId(guard.mutationId,expected)
        || current.execution_storage_revision!==this.fileRevision(guard.mutationId,expected)
        || fingerprint(this.signature(current.tab_id))!==fingerprint(expected.signature))fail('group_file_close_family_changed');
    }
    // Check both directions: a stale/forged snapshot may not omit another
    // record just because all members of this family happen to be absent.
    for(const snapshot of snapshots) {
      const incoming=new Set(snapshot.tabs.map(tab=>tab.tabId));
      const actual=this.db.prepare('SELECT tab_id FROM tabs WHERE COALESCE(project_id,execution_namespace)=? AND execution_archived=0').all(snapshot.projectId);
      for(const file of actual)if(!incoming.has(file.tab_id) && !seen.has(file.tab_id))fail('group_file_close_outside_family');
    }
    for(const file of files) {
      const scope=executionScopeForRow(file),ns=scope.executionNamespace || scope.projectId;
      const snapshot=snapshots.find(item=>item.projectId===ns);
      if(!snapshot || !snapshot.expectedTabIds.includes(file.tab_id) || snapshot.tabs.some(tab=>tab.tabId===file.tab_id))fail('group_file_close_family_changed');
    }
    return {guard,files,signature:this.signature(guard.tabId),family};
  }
  fileStorageId(mutationId,expected) {
    let storageId=expected.row.id;
    const scope=executionScopeForRow(expected.row),namespace=scope.executionNamespace || scope.projectId;
    const receipts=this.db.prepare('SELECT * FROM workflow_group_close_storage_ids WHERE mutation_id=? AND tab_id=? ORDER BY rowid')
      .all(mutationId,expected.row.tab_id);
    for(const receipt of receipts) {
      if(receipt.namespace!==namespace || receipt.from_id!==storageId
        || fingerprint(JSON.parse(receipt.signature_json))!==fingerprint(expected.signature))fail('group_file_close_family_changed');
      storageId=receipt.to_id;
    }
    return storageId;
  }
  fileRevision(mutationId,expected) {
    let revision=expected.row.execution_storage_revision;
    const scope=executionScopeForRow(expected.row),namespace=scope.executionNamespace || scope.projectId;
    const receipts=this.db.prepare('SELECT * FROM workflow_group_close_revisions WHERE mutation_id=? AND tab_id=? ORDER BY to_revision')
      .all(mutationId,expected.row.tab_id);
    for(const receipt of receipts) {
      if(receipt.namespace!==namespace || receipt.storage_id!==expected.row.id || receipt.from_revision!==revision
        || fingerprint(JSON.parse(receipt.signature_json))!==fingerprint(expected.signature))fail('group_file_close_family_changed');
      revision=receipt.to_revision;
    }
    return revision;
  }
  prepareClose(guard,snapshots) {
    const command=this.command(guard.mutationId),member=command.members.find(item=>item.tabId===guard.tabId);
    const step=this.db.prepare('SELECT * FROM workflow_group_close_steps WHERE mutation_id=? AND tab_id=?').get(guard.mutationId,guard.tabId);
    if(command.kind!=='close' || !member || !step || step.state!=='prepared' || step.guard_token!==guard.guardToken)
      fail('group_close_execution_changed');
    const proof=member.execution.tabType==='file'?this.prepareFileClose(guard,snapshots):{guard};
    const expected=new Map(command.members.flatMap(item=>item.fileFamily || []).map(item=>[item.row.tab_id,item]));
    const advances=[];
    for(const item of expected.values()) {
      const row=this.db.prepare('SELECT * FROM tabs WHERE tab_id=? AND execution_archived=0').get(item.row.tab_id);
      if(!row || row.id!==this.fileStorageId(guard.mutationId,item)
        || row.execution_storage_revision!==this.fileRevision(guard.mutationId,item)
        || fingerprint(this.signature(row.tab_id))!==fingerprint(item.signature))continue;
      const scope=executionScopeForRow(row),namespace=scope.executionNamespace || scope.projectId;
      const incoming=snapshots.find(snapshot=>snapshot.projectId===namespace)?.tabs.find(tab=>tab.tabId===row.tab_id);
      if(!incoming || row.execution_subject_version===2 && (incoming.executionSubject?.subjectId!==row.execution_subject_id
        || incoming.executionStorageRevision!==row.execution_storage_revision))continue;
      advances.push({tabId:row.tab_id,namespace,storageId:row.id,subjectVersion:row.execution_subject_version,
        fromRevision:row.execution_storage_revision,signature:item.signature});
    }
    return {...proof,advances};
  }
  finishClose(proof) {
    if(!this.db.inTransaction)fail('group_file_close_transaction_required');
    if(proof.family)this.finishFileClose(proof);
    else {
      const command=this.command(proof.guard.mutationId),member=command.members.find(item=>item.tabId===proof.guard.tabId);
      if(!member || !this.closureProven(command,member))fail('group_close_not_committed');
    }
    for(const expected of proof.advances) {
      const row=this.db.prepare('SELECT * FROM tabs WHERE tab_id=? AND execution_archived=0').get(expected.tabId);
      if(expected.subjectVersion===1) {
        if(!row || row.execution_subject_version!==1 || row.project_id!==expected.namespace
          || row.execution_storage_revision!==expected.fromRevision
          || fingerprint(this.signature(row.tab_id))!==fingerprint(expected.signature))continue;
        if(row.id!==expected.storageId)this.db.prepare('INSERT OR IGNORE INTO workflow_group_close_storage_ids VALUES(?,?,?,?,?,?,?)')
          .run(proof.guard.mutationId,proof.guard.tabId,expected.tabId,expected.namespace,expected.storageId,row.id,JSON.stringify(expected.signature));
        continue;
      }
      // Only this synchronous transaction's exact CAS write advances proof.
      // Foreign revisions or changed type/relation/SID never become an ACK.
      if(!row || row.id!==expected.storageId || row.execution_namespace!==expected.namespace
        || row.execution_storage_revision!==expected.fromRevision+1
        || fingerprint(this.signature(row.tab_id))!==fingerprint(expected.signature))continue;
      this.db.prepare('INSERT OR IGNORE INTO workflow_group_close_revisions VALUES(?,?,?,?,?,?,?,?)')
        .run(proof.guard.mutationId,proof.guard.tabId,expected.tabId,expected.namespace,expected.storageId,
          expected.fromRevision,row.execution_storage_revision,JSON.stringify(expected.signature));
    }
  }
  fileFamily(tabId) {
    const row=this.db.prepare("SELECT * FROM tabs WHERE tab_id=? AND tab_type='file' AND execution_archived=0").get(tabId);
    if(!row)return [];
    const rows=this.db.prepare("SELECT * FROM tabs WHERE tab_type='file' AND execution_archived=0").all();
    const files=[row],seen=new Set([row.tab_id]);
    for(const parent of files)for(const child of rows)if(!seen.has(child.tab_id)
      && (child.visual_parent_tab_id || child.parent_tab_id)===parent.tab_id) {seen.add(child.tab_id);files.push(child);}
    return files;
  }
  finishFileClose(proof) {
    if(!this.db.inTransaction)fail('group_file_close_transaction_required');
    for(const file of proof.files)if(this.signature(file.tab_id))fail('group_file_close_not_committed');
    const command=this.command(proof.guard.mutationId);
    for(const item of proof.family) {
      const member=command.members.find(member=>member.tabId===item.row.tab_id);
      if(!member)continue;
      if(fingerprint(member.execution)!==fingerprint(item.signature))fail('group_file_close_execution_changed');
      this.db.prepare('INSERT OR IGNORE INTO workflow_group_file_closes VALUES(?,?,?,?)')
        .run(proof.guard.mutationId,member.tabId,JSON.stringify(member.execution),JSON.stringify(proof.files));
    }
  }
  ack({mutationId,tabId}) {
    const command=this.command(mutationId),member=command.members.find(member=>member.tabId===tabId);
    if(!member || !this.closureProven(command,member))fail('group_close_not_committed');
    const old=this.db.prepare('SELECT * FROM workflow_group_close_steps WHERE mutation_id=? AND tab_id=?').get(mutationId,tabId);
    this.db.prepare("INSERT INTO workflow_group_close_steps VALUES(?,?,?,'completed') ON CONFLICT(mutation_id,tab_id) DO UPDATE SET state='completed'")
      .run(mutationId,tabId,old?.guard_token || crypto.randomUUID());
    const complete=command.members.every(item=>this.db.prepare("SELECT 1 FROM workflow_group_close_steps WHERE mutation_id=? AND tab_id=? AND state='completed'").get(mutationId,item.tabId));
    if(complete)this.db.prepare('UPDATE workflow_group_actions SET response_json=? WHERE mutation_id=?')
      .run(JSON.stringify({success:true,completed:true,mutationId}),mutationId);
    return {success:true,completed:true,mutationId,tabId};
  }
}
module.exports={WorkflowGroupActions};
