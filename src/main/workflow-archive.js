'use strict';

const crypto = require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const { fingerprint } = require('./workflow-organization');
const { INBOX_WORKFLOW_ID, executionScopeForRow } = require('../shared/workflow-organization.cjs');
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const clean = value => JSON.parse(JSON.stringify(value));
const namespaceOf = row => row.execution_subject_version === 2 ? row.execution_namespace : row.project_id;

/** Global archive addresses remain namespace + storage PK, never workflow/cwd. */
class WorkflowArchive {
  constructor({ database, organization, fileLinks, groups,roots }) {
    this.database = database;
    this.db = database.db;
    this.organization = organization;
    this.fileLinks = fileLinks;
    this.groups = groups;
    this.roots=roots;
    this.leases = null;
    const existing=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_archive_meta' AND type='table'").get();
    if(existing && this.db.prepare('SELECT version FROM workflow_archive_meta WHERE singleton=1').get()?.version!==1)return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_archive_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO workflow_archive_meta VALUES(1,1);
      CREATE TABLE IF NOT EXISTS workflow_archive_restore_owners(history_id INTEGER PRIMARY KEY,
        namespace TEXT NOT NULL,source_tab_id TEXT,target_tab_id TEXT NOT NULL,archive_identity TEXT NOT NULL,
        baseline_metadata_json TEXT);
      CREATE TABLE IF NOT EXISTS workflow_archive_mutations(request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,response_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_archive_actions(request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,request_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_archive_metadata_transfers(history_id INTEGER PRIMARY KEY,
        namespace TEXT NOT NULL,owner_tab_id TEXT NOT NULL,metadata_json TEXT NOT NULL,archive_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_archive_finish_receipts(history_id INTEGER NOT NULL,namespace TEXT NOT NULL,
        lease_token TEXT NOT NULL,owner_tab_id TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(history_id,namespace,lease_token));`);
    if(!this.db.prepare('PRAGMA table_info(workflow_archive_restore_owners)').all().some(column=>column.name==='baseline_metadata_json'))
      this.db.exec('ALTER TABLE workflow_archive_restore_owners ADD COLUMN baseline_metadata_json TEXT');
  }
  writable() {
    if (this.db.prepare('SELECT version FROM workflow_archive_meta WHERE singleton=1').get()?.version !== 1) fail('workflow_archive_forward_version');
  }
  bindLeases(leases) { this.leases = leases; }
  inTransaction(fn) { return this.db.inTransaction ? fn() : this.db.transaction(fn).immediate(); }
  describe(entry) {
    if (!entry) return entry;
    const manifest = this.fileLinks.read(entry.id);
    return { ...entry, ...(manifest ? { attachmentManifest: { version: 1, hash: manifest.hash, count: manifest.files.length } } : {}) };
  }
  identity(row) {
    return fingerprint([row.id, namespaceOf(row), row.tab_id, row.execution_subject_version || 1,
      row.execution_subject_id || null, row.created_at, row.closed_at]);
  }
  validateLease(namespace, historyId, leaseToken) {
    this.writable();
    if (!this.leases) fail('archive_restore_leases_unavailable');
    const result = this.leases.validate({ projectId: namespace, id: historyId, token: leaseToken });
    if (!result.ok) fail('archive_restore_' + result.reason);
    return result.entry;
  }
  reserveOwner(entry, expectedTabId) {
    this.writable();
    const namespace = entry.project_id || entry.execution_namespace;
    if (expectedTabId && entry.tab_id !== expectedTabId) fail('archive_restore_source_changed');
    let claim = this.db.prepare('SELECT * FROM workflow_archive_restore_owners WHERE history_id=?').get(entry.id);
    const identity = this.identity({ ...entry, project_id: namespace });
    if (claim) {
      if (claim.namespace !== namespace || claim.archive_identity !== identity) fail('archive_restore_identity_changed');
    } else {
      const target = entry.execution_subject_version === 2 || expectedTabId ? entry.tab_id : 'restored-' + crypto.randomUUID();
      if (!target) fail('archive_restore_target_missing');
      const existing = this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(target);
      if (existing && (entry.execution_subject_version !== 2 || existing.execution_archived !== 1
        || existing.execution_subject_id !== entry.execution_subject_id || namespaceOf(existing) !== namespace)) fail('archive_restore_target_in_use');
      this.db.prepare(`INSERT INTO workflow_archive_restore_owners
        (history_id,namespace,source_tab_id,target_tab_id,archive_identity,baseline_metadata_json) VALUES(?,?,?,?,?,?)`)
        .run(entry.id, namespace, entry.tab_id || null, target, identity,JSON.stringify(this.metadata(entry)));
      claim = this.db.prepare('SELECT * FROM workflow_archive_restore_owners WHERE history_id=?').get(entry.id);
    }
    const owner = this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(claim.target_tab_id);
    // An older claim with no materialized owner can still establish a proven
    // baseline. Never infer an already-live replacement's old notes from it.
    if(!claim.baseline_metadata_json && (!owner || owner.execution_archived===1))
      this.db.prepare('UPDATE workflow_archive_restore_owners SET baseline_metadata_json=? WHERE history_id=?')
        .run(JSON.stringify(this.metadata(entry)),entry.id);
    let origin=null;try{origin=JSON.parse(owner?.execution_record_json || '{}').archiveRestoreOrigin;}catch{ /* no receipt */ }
    const restored = owner && owner.execution_archived !== 1 && namespaceOf(owner) === namespace
      && (owner.codex_session_id || null)===(entry.codex_session_id || null)
      && (owner.claude_session_id || null)===(entry.claude_session_id || null)
      && (entry.execution_subject_version !== 2 || owner.execution_subject_id === entry.execution_subject_id && origin?.historyId===entry.id);
    if(owner && owner.execution_archived!==1 && !restored)fail('archive_restore_target_in_use');
    return { targetTabId: claim.target_tab_id, ...(restored ? {
      replacement: { namespace, historyId: entry.id, tabId: claim.target_tab_id, sourceTabId: entry.tab_id || null },
    } : {}) };
  }
  beginRestore({ projectId, id, request } = {}) {
    this.writable();
    if (request) this.assertAddress('history', request);
    const result = this.leases.begin({ projectId, id });
    if (!result.ok) return result;
    try {
      this.leases.leases.get(result.id).metadataSnapshot=this.metadata(result.entry);
      const claim = this.inTransaction(() => this.reserveOwner(result.entry, request?.expectedTabId));
      if(result.entry.execution_subject_version===2) {
        const owner=this.database.getExecutionTabV2({executionNamespace:projectId,tabId:claim.targetTabId,subjectId:result.entry.execution_subject_id});
        this.leases.leases.get(result.id).restoreRevision=owner?.archived?owner.revision
          : owner?.tab.archiveRestoreOrigin?.closedRevision ?? result.entry.execution_storage_revision+1;
      }
      return { ...result, entry: { ...this.describe(result.entry), restoreTargetTabId: claim.targetTabId },
        ...(claim.replacement ? { replacement: claim.replacement } : {}) };
    } catch (error) {
      this.leases.finish({ projectId, id: result.id, token: result.token, commit: false });
      return { ok: false, reason: error.code || error.message, id: result.id };
    }
  }
  restoreExecution({ namespace, historyId, leaseToken,cwd }) {
    const entry = this.validateLease(namespace, historyId, leaseToken);
    if (entry.execution_subject_version !== 2) fail('execution_restore_subject_required');
    const claim = this.reserveOwner(entry, entry.tab_id);
    const closedRevision=this.leases.leases.get(historyId).restoreRevision;
    const mutationId = 'archive-restore:' + fingerprint([namespace, historyId,closedRevision]);
    let request;
    const previous = this.db.prepare('SELECT request_json FROM workflow_execution_mutations WHERE mutation_id=?').get(mutationId);
    if (previous) request = JSON.parse(previous.request_json).request;
    else {
      const current = this.database.getExecutionTabV2({ executionNamespace: namespace, tabId: entry.tab_id, subjectId: entry.execution_subject_id });
      if(current && (!current.archived || current.revision!==closedRevision))fail('archive_closed_owner_changed');
      const directory=cwd || entry.cwd;
      if(!path.isAbsolute(directory || '') || !fs.statSync(directory).isDirectory())fail('working_directory_unavailable');
      request = { mutationId, executionNamespace: namespace, archiveId: historyId,
        subjectId: entry.execution_subject_id, expectedRevision: closedRevision,cwd:directory };
    }
    this.database.restoreExecutionTabV2(request);
    const current = this.database.getExecutionTabV2({ executionNamespace: namespace, tabId: claim.targetTabId, subjectId: entry.execution_subject_id });
    if (!current || current.archived) fail('archive_restored_owner_changed');
    return { success: true, namespace, historyId, tabId: current.tab.tabId, tab: current.tab,
      executionSubject: current.executionSubject, executionStorageRevision: current.revision };
  }
  restoreFiles({ namespace, historyId, ownerTabId, manifestHash, leaseToken }) {
    this.validateLease(namespace, historyId, leaseToken);
    const claim = this.db.prepare('SELECT * FROM workflow_archive_restore_owners WHERE history_id=?').get(historyId);
    if (!claim || claim.namespace !== namespace || claim.target_tab_id !== ownerTabId) fail('archive_restore_owner_changed');
    const result = this.fileLinks.restore({ historyId, namespace, ownerTabId, manifestHash });
    this.ensureRestoredCatalog(historyId,namespace,ownerTabId);
    return { success: true, namespace, historyId, ownerTabId, ...result };
  }
  finishRestore(request) {
    this.writable();
    const receipt=this.db.prepare('SELECT response_json FROM workflow_archive_finish_receipts WHERE history_id=? AND namespace=? AND lease_token=?')
      .get(request.id,request.projectId,request.token);
    if(receipt)return JSON.parse(receipt.response_json);
    if (request.commit) {
      const entry = this.validateLease(request.projectId, request.id, request.token);
      this.fileLinks.assertRestored(request.id, request.projectId);
      const claim = this.db.prepare('SELECT * FROM workflow_archive_restore_owners WHERE history_id=?').get(request.id);
      const owner = claim && this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(claim.target_tab_id);
      if (!owner || owner.execution_archived === 1 || namespaceOf(owner) !== request.projectId
        || entry.execution_subject_version === 2 && owner.execution_subject_id !== entry.execution_subject_id) fail('archive_restore_owner_not_persisted');
      const transfer=this.db.prepare('SELECT * FROM workflow_archive_metadata_transfers WHERE history_id=?').get(request.id);
      const origin=JSON.parse(owner.execution_record_json || '{}').archiveRestoreOrigin;
      const archiveHash=fingerprint(this.metadata(entry));
      if(!transfer && entry.execution_subject_version===2 && fingerprint(origin?.metadata || null)!==archiveHash
        || !transfer && entry.execution_subject_version!==2 && fingerprint(this.metadata(owner))!==archiveHash
        || transfer && (transfer.namespace!==request.projectId || transfer.owner_tab_id!==claim.target_tab_id || transfer.archive_hash!==archiveHash))
        fail('archive_metadata_transfer_unconfirmed');
      this.ensureRestoredCatalog(request.id,request.projectId,claim.target_tab_id);
      return this.inTransaction(()=>{
        const result=this.leases.finish(request);
        if(result.ok && result.committed) {
          const currentOwner=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(claim.target_tab_id);
          result.restoration={version:1,namespace:request.projectId,historyId:request.id,leaseToken:request.token,
            sourceTabId:entry.tab_id,targetTabId:claim.target_tab_id,archiveIdentity:claim.archive_identity,
            ownerIdentity:this.restorationOwnerIdentity(currentOwner)};
          this.db.prepare('INSERT INTO workflow_archive_finish_receipts VALUES(?,?,?,?,?)')
            .run(request.id,request.projectId,request.token,claim.target_tab_id,JSON.stringify(result));
        }
        return result;
      });
    }
    return this.leases.finish(request);
  }
  restorationOwnerIdentity(owner) {
    const origin=owner.execution_subject_version===2
      ? JSON.parse(owner.execution_record_json || '{}').archiveRestoreOrigin : null;
    return fingerprint([owner.id,owner.created_at,namespaceOf(owner),owner.tab_id,owner.cwd,owner.command_type,
      owner.claude_session_id || null,owner.codex_session_id || null,
      owner.execution_subject_version || 1,owner.execution_subject_id || null,
      origin?.historyId || null,origin?.closedRevision ?? null]);
  }
  readCommittedRestoration(address) {
    this.writable();
    if(typeof address?.namespace!=='string' || !Number.isSafeInteger(address.historyId) || address.historyId<1
      || !Object.prototype.hasOwnProperty.call(address,'sourceTabId'))fail('archive_restore_address_invalid');
    const row=this.db.prepare(`SELECT response_json FROM workflow_archive_finish_receipts
      WHERE namespace=? AND history_id=?`+(address.leaseToken?' AND lease_token=?':'')+' ORDER BY rowid DESC LIMIT 1')
      .get(...(address.leaseToken?[address.namespace,address.historyId,address.leaseToken]:[address.namespace,address.historyId]));
    const response=row && JSON.parse(row.response_json),proof=response?.restoration;
    if(response?.ok!==true || response.committed!==true || proof?.version!==1
      || proof.namespace!==address.namespace || proof.historyId!==address.historyId || proof.sourceTabId!==address.sourceTabId
      || address.targetTabId && proof.targetTabId!==address.targetTabId
      || address.archiveIdentity && proof.archiveIdentity!==address.archiveIdentity
      || address.ownerIdentity && proof.ownerIdentity!==address.ownerIdentity)fail('archive_restore_commit_unconfirmed');
    const owner=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(proof.targetTabId);
    if(!owner || owner.execution_archived===1 || this.restorationOwnerIdentity(owner)!==proof.ownerIdentity)
      fail('archive_restore_live_owner_changed');
    return clean(proof);
  }
  metadata(row) {return {name:row.name,notes:row.notes ?? '',nameSetManually:row.name_set_manually===1};}
  synchronizeMetadata({namespace,historyId,ownerTabId,leaseToken,expectedLiveMetadata}) {
    return this.inTransaction(()=>{
      const entry=this.validateLease(namespace,historyId,leaseToken);
      const claim=this.db.prepare('SELECT * FROM workflow_archive_restore_owners WHERE history_id=?').get(historyId);
      const owner=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(ownerTabId);
      if(!claim || claim.target_tab_id!==ownerTabId || claim.namespace!==namespace || !owner || owner.execution_archived===1
        || namespaceOf(owner)!==namespace)fail('archive_restore_owner_changed');
      const live=this.metadata(owner),archive=this.metadata(entry);
      if(fingerprint(live)!==fingerprint(expectedLiveMetadata))fail('archive_live_metadata_changed');
      const previous=this.db.prepare('SELECT * FROM workflow_archive_metadata_transfers WHERE history_id=?').get(historyId);
      const origin=JSON.parse(owner.execution_record_json || '{}').archiveRestoreOrigin;
      if(previous && (previous.namespace!==namespace || previous.owner_tab_id!==ownerTabId))fail('archive_restore_owner_changed');
      const baseline=previous?JSON.parse(previous.metadata_json):origin?.metadata || JSON.parse(claim.baseline_metadata_json || 'null');
      if(!baseline)fail('archive_metadata_conflict');
      const next={...live};
      for(const key of Object.keys(archive)) {
        if(archive[key]===baseline[key])continue;
        if(live[key]!==baseline[key] && live[key]!==archive[key])fail('archive_metadata_conflict');
        next[key]=archive[key];
      }
      if(fingerprint(next)!==fingerprint(live)) {
        if(owner.execution_subject_version===2)this.database.saveExecutionTabV2({executionNamespace:namespace,tabId:ownerTabId,
          subjectId:owner.execution_subject_id,expectedRevision:owner.execution_storage_revision,
          columns:{name:next.name,notes:next.notes,name_set_manually:Number(next.nameSetManually)},record:next});
        else this.db.prepare('UPDATE tabs SET name=?,notes=?,name_set_manually=? WHERE tab_id=? AND project_id=?')
          .run(next.name,next.notes,Number(next.nameSetManually),ownerTabId,namespace);
      }
      this.db.prepare('INSERT INTO workflow_archive_metadata_transfers VALUES(?,?,?,?,?) ON CONFLICT(history_id) DO UPDATE SET metadata_json=excluded.metadata_json,archive_hash=excluded.archive_hash')
        .run(historyId,namespace,ownerTabId,JSON.stringify(archive),fingerprint(archive));
      const current=this.db.prepare('SELECT execution_storage_revision FROM tabs WHERE tab_id=?').get(ownerTabId);
      return {success:true,namespace,historyId,ownerTabId,metadata:next,executionStorageRevision:current.execution_storage_revision};
    });
  }
  ensureRestoredCatalog(historyId,namespace,ownerTabId) {
    if(this.organization.getPublication().migrationVersion!==1 || this.organization.getTab(ownerTabId))return;
    const entry=this.database.getTabHistoryEntry(historyId,namespace);
    if(!entry)fail('archive_address_changed');
    const sourceMember=entry.tab_id && this.organization.getMembership(entry.tab_id);
    let workflowId=sourceMember?.workflowId;
    if(!workflowId || !this.organization.getWorkflow(workflowId))workflowId=INBOX_WORKFLOW_ID;
    const sourceGroup=entry.tab_id && this.groups.read().tabGroups[entry.tab_id];
    this.organization.registerLegacyTab({mutationId:'archive-register:'+fingerprint([namespace,historyId]),
      expectedRevision:this.organization.getPublication().revision,legacyNamespace:namespace,tabId:ownerTabId,workflowId,
      sourceTabId:entry.tab_id || null,record:sourceGroup?{globalGroupId:sourceGroup}:{}});
  }
  read() {
    const run = () => {
      const workflows = this.organization.listWorkflows();
      const map = new Map(workflows.map(workflow => [workflow.id, workflow]));
      const rows = table => this.db.prepare(`SELECT * FROM ${table} ${table === 'tab_history' ? `WHERE (tab_type IS NULL OR tab_type!='file') AND ${this.database.visibleTabHistorySql()}` : ''} ORDER BY id DESC`).all()
        .map(raw => {
          const namespace = namespaceOf(raw);
          const row = this.database._executionWireRow(raw);
          let context = {}; try { context = JSON.parse(raw.workflow_context_json || '{}'); } catch { /* raw payload retained */ }
          const workflowId = context.workflowId || context.restorePlacement?.window?.spaceId
            || (raw.tab_id && this.organization.getMembership(raw.tab_id)?.workflowId) || INBOX_WORKFLOW_ID;
          const lease = this.leases?.leases.get(row.id);
          return { ...row, namespace, workflowId, workflowName: map.get(workflowId)?.metadata?.name || map.get(workflowId)?.name || null,
            ...(table === 'tab_history' && lease && this.leases.now()-lease.createdAt < this.leases.leaseTtlMs
              ? { protected: true, protectedReason: 'Восстановление уже выполняется' } : {}) };
        });
      const history = rows('tab_history'), favorites = rows('favorites');
      const clearScopes=[...new Set(history.map(row=>row.namespace))].map(namespace=>this.clearScope(namespace));
      return { version: 1, history, favorites,clearScopes, revision: fingerprint({ history, favorites }) };
    };
    return this.db.inTransaction ? run() : this.db.transaction(run)();
  }
  clearScope(namespace) {
    const rows=this.db.prepare(`SELECT * FROM tab_history WHERE COALESCE(project_id,execution_namespace)=? AND ${this.database.visibleTabHistorySql()} ORDER BY id`).all(namespace);
    return {namespace,historyIds:rows.map(row=>row.id),rowsHash:fingerprint(rows),count:rows.length,
      cwds:[...new Set(rows.map(row=>row.cwd))],notesCount:rows.filter(row=>!!row.notes).length};
  }
  clearReceipt(request) {
    const previous=this.db.prepare('SELECT * FROM workflow_archive_mutations WHERE request_id=?').get(request.requestId);
    if(!previous)return null;
    if(previous.request_hash!==fingerprint(request))fail('archive_request_id_conflict');
    return JSON.parse(previous.response_json);
  }
  clearRefusal(request,error) {
    const existing=this.clearReceipt(request);if(existing)return existing;
    const result={success:false,disposition:'not-applied',version:request.version,requestId:request.requestId,
      namespace:request.namespace,kind:request.kind,historyIds:request.historyIds,expectedRowsHash:request.expectedRowsHash,error};
    this.db.prepare('INSERT INTO workflow_archive_mutations VALUES(?,?,?)').run(request.requestId,fingerprint(request),JSON.stringify(result));
    return result;
  }
  clearNamespace(request) {
    this.writable();
    if(request?.version!==1 || !request.requestId || !request.namespace
      || !['clear-history','clear-except-notes'].includes(request.kind))fail('archive_clear_request_required');
    return this.inTransaction(()=>{
      const signature=fingerprint(request);
      const previous=this.db.prepare('SELECT * FROM workflow_archive_mutations WHERE request_id=?').get(request.requestId);
      if(previous) {
        if(previous.request_hash!==signature)fail('archive_request_id_conflict');
        return JSON.parse(previous.response_json);
      }
      const actual=this.clearScope(request.namespace);
      if(actual.rowsHash!==request.expectedRowsHash || fingerprint(actual.historyIds)!==fingerprint(request.historyIds))fail('archive_clear_scope_changed');
      for(const id of actual.historyIds) {
        const lease=this.leases?.leases.get(id);
        if(lease && this.leases.now()-lease.createdAt < this.leases.leaseTtlMs)fail('archive_restore_busy');
      }
      const rows=this.db.prepare(`SELECT id,notes FROM tab_history WHERE COALESCE(project_id,execution_namespace)=? AND ${this.database.visibleTabHistorySql()}`).all(request.namespace);
      const ids=rows.filter(row=>request.kind==='clear-history' || !row.notes).map(row=>row.id);
      for(const id of ids)this.database.deleteTabHistoryEntry(id);
      const result={success:true,version:1,namespace:request.namespace,requestId:request.requestId,kind:request.kind,
        historyIds:request.historyIds,expectedRowsHash:request.expectedRowsHash,deletedIds:ids};
      this.db.prepare('INSERT INTO workflow_archive_mutations VALUES(?,?,?)').run(request.requestId,signature,JSON.stringify(result));
      return result;
    });
  }
  assertAddress(kind, request) {
    if (request?.version !== 1 || typeof request.namespace !== 'string' || !request.namespace
      || typeof request.requestId !== 'string' || !request.requestId) fail('archive_exact_request_required');
    const table = kind === 'favorite' ? 'favorites' : 'tab_history';
    const id = kind === 'favorite' ? request.favoriteId : request.historyId;
    if (!Number.isSafeInteger(id) || id < 1 || request.record?.id !== id || request.record.namespace !== request.namespace) fail('archive_exact_address_required');
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row || namespaceOf(row) !== request.namespace || request.expectedTabId && row.tab_id !== request.expectedTabId) fail('archive_address_changed');
    if (kind !== 'favorite' && !this.database.getTabHistoryEntry(id, request.namespace)) fail('archive_address_changed');
    if (request.expectedRevision !== undefined && this.read().revision !== request.expectedRevision) fail('archive_revision_changed');
    return row;
  }
  mutate(kind, request, createTab) {
    this.writable();
    request = clean(request);
    const signature = fingerprint({ kind, request });
    const previous = this.db.prepare('SELECT * FROM workflow_archive_mutations WHERE request_id=?').get(request.requestId);
    if (previous) {
      if (previous.request_hash !== signature) fail('archive_request_id_conflict');
      return JSON.parse(previous.response_json);
    }
    if (kind === 'open-favorite') return this.openFavorite(request,signature,createTab);
    return this.inTransaction(() => {
      const favorite = ['remove-favorite','open-favorite'].includes(kind);
      const row = this.assertAddress(favorite ? 'favorite' : 'history', request);
      const lease=this.leases?.leases.get(row.id);
      if (lease && this.leases.now()-lease.createdAt < this.leases.leaseTtlMs && !favorite) fail('archive_restore_busy');
      let result = { success: true, namespace: request.namespace, requestId: request.requestId,
        ...(favorite ? { favoriteId: row.id } : { historyId: row.id }) };
      if (kind === 'delete-history') this.database.deleteTabHistoryEntry(row.id);
      else if (kind === 'remove-favorite') this.database.deleteFavorite(row.id);
      else if (kind === 'rename-history') {
        if (!this.database.updateTabHistoryTitle(row.id, request.name, true)) fail('archive_rename_failed');
      } else if (kind === 'update-notes') {
        if (typeof request.notes !== 'string') fail('archive_notes_required');
        this.db.prepare('UPDATE tab_history SET notes=? WHERE id=?').run(request.notes, row.id);
      } else if (kind === 'add-favorite') {
        const values = { ...row }; delete values.id;
        const info = this.database._executionInsert('favorites', values);
        result.favoriteId = Number(info.lastInsertRowid);
      } else fail('archive_action_unknown');
      this.db.prepare('INSERT INTO workflow_archive_mutations VALUES(?,?,?)').run(request.requestId, signature, JSON.stringify(result));
      return result;
    });
  }
  openFavorite(request,signature,createTab) {
    if (typeof createTab !== 'function') fail('archive_creation_unavailable');
    const command=this.inTransaction(() => {
      const accepted=this.db.prepare('SELECT * FROM workflow_archive_actions WHERE request_id=?').get(request.requestId);
      if(accepted) {
        if(accepted.request_hash!==signature)fail('archive_request_id_conflict');
        return JSON.parse(accepted.request_json);
      }
      const row=this.assertAddress('favorite',request);
      const parse=(value,fallback) => {try{return typeof value==='string'?JSON.parse(value):value ?? fallback;}catch{return fallback;}};
      const record={name:row.name,color:row.color,notes:row.notes,cwd:row.cwd,
        tabType:row.tab_type,commandType:row.command_type,claudeSessionId:row.claude_session_id,
        codexSessionId:row.codex_session_id,geminiSessionId:row.gemini_session_id,
        taskPlan:parse(row.task_plan,null),externalRun:parse(row.external_run,null),codexModel:row.codex_model,codexEffort:row.codex_effort};
      const command=clean({mutationId:'favorite-open:'+request.requestId,cwd:row.cwd,record,
        workflowId:request.targetWorkflowId || (row.tab_id && this.organization.getMembership(row.tab_id)?.workflowId) || INBOX_WORKFLOW_ID});
      this.db.prepare('INSERT INTO workflow_archive_actions VALUES(?,?,?)').run(request.requestId,signature,JSON.stringify(command));
      return command;
    });
    // Organization owns its commit; the durable accepted command above makes
    // a crash between commits recover the same created tab, never a duplicate.
    const created=createTab(command);
    const result={success:true,namespace:request.namespace,requestId:request.requestId,favoriteId:request.favoriteId,tabId:created.tabId};
    this.db.prepare('INSERT INTO workflow_archive_mutations VALUES(?,?,?)').run(request.requestId,signature,JSON.stringify(result));
    return result;
  }
}

module.exports = { WorkflowArchive };
