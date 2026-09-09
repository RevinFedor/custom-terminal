'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const settings = require('../claude-confirmed-settings');
const { loadJsonlRecords, _api: jsonlApi } = require('./claude-data');
const { planClaudePtySettings } = require('../../shared/claude-pty-setting-plan.cjs');

const source = fs.readFileSync(path.join(__dirname, 'claude-data.js'), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `actual source section: ${startMarker}`);
  return source.slice(start, end);
}
const chainSource = section('async function resolveSessionChain(', '// Find the latest (tip) session');
const topologySource = section('async function _validateClaudeHistoryTopology(', '\nfunction register(');
const cacheSource = section('  const confirmedSettingsCache = new Map();', "  ipcMain.handle(\n    'claude:get-confirmed-settings'");
const startedAt = Date.parse('2026-09-09T09:59:00.000Z');

function records(sessionId, model, effort, prefix = sessionId, at = startedAt + 1000) {
  return [
    { uuid: `${prefix}-model`, parentUuid: null,
      message: { content: `<command-name>/model</command-name><command-args>${model}</command-args>` } },
    { uuid: `${prefix}-model-out`, parentUuid: `${prefix}-model`,
      message: { content: `<local-command-stdout>Set model to ${model}</local-command-stdout>` } },
    { uuid: `${prefix}-effort`, parentUuid: `${prefix}-model-out`,
      message: { content: `<command-name>/effort</command-name><command-args>${effort}</command-args>` } },
    { uuid: `${prefix}-effort-out`, parentUuid: `${prefix}-effort`,
      message: { content: `<local-command-stdout>Set effort level to ${effort}</local-command-stdout>` } },
  ].map((record, index) => ({
    ...record, type: 'user', sessionId, timestamp: new Date(at).toISOString(),
    _fromFile: sessionId, _fileIndex: index,
  }));
}

// Run the actual API and actual backward-chain resolver, replacing only their
// external file/SQLite/runtime boundaries. onRead deterministically advances
// those boundaries after a snapshot was captured, without timing sleeps.
function harness() {
  const files = new Map();
  const parents = new Map();
  const reads = [];
  let latestReads = 0;
  const state = {
    row: { claude_session_id: 'child', cwd: '/settings-cache-fixture' },
    runtime: { generation: 'G1', startedAt, sessionId: 'child', processAlive: true },
    directoryVersion: 1,
    onRead() {},
  };
  function put(sessionId, fileRecords, bridgeSessionId = null) {
    const previous = files.get(sessionId);
    files.set(sessionId, {
      filePath: `/settings-cache-fixture/${sessionId}.jsonl`,
      records: fileRecords, bridgeSessionId, version: (previous?.version || 0) + 1,
    });
  }
  put('child', records('child', 'sonnet', 'low'), 'parent');
  put('parent', []);
  const findSessionFile = sessionId => {
    const file = files.get(sessionId);
    return file ? { filePath: file.filePath, projectDir: state.row.cwd } : null;
  };
  const projectManager = { db: {
    db: { prepare: () => ({ get: () => state.row && { ...state.row } }) },
    getSessionParent: sessionId => parents.get(sessionId) || null,
    getSessionChild: sessionId => [...parents].find(([, parent]) => parent === sessionId)?.[0] || null,
  } };
  const api = {};
  const context = vm.createContext({
    ...settings, path, _api: api, projectManager, _projectManager: projectManager,
    console: { log() {}, warn() {}, error() {} }, findSessionFile,
    _getClaudeRuntimeSettingsScope: () => state.runtime,
    fs: { statSync: filePath => {
      if (filePath === state.row?.cwd) return { mtimeMs: state.directoryVersion, size: 0 };
      const file = [...files.values()].find(candidate => candidate.filePath === filePath);
      if (!file) throw new Error('ENOENT');
      return { mtimeMs: file.version, size: file.version * 100 };
    } },
    resolveLatestSessionInChain: sessionId => {
      latestReads += 1;
      const visited = new Set();
      while (!visited.has(sessionId)) {
        visited.add(sessionId);
        const child = projectManager.db.getSessionChild(sessionId);
        if (!child || !files.has(child)) break;
        sessionId = child;
      }
      return sessionId;
    },
    loadJsonlRecords: async filePath => {
      const [sessionId, file] = [...files].find(([, candidate]) => candidate.filePath === filePath);
      reads.push(sessionId);
      const captured = {
        recordMap: new Map(file.records.map(record => [record.uuid, record])),
        lastRecord: file.records.at(-1) || null,
        bridgeSessionId: file.bridgeSessionId, progressEntries: [], queueOperations: [],
        sourceSnapshot: { filePath, sessionId, size: file.version * 100, mtimeMs: file.version },
      };
      await state.onRead(sessionId, captured);
      return captured;
    },
  });
  vm.runInContext(chainSource + topologySource + cacheSource, context);
  return { api, state, files, parents, reads, put, latestReads: () => latestReads };
}

test('mid-chain child append cannot cache old settings with the newer file metadata', async () => {
  const h = harness();
  let changed = false;
  h.state.onRead = sessionId => {
    if (sessionId !== 'parent' || changed) return;
    changed = true;
    h.put('child', records('child', 'opus', 'high', 'new', startedAt + 2000), 'parent');
  };
  const first = await h.api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(first.model, 'opus', 'the initial response must also use the validated source');
  assert.equal(first.effort, 'high');
  const warm = await h.api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(warm.cache, 'hit');
  assert.equal(warm.model, 'opus');
  assert.equal(warm.effort, 'high');
  const plan = planClaudePtySettings({ requestedModel: 'sonnet', requestedEffort: 'low',
    confirmed: warm, currentSessionId: 'child' });
  assert.equal(plan.applyModel, true, 'the stale cache must not suppress a real model change');
  assert.equal(plan.applyEffort, true);
  assert.deepEqual(h.reads, ['child', 'parent', 'child', 'parent']);
});

test('every ancestor snapshot is validated, not only the primary file', async () => {
  const h = harness();
  h.put('parent', records('parent', 'sonnet', 'low'), 'grandparent');
  h.put('grandparent', []);
  h.put('child', [{ uuid: 'child-user', type: 'user', sessionId: 'child',
    _fromFile: 'child', _fileIndex: 0, message: { content: 'Hello' } }], 'parent');
  let changed = false;
  h.state.onRead = sessionId => {
    if (sessionId !== 'grandparent' || changed) return;
    changed = true;
    h.put('parent', records('parent', 'opus', 'high', 'new-parent'), 'grandparent');
  };
  assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).model, 'opus');
  assert.equal(h.reads.length, 6);
});

for (const timing of ['during-read', 'after-cache']) {
  test(`SQLite-only ancestor relink ${timing} invalidates unchanged source files`, async () => {
    const h = harness();
    h.put('child', [{ uuid: 'child-user', type: 'user', sessionId: 'child',
      _fromFile: 'child', _fileIndex: 0, message: { content: 'Hello' } }]);
    h.put('parent', records('parent', 'sonnet', 'low'));
    h.put('other-parent', records('other-parent', 'opus', 'high'));
    h.parents.set('child', 'parent');
    if (timing === 'during-read') {
      h.state.onRead = sessionId => {
        if (sessionId === 'parent') h.parents.set('child', 'other-parent');
      };
    } else {
      assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).model, 'sonnet');
      h.parents.set('child', 'other-parent');
    }
    assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).model, 'opus');
    assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).cache, 'hit');
  });
}

test('SQLite-only new descendant updates latestSessionId without touching any file', async () => {
  const h = harness();
  h.put('new-child', records('new-child', 'opus', 'high'));
  assert.equal((await h.api.getConfirmedSettings({ sessionId: 'child' })).latestSessionId, 'child');
  h.parents.set('new-child', 'child');
  const changed = await h.api.getConfirmedSettings({ sessionId: 'child' });
  assert.equal(changed.latestSessionId, 'new-child');
  assert.equal(changed.cache, undefined);
});

test('a new session file during the chain read invalidates the captured directory discovery', async () => {
  const h = harness();
  let changed = false;
  h.state.onRead = sessionId => {
    if (sessionId !== 'parent' || changed) return;
    changed = true;
    h.state.directoryVersion += 1;
  };
  assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).model, 'sonnet');
  assert.deepEqual(h.reads, ['child', 'parent', 'child', 'parent']);
  assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).cache, 'hit');
});

test('launch generation changed during the read is reread and does not re-confirm old effort', async () => {
  const h = harness();
  h.state.onRead = sessionId => {
    if (sessionId === 'parent') {
      Object.assign(h.state.runtime, { generation: 'G2', startedAt: startedAt + 5000 });
    }
  };
  const result = await h.api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(result.success, true);
  assert.equal(result.runtimeGeneration, 'G2');
  assert.equal(result.model, 'sonnet', 'model history remains session-scoped');
  assert.equal(result.effort, null);
  assert.equal(result.effortHistorical, 'low');
  assert.deepEqual(h.reads, ['child', 'parent', 'child', 'parent']);
  assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).cache, 'hit');
});

test('process exit during the read keeps historical settings without claiming live effort', async () => {
  const h = harness();
  h.state.onRead = sessionId => {
    if (sessionId === 'parent') h.state.runtime.processAlive = false;
  };
  const result = await h.api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(result.success, true);
  assert.equal(result.model, 'sonnet');
  assert.equal(result.effortHistorical, 'low');
  assert.equal(result.effort, null);
  assert.equal(result.effortCurrentRuntime, false);
  assert.deepEqual(h.reads, ['child', 'parent', 'child', 'parent']);
});

for (const explicitSession of [false, true]) {
  test(`writer changed during the read cannot publish the old tab proof (explicit=${explicitSession})`, async () => {
    const h = harness();
    h.put('new-writer', records('new-writer', 'opus', 'high'));
    h.state.onRead = sessionId => {
      if (sessionId === 'parent') {
        h.state.row.claude_session_id = 'new-writer';
        h.state.runtime = { ...h.state.runtime, sessionId: 'new-writer' };
      }
    };
    const result = await h.api.getConfirmedSettings({ tabId: 'tab',
      ...(explicitSession ? { sessionId: 'child' } : {}) });
    assert.equal(result.sessionId, 'new-writer');
    if (explicitSession) {
      assert.equal(result.success, false);
      assert.equal(result.reason, 'stale-session');
    } else {
      assert.equal(result.success, true);
      assert.equal(result.model, 'opus');
      assert.equal(result.effort, 'high');
    }
  });
}

test('stable cache uses only file/topology checks and reprojects effort for the current launch', async () => {
  const h = harness();
  assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).effort, 'low');
  const initialLatestReads = h.latestReads();
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).cache, 'hit');
  }
  h.state.runtime = { ...h.state.runtime, generation: 'G2', startedAt: startedAt + 5000 };
  const restarted = await h.api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(restarted.cache, 'hit');
  assert.equal(restarted.effort, null);
  assert.equal(restarted.effortHistorical, 'low');
  assert.equal(restarted.runtimeGeneration, 'G2');
  assert.deepEqual(h.reads, ['child', 'parent']);
  assert.equal(h.latestReads(), initialLatestReads, 'no forward file scan on a warm hit');
});

test('continuously changing files return no stale proof after bounded rereads and can recover', async () => {
  const h = harness();
  h.state.onRead = sessionId => {
    if (sessionId === 'parent') h.put('child', records('child', 'opus', 'high'), 'parent');
  };
  const unstable = await h.api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(unstable.success, false);
  assert.equal(unstable.reason, 'settings-read-unstable');
  assert.equal(unstable.model, undefined);
  assert.ok(h.reads.length > 2 && h.reads.length <= 6, 'retries are bounded without waiting timers');
  h.state.onRead = () => {};
  const recovered = await h.api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(recovered.success, true);
  assert.equal(recovered.model, 'opus');
  assert.equal(recovered.effort, 'high');
  assert.equal((await h.api.getConfirmedSettings({ tabId: 'tab' })).cache, 'hit');
});

test('actual incremental JSONL reader rereads a mid-chain append and keeps the validated warm result', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-cache-race-'));
  const childPath = path.join(directory, 'child.jsonl');
  const parentPath = path.join(directory, 'parent.jsonl');
  t.after(() => {
    jsonlApi.resetJsonlCacheForTests();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const lines = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  fs.writeFileSync(childPath, lines(records('child', 'sonnet', 'low')));
  fs.writeFileSync(parentPath, '');
  const reads = [];
  let appended = false;
  const projectManager = { db: {
    db: { prepare: () => ({ get: () => ({ claude_session_id: 'child', cwd: directory }) }) },
    getSessionParent: sessionId => sessionId === 'child' ? 'parent' : null,
    getSessionChild: sessionId => sessionId === 'parent' ? 'child' : null,
  } };
  const api = {};
  const context = vm.createContext({
    ...settings, fs, path, _api: api, projectManager, _projectManager: projectManager,
    console: { log() {}, warn() {}, error() {} },
    _getClaudeRuntimeSettingsScope: () => ({ generation: 'G1', startedAt, sessionId: 'child', processAlive: true }),
    findSessionFile: sessionId => ['child', 'parent'].includes(sessionId)
      ? { filePath: path.join(directory, sessionId + '.jsonl'), projectDir: directory } : null,
    resolveLatestSessionInChain: () => 'child',
    loadJsonlRecords: async filePath => {
      reads.push(path.basename(filePath));
      if (filePath === parentPath && !appended) {
        // The real child reader already returned and resolveSessionChain
        // already merged that snapshot before reaching its ancestor.
        appended = true;
        fs.appendFileSync(childPath, lines(records('child', 'opus', 'high', 'new', startedAt + 2000)));
      }
      return loadJsonlRecords(filePath);
    },
  });
  vm.runInContext(chainSource + topologySource + cacheSource, context);
  const initial = await api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(initial.success, true);
  assert.equal(initial.model, 'opus');
  assert.equal(initial.effort, 'high');
  const warm = await api.getConfirmedSettings({ tabId: 'tab' });
  assert.equal(warm.cache, 'hit');
  assert.equal(warm.model, 'opus');
  assert.equal(warm.effort, 'high');
  assert.deepEqual(reads, ['child.jsonl', 'parent.jsonl', 'child.jsonl', 'parent.jsonl']);
});
