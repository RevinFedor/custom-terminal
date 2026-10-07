'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { WorkflowOrganization, INBOX_WORKFLOW_ID, fingerprint } = require('./workflow-organization');
const { GLOBAL_EXECUTION_NAMESPACE, executionScopeForRow } = require('../shared/workflow-organization.cjs');
const { WorkflowRootRegistry } = require('./workflow-root-registry');
const { activateOrganizationPolicy } = require('../shared/workflow-policy-migration.cjs');
const { WorkflowGroups } = require('./workflow-groups');
const { ArchivedFileLinks } = require('./archived-file-links');
const { WorkflowArchive } = require('./workflow-archive');
const { WorkflowGroupActions } = require('./workflow-group-actions');

/** One Main publication serves the renderer, automation and external readers. */
function createWorkflowOrganizationApi({ database, publish = () => {}, validateDirectory = cwd => fs.statSync(cwd).isDirectory(),captureExecution }) {
  let migrationSource = null;
  const roots = new WorkflowRootRegistry(database);
  const groups = new WorkflowGroups({database});
  const archivedFileLinks=new ArchivedFileLinks(database);
  database.archivedFileLinks=archivedFileLinks;
  const service = new WorkflowOrganization({ database, publish: publication=>{
    const receipt=database.db.prepare('SELECT request_json FROM workflow_org_mutations WHERE mutation_id=?').get(publication.mutationId);
    const kind=receipt && JSON.parse(receipt.request_json).kind;
    if(['publishMigration','createTab','registerLegacyTab'].includes(kind))roots.notify({kind,tabIds:publication.tabId?[publication.tabId]:null});
    publish(publication);
  },
    captureSource: () => migrationSource || {},
    activateArtifacts: (plan,generation) => {
      roots.seedLegacy(plan.artifacts.legacy.tables);
      groups.seedLegacy(plan,{generation});
      activateOrganizationPolicy(database,plan,generation);
      for (const workflow of plan.workflows) if (workflow.metadata.icon === undefined && workflow.kind !== 'inbox') {
        const source = plan.artifacts.legacy.tables.projects?.find(project => project.id === workflow.metadata.projectIds?.[0]);
        database.db.prepare('UPDATE workflow_org_workflows SET metadata_json=? WHERE workflow_id=?')
          .run(JSON.stringify({...workflow.metadata,icon:source?.icon || null}),workflow.id);
      }
    },
    registerTabArtifacts: (tabId,request) => {
      const namespace=request.executionSubject.executionNamespace || request.executionSubject.projectId;
      const groupId=request.record?.globalGroupId
        || (request.record?.groupId && (groups.read().groups.some(group=>group.id===request.record.groupId)
          ? request.record.groupId : groups.resolveLegacy(namespace,request.record.groupId)))
        || (request.record?.visualParentTabId && groups.read().tabGroups[request.record.visualParentTabId]);
      if(groupId) {
        groups.group(groupId);
        database.db.prepare('INSERT INTO workflow_group_memberships VALUES(?,?,1)').run(tabId,groupId);
        database.db.prepare('UPDATE workflow_group_meta SET revision=revision+1 WHERE singleton=1').run();
      }
      roots.bindCreatedTab(tabId,namespace,request.admissionRequest?.sourceTabId);
    },
  });
  const db = database.db;
  database.ensureInboxProject();
  db.prepare('INSERT OR IGNORE INTO workflow_execution_scopes(namespace,metadata_json) VALUES(?,?)')
    .run(GLOBAL_EXECUTION_NAMESPACE,JSON.stringify({name:'Вкладки',kind:'global-catalog',recommendedCwd:require('node:os').homedir()}));
  const archive = new WorkflowArchive({database,organization:service,fileLinks:archivedFileLinks,groups,roots});
  const groupActions = new WorkflowGroupActions({database,organization:service,groups,captureExecution});
  const error = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
  const ready = () => service.getPublication().migrationVersion === 1;
  const read = () => service.read(() => ({...service.readState(),globalGroups:groups.read(),
    migrationScopes:database.getAppState('workflow-organization-migration-scopes.v1')?.scopes || {}}));
  const bootstrap = request => {
    if (!ready()) {
      if (!request?.workspace || typeof request.workspace !== 'object') error('workflow_bootstrap_workspace_required');
      const revision = service.getPublication().revision;
      migrationSource = { workspace: request.workspace, sourceRevisions: request.sourceRevisions || {},
        artifacts: { globalAutoCompact: database.getAppState('globalAutoCompact'),
          promptQueues: database.getAppState('promptQueueByTab') } };
      try {
        const migrationId = request.migrationId || `workflow-organization.v1:${crypto.randomUUID()}`;
        const staged = service.prepareMigration({ migrationId, expectedRevision: revision });
        service.publishMigration({ migrationId, mutationId: request.mutationId || migrationId + ':activate',
          expectedRevision: revision, sourceFingerprint: staged.sourceFingerprint });
      } finally { migrationSource = null; }
    }
    return read();
  };
  const execution = tabId => {
    const row = db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(tabId);
    if (row) return { row, scope: executionScopeForRow(row) };
    const tab = service.getTab(tabId);
    return tab ? { row: null, scope: tab.executionSubject } : null;
  };
  const namespace = tabId => {
    const value = execution(tabId)?.scope;
    return value?.version === 2 ? value.executionNamespace : value?.projectId || null;
  };
  const createTab = request => {
    request = JSON.parse(JSON.stringify(request));
    if (!ready()) error('workflow_migration_required');
    const previous = db.prepare('SELECT request_json FROM workflow_org_mutations WHERE mutation_id=?').get(request.mutationId);
    if (previous) {
      const recorded = JSON.parse(previous.request_json);
      if (recorded.kind !== 'createTab' || fingerprint(recorded.admissionRequest) !== fingerprint(request)) error('workflow_mutation_id_conflict');
      delete recorded.kind;
      return service.createTab(recorded);
    }
    const cwd = request?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || !validateDirectory(cwd)) error('working_directory_unavailable', 400);
    const source = request.sourceTabId ? service.getMembership(request.sourceTabId) : null;
    const workflowId = request.workflowId || source?.workflowId || INBOX_WORKFLOW_ID;
    const executionNamespace = request.executionNamespace || (request.sourceTabId && namespace(request.sourceTabId)) || GLOBAL_EXECUTION_NAMESPACE;
    if (executionNamespace !== GLOBAL_EXECUTION_NAMESPACE
      && !database.getProjectById(executionNamespace)
      && !service.listGlobalTabs().some(tab => tab.executionSubject?.executionNamespace === executionNamespace)) error('execution_namespace_unknown');
    const tabId = request.tabId || `tab-${crypto.createHash('sha256').update(String(request.mutationId || '')).digest('hex').slice(0,32)}`;
    const publication = service.getPublication();
    return service.createTab({ admissionRequest:request,mutationId: request.mutationId, expectedRevision: request.expectedRevision ?? publication.revision,
      tabId, workflowId, record: request.record || {},
      executionSubject: { version: 2, tabId, cwd, executionNamespace, ...(request.subjectId ? {subjectId:request.subjectId} : {}) },
      aliases: [{ namespace: executionNamespace, tabId }] });
  };
  const mutate = (kind, request) => {
    const allowed = new Set(['moveTab', 'detachTab', 'createWorkflow', 'saveLayout', 'deleteWorkflow', 'commitWorkspace']);
    if (!allowed.has(kind) || typeof service[kind] !== 'function') error('workflow_mutation_unknown', 400);
    return service[kind](JSON.parse(JSON.stringify(request)));
  };
  const getMutation = mutationId => {
    const row = db.prepare('SELECT response_json FROM workflow_org_mutations WHERE mutation_id=?').get(mutationId);
    return row ? JSON.parse(row.response_json) : null;
  };
  const listNamespaces = () => {
    const ids = new Set(database.getAllProjects().map(project => project.id));
    for(const row of db.prepare('SELECT namespace FROM workflow_execution_scopes').all())ids.add(row.namespace);
    if (ready()) for (const tab of service.listGlobalTabs()) {
      const id = tab.executionSubject?.executionNamespace || tab.executionSubject?.projectId;
      if (id) ids.add(id);
    }
    return [...ids].map(id => database.getProjectById(id)).filter(Boolean);
  };
  const storageRevisions = executionNamespace => db.prepare(`SELECT tab_id AS tabId,execution_subject_id AS subjectId,
    execution_storage_revision AS revision FROM tabs WHERE execution_subject_version=2 AND execution_namespace=?`).all(executionNamespace);
  return { service, roots, groups, archive, groupActions, archivedFileLinks,ready, read, bootstrap, execution, namespace, createTab, mutate, getMutation, listNamespaces,storageRevisions };
}

function registerWorkflowOrganizationIpc(ipcMain, api) {
  ipcMain.handle('workflow:bootstrap', (_event, request) => api.bootstrap(request));
  ipcMain.handle('workflow:read', () => api.read());
  ipcMain.handle('workflow:catalog', () => ({ ...api.read(), namespaces: api.listNamespaces() }));
  ipcMain.handle('workflow:create-tab', (_event, request) => api.createTab(request));
  ipcMain.handle('workflow:mutate', (_event, { kind, request }) => api.mutate(kind, request));
  ipcMain.handle('workflow:mutation', (_event, mutationId) => api.getMutation(mutationId));
  ipcMain.handle('workflow:list-roots', () => api.roots.read());
  ipcMain.handle('workflow:save-root', (_event, request) => api.roots.save(request));
  ipcMain.handle('workflow:remove-root', (_event, request) => api.roots.remove(request));
  ipcMain.handle('workflow:tab-roots', (_event, tabId) => ({...api.roots.read(),sources:api.roots.sourcesForTab(tabId),
    rootIds:api.roots.sourcesForTab(tabId).map(source=>source.rootId)}));
  ipcMain.handle('workflow:set-tab-roots', (_event, request) => api.roots.setTabSources(request));
  ipcMain.handle('workflow:groups-read', () => api.groups.read());
  ipcMain.handle('workflow:group-mutate', (_event, {kind,request}) => api.groups.mutate(kind,request));
  ipcMain.handle('workflow:group-action', (_event, request) => api.groupActions.begin(request));
  ipcMain.handle('workflow:group-close-step', (_event, request) => api.groupActions.step(request));
  ipcMain.handle('workflow:group-close-ack', (_event, request) => api.groupActions.ack(request));
  ipcMain.handle('workflow:archive-read', () => api.archive.read());
  ipcMain.handle('workflow:archive-clear', (_event, request) => {
    try{return api.archive.clearNamespace(request);}catch(error){
      if(['archive_clear_scope_changed','archive_restore_busy'].includes(error.code))return api.archive.clearRefusal(request,error.code);
      throw error;
    }
  });
  ipcMain.handle('workflow:archive-clear-receipt', (_event, request) => api.archive.clearReceipt(request));
  ipcMain.handle('workflow:archive-mutate', (_event, {kind,request}) => api.archive.mutate(kind,request,api.createTab));
  ipcMain.handle('project:restore-execution-tab', (_event, request) => api.archive.restoreExecution(request));
  ipcMain.handle('project:restore-file-links', (_event, request) => api.archive.restoreFiles(request));
  ipcMain.handle('project:sync-restored-archive-metadata', (_event, request) => api.archive.synchronizeMetadata(request));
}

module.exports = { createWorkflowOrganizationApi, registerWorkflowOrganizationIpc };
