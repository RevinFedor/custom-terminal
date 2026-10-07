import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { commitCreatedTabSnapshot } from './tabCreationCommit.mjs';
import { createProjectTabSaveQueue } from './projectTabSaveQueue.mjs';

const source = fs.readFileSync(new URL('./linkFileTab.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
function fixture() {
  const owner = { id: 'owner', commandType: 'codex', cwd: '/fixture', tabType: 'terminal', createdAt: 100 };
  const workspace = { tabs: new Map([['owner', owner]]) }, queue = createProjectTabSaveQueue();
  const state = { openProjects: new Map([['p', workspace]]) };
  let created = 0, published = 0, persists = 0, rollback = 0, persistHook;
  state.createTabAfterCurrent = async (_p, name, cwd, options) => {
    created++;
    const file = { id: 'file', name, cwd, ...options };
    const result = await commitCreatedTabSnapshot({ queue, projectId: 'p',
      isWorkspaceCurrent: () => state.openProjects.get('p') === workspace,
      getCurrentTabs: () => workspace.tabs,
      buildCandidateTabs: base => new Map([...base, ['file', file]]),
      persist: async () => { persists++; await persistHook?.(); return { success: true }; },
      publish: tabs => { published++; workspace.tabs = tabs; },
      canPublish: options.canPublish });
    if (result.success !== true) { rollback++; return ''; }
    return 'file';
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, window: { require: () => path },
    require: name => { assert.equal(name, '../store/useWorkspaceStore'); return { useWorkspaceStore: { getState: () => state } }; } });
  return { state, workspace, owner, link: module.exports.linkFileTab,
    beforePersist: hook => { persistHook = hook; }, counts: () => ({ created, published, persists, rollback }) };
}

test('actual link wrapper preserves idempotent exact owner/path and existing creation executor', async () => {
  const f = fixture(), result = await f.link('/fixture/context.md', 'owner');
  assert.equal(result.fileTabId, 'file'); assert.equal(result.parentTabId, 'owner');
  assert.equal(f.workspace.tabs.get('file').visualParentTabId, 'owner');
  assert.equal((await f.link('/fixture/context.md', 'owner')).reused, true);
  assert.deepEqual(f.counts(), { created: 1, published: 1, persists: 1, rollback: 0 });
});

test('owner closing while persistence waits never publishes a linked file', async () => {
  const f = fixture(); f.beforePersist(() => { f.owner.aiClosing = true; });
  await assert.rejects(f.link('/fixture/context.md', 'owner'), /target tab/);
  assert.equal(f.workspace.tabs.has('file'), false);
  assert.equal(f.counts().published, 0); assert.equal(f.counts().rollback, 1);
});

test('owner closed during creation cannot be replaced by a root/orphan file on retry', async () => {
  const f = fixture(); f.beforePersist(() => { f.workspace.tabs = new Map(); });
  await assert.rejects(f.link('/fixture/context.md', 'owner'), /target tab/);
  assert.equal(f.workspace.tabs.size, 0);
  assert.equal(f.counts().published, 0);
});

test('an already closing owner refuses before allocating a file-tab', async () => {
  const f = fixture(); f.owner.aiClosing = true;
  await assert.rejects(f.link('/fixture/context.md', 'owner'), /target tab/);
  assert.equal(f.counts().created, 0);
});

test('unrelated tab changes during creation do not cancel a still-live owner attachment', async () => {
  const f = fixture(); let changed = false;
  f.beforePersist(() => { if (!changed) { changed = true; f.workspace.tabs.set('other', { id: 'other' }); } });
  assert.equal((await f.link('/fixture/context.md', 'owner')).fileTabId, 'file');
  assert.ok(f.workspace.tabs.has('other'));
  assert.equal(f.counts().published, 1);
});
