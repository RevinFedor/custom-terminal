'use strict';

const { causal } = require('./perf-causal-context');

// Named call sites only: retain the original statement and separate compile/execute timing.
function sqlStatement(siteId, operation, prepare, execute) {
  const statement = causal.sql(siteId, 'prepare', prepare);
  return causal.sql(siteId, operation, () => execute(statement));
}

const crypto = require('node:crypto');
const fs = require('node:fs');
const {normalizeSourceRoots}=require('./project-prompt-catalog');

/** Directory registrations are sources, never the lifetime owner of a tab. */
class WorkflowRootRegistry {
  constructor(database) {
    this.database = database;
    this.db = database.db;
    this.onChanged=()=>{};
    const present=sqlStatement('roots.init.sqlite_master', 'get', () => this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_root_meta' AND type='table'"), statement => statement.get());
    if(present && sqlStatement('roots.init.workflow_root_meta', 'get', () => this.db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1'), statement => statement.get())?.version!==1)return;
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
    const work = () => {
      return this.db.transaction(() => ({ ...sqlStatement('roots.read.workflow_root_meta', 'get', () => this.db.prepare('SELECT version,revision FROM workflow_root_meta WHERE singleton=1'), statement => statement.get()),
        roots: sqlStatement('roots.read.workflow_roots', 'all', () => this.db.prepare('SELECT * FROM workflow_roots WHERE removed=0 ORDER BY rowid'), statement => statement.all()).map(row => (
          { ...JSON.parse(row.metadata_json), id: row.id, path: row.path, revision: row.revision })),
      }))();
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.read', {}, work);
  }
  seedLegacy(tables) {
    const work = () => {
      if(sqlStatement('roots.seedLegacy.workflow_root_meta', 'get', () => this.db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1'), statement => statement.get())?.version!==1)this.fail('root_forward_version');
      const put = (path, metadata, scope, position) => {
        if (typeof path !== 'string' || !path.startsWith('/')) return;
        const id = 'root:' + crypto.createHash('sha256').update(path).digest('hex').slice(0,24);
        sqlStatement('roots.seedLegacy.workflow_roots', 'run', () => this.db.prepare('INSERT OR IGNORE INTO workflow_roots(id,path,metadata_json,revision) VALUES(?,?,?,1)'), statement => statement.run(id, path, JSON.stringify({name:metadata.name || path.split('/').pop(),kind:metadata.kind || 'directory',icon:metadata.icon || null,enabled:true})));
        if (scope) sqlStatement('roots.seedLegacy.workflow_root_bindings', 'run', () => this.db.prepare('INSERT OR IGNORE INTO workflow_root_bindings(scope,root_id,position,metadata_json) VALUES(?,?,?,?)'), statement => statement.run(scope, id, position, JSON.stringify(metadata)));
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
        if(sqlStatement('roots.seedLegacy.workflow_root_scope_meta', 'get', () => this.db.prepare('SELECT 1 FROM workflow_root_scope_meta WHERE scope=?'), statement => statement.get(scope)))continue;
        const namespace=tab.execution_namespace || tab.project_id;
        this.copyBindings(scope,'prompts:'+namespace);
      }
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.seedLegacy', {}, work);
  }
  copyBindings(scope,sourceScope) {
    const work = () => {
      const version=sqlStatement('roots.copyBindings.workflow_root_scope_meta', 'get', () => this.db.prepare('SELECT version FROM workflow_root_scope_meta WHERE scope=?'), statement => statement.get(sourceScope))?.version || 1;
      for(const binding of sqlStatement('roots.copyBindings.workflow_root_bindings', 'all', () => this.db.prepare('SELECT * FROM workflow_root_bindings WHERE scope=? ORDER BY position'), statement => statement.all(sourceScope)))
        sqlStatement('roots.copyBindings.workflow_root_bindings.2', 'run', () => this.db.prepare('INSERT OR IGNORE INTO workflow_root_bindings VALUES(?,?,?,?)'), statement => statement.run(scope, binding.root_id, binding.position, binding.metadata_json));
      // Preserve opaque future bindings and their version without interpreting
      // them. Unrelated tab creation stays available; old readers refuse that scope.
      sqlStatement('roots.copyBindings.workflow_root_scope_meta.2', 'run', () => this.db.prepare('INSERT OR IGNORE INTO workflow_root_scope_meta VALUES(?,?,1)'), statement => statement.run(scope, version));
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.copyBindings', {}, work);
  }
  bindCreatedTab(tabId,namespace,sourceTabId) {
    const work = () => {
      if(!this.db.inTransaction)this.fail('root_binding_transaction_required');
      if(sqlStatement('roots.bindCreatedTab.workflow_root_meta', 'get', () => this.db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1'), statement => statement.get())?.version!==1)this.fail('root_forward_version');
      let sourceScope=sourceTabId && 'tab:'+sourceTabId;
      if(!sourceScope || !sqlStatement('roots.bindCreatedTab.workflow_root_scope_meta', 'get', () => this.db.prepare('SELECT 1 FROM workflow_root_scope_meta WHERE scope=?'), statement => statement.get(sourceScope))) {
        const row=sourceTabId && sqlStatement('roots.bindCreatedTab.tabs', 'get', () => this.db.prepare('SELECT project_id,execution_namespace FROM tabs WHERE tab_id=?'), statement => statement.get(sourceTabId));
        sourceScope='prompts:'+(row?.execution_namespace || row?.project_id || namespace);
      }
      this.copyBindings('tab:'+tabId,sourceScope);
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.bindCreatedTab', { tabId }, work);
  }
  sourcesForTab(tabId) {
    return this.readTabSources(tabId,(sql,siteId)=>causal.sql(siteId,'prepare',()=>this.db.prepare(sql)));
  }
  createSourcesReader() {
    // One synchronous caller owns these four compiled queries. Every invocation
    // still reads current rows/versions; no binding result or CAS proof is cached.
    const statements=new Map();
    const prepare=(sql,siteId)=>{
      if(!statements.has(sql))statements.set(sql,causal.sql(siteId,'prepare',()=>this.db.prepare(sql)));
      return statements.get(sql);
    };
    return tabId=>this.readTabSources(tabId,prepare);
  }
  readTabSources(tabId,prepare) {
    const work = () => {
      const scope='tab:'+tabId;
      causal.count('sourceReads');
      const ownerStatement=prepare('SELECT project_id,execution_namespace FROM tabs WHERE tab_id=?','roots.tabSources.owner');
      const row=causal.sql('roots.tabSources.owner','get',()=>ownerStatement.get(tabId));
      const catalogStatement=prepare('SELECT execution_json FROM workflow_org_tabs WHERE tab_id=?','roots.tabSources.catalog');
      const catalog=causal.sql('roots.tabSources.catalog','get',()=>catalogStatement.get(tabId));
      const execution=catalog?.execution_json ? JSON.parse(catalog.execution_json) : null;
      const namespace=row?.execution_namespace || row?.project_id || execution?.executionNamespace || execution?.projectId || null;
      const scopeStatement=prepare('SELECT * FROM workflow_root_scope_meta WHERE scope=?','roots.tabSources.scope');
      const registered=causal.sql('roots.tabSources.scope','get',()=>scopeStatement.get(scope));
      if(registered && registered.version!==1)this.fail('root_binding_forward_version');
      const sourceScope=registered?scope:'prompts:'+namespace;
      const bindingsStatement=prepare(`SELECT r.*,b.position,b.metadata_json AS binding_json FROM workflow_root_bindings b
        JOIN workflow_roots r ON r.id=b.root_id WHERE b.scope=? ORDER BY b.position,r.id`,'roots.tabSources.bindings');
      return causal.sql('roots.tabSources.bindings','all',()=>bindingsStatement.all(sourceScope))
        .map(root=>{
          const metadata=JSON.parse(root.metadata_json),binding=JSON.parse(root.binding_json);
          return {...metadata,...binding,id:root.id,rootId:root.id,
            rootPath:root.path,projectId:binding.project_id || namespace,position:root.position,
            removed:root.removed===1,enabled:root.removed!==1 && metadata.enabled!==false};
        });
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.readTabSources', { tabId }, work);
  }
  listSourceScopes() {
    const work = () => {
      return sqlStatement('roots.listSourceScopes.workflow_root_scope_meta', 'all', () => this.db.prepare("SELECT scope FROM workflow_root_scope_meta WHERE scope LIKE 'tab:%' ORDER BY scope"), statement => statement.all())
        .map(row=>({id:row.scope,tabId:row.scope.slice(4),name:row.scope.slice(4)}));
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.listSourceScopes', {}, work);
  }
  setTabSources(request) {
    return this.mutate('tab-sources',request,()=>{
      if(typeof request.tabId!=='string' || !request.tabId || !Array.isArray(request.rootIds)
        || new Set(request.rootIds).size!==request.rootIds.length)this.fail('root_binding_request_invalid');
      if(!sqlStatement('roots.setTabSources.workflow_org_tabs', 'get', () => this.db.prepare('SELECT 1 FROM workflow_org_tabs WHERE tab_id=?'), statement => statement.get(request.tabId)))this.fail('root_binding_tab_unknown');
      const scope='tab:'+request.tabId,old=sqlStatement('roots.setTabSources.workflow_root_scope_meta', 'get', () => this.db.prepare('SELECT * FROM workflow_root_scope_meta WHERE scope=?'), statement => statement.get(scope));
      if(old && old.version!==1)this.fail('root_binding_forward_version');
      const bindings=new Map(sqlStatement('roots.setTabSources.workflow_root_bindings', 'all', () => this.db.prepare('SELECT * FROM workflow_root_bindings WHERE scope=?'), statement => statement.all(scope)).map(binding=>[binding.root_id,binding]));
      const roots=request.rootIds.map(rootId=>{
        const row=sqlStatement('roots.setTabSources.workflow_roots', 'get', () => this.db.prepare('SELECT * FROM workflow_roots WHERE id=?'), statement => statement.get(rootId));
        if(!row || row.removed===1 && !bindings.has(rootId))this.fail('root_registration_missing');
        return row;
      });
      if(normalizeSourceRoots(roots.map(root=>root.path)).length!==roots.length)this.fail('overlapping_prompt_sources');
      sqlStatement('roots.setTabSources.workflow_root_bindings.2', 'run', () => this.db.prepare('DELETE FROM workflow_root_bindings WHERE scope=?'), statement => statement.run(scope));
      for(const [position,root] of roots.entries())sqlStatement('roots.setTabSources.workflow_root_bindings.3', 'run', () => this.db.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,?,?)'), statement => statement.run(scope, root.id, position, bindings.get(root.id)?.metadata_json || JSON.stringify({kind:'prompt-source',bindingVersion:1})));
      sqlStatement('roots.setTabSources.workflow_root_scope_meta.2', 'run', () => this.db.prepare('INSERT INTO workflow_root_scope_meta VALUES(?,1,1) ON CONFLICT(scope) DO UPDATE SET revision=revision+1'), statement => statement.run(scope));
      return {tabId:request.tabId,rootIds:request.rootIds};
    });
  }
  mutate(kind, request, change) {
    const work = () => {
      const payload = JSON.stringify({kind,...request});
      if (typeof request.mutationId !== 'string' || !request.mutationId) this.fail('root_mutation_id_required');
      let replay=false;
      const result=this.db.transaction(() => {
        const meta = sqlStatement('roots.mutate.workflow_root_meta', 'get', () => this.db.prepare('SELECT * FROM workflow_root_meta WHERE singleton=1'), statement => statement.get());
        if (meta.version !== 1) this.fail('root_forward_version');
        const old = sqlStatement('roots.mutate.workflow_root_mutations', 'get', () => this.db.prepare('SELECT * FROM workflow_root_mutations WHERE id=?'), statement => statement.get(request.mutationId));
        if (old) { if (old.request_json !== payload) this.fail('root_mutation_id_conflict'); replay=true;return JSON.parse(old.result_json); }
        if (request.expectedRevision !== meta.revision) this.fail('root_revision_changed');
        const result = change();
        sqlStatement('roots.mutate.workflow_root_meta.2', 'run', () => this.db.prepare('UPDATE workflow_root_meta SET revision=revision+1 WHERE singleton=1'), statement => statement.run());
        const answer = {...result,version:1,revision:meta.revision+1};
        sqlStatement('roots.mutate.workflow_root_mutations.2', 'run', () => this.db.prepare('INSERT INTO workflow_root_mutations VALUES(?,?,?)'), statement => statement.run(request.mutationId, payload, JSON.stringify(answer)));
        return answer;
      }).immediate();
      if(!replay)this.notify({kind,tabIds:request.tabId?[request.tabId]:null});
      return result;
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.mutate', {}, work);
  }
  notify(change) {
    const work = () => {
      try{this.onChanged(change);}catch(error){console.warn('[WorkflowRoots] committed; catalog refresh failed:',error?.message || error);}
    };
    return causal.hasWork() ? work() : causal.syncWork('roots.notify', {}, work);
  }
  save(request) {
    return this.mutate('save',request,() => {
      const old = request.id ? sqlStatement('roots.save.workflow_roots', 'get', () => this.db.prepare('SELECT * FROM workflow_roots WHERE id=? AND removed=0'), statement => statement.get(request.id)) : null;
      if (request.id && !old) this.fail('root_missing');
      const path = request.path || old?.path;
      // Validate a new path only. A temporarily missing registration remains editable.
      if (typeof path !== 'string' || !path.startsWith('/')) this.fail('root_path_required');
      if ((!old || path !== old.path) && !fs.statSync(path).isDirectory()) this.fail('working_directory_unavailable');
      const id = old?.id || 'root:' + crypto.randomUUID();
      const metadata = {...(old ? JSON.parse(old.metadata_json) : {}), ...request};
      for (const key of ['id','path','mutationId','expectedRevision']) delete metadata[key];
      sqlStatement('roots.save.workflow_roots.2', 'run', () => this.db.prepare(`INSERT INTO workflow_roots(id,path,metadata_json,revision) VALUES(?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,metadata_json=excluded.metadata_json,revision=workflow_roots.revision+1,removed=0`), statement => statement.run(id, path, JSON.stringify(metadata)));
      return {id};
    });
  }
  remove(request) {
    return this.mutate('remove',request,() => {
      const root = sqlStatement('roots.remove.workflow_roots', 'get', () => this.db.prepare('SELECT * FROM workflow_roots WHERE id=? AND removed=0'), statement => statement.get(request.id));
      if (!root || root.revision !== request.expectedRootRevision) this.fail('root_revision_changed');
      sqlStatement('roots.remove.workflow_roots.2', 'run', () => this.db.prepare('UPDATE workflow_roots SET removed=1,revision=revision+1 WHERE id=?'), statement => statement.run(request.id));
      // Historical registrations/bindings stay readable by exact namespace.
      // No file, cwd, execution alias, prompt stable id or session is removed.
      return {id:request.id,removed:true};
    });
  }
}
module.exports = { WorkflowRootRegistry };
