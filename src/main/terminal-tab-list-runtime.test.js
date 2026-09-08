'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf("    if (req.method === 'GET' && req.url?.startsWith('/terminal/tabs')) {");
const end = source.indexOf('\n    } else if', start) + '\n    }'.length;
assert.ok(start > 0 && end > start);
const handler = new vm.Script(source.slice(start, end));

async function listTabs(rows, { color = '', snapshots = {} } = {}) {
  const calls = [];
  const project = { id: 'exact-project', path: '/work/project' };
  let status;
  const result = new Promise((resolve, reject) => {
    handler.runInNewContext({
      URL,
      req: { method: 'GET', url: '/terminal/tabs?parentProjectId=exact-project&color=' + color },
      res: { writeHead(value) { status = value; }, end(body) { resolve({ status, ...JSON.parse(body) }); } },
      console: { log() {} },
      projectManager: { db: { db: { prepare(sql) {
        if (sql.startsWith('SELECT * FROM projects')) return { get: () => project };
        if (sql.startsWith('SELECT * FROM tabs')) return { all: () => rows };
        throw new Error('unexpected SQL: ' + sql);
      } } } },
      terminals: new Map(rows.map(t => [t.tab_id, { pid: 123 }])),
      terminalCommandState: new Map(),
      terminalProjects: new Map(),
      terminalInitialCommand: new Map(),
      bridgeKnownSessions: new Map(),
      getCodexRuntimeProjectionBatch(descriptors, projectId) {
        calls.push({ descriptors: JSON.parse(JSON.stringify(descriptors)), projectId });
        return snapshots;
      },
      getCodexRuntimeSessionSnapshot() {
        reject(new Error('passive tab listing must not reconcile any writer/process/rollout'));
        throw new Error('unexpected per-tab snapshot');
      },
    });
  });
  return { ...await result, calls };
}

test('large Terminal MCP lists use one event projection batch, with no per-tab I/O', async () => {
  const rows = Array.from({ length: 43 }, (_, index) => ({
    tab_id: 'tab-' + index, command_type: 'codex', codex_session_id: 'saved-' + index,
  }));
  const snapshots = Object.fromEntries(rows.map((row, index) => [row.tab_id, {
    sessionId: 'live-' + index, writerConfirmed: true, writerUsableForMutation: true,
    writerStatus: 'confirmed', liveLifecycle: true, sessionStatus: 'busy',
  }]));
  const result = await listTabs(rows, { snapshots });
  assert.equal(result.status, 200);
  assert.equal(result.tabs.length, 43);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].projectId, 'exact-project');
  assert.deepEqual(result.calls[0].descriptors, rows.map(row => ({ tabId: row.tab_id, savedSessionId: row.codex_session_id })));
  assert.equal(result.tabs[42].sessionId, 'live-42');
  assert.equal(result.tabs[42].codexSavedSessionId, 'saved-42');
  assert.equal(result.tabs[42].isRunning, true);
  assert.equal(result.tabs[42].codexWriterConfirmed, true);
});

test('projection batch respects color and current provider and preserves unknown lifecycle', async () => {
  const result = await listTabs([
    { tab_id: 'codex', color: 'red', command_type: 'codex', codex_session_id: 'saved' },
    { tab_id: 'hidden', color: 'blue', command_type: 'codex', codex_session_id: 'hidden-saved' },
    { tab_id: 'claude', color: 'red', command_type: 'claude', claude_session_id: 'claude-session', codex_session_id: 'stale' },
  ], { color: 'red', snapshots: { codex: { sessionId: 'saved', liveLifecycle: null } } });
  assert.deepEqual(result.calls[0].descriptors, [{ tabId: 'codex', savedSessionId: 'saved' }]);
  assert.equal(result.tabs.length, 2);
  assert.equal(result.tabs[0].processLookupUnknown, true);
  assert.equal(result.tabs[0].isRunning, false);
  assert.equal(result.tabs[1].sessionId, 'claude-session');
  assert.equal(result.tabs[1].codexSessionId, null);
});
