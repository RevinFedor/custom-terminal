import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTerminalCommandAdmission } = require('../../main/terminal-command-admission.js');
const { outputFiles } = await build({ entryPoints: [new URL('./useRestartAfterRunner.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18',
  plugins: [{ name: 'isolated-runtime-dependencies', setup(b) {
    b.onResolve({ filter: /^(react|\.\.\/store\/use(Workspace|UI|Orchestration)Store)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'react'
      ? 'export const useEffect = callback => callback();'
      : path.endsWith('useWorkspaceStore')
        ? 'export const useWorkspaceStore = { getState: () => globalThis.fixture.workspace, subscribe: fn => { globalThis.fixture.storeListeners.add(fn); return () => globalThis.fixture.storeListeners.delete(fn); } };'
        : path.endsWith('useUIStore')
          ? 'export const useUIStore = { getState: () => ({freePortsBeforeStart:false}) };'
          : 'export const isOrchestrationCompletionBlocked = () => false; export const subscribeOrchestrationRunChanges = fn => { globalThis.fixture.orchestration.add(fn); return () => globalThis.fixture.orchestration.delete(fn); };' }));
  } }],
});
const bundle = outputFiles[0].text;
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const listeners = new Map(), storeListeners = new Set(), orchestration = new Set(), writes = [], calls = [];
  const target = { id: 'target', commandType: 'generic', cwd: '/synthetic-target', restartAfterTabIds: ['source'] };
  const gate = createTerminalCommandAdmission(() => terminal);
  const terminal = {};
  let running = false, seq = 0, currentOperation = null;
  const emit = (channel, data) => { for (const listener of listeners.get(channel) || []) listener(null, data); };
  const workspace = { activeProjectId: 'other-project',
    openProjects: new Map([['target-project', { tabs: new Map([['target', target]]) }]]),
    consumeRestartAfterTriggerIdle: () => [{ tabId: 'target' }], setTabCommandType: () => {},
  };
  const fixture = { workspace, storeListeners, orchestration, cwdWait: null };
  const ipc = {
    on(channel, listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(listener); },
    send(channel, data) { calls.push({ channel, data }); assert.equal(channel, 'terminal:cancel-command-operation'); gate.cancel(data.tabId, data.operationId); },
    async invoke(channel, data) {
      calls.push({ channel, data });
      if (channel === 'terminal:begin-command-operation') return { success: gate.begin(data.tabId, data.operationId) };
      if (channel === 'terminal:getCwd') { if (fixture.cwdWait) await fixture.cwdWait; return target.cwd; }
      if (channel === 'terminal:get-last-project-command') {
        assert.equal(data.projectId, 'target-project'); assert.equal(data.tabId, 'target');
        return { success: true, command: './deploy.sh' };
      }
      if (channel === 'terminal:command-operation-status') return { valid: gate.valid(data.tabId, data.operationId), isRunning: running,
        runningOperationId: gate.running(data.tabId) };
      if (channel === 'terminal:deterministic-stop') {
        emit('terminal:stop-progress', { tabId: data.tabId, phase: 'starting', commandOperationId: data.commandOperationId });
        return { success: gate.valid(data.tabId, data.commandOperationId) };
      }
      if (channel === 'terminal:submit-command-operation') {
        if (!gate.commit(data.tabId, data.operationId)) return { success: false };
        writes.push(data); gate.confirm(data.tabId, data.operationId); currentOperation = data.operationId;
        running = true; gate.started('target', ++seq); return { success: true };
      }
      throw Error('Unexpected IPC ' + channel);
    },
  };
  const sandbox = vm.createContext({ module: { exports: {} }, exports: {}, fixture, crypto: webcrypto,
    window: { require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc }; } }, console: { log() {}, warn() {}, error() {} } });
  sandbox.exports = sandbox.module.exports;
  vm.runInContext(bundle, sandbox);
  const api = sandbox.module.exports;
  return { api, fixture, calls, writes, listeners, gate, emit,
    complete: n => { emit('codex:busy-state', { tabId: 'source', busy: true }); emit('codex:busy-state', { tabId: 'source', busy: false, reason: 'task_complete', outcomeTs: n }); },
    finished: (exitCode = 0) => { const id = currentOperation; gate.finished('target', seq); running = false;
      emit('terminal:command-finished', { tabId: 'target', commandOperationId: id, exitCode }); },
  };
}

test('actual background adapter installs once for ten mounts and launches in a nonfocused project', async () => {
  const f = fixture(); for (let i = 0; i < 10; i++) f.api.useRestartAfterRunner();
  assert.equal(f.listeners.get('codex:busy-state').size, 1);
  f.complete(1); await settle(); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].data, '\x15./deploy.sh\r');
  for (let i = 2; i <= 10; i++) f.complete(i);
  await settle(); assert.equal(f.writes.length, 1); f.finished(); await settle(); assert.equal(f.writes.length, 2);
});

test('actual Stop API cancels a pending repeat and a late lookup, but later natural results still work', async () => {
  const f = fixture(); f.api.useRestartAfterRunner(); f.complete(1); await settle(); f.complete(2);
  f.api.cancelRestartAfterCommand('target'); f.finished(); await settle(); assert.equal(f.writes.length, 1);
  let resolve; f.fixture.cwdWait = new Promise(r => { resolve = r; });
  f.complete(3); await settle(); f.api.cancelRestartAfterCommand('target'); resolve(); await settle();
  assert.equal(f.writes.length, 1);
  f.fixture.cwdWait = null; f.complete(4); await settle(); assert.equal(f.writes.length, 2);
});

test('actual source interrupt never dispatches Stop or starts another script', async () => {
  const f = fixture(); f.api.useRestartAfterRunner(); f.complete(1); await settle(); const count = f.calls.length;
  f.emit('codex:busy-state', { tabId: 'source', busy: true });
  f.emit('codex:busy-state', { tabId: 'source', busy: false, reason: 'turn_aborted' }); await settle();
  assert.equal(f.calls.length, count);
});

test('initial live busy is seeded, and planned shutdown cancels pending work', async () => {
  const f = fixture();
  f.fixture.workspace.openProjects.get('target-project').tabs.set('source', { id: 'source', commandType: 'codex', aiBusy: true });
  f.api.useRestartAfterRunner();
  f.emit('codex:busy-state', { tabId: 'source', busy: false, reason: 'task_complete', outcomeTs: 1 });
  await settle(); assert.equal(f.writes.length, 1);
  f.complete(2); f.emit('shutdown:overlay', { show: true }); f.finished(); await settle(); assert.equal(f.writes.length, 1);
  f.emit('shutdown:overlay', { show: false }); f.complete(3); await settle(); assert.equal(f.writes.length, 2);
});

test('actual runner resolves ALL against new tabs and rechecks membership after async preparation', async () => {
  const f = fixture(), ws = f.fixture.workspace;
  const target = ws.openProjects.get('target-project').tabs.get('target');
  delete target.restartAfterTabIds; target.restartAfterWorkflowIds = ['chosen'];
  ws.spaces = [{ id: 'chosen', projectIds: ['trigger-project'] }];
  const triggers = { tabs: new Map() }; ws.openProjects.set('trigger-project', triggers);
  f.api.useRestartAfterRunner(); f.complete(1); await settle(); assert.equal(f.writes.length, 0);
  triggers.tabs.set('source', { id: 'source', commandType: 'codex' });
  f.complete(2); await settle(); assert.equal(f.writes.length, 1); f.finished();
  let resolve; f.fixture.cwdWait = new Promise(r => { resolve = r; });
  f.complete(3); await settle(); ws.spaces[0].projectIds = [];
  for (const notify of f.fixture.storeListeners) notify();
  resolve(); await settle(); assert.equal(f.writes.length, 1, 'moving out of selected workflow revokes the prepared write');
});

test('clearing ALL cancels its pending rerun; source interruption still cannot trigger it', async () => {
  const f = fixture(), ws = f.fixture.workspace, target = ws.openProjects.get('target-project').tabs.get('target');
  delete target.restartAfterTabIds; target.restartAfterWorkflowIds = ['chosen'];
  ws.spaces = [{ id: 'chosen', projectIds: ['trigger-project'] }];
  ws.openProjects.set('trigger-project', { tabs: new Map([['source', { id: 'source', commandType: 'codex' }]]) });
  f.api.useRestartAfterRunner(); f.complete(1); await settle(); f.complete(2); await settle();
  delete target.restartAfterWorkflowIds; for (const notify of f.fixture.storeListeners) notify();
  f.finished(); await settle(); assert.equal(f.writes.length, 1);
  target.restartAfterWorkflowIds = ['chosen'];
  f.emit('codex:busy-state', { tabId: 'source', busy: true });
  f.emit('codex:busy-state', { tabId: 'source', busy: false, reason: 'turn_aborted' });
  await settle(); assert.equal(f.writes.length, 1);
});

test('TabBar contains no automation listener; App owns it and main gates the real write', () => {
  const tabBar = fs.readFileSync(new URL('../components/Workspace/TabBar.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(tabBar, /restartAfterScriptRunsRef|applyRestartAfterBusyEdge|executeRestartAfterTrigger/);
  assert.match(tabBar, /cancelRestartAfterCommand\(tabId\);/);
  const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /useRestartAfterRunner\(\);/);
  const main = fs.readFileSync(new URL('../../main/main.js', import.meta.url), 'utf8');
  const write = main.slice(main.indexOf('// No await between admission'), main.indexOf('ipcMain.on(\'terminal:input\''));
  assert.match(write, /terminalCommandAdmission\.commit\(tabId, meta\.commandOperationId\)/);
  assert.match(write, /term\.write\(data\);\s*if \(meta\?\.source === 'restart-after'\) terminalCommandAdmission\.confirm/);
  assert.doesNotMatch(write.replace(/\/\/[^\n]*/g, ''), /\bawait\b/);
});
