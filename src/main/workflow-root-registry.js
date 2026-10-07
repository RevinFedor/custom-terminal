'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const {normalizeSourceRoots}=require('./project-prompt-catalog');

/** Directory registrations are sources, never the lifetime owner of a tab. */
class WorkflowRootRegistry {
  constructor(database) {
    this.database = database;
    this.db = database.db;
    this.onChanged=()=>{};
    const present=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_root_meta' AND type='table'").get();
    if(present && this.db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1').get()?.version!==1)return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_roots (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, metadata_json TEXT NOT NULL,
      revision INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workflow_root_bindings (
        scope TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES workflow_roots(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY(scope, root_id));
      CREATE TABLE IF NOT EXISTS workflow_root_meta (singleton INTEGER PRIMARY KEY,version INTEGER NOT NULL,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO workflow_root_meta VALUES(1,1,0);
      CREATE TABLE IF NOT EXISTS workflow_root_mutations (id TEXT PRIMARY KEY,request_json TEXT NOT NULL,result_json TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_root_scope_meta(scope TEXT PRIMARY KEY,version INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1);`);
  }
  fail(code) { throw Object.assign(new Error(code), { code, statusCode: 409 }); }
  read() {
    return this.db.transaction(() => ({ ...this.db.prepare('SELECT version,revision FROM workflow_root_meta WHERE singleton=1').get(),
      roots: this.db.prepare('SELECT * FROM workflow_roots WHERE removed=0 ORDER BY rowid').all().map(row => (
        { ...JSON.parse(row.metadata_json), id: row.id, path: row.path, revision: row.revision })),
    }))();
  }
  seedLegacy(tables) {
    if(this.db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1').get()?.version!==1)this.fail('root_forward_version');
    const put = (path, metadata, scope, position) => {
      if (typeof path !== 'string' || !path.startsWith('/')) return;
      const id = 'root:' + crypto.createHash('sha256').update(path).digest('hex').slice(0,24);
      this.db.prepare('INSERT OR IGNORE INTO workflow_roots(id,path,metadata_json,revision) VALUES(?,?,?,1)')
        .run(id,path,JSON.stringify({name:metadata.name || path.split('/').pop(),kind:metadata.kind || 'directory',icon:metadata.icon || null,enabled:true}));
      if (scope) this.db.prepare('INSERT OR IGNORE INTO workflow_root_bindings(scope,root_id,position,metadata_json) VALUES(?,?,?,?)')
        .run(scope,id,position,JSON.stringify(metadata));
    };
    for (const [position, project] of (tables.projects || []).entries()) {
      put(project.path, {name:project.name,icon:project.icon,kind:'directory',legacyNamespace:project.id}, 'namespace:' + project.id, position);
    }
    for (const [position, source] of (tables.project_prompt_sources || []).entries()) {
      const path = source.root_path || source.path || source.source_path || source.folder_path;
      put(path, {...source,kind:'prompt-source'}, 'prompts:' + source.project_id, position);
    }
    for(const tab of [...(tables.tabs || []),...(tables.tab_history || [])]) {
      if(!tab.tab_id)continue;
      const scope='tab:'+tab.tab_id;
      if(this.db.prepare('SELECT 1 FROM workflow_root_scope_meta WHERE scope=?').get(scope))continue;
      const namespace=tab.execution_namespace || tab.project_id;
      this.copyBindings(scope,'prompts:'+namespace);
    }
  }
  copyBindings(scope,sourceScope) {
    const version=this.db.prepare('SELECT version FROM workflow_root_scope_meta WHERE scope=?').get(sourceScope)?.version || 1;
    for(const binding of this.db.prepare('SELECT * FROM workflow_root_bindings WHERE scope=? ORDER BY position').all(sourceScope))
      this.db.prepare('INSERT OR IGNORE INTO workflow_root_bindings VALUES(?,?,?,?)')
        .run(scope,binding.root_id,binding.position,binding.metadata_json);
    // Preserve opaque future bindings and their version without interpreting
    // them. Unrelated tab creation stays available; old readers refuse that scope.
    this.db.prepare('INSERT OR IGNORE INTO workflow_root_scope_meta VALUES(?,?,1)').run(scope,version);
  }
  bindCreatedTab(tabId,namespace,sourceTabId) {
    if(!this.db.inTransaction)this.fail('root_binding_transaction_required');
    if(this.db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1').get()?.version!==1)this.fail('root_forward_version');
    let sourceScope=sourceTabId && 'tab:'+sourceTabId;
    if(!sourceScope || !this.db.prepare('SELECT 1 FROM workflow_root_scope_meta WHERE scope=?').get(sourceScope)) {
      const row=sourceTabId && this.db.prepare('SELECT project_id,execution_namespace FROM tabs WHERE tab_id=?').get(sourceTabId);
      sourceScope='prompts:'+(row?.execution_namespace || row?.project_id || namespace);
    }
    this.copyBindings('tab:'+tabId,sourceScope);
  }
  sourcesForTab(tabId) {
    const scope='tab:'+tabId;
    const row=this.db.prepare('SELECT project_id,execution_namespace FROM tabs WHERE tab_id=?').get(tabId);
    const catalog=this.db.prepare('SELECT execution_json FROM workflow_org_tabs WHERE tab_id=?').get(tabId);
    const execution=catalog?.execution_json ? JSON.parse(catalog.execution_json) : null;
    const namespace=row?.execution_namespace || row?.project_id || execution?.executionNamespace || execution?.projectId || null;
    const registered=this.db.prepare('SELECT * FROM workflow_root_scope_meta WHERE scope=?').get(scope);
    if(registered && registered.version!==1)this.fail('root_binding_forward_version');
    const sourceScope=registered?scope:'prompts:'+namespace;
    return this.db.prepare(`SELECT r.*,b.position,b.metadata_json AS binding_json FROM workflow_root_bindings b
      JOIN workflow_roots r ON r.id=b.root_id WHERE b.scope=? ORDER BY b.position,r.id`).all(sourceScope)
      .map(root=>({...JSON.parse(root.metadata_json),...JSON.parse(root.binding_json),id:root.id,rootId:root.id,
        rootPath:root.path,projectId:JSON.parse(root.binding_json).project_id || namespace,position:root.position,
        removed:root.removed===1,enabled:root.removed!==1 && JSON.parse(root.metadata_json).enabled!==false}));
  }
  listSourceScopes() {
    return this.db.prepare("SELECT scope FROM workflow_root_scope_meta WHERE scope LIKE 'tab:%' ORDER BY scope").all()
      .map(row=>({id:row.scope,tabId:row.scope.slice(4),name:row.scope.slice(4)}));
  }
  setTabSources(request) {
    return this.mutate('tab-sources',request,()=>{
      if(typeof request.tabId!=='string' || !request.tabId || !Array.isArray(request.rootIds)
        || new Set(request.rootIds).size!==request.rootIds.length)this.fail('root_binding_request_invalid');
      if(!this.db.prepare('SELECT 1 FROM workflow_org_tabs WHERE tab_id=?').get(request.tabId))this.fail('root_binding_tab_unknown');
      const scope='tab:'+request.tabId,old=this.db.prepare('SELECT * FROM workflow_root_scope_meta WHERE scope=?').get(scope);
      if(old && old.version!==1)this.fail('root_binding_forward_version');
      const bindings=new Map(this.db.prepare('SELECT * FROM workflow_root_bindings WHERE scope=?').all(scope).map(binding=>[binding.root_id,binding]));
      const roots=request.rootIds.map(rootId=>{
        const row=this.db.prepare('SELECT * FROM workflow_roots WHERE id=?').get(rootId);
        if(!row || row.removed===1 && !bindings.has(rootId))this.fail('root_registration_missing');
        return row;
      });
      if(normalizeSourceRoots(roots.map(root=>root.path)).length!==roots.length)this.fail('overlapping_prompt_sources');
      this.db.prepare('DELETE FROM workflow_root_bindings WHERE scope=?').run(scope);
      for(const [position,root] of roots.entries())this.db.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,?,?)')
        .run(scope,root.id,position,bindings.get(root.id)?.metadata_json || JSON.stringify({kind:'prompt-source',bindingVersion:1}));
      this.db.prepare('INSERT INTO workflow_root_scope_meta VALUES(?,1,1) ON CONFLICT(scope) DO UPDATE SET revision=revision+1').run(scope);
      return {tabId:request.tabId,rootIds:request.rootIds};
    });
  }
  mutate(kind, request, change) {
    const payload = JSON.stringify({kind,...request});
    if (typeof request.mutationId !== 'string' || !request.mutationId) this.fail('root_mutation_id_required');
    let replay=false;
    const result=this.db.transaction(() => {
      const meta = this.db.prepare('SELECT * FROM workflow_root_meta WHERE singleton=1').get();
      if (meta.version !== 1) this.fail('root_forward_version');
      const old = this.db.prepare('SELECT * FROM workflow_root_mutations WHERE id=?').get(request.mutationId);
      if (old) { if (old.request_json !== payload) this.fail('root_mutation_id_conflict'); replay=true;return JSON.parse(old.result_json); }
      if (request.expectedRevision !== meta.revision) this.fail('root_revision_changed');
      const result = change();
      this.db.prepare('UPDATE workflow_root_meta SET revision=revision+1 WHERE singleton=1').run();
      const answer = {...result,version:1,revision:meta.revision+1};
      this.db.prepare('INSERT INTO workflow_root_mutations VALUES(?,?,?)').run(request.mutationId,payload,JSON.stringify(answer));
      return answer;
    }).immediate();
    if(!replay)this.notify({kind,tabIds:request.tabId?[request.tabId]:null});
    return result;
  }
  notify(change) {try{this.onChanged(change);}catch(error){console.warn('[WorkflowRoots] committed; catalog refresh failed:',error?.message || error);}}
  save(request) {
    return this.mutate('save',request,() => {
      const old = request.id ? this.db.prepare('SELECT * FROM workflow_roots WHERE id=? AND removed=0').get(request.id) : null;
      if (request.id && !old) this.fail('root_missing');
      const path = request.path || old?.path;
      // Validate a new path only. A temporarily missing registration remains editable.
      if (typeof path !== 'string' || !path.startsWith('/')) this.fail('root_path_required');
      if ((!old || path !== old.path) && !fs.statSync(path).isDirectory()) this.fail('working_directory_unavailable');
      const id = old?.id || 'root:' + crypto.randomUUID();
      const metadata = {...(old ? JSON.parse(old.metadata_json) : {}), ...request};
      for (const key of ['id','path','mutationId','expectedRevision']) delete metadata[key];
      this.db.prepare(`INSERT INTO workflow_roots(id,path,metadata_json,revision) VALUES(?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,metadata_json=excluded.metadata_json,revision=workflow_roots.revision+1,removed=0`)
        .run(id,path,JSON.stringify(metadata));
      return {id};
    });
  }
  remove(request) {
    return this.mutate('remove',request,() => {
      const root = this.db.prepare('SELECT * FROM workflow_roots WHERE id=? AND removed=0').get(request.id);
      if (!root || root.revision !== request.expectedRootRevision) this.fail('root_revision_changed');
      this.db.prepare('UPDATE workflow_roots SET removed=1,revision=revision+1 WHERE id=?').run(request.id);
      // Historical registrations/bindings stay readable by exact namespace.
      // No file, cwd, execution alias, prompt stable id or session is removed.
      return {id:request.id,removed:true};
    });
  }
}
module.exports = { WorkflowRootRegistry };
