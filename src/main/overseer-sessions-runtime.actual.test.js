'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const routeStart = main.indexOf("  if (p === '/overseer/sessions') {");
const routeEnd = main.indexOf('\n  // /overseer/session/:sessionId/', routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart);
const catalog = new vm.Script('(async () => {' + main.slice(routeStart, routeEnd) + '})()');
const mcp = fs.readFileSync(path.join(__dirname, '../../mcp/terminal-server.mjs'), 'utf8');
const lifecycleStart = mcp.indexOf('async function liveSessionSnapshot(');
const lifecycleEnd = mcp.indexOf('\nfunction simpleAgentCommand(', lifecycleStart);
assert.ok(lifecycleStart > 0 && lifecycleEnd > lifecycleStart);

async function readCatalog(rows, snapshots = {}, overrides = {}) {
  const calls = { batch: [], full: [] };
  const context = {
    p: '/overseer/sessions',
    projectManager: { db: { db: { prepare: () => ({ all: () => rows }) } } },
    codexKnownSessions: new Map(),
    terminals: new Map(),
    bridgeKnownSessions: new Map(),
    bridgeMetadata: new Map(),
    codexTurnWatchers: new Map(),
    claudeHookLastEvent: new Map(),
    claudeTurnBusy: new Map(),
    claudeSpinnerBusy: new Map(),
    claudeLocalCommandWatchers: new Map(),
    sdkSessions: new Map(),
    terminalProjects: new Map(),
    agentContextUsageState: { read: () => null },
    console: { log() {} },
    getCodexRuntimeProjectionBatch(descriptors, projectId) {
      calls.batch.push({ descriptors: JSON.parse(JSON.stringify(descriptors)), projectId });
      return snapshots;
    },
    async getCodexRuntimeSessionSnapshot(tabId) {
      calls.full.push(tabId);
      return snapshots[tabId];
    },
    ...overrides,
  };
  const result = await catalog.runInNewContext(context);
  return { sessions: JSON.parse(JSON.stringify(result.body.sessions)), calls };
}

async function readHistoryLifecycle(sessions, sessionId = 'writer', error = null) {
  let calls = 0;
  const context = vm.createContext({
    async httpGet(endpoint) {
      calls++;
      assert.equal(endpoint, '/overseer/sessions');
      if (error) throw error;
      return { sessions };
    },
  });
  vm.runInContext(mcp.slice(lifecycleStart, lifecycleEnd), context);
  const result = await context.historyResultWithLifecycle(sessionId, '/project', { text: 'saved answer' });
  return { ...JSON.parse(JSON.stringify(result)), calls };
}

test('119-session catalog uses one global passive batch and no per-tab process/history reads', async () => {
  const rows = Array.from({ length: 119 }, (_, i) => ({
    tab_id: 'tab-' + i, name: 'session-' + i, command_type: 'codex',
    codex_session_id: 'saved-' + i, project_path: '/project-' + (i % 3),
  }));
  const snapshots = Object.fromEntries(rows.map((r, i) => [r.tab_id, {
    sessionId: 'writer-' + i, provenWriterSessionId: 'writer-' + i,
    writerUsableForMutation: true, writerStatus: 'adopted', liveLifecycle: true,
    sessionStatus: 'active', busy: false,
  }]));
  const result = await readCatalog(rows, snapshots);
  assert.equal(result.calls.full.length, 0);
  assert.equal(result.calls.batch.length, 1);
  assert.equal(result.calls.batch[0].projectId, undefined);
  assert.deepEqual(result.calls.batch[0].descriptors, rows.map(r => ({
    tabId: r.tab_id, savedSessionId: r.codex_session_id,
  })));
  assert.equal(result.sessions.length, 119);
  assert.equal(result.sessions[118].sessionId, 'writer-118');
  assert.equal(result.sessions[118].savedSessionId, 'saved-118');
  assert.equal(result.sessions[118].projectPath, '/project-1');
});

test('stopped, starting, unknown, busy and source-to-child identities stay distinct', async () => {
  const snapshots = {
    stopped: { sessionId: 'stopped-source', liveLifecycle: false, sessionStatus: 'inactive', busy: false, writerStatus: 'absent' },
    starting: { sessionId: null, liveLifecycle: null, sessionStatus: 'starting', busy: false, writerStatus: 'pending' },
    unknown: { sessionId: null, liveLifecycle: null, sessionStatus: 'unknown', busy: false, writerStatus: 'unknown' },
    busy: { sessionId: 'busy-writer', provenWriterSessionId: 'busy-writer', liveLifecycle: true, sessionStatus: 'active', busy: true, writerUsableForMutation: true, writerStatus: 'adopted' },
    child: { sessionId: 'new-child', provenWriterSessionId: 'new-child', liveLifecycle: true, sessionStatus: 'active', busy: false, writerUsableForMutation: true, writerStatus: 'adopted' },
  };
  const rows = Object.keys(snapshots).map(tab_id => ({ tab_id, command_type: 'codex', codex_session_id: tab_id + '-source' }));
  const result = await readCatalog(rows, snapshots);
  const [stopped, starting, unknown, busy, child] = result.sessions;
  assert.equal(stopped.status, 'closed');
  assert.equal(stopped.sessionId, 'stopped-source');
  assert.equal(stopped.writerConfirmed, false);
  assert.equal(stopped.liveLifecycle, false);
  assert.equal(starting.status, 'starting');
  assert.equal(starting.sessionId, null);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.liveLifecycle, null);
  assert.equal(unknown.sessionId, null);
  assert.equal(unknown.savedSessionId, 'unknown-source');
  assert.equal(busy.busy, true);
  assert.equal(busy.writerUsableForMutation, true);
  assert.equal(child.sessionId, 'new-child');
  assert.equal(child.savedSessionId, 'child-source');
  assert.equal(child.writerConfirmed, true);
});

test('missing projection stays unknown and never borrows the saved SID as a live writer', async () => {
  const { sessions: [session] } = await readCatalog([{ tab_id: 'missing', command_type: 'codex', codex_session_id: 'saved' }]);
  assert.equal(session.sessionId, null);
  assert.equal(session.savedSessionId, 'saved');
  assert.equal(session.status, 'unknown');
  assert.equal(session.liveLifecycle, null);
  assert.equal(session.writerConfirmed, false);
  assert.equal(session.writerUsableForMutation, false);
});

test('Claude bridge identity, own busy and context usage are preserved', async () => {
  const result = await readCatalog([
    { tab_id: 'claude', command_type: 'claude', claude_session_id: 'old', context_pct: 15 },
    { tab_id: 'unbound', command_type: 'claude' },
  ], {}, {
    bridgeKnownSessions: new Map([['claude', 'live-claude']]),
    bridgeMetadata: new Map([['claude', { contextPct: 26, model: 'Haiku' }]]),
    terminals: new Map([['claude', {}]]),
    claudeTurnBusy: new Map([['claude', true]]),
  });
  assert.equal(result.calls.full.length, 0);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, 'live-claude');
  assert.equal(result.sessions[0].busy, true);
  assert.equal(result.sessions[0].contextUsedPct, 26);
  assert.equal(result.sessions[0].model, 'Haiku');
});

test('history never claims completion for unknown, starting or stopped lifecycle', async () => {
  for (const state of [
    { status: 'unknown', liveLifecycle: null },
    { status: 'starting', liveLifecycle: true },
    { status: 'closed', liveLifecycle: false },
    { status: 'active', liveLifecycle: null },
    { status: 'active' },
  ]) {
    const result = await readHistoryLifecycle([{ sessionId: 'writer', busy: false, ...state }]);
    assert.doesNotMatch(result.waitGate, /NOT BUSY|latest transcript state is complete/);
    assert.match(result.waitGate, /not confirmed idle/i);
    assert.equal(result.text, 'saved answer');
    assert.equal(result.calls, 1);
  }
});

test('history retains known busy/idle evidence without treating missing busy as idle', async () => {
  const busy = await readHistoryLifecycle([{ sessionId: 'writer', status: 'unknown', busy: true, liveLifecycle: null }]);
  assert.match(busy.waitGate, /^BUSY:/);
  const idle = await readHistoryLifecycle([{ sessionId: 'writer', status: 'active', busy: false, liveLifecycle: true }]);
  assert.match(idle.waitGate, /^NOT BUSY:/);
  const missingBusy = await readHistoryLifecycle([{ sessionId: 'writer', status: 'active', liveLifecycle: true }]);
  assert.doesNotMatch(missingBusy.waitGate, /^NOT BUSY:/);
});

test('history exact session lookup does not alias a source to its resumed child', async () => {
  const child = { sessionId: 'child', savedSessionId: 'source', status: 'active', liveLifecycle: true, busy: false };
  const old = await readHistoryLifecycle([child], 'source');
  assert.equal(old.lifecycle, null);
  assert.doesNotMatch(old.waitGate, /^NOT BUSY:/);
  const current = await readHistoryLifecycle([child], 'child');
  assert.equal(current.lifecycle.sessionId, 'child');
});

test('history lifecycle transport errors remain explicit, without hiding saved text', async () => {
  const result = await readHistoryLifecycle([], 'writer', new Error('read unavailable'));
  assert.equal(result.lifecycle.lifecycleUnavailable, true);
  assert.match(result.waitGate, /Lifecycle unavailable/);
  assert.equal(result.text, 'saved answer');
});
