'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, 'session-transcript-service.js'), 'utf8');
const tabBar = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'TabBar.tsx'),
  'utf8',
);
const history = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'HistoryPanel.tsx'),
  'utf8',
);

test('Claude background activity is observed in main before History filtering', () => {
  assert.match(service, /onRawRecord/);
  assert.match(service, /raw observer failed/);
  assert.match(main, /onRawRecord: \(detail\) => \{[\s\S]*observeClaudeBackgroundRawRecord\(detail\)/);
  assert.match(main, /main:claude-background-work:/);
  assert.match(main, /ensureClaudeBackgroundActivityObserver\([\s\S]*data\.session_id/);
  assert.match(main, /clearClaudeBackgroundActivityObserver\(tabId, 'bridge-clear'\)/);
});

test('tab loader hydrates main-owned background state and ignores History mount state', () => {
  assert.match(main, /ipcMain\.handle\('agent:list-background-work'/);
  assert.match(main, /tabBackgroundWorkRevisionByTab\.get\(tabId\)/);
  assert.match(main, /agents:\s*getTabBackgroundWorkAgents\(tabId\)/);
  assert.match(main, /tasks:\s*getTabBackgroundWorkTasks\(tabId\)/);
  assert.match(main, /terminalBackgroundToolUseIds:\s*getTabTerminalBackgroundToolUseIds\(tabId\)/);
  assert.match(tabBar, /ipcRenderer\.invoke\('agent:list-background-work', \{ tabIds \}\)/);
  assert.match(tabBar, /useRef<Map<string, number>>\(new Map\(\)\)/);
  assert.match(tabBar, /acceptTabBackgroundWorkRecord/);
  assert.doesNotMatch(tabBar, /history-panel:background-work/);
  assert.doesNotMatch(history, /dispatchEvent\(new CustomEvent\('history-panel:background-work'/);
  assert.match(history, /kind: 'bash' \| 'monitor' \| 'subagent'/);
  assert.match(history, /exactActiveBackgroundTasks/);
  assert.match(history, /terminalBackgroundTaskCalls/);
  assert.match(history, /chip\.kind === 'monitor'/);
});

test('both provider process boundaries clear inherited background activity', () => {
  assert.match(main, /clearClaudeBackgroundActivityObserver\(tabId, 'bridge-clear'\)/);
  assert.match(main, /clearCodexTabSubagentActivity\(tabId, 'known-session-clear:' \+ reason\)/);
  assert.match(main, /clearCodexTabSubagentActivity\(tabId, 'process-boundary:' \+ reason\)/);
});

test('Claude hook lifecycle carries exact background work into durable orchestration', () => {
  assert.match(main, /internalAgentContinuation: internalAgentContinuationKind \|\| null/);
  assert.match(main, /backgroundWorkCount: getCombinedTabBackgroundWorkCount\(tabId\)/);
  assert.match(main, /\[OrchestrationInternalWork\] exact Claude continuation/);
});
