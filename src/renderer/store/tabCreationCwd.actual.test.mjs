import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { buildSync, transformSync } from 'esbuild';
import { commitCreatedTabSnapshot } from '../utils/tabCreationCommit.mjs';
import { createProjectTabSaveQueue } from '../utils/projectTabSaveQueue.mjs';
import { resolveSiblingInsertionIndex, resolveTabInsertionIndex } from '../utils/tabInsertionModel.mjs';
const require = createRequire(import.meta.url);
const { resolveWorkingDirectory } = require('../../shared/working-directory.cjs');
const root = path.resolve(import.meta.dirname, '../../..');
const quiet = { log() {}, warn() {}, error() {}, time() {}, timeEnd() {} };
const systemSource = path.join(root, 'src/renderer/constants/systemProjects.ts');
const built = buildSync({ entryPoints: [systemSource], bundle: true, platform: 'browser', format: 'cjs', write: false,
  define: { 'process.env': '{}' }, logLevel: 'silent' }).outputFiles[0].text;
const store = fs.readFileSync(path.join(root, 'src/renderer/store/useWorkspaceStore.ts'), 'utf8');
const start = store.indexOf('  createTab: async (projectId, name, cwd, options)');
const end = store.indexOf('\n\n  closeTab:', start);
assert.ok(start >= 0 && end > start);
const sdkStart = store.indexOf('  createSDKTab: async (projectId, name, options)');
const sdkEnd = store.indexOf('\n\n  convertToSDKTab:', sdkStart);
assert.ok(sdkStart > 0 && sdkEnd > sdkStart);
const cwdStart = store.indexOf('      const projectPath = workspace.projectPath &&', store.indexOf('createTabForWindowChooser:'));
const cwdEnd = store.indexOf('      // Форки:', cwdStart);
assert.ok(cwdStart > 0 && cwdEnd > cwdStart);
const creation = transformSync('module.exports = {' + store.slice(start, end)
  + store.slice(sdkStart, sdkEnd) + '};\nmodule.exports.chooserCwd = (context) => {const workspace=get().openProjects.get("project");'
  + store.slice(cwdStart, cwdEnd) + 'return cwd;};', { loader: 'ts', format: 'cjs' }).code;
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const mainStart = main.indexOf("ipcMain.handle('terminal:create', async");
const mainEnd = main.indexOf("    disarmCodexProviderSemanticSource(tabId, 'terminal-generation-changed');", mainStart);
assert.ok(mainStart >= 0 && mainEnd > mainStart);

function runtime(home, nativeEnv = {}) {
  const module = { exports: {} };
  vm.runInNewContext(built, { module, exports: module.exports, window: { require(name) {
    if (name === 'process') return { env: nativeEnv };
    if (name === 'os') return { homedir: () => home };
    if (name === 'path') return path;
    throw new Error('unexpected native dependency: ' + name);
  } } });
  return module.exports;
}

async function fixture(t, projectPath = '~') {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-create-cwd-'));
  t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(home, 'project'));
  const systems = runtime(home);
  let createPty;
  const validated = [], persisted = [];
  // Execute the real IPC reuse/validation boundary, with a PTY seam AFTER
  // successful stat. No shell, agent, application DB or user directory.
  vm.runInNewContext(main.slice(mainStart, mainEnd) + 'validated.push(workingDir); return { pid: 321, cwd: workingDir }; });', {
    ipcMain: { handle(channel, handler) { assert.equal(channel, 'terminal:create'); createPty = handler; } },
    terminals: new Map(), terminalProjectIds: new Map(), terminalProjects: new Map(), console: quiet,
    process: { env: {} }, path, fs, os: { homedir: () => home }, resolveWorkingDirectory, validated,
  });
  const workspace = { projectId: 'project', projectPath, tabs: new Map(), tabCounter: 1, tabGroups: [], tabHistory: [] };
  const state = { openProjects: new Map([['project', workspace]]), isRestoring: false,
    touchGlobalTabMru() {}, clearTerminalBuffer() {} };
  const ui = { newTabPrimarySurface: 'history', terminalIsPrimaryTabs: {}, setTabTerminalIsPrimary() {}, showToast() {} };
  const module = { exports: {} };
  vm.runInNewContext(creation, { module, console: quiet, log: { tabs() {} },
    get: () => state, set: next => Object.assign(state, next), useUIStore: { getState: () => ui },
    resolveWorkspaceCwd: systems.resolveWorkspaceCwd, restoreShortId: value => String(value || ''),
    resolveExistingTabGroupId: () => undefined, getNextAvailableName: () => 'tab',
    ipcRenderer: { invoke: async (channel, request) => {
      assert.equal(channel, 'terminal:create'); return createPty({}, request);
    }, send() { throw new Error('unexpected kill'); } },
    commitCreatedTabSnapshot, projectTabCreationQueue: createProjectTabSaveQueue(), projectTabSaveRevisions: new Map(),
    saveTabsThenNotifyProjectLayoutChanged: async (project, tabs) => {
      persisted.push([...tabs.values()].map(tab => ({ ...tab }))); return { success: true };
    }, resolveSiblingInsertionIndex, resolveTabInsertionIndex,
  });
  Object.assign(state, module.exports);
  return { home, systems, methods: module.exports, workspace, validated, persisted, createPty };
}

test('Inbox uses native home/config even when browser process.env is compiled to an empty object', () => {
  assert.equal(runtime('/native/home').getInboxProjectPath(), '/native/home');
  assert.equal(runtime('/native/home', { NOTED_INBOX_CWD: '~/custom folder' }).getInboxProjectPath(), '/native/home/custom folder');
  assert.equal(runtime('/native/home', { NOTED_INBOX_CWD: '/explicit/project' }).getInboxProjectPath(), '/explicit/project');
});

for (const method of ['createTab', 'createTabAfterCurrent']) {
  for (const action of ['terminal', 'claude', 'codex', 'sdk']) {
    test(method + ': legacy home project creates/persists the same cwd for ' + action, async t => {
      const f = await fixture(t);
      const options = { background: true, tabType: action === 'sdk' ? 'claude-sdk' : 'terminal',
        commandType: action === 'terminal' ? 'generic' : undefined,
        pendingAction: action === 'terminal' ? undefined : { type: action + '-new' } };
      const id = await f.methods[method]('project', action, undefined, options);
      assert.ok(id);assert.equal(f.workspace.tabs.get(id).cwd, f.home);
      assert.equal(f.persisted.at(-1).at(-1).cwd, f.home);
      assert.deepEqual(f.validated, action === 'sdk' ? [] : [f.home]);
    });
  }
}

test('explicit directory wins over project, and IPC resolves old home shorthand before stat', async t => {
  const f = await fixture(t, '/missing-project');
  const chosen = path.join(f.home, 'project');
  const id = await f.methods.createTabAfterCurrent('project', 'chosen', chosen, { background: true });
  assert.equal(f.workspace.tabs.get(id).cwd, chosen);
  assert.equal((await f.createPty({}, { tabId: 'old-slot', projectId: 'project', cwd: '~/project' })).cwd, chosen);
  assert.equal((await f.createPty({}, { tabId: 'old-home', projectId: 'project', cwd: '~' })).cwd, f.home);
});

test('missing directory or a regular file fails before PTY/persistence and never falls back home', async t => {
  const f = await fixture(t);const regularFile = path.join(f.home, 'a-file');await fs.promises.writeFile(regularFile, 'fixture');
  for (const cwd of [path.join(f.home, 'missing'), regularFile, '~/missing']) {
    await assert.rejects(f.methods.createTabAfterCurrent('project', 'invalid', cwd, { background: true }), /working_directory_missing:/);
  }
  assert.equal(f.workspace.tabs.size, 0);assert.deepEqual(f.persisted, []);assert.deepEqual(f.validated, []);
});

test('home expansion supports Windows paths without rewriting ordinary directory names', () => {
  assert.equal(resolveWorkingDirectory('~\\project', 'C:\\Users\\fixture', path.win32), 'C:\\Users\\fixture\\project');
  assert.equal(resolveWorkingDirectory('~/project', 'C:\\Users\\fixture', path.win32), 'C:\\Users\\fixture\\project');
  assert.equal(resolveWorkingDirectory('/project/~literal', '/home/fixture', path.posix), '/project/~literal');
  assert.equal(resolveWorkingDirectory('~another-user', '/home/fixture', path.posix), '~another-user');
});

test('chooser captures normalized cwd before fork IPC, while an unset project still requires selection', async t => {
  const f = await fixture(t);
  assert.equal(f.methods.chooserCwd({ cwd: '~' }), f.home);
  assert.equal(f.methods.chooserCwd({ cwd: '~/project' }), path.join(f.home, 'project'));
  f.workspace.projectPath = '__unset__';
  assert.equal(f.methods.chooserCwd({}), null);
});

test('the actual SDK factory forwards the selected directory without stripping filename spaces', async t => {
  const f = await fixture(t); const chosen = path.join(f.home, 'folder ');
  await fs.promises.mkdir(chosen);
  const id = await f.methods.createSDKTab('project', 'sdk', { cwd: chosen, background: true });
  assert.equal(f.workspace.tabs.get(id).cwd, chosen); assert.deepEqual(f.validated, []);
  assert.equal(f.persisted.at(-1).at(-1).cwd, chosen);
});
