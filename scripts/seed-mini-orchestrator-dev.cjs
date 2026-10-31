'use strict';
// Offline preparation of ONE fresh private DEV profile, never the host DB.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('../src/main/database');
const { createWorkflowOrganizationApi } = require('../src/main/workflow-organization-api');
const { GLOBAL_EXECUTION_NAMESPACE: NS } = require('../src/shared/workflow-organization.cjs');
const root = fs.realpathSync(process.argv[2] || '');
if (!path.basename(root).startsWith('noted-mini-dev-')) throw Error('fresh private mini DEV root required');
const data = path.join(root, 'data');
const replay = process.env.NOTED_MINI_REPLAY_PROFILE
  ? JSON.parse(fs.readFileSync(process.env.NOTED_MINI_REPLAY_PROFILE, 'utf8')) : null;
const cwd = replay?.cwd || path.join(root, 'fixture');
if (replay && (replay.root !== root || !fs.statSync(cwd).isDirectory() || !replay.sessionFile.startsWith(root + path.sep))) throw Error('private replay owner mismatch');
const replayCases = replay?.cases || (replay ? [replay] : []);
for (const item of replayCases) if (!item.tabId || !item.sessionId || !fs.statSync(item.cwd).isDirectory()
  || !item.sessionFile.startsWith(root + path.sep)) throw Error('private case identity mismatch');
const filename = path.join(data, 'noted-terminal-dev.db');
if (fs.existsSync(filename)) {
  if (replay) { console.log('[MiniDEV] Existing replay database retained, including all user changes.'); process.exit(0); }
  throw Error('refusing to replace an existing profile');
}
const connection = new Database(filename);
const db = new DatabaseManager({ existingConnection: connection }); db.initTables();
const api = createWorkflowOrganizationApi({ database: db });
const workflowId = 'mini-review-dev', guide = replay?.tabId || 'mini-dev-guide';
const ref = tabId => ({ projectId: NS, tabId });
const layout = { splitPanes: [{ windowId: 'mini-dev-window', projectId: NS, tabId: guide,
  tabs: replayCases.length ? replayCases.map(item => ref(item.tabId)) : [ref(guide)], column: 0, row: 0 }], splitFocusedIndex: 0,
  activeProjectId: NS, focusedProjectId: NS, activeSpaceTab: ref(guide), centerStrips: {}, splitSizes: null,
  windowDisplayKey: null, windowDisplayLayouts: {} };
api.bootstrap({ migrationId: 'mini-dev-migration', mutationId: 'mini-dev-bootstrap',
  workspace: { spaces: [{ id: workflowId, name: 'Мини-оркестратор · DEV', projectIds: [],
    layout: { ...layout, splitPanes: [], activeSpaceTab: null } }], activeSpaceId: workflowId } });
if (replayCases.length) {
  for (const item of replayCases) {
    api.createTab({ mutationId: 'mini-dev-create-' + item.tabId, tabId: item.tabId, cwd: item.cwd, workflowId,
      record: { name: item.name || 'Main · Rewind replay', tabType: 'terminal', commandType: 'codex',
        wasInterrupted: false, codexSessionId: item.sessionId, nameSetManually: true } });
    if (item.archiveFile) {
      const archive = JSON.parse(fs.readFileSync(item.archiveFile, 'utf8'));
      const { normalizeMiniReviewArchive } = require('../src/main/mini-orchestrator-archive');
      normalizeMiniReviewArchive(archive, item.tabId);
      db.setAppState('mini-orchestrator-archive:' + item.tabId, archive);
    }
  }
} else api.createTab({ mutationId: 'mini-dev-guide-create', tabId: guide, cwd, workflowId,
  record: { name: 'Подготовка мини-оркестратора', tabType: 'terminal', commandType: null, wasInterrupted: false } });
const spaces = api.service.listWorkflows().map(w => ({ id: w.id, name: w.metadata.name, kind: w.kind,
  projectIds: [], layout: w.id === workflowId ? layout : { ...layout, splitPanes: [], activeSpaceTab: null } }));
api.service.commitWorkspace({ mutationId: 'mini-dev-layout', expectedRevision: api.service.getPublication().revision,
  spaces, tabWorkflowMembership: Object.fromEntries((replayCases.length ? replayCases.map(x => x.tabId) : [guide])
    .map(id => [id, api.service.getMembership(id)])) });
db.setAppState('workspace-session', { openProjects: [{ projectId: NS, projectPath: cwd, activeTabIndex: 0,
  runtimeTabIds: replayCases.length ? replayCases.map(item => item.tabId) : [] }],
  activeProjectId: NS, focusedProjectId: NS, view: 'workspace', projectHistory: [NS], globalTabMru: [],
  ...layout, spaces, activeSpaceId: workflowId, organizationVersion: 1,
  organizationRevision: api.service.getPublication().revision, organizationGeneration: api.service.getPublication().generation,
  tabLastWorkflowIds: {}, runAfterWorkflowScopeVersions: {}, workflowSidebarState: {} });
db.setAppState('globalAutoCompact', { enabled: false }); db.setAppState('promptQueueByTab', {});
db.setAppState('defaultClaudeEffort', 'low'); db.setAppState('defaultCodexEffort', 'low');
// Same role ID/canonical live file, in the disposable DEV database only.
// No production System Prompt is created or changed by this command.
const reviewer = process.env.NOTED_MINI_SYSTEM_PROMPT_SNAPSHOT
  ? JSON.parse(fs.readFileSync(process.env.NOTED_MINI_SYSTEM_PROMPT_SNAPSHOT, 'utf8')) : null;
if (reviewer && reviewer.id !== 'mini-orchestrator-review') throw Error('exact reviewer role required');
db.saveAIPrompt({ id: 'mini-orchestrator-review', name: 'Мини-оркестратор · проверка ответа', content: '',
  model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', color: '#22c55e', showInContextMenu: false,
  position: 12, isBuiltIn: false, filePaths: [process.env.NOTED_MINI_REVIEW_PROMPT_FILE], ...(reviewer || {}) });
db.close();
fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ root, cwd, namespace: NS, workflowId, guide,
  ...(replay ? { replaySessionId: replay.sessionId, replay: true, presentationOnly: replay.presentationOnly === true,
    cases: replayCases.map(item => ({ tabId: item.tabId, sessionId: item.sessionId, name: item.name })) } : {}) }, null, 2), { flag: 'wx' });
console.log('[MiniDEV] Private workspace prepared; no model prompt submitted.');
