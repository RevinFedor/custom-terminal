'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { GLOBAL_EXECUTION_NAMESPACE, INBOX_WORKFLOW_ID } = require('../shared/workflow-organization.cjs');

const WORKFLOW_HTTP_CAPABILITY = Object.freeze({ version: 1, executionSubjectVersion: 2,
  endpoint: '/api/workflow-organization', workflows: '/api/workflows', tabCatalog: '/api/tab-catalog',
  directoryRegistry: '/api/directory-roots', mutations: '/api/workflow-organization/mutations',
  mutationRead: '/api/workflow-organization/mutations/:mutationId',
  createAgentTab: '/api/workflows/:workflowId/agent-tabs',
  createTerminalTab: '/api/workflows/:workflowId/terminal-tabs',
  catalogProjection: Object.freeze({version:1,endpoint:'/api/workflow-organization?projection=catalog-v1',
    inventory:'active-membership',treeVersion:1,executionRefs:true,sourceBindings:'tab',
    runtime:false,cardSignals:false,history:false,descriptorClock:'content-hash'}),
  groupActions:Object.freeze({version:1,read:'/api/workflow-organization/groups',
    mutate:'/api/workflow-organization/groups/mutations',receipt:'/api/workflow-organization/groups/mutations/:mutationId',
    actions:['create','assign','rename','color','status','collapse','delete'],collapse:'explicit-boolean',delete:'ungroup-members'}),
  nativeDrag:Object.freeze({version:1,status:'/api/workflow-organization/drag',
    capture:'/api/workflow-organization/drag/capture',preview:'/api/workflow-organization/drag/preview',
    commit:'/api/workflow-organization/drag/commit',release:'/api/workflow-organization/drag/:captureId',
    receipt:'/api/workflow-organization/mutations/:mutationId',inventory:'active-membership',
    actions:['reorder','indent','outdent'],destinations:'workflow-tree',compiler:'desktop-shared',windowPlacement:'preserve-unless-workflow-transfer'}),
  defaultCwd:true,
  independentCwd: true, legacyExecutionAliases: true, revision: true,
  durableMutationId: ['organization', 'directory-registry','global-groups','workflow-drag'], tabCreation: 'renderer-scenario' });
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const copy = value => JSON.parse(JSON.stringify(value));
const text = value => typeof value === 'string' ? value.trim() : '';

// These are execution addresses. A workflow id must never be substituted here.
function executionNamespaceForRow(row) {
  if (!row) return null;
  if (row.execution_subject_version === 2) return row.execution_namespace || null;
  if (row.execution_subject_version != null && row.execution_subject_version !== 1) return null;
  return row.project_id || row.projectId || null;
}
function listExecutionNamespaces(projectManager) {
  return projectManager.workflowOrganization?.listNamespaces
    ? projectManager.workflowOrganization.listNamespaces() : projectManager.db.getAllProjects();
}

// Capture before any async directory/model/renderer work. The bridge still owns
// allocation, persistence, placement and launch, including background creation.
async function freezeWorkflowCreationContext(projectManager, raw, workflowId) {
  const request = copy(raw);
  const api = projectManager.workflowOrganization;
  if (!api?.ready()) fail('workflow_migration_required');
  const snapshot = api.read();
  const sourceTabId = text(request.sourceTabId || request.parentTabId || request.visualParentTabId || request.windowTarget?.anchorTabId);
  const source = sourceTabId ? snapshot.tabs.find(tab => tab.tabId === sourceTabId) : null;
  if (sourceTabId && (!source || !source.executionResolved || source.nativeRow?.execution_archived === 1)) {
    fail('workflow_source_tab_missing', 404);
  }
  const targetWorkflowId = workflowId || text(request.workflowId) || source?.membership?.workflowId || INBOX_WORKFLOW_ID;
  if (request.workflowId && request.workflowId !== targetWorkflowId) fail('workflow_route_identity_conflict', 400);
  const targetWorkflow=snapshot.workflows.find(workflow => workflow.id === targetWorkflowId);
  if (!targetWorkflow) fail('workflow_not_found', 404);
  const sourceNamespace = source?.executionSubject?.version === 2
    ? source.executionSubject.executionNamespace : source?.executionSubject?.projectId;
  const executionNamespace = text(request.executionNamespace || request.projectId) || sourceNamespace
    || text(request.fallbackProjectId) || GLOBAL_EXECUTION_NAMESPACE;
  if (request.executionNamespace && request.projectId && request.executionNamespace !== request.projectId) {
    fail('execution_namespace_conflict', 400);
  }
  if (executionNamespace !== GLOBAL_EXECUTION_NAMESPACE
    && !listExecutionNamespaces(projectManager).some(namespace => namespace.id === executionNamespace)) {
    fail('execution_namespace_unknown', 404);
  }
  const cwd = text(request.cwd) || source?.executionSubject?.cwd
    || text(targetWorkflow.metadata?.defaultCwd)
    || projectManager.db.getProjectById(executionNamespace)?.path
    || (request.projectId || request.executionNamespace || request.fallbackProjectId
      ? projectManager.db.getProjectById(executionNamespace)?.recommendedCwd : null);
  if (!cwd || !path.isAbsolute(cwd)) fail('working_directory_required', 400);
  const frozen = { ...request, projectId: executionNamespace, executionNamespace,
    workflowId: targetWorkflowId, cwd, ...(sourceTabId ? { sourceTabId } : {}) };
  let available = false;
  try { available = (await fs.stat(cwd)).isDirectory(); } catch { /* unavailable directory */ }
  if (!available) fail('working_directory_unavailable', 400);
  return frozen;
}

// Keep the project-only alias usable without deriving cwd from current UI focus.
function legacyCreationContext(projectManager, namespace, request) {
  const bucket = projectManager.db.getProjectById(namespace);
  const cwd = text(request.cwd) || bucket?.path || bucket?.recommendedCwd;
  if (!bucket) fail('execution_namespace_unknown', 404);
  if (!cwd || !path.isAbsolute(cwd)) fail('working_directory_required', 400);
  return { ...copy(request), projectId: namespace, cwd };
}

/** Imported independently by native HTTP tests; no Main bootstrap or fake globals. */
function createWorkflowOrganizationHttp({ getProjectManager, checkAuth, readBody, sendJson, sendCreationError, createAgentTab, createTerminalTab }) {
  const handles = pathname => /^\/api\/(?:workflow-organization|workflows|tab-catalog|directory-roots)(?:\/|$)/.test(pathname);
  const requestFor = (body, field, value) => {
    if (body[field] !== undefined && body[field] !== value) fail('workflow_route_identity_conflict', 400);
    return { ...body, [field]: value };
  };
  return async (req, res, parsed) => {
    if (!handles(parsed.pathname)) return false;
    if (!checkAuth(req)) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
    try {
      const projectManager = getProjectManager();
      const api = projectManager.workflowOrganization;
      if (!api) fail('workflow_organization_unavailable', 503);
      if (!api.ready()) fail('workflow_migration_required');
      const pathname = parsed.pathname;
      const method = req.method;
      let result;
      if (pathname === '/api/workflow-organization/groups' && method === 'GET') result=api.groups.read();
      else if (pathname === '/api/workflow-organization/groups/mutations' && method === 'POST') {
        const body=await readBody(req);result=api.groups.mutate(body.kind,body.request);
      } else if (/^\/api\/workflow-organization\/groups\/mutations\/[^/]+$/.test(pathname) && method === 'GET') {
        result=api.groups.getMutation(decodeURIComponent(pathname.split('/').pop()));
        if(!result)fail('workflow_group_mutation_not_found',404);
      } else if (pathname === '/api/workflow-organization/drag' && method === 'GET') result=api.nativeDrag.status();
      else if (/^\/api\/workflow-organization\/drag\/(capture|preview|commit)$/.test(pathname) && method === 'POST')
        result=await api.nativeDrag[pathname.split('/').pop()](await readBody(req));
      else if (/^\/api\/workflow-organization\/drag\/[^/]+$/.test(pathname) && method === 'DELETE')
        result=api.nativeDrag.release(decodeURIComponent(pathname.split('/').pop()));
      else if (pathname === '/api/workflow-organization' && method === 'GET') {
        const projection = parsed.query?.projection;
        if (projection === undefined) result = api.read();
        else if (projection === 'catalog-v1') result = await api.readCatalog();
        else fail('workflow_projection_unsupported',400);
      }
      else if (pathname === '/api/workflows' && method === 'GET') {
        const { publication, workflows } = api.read(); result = { publication, workflows };
      } else if (pathname === '/api/tab-catalog' && method === 'GET') {
        const { publication, tabs } = api.read(); result = { publication, tabs };
      } else if (pathname === '/api/workflows' && method === 'POST') result = api.mutate('createWorkflow', await readBody(req));
      else if (pathname === '/api/workflow-organization/mutations' && method === 'POST') {
        const body = await readBody(req); result = api.mutate(body.kind, body.request);
      } else if (/^\/api\/workflow-organization\/mutations\/[^/]+$/.test(pathname) && method === 'GET') {
        result = api.getMutation(decodeURIComponent(pathname.split('/').pop()));
        if (!result) fail('workflow_mutation_not_found', 404);
      } else if (pathname === '/api/directory-roots' && method === 'GET') result = api.roots.read();
      else if (pathname === '/api/directory-roots' && method === 'POST') result = api.roots.save(await readBody(req));
      else {
        let match = pathname.match(/^\/api\/directory-roots\/([^/]+)$/);
        if (match && method === 'DELETE') result = api.roots.remove(requestFor(await readBody(req), 'id', decodeURIComponent(match[1])));
        else if ((match = pathname.match(/^\/api\/tab-catalog\/([^/]+)\/(move|detach)$/)) && method === 'POST') {
          result = api.mutate(match[2] === 'move' ? 'moveTab' : 'detachTab',
            requestFor(await readBody(req), 'tabId', decodeURIComponent(match[1])));
        } else if ((match = pathname.match(/^\/api\/workflows\/([^/]+)(?:\/(layout|agent-tabs|terminal-tabs))?$/))) {
          const workflowId = decodeURIComponent(match[1]);
          if (method === 'GET' && !match[2]) {
            const snapshot = api.read(); const workflow = snapshot.workflows.find(value => value.id === workflowId);
            if (!workflow) fail('workflow_not_found', 404);
            result = { publication: snapshot.publication, workflow, tabs: snapshot.tabs.filter(tab => tab.membership?.workflowId === workflowId) };
          } else if (method === 'DELETE' && !match[2]) result = api.mutate('deleteWorkflow', requestFor(await readBody(req), 'workflowId', workflowId));
          else if (method === 'PUT' && match[2] === 'layout') result = api.mutate('saveLayout', requestFor(await readBody(req), 'workflowId', workflowId));
          else if (method === 'POST' && ['agent-tabs', 'terminal-tabs'].includes(match[2])) {
            const body = await freezeWorkflowCreationContext(projectManager, await readBody(req), workflowId);
            const create = match[2] === 'agent-tabs' ? createAgentTab : createTerminalTab;
            if (!create) fail('workflow_creation_bridge_unavailable', 503);
            result = await create(body);
          } else fail('method_not_allowed', 405);
        } else fail('workflow_route_not_found', 404);
      }
      sendJson(res, 200, result);
    } catch (error) {
      if (sendCreationError && (error.bridgeData || error.code?.startsWith('bridge_'))) sendCreationError(res, error);
      else sendJson(res, error.statusCode || (error.code === 'bridge_unavailable' ? 503 : 409),
        { ok: false, error: error.code || error.message, ...(error.bridgeData ? { data: error.bridgeData } : {}) });
    }
    return true;
  };
}

module.exports = { WORKFLOW_HTTP_CAPABILITY, createWorkflowOrganizationHttp, freezeWorkflowCreationContext,
  legacyCreationContext, listExecutionNamespaces, executionNamespaceForRow };
