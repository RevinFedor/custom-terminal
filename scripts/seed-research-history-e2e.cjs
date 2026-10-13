'use strict';
// Disposable offline fixture: real Main database/reader, API-copied message
// bodies and normal durable presentation metadata. Never reads production DB
// or provider journals. Run with Electron's Node ABI before the DEV starts.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const DatabaseManager = require('../src/main/database');
const { createWorkflowOrganizationApi } = require('../src/main/workflow-organization-api');
const { GLOBAL_EXECUTION_NAMESPACE: NS } = require('../src/shared/workflow-organization.cjs');
const { saveAuditedPromptPresentation } = require('../src/main/history-prompt-presentations');
const { OrchestrationRunStore } = require('../src/main/orchestration-runs');
const { assertE2ECliIsolation } = require('../src/main/e2e-cli-isolation');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

(async () => {
  const lease = fs.realpathSync(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(path.join(lease, 'manifest.json'), 'utf8'));
  assert.equal(fs.realpathSync(manifest.lease), lease);
  assertE2ECliIsolation(manifest.env);
  const group = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const prefix = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const metadataAt = process.argv.indexOf('--metadata');
  const metadata = metadataAt >= 0 ? JSON.parse(fs.readFileSync(process.argv[metadataAt + 1], 'utf8')) : [];
  const toolsMode = process.argv.includes('--tools');
  assert.equal(group.entries.length, 5);
  assert.equal(prefix.entries.length, 1);
  const filename = path.join(manifest.env.NOTED_USER_DATA_DIR, 'noted-terminal-dev.db');
  assert.equal(fs.existsSync(filename), false, 'never overwrite a fixture database');
  const db = new Database(filename);
  const manager = new DatabaseManager({ existingConnection: db });
  manager.initTables();
  const api = createWorkflowOrganizationApi({ database: manager });
  const cwd = path.join(lease, 'fixture-files'); fs.mkdirSync(cwd);
  const wf = 'research-review';
  const ref = id => ({ projectId: NS, tabId: id });
  const tabs = [
    { id: 'research-markdown', name: 'Research Markdown (15650)', sessionId: 'a5000000-0000-4000-8000-000000000001', entries: prefix.entries },
    { id: 'research-group', name: 'Research JSON group (3773)', sessionId: 'a5000000-0000-4000-8000-000000000002', entries: group.entries },
  ];
  if (toolsMode) {
    const syntheticResult = (runId, phase, body) => {
      const envelope = '[Private Research presentation fixture]\n';
      const content = envelope + body;
      return { uuid: 'fixture-' + runId, role: 'user', content, semanticTags: [{ kind: 'orchestration',
        runId, runKind: 'external-research', phase, envelopeStart: 0, envelopeText: envelope,
        bodyStart: envelope.length, bodyEnd: content.length, bodyProjectionHash: sha(content) }] };
    };
    tabs.push({ id: 'research-outcomes', name: 'Research outcomes (synthetic)',
      sessionId: 'a5000000-0000-4000-8000-000000000003', entries: [
        syntheticResult('e5000000-0000-4000-8000-000000000001', 'completion',
          Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: i, verdict: 'reject', reason: 'Meaning overlaps with an existing group.' })).join('\n')),
        syntheticResult('e5000000-0000-4000-8000-000000000002', 'failure',
          'The external request failed before a complete answer was saved.'),
      ] });
  }
  const layout = { splitPanes: [{ windowId: 'research-window', projectId: NS,
    tabId: tabs[0].id, tabs: tabs.map(t => ref(t.id)), column: 0, row: 0 }],
    splitFocusedIndex: 0, activeProjectId: NS, focusedProjectId: NS, activeSpaceTab: ref(tabs[0].id),
    centerStrips: {}, splitSizes: null, windowDisplayKey: null, windowDisplayLayouts: {} };
  api.bootstrap({ migrationId: 'research-fixture-migration', mutationId: 'research-fixture-activate',
    workspace: { spaces: [{ id: wf, name: 'Research visual review', projectIds: [], layout: { ...layout, splitPanes: [], activeSpaceTab: null } }], activeSpaceId: wf } });
  const runs = new OrchestrationRunStore(path.join(manifest.env.NOTED_USER_DATA_DIR, 'orchestration-runs.json'));
  const fixture = { version: 1, lease, namespace: NS, database: filename, tabs: [], sourceBodiesUnchanged: true };
  for (const tab of tabs) {
    api.createTab({ mutationId: 'create:' + tab.id, tabId: tab.id, cwd, workflowId: wf,
      record: { name: tab.name, color: 'codex', commandType: 'codex', tabType: 'terminal',
        codexSessionId: tab.sessionId, wasInterrupted: true, activeView: 'history',
        codexModel: 'gpt-6-luna', codexEffort: 'medium' } });
    const records = [{ timestamp: '2026-10-10T17:00:00.000Z', type: 'session_meta', payload: {
      id: tab.sessionId, timestamp: '2026-10-10T17:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.162.0' } }];
    const expected = [];
    for (let index = 0; index < tab.entries.length; index++) {
      const entry = tab.entries[index], timestamp = new Date(Date.parse('2026-10-10T17:00:00.000Z') + (index + 1) * 1000).toISOString();
      records.push({ timestamp, type: 'event_msg', payload: { type: 'user_message', message: entry.content, images: [] } });
      assert.ok(saveAuditedPromptPresentation(manager, { toolType: 'codex', sessionId: tab.sessionId,
        auditTimestamp: timestamp, actualText: entry.content,
        snapshot: { promptChips: entry.promptChips || [], semanticTags: entry.semanticTags, imagePaths: [] } }));
      const tag = entry.semanticTags[0];
      const saved = metadata.find(run => run.runId === tag.runId) || {};
      await runs.create({ runId: tag.runId, runKind: 'external-research', sourceTabId: tab.id,
        sourceProjectId: NS, externalProvider: 'chatgpt', targetCreated: false, notifySource: false,
        label: saved.label || (toolsMode ? 'Synthetic result · ' + (index + 1) : undefined),
        externalResearchJobId: saved.externalResearchJobId,
        externalResearchConversationUrl: saved.externalResearchConversationUrl,
        autoStopCreatedTargets: false, externalResearchModel: tab.id === 'research-markdown' ? '6-astra' : '6',
        externalResearchEffort: tab.id === 'research-markdown' ? 'pro' : 'xhigh', externalResearchMode: 'chat' });
      await runs.patch(tag.runId, { status: tag.phase === 'failure' ? 'failed' : 'completed', outcome: tag.phase === 'failure' ? 'failure' : 'success', ownCompletedAt: Date.now(),
        completedAt: Date.now(), notificationStatus: 'suppressed', acknowledgedAt: Date.now(),
        sourceFollowupPending: false, resultAvailable: false, resultComplete: true });
      expected.push({ originalUuid: entry.uuid, timestamp, rawHash: sha(entry.content), chars: entry.content.length,
        runId: tag.runId, phase: tag.phase, label: saved.label || (toolsMode ? 'Synthetic result · ' + (index + 1) : null),
        jobId: saved.externalResearchJobId || null, hasContextPrefix: tag.envelopeStart > 0 });
    }
    records.push({ timestamp: '2026-10-10T17:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Ordinary user control', images: [] } });
    if (toolsMode && tab.id === 'research-outcomes') {
      records.push({ timestamp: '2026-10-10T17:01:00.100Z', type: 'response_item', payload: {
        type: 'function_call', name: 'mcp__terminal__get_delegation_result', call_id: 'fixture-reference-mcp',
        arguments: JSON.stringify({ runId: 'reference-only-no-execution' }),
      } });
      records.push({ timestamp: '2026-10-10T17:01:00.200Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'fixture-reference-mcp', output: 'Reference MCP output\nNo request was executed.',
      } });
    }
    records.push({ timestamp: '2026-10-10T17:01:01.000Z', type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'End of the saved visual fixture.' }] } });
    const directory = path.join(manifest.env.CODEX_HOME, 'sessions', '2026', '10', '10');
    fs.mkdirSync(directory, { recursive: true });
    const transcript = path.join(directory, 'rollout-2026-10-10T17-00-00-' + tab.sessionId + '.jsonl');
    fs.writeFileSync(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    fixture.tabs.push({ tabId: tab.id, name: tab.name, sessionId: tab.sessionId, expected,
      transcriptHash: sha(fs.readFileSync(transcript)), transcript });
  }
  await runs.persistStrict();
  const spaces = api.service.listWorkflows().map(w => ({ id: w.id, name: w.metadata.name, kind: w.kind,
    projectIds: [], layout: w.id === wf ? layout : { ...layout, splitPanes: [], activeSpaceTab: null } }));
  api.service.commitWorkspace({ mutationId: 'research-fixture-layout', expectedRevision: api.service.getPublication().revision,
    spaces, tabWorkflowMembership: Object.fromEntries(tabs.map(t => [t.id, api.service.getMembership(t.id)])) });
  manager.setAppState('workspace-session', { openProjects: [{ projectId: NS, projectPath: cwd, activeTabIndex: 0, runtimeTabIds: [] }],
    ...layout, view: 'workspace', projectHistory: [NS], globalTabMru: [], spaces, activeSpaceId: wf,
    organizationVersion: 1, organizationRevision: api.service.getPublication().revision,
    organizationGeneration: api.service.getPublication().generation, tabLastWorkflowIds: {},
    runAfterWorkflowScopeVersions: {}, workflowSidebarState: {} });
  manager.setAppState('globalAutoCompact', { enabled: false });
  manager.setAppState('promptQueueByTab', {});
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
  fs.writeFileSync(path.join(lease, 'research-fixture.json'), JSON.stringify(fixture, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, lease, tabs: fixture.tabs.map(t => ({ tabId: t.tabId, sessionId: t.sessionId, entries: t.expected.length })) }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
