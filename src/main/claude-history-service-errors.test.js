'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { claudeHistoryFailureFromRecord: failure, claudeProviderFailureFromRecord: terminalFailure } = require('../shared/claude-provider-failure.cjs');

// Actual production carrier confirmed through Terminal MCP, tabs171/213,
// 24.09 23:57 UTC. IDs/text outside the error are fixture-owned.
const reason = 'API error: 403 OAuth authentication is currently not allowed for this organization · model not changed';
const local = (uuid, text = reason, channel = 'stdout') => ({
  uuid, sessionId: 'S', type: 'system', subtype: 'local_command', isSidechain: false,
  content: `<local-command-${channel}>${text}</local-command-${channel}>`,
  timestamp: '2026-09-24T23:57:22.519Z',
});

test('typed local-command failure is visible without converting it to a terminal turn outcome', () => {
  const record = local('403');
  assert.equal(failure(record).message, reason);
  assert.equal(failure(record).status, 403);
  assert.equal(failure(record).source, 'local-command');
  assert.equal(terminalFailure(record), null);
  assert.equal(failure(local('429', 'API Error: 429 Too many requests')).kind, 'usage-limit');
  assert.equal(failure(local('auth', 'Unable to validate model: OAuth refresh token is no longer valid')).kind, 'provider-error');
  assert.equal(failure(local('stderr', 'No such setting', 'stderr')).message, 'No such setting');
});

test('API retry retains its exact failure and retry metadata, not a synthetic completion', () => {
  for (const status of [400, 401, 403, 429, 500, 529]) {
    const record = { uuid: 'retry', type: 'system', subtype: 'api_error',
      error: { status, message: 'upstream reason', error: { type: status === 429 ? 'rate_limit_error' : 'api_error' } },
      retryInMs: 5000, retryAttempt: 2, maxRetries: 10 };
    const projected = failure(record);
    assert.equal(projected.status, status);
    assert.equal(projected.message, 'upstream reason');
    assert.equal(projected.retryAttempt, 2);
    assert.equal(projected.retryInMs, 5000);
    assert.equal(terminalFailure(record), null);
  }
  assert.equal(failure({ type: 'system', subtype: 'api_error', error: { error: { message: 'nested reason' } } }).message,
    'nested reason');
});

test('success, quoted errors, tool output and sidechains are not service failures', () => {
  for (const record of [
    local('success', 'Set model to Opus 5 (1M context)'),
    local('help', 'The example says API error: 403'),
    { ...local('quoted'), type: 'user', message: { role: 'user', content: local('q').content } },
    { type: 'assistant', message: { role: 'assistant', content: reason } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: reason }] } },
    { ...local('side'), isSidechain: true },
    { ...local('other'), subtype: 'turn_duration' },
    { ...local('nested'), content: '<example>' + local('e').content + '</example>' },
  ]) assert.equal(failure(record), null, JSON.stringify(record));
});

test('actual transcript append publishes typed service failures once per tab, not only after refresh', async t => {
  const { SessionTranscriptService } = require('./session-transcript-service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-service-delta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'S.jsonl');
  fs.writeFileSync(filePath, [local('failure'), local('ok', 'All good'),
    { uuid: 'retry', type: 'system', subtype: 'api_error', error: { status: 500, message: 'Internal server error' } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const live = [], frames = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => frames.push(args) } }),
    claudeData: null, codexData: null, onLiveMessage: event => live.push(event),
  });
  const state = { filePath, size: fs.statSync(filePath).size, offset: 0, sessionId: 'S',
    consumers: new Map([['history', { tabId: 'T' }], ['timeline', { tabId: 'T' }]]) };
  await service._broadcastClaudeDelta(state, 0);
  assert.deepEqual(live.map(e => e.message.uuid), ['failure', 'retry']);
  assert.equal(frames.length, 2);
  assert.equal(live[0].message.type, 'system');
  assert.equal(live[1].message.error.status, 500);
  assert.ok(Number.isInteger(live[0].recordByteOffset));
});

test('actual durable parser and live reducer preserve local errors/retries once, including repeat attempts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-service-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, '.claude/projects/-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const records = [
    { uuid: 'start', type: 'user', message: { role: 'user', content: 'fixture' } },
    { ...local('abandoned'), parentUuid: 'start' },
    { ...local('first'), parentUuid: 'start' },
    { ...local('second'), parentUuid: 'first' },
    { ...local('retry'), parentUuid: 'second', subtype: 'api_error', content: undefined,
      error: { status: 529, message: 'Overloaded' }, retryInMs: 5000, retryAttempt: 1, maxRetries: 3 },
    { ...local('success', 'Set model to Opus 5 (1M context)'), parentUuid: 'retry' },
    { uuid: 'answer', parentUuid: 'success', type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: reason }] } },
  ].map(r => ({ sessionId: 'S', timestamp: '2026-09-24T23:57:22.519Z', ...r }));
  fs.writeFileSync(path.join(projectDir, 'S.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const originalLoad = Module._load;
  const dataPath = require.resolve('./ipc/claude-data');
  delete require.cache[dataPath];
  Module._load = function(name, parent, isMain) {
    if (name === 'electron') return { ipcMain: { handle() {} } };
    if (name === 'os' || name === 'node:os') return { ...os, homedir: () => root };
    return originalLoad.call(this, name, parent, isMain);
  };
  let data;
  try { data = require(dataPath); } finally { Module._load = originalLoad; }
  data.register({ projectManager: {}, formatToolAction: () => null });
  const durable = await data._api.getFullHistory({ sessionId: 'S', cwd: '/fixture' });
  assert.equal(durable.success, true, durable.error);
  assert.deepEqual(durable.entries.filter(r => r.role === 'provider-error').map(r => r.uuid), ['first', 'second', 'retry']);
  assert.equal(durable.entries.find(r => r.uuid === 'answer').role, 'assistant');
  const live = await import('../renderer/utils/historyLiveProjection.mjs');
  let pending = [];
  for (const record of records.filter(r => ['first', 'second', 'retry'].includes(r.uuid))) {
    const event = { toolType: 'claude', sessionId: 'S', type: 'message', message: record };
    pending = live.reduceHistoryLiveProjection(pending, event);
    pending = live.reduceHistoryLiveProjection(pending, event);
  }
  assert.equal(pending.length, 3);
  assert.equal(pending.find(r => r.uuid === 'retry').providerFailure.retryInMs, 5000);
  assert.equal(live.buildHistoryLivePresentation(durable.entries, pending).filter(r => r.role === 'provider-error').length, 3);
  assert.equal(live.reconcileCommittedHistoryLiveProjection(pending, durable.entries).entries.length, 0);
  const reread = await data._api.getFullHistory({ sessionId: 'S', cwd: '/fixture' });
  assert.deepEqual(reread.entries, durable.entries);
});
