import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// A private candidate can use unchanged production dependencies read-only.
// In the repository no override is needed; the candidate source stays local.
const dependencyBase = process.env.NOTED_LINK_FILE_TEST_DEPENDENCIES
  ? pathToFileURL(`${path.resolve(process.env.NOTED_LINK_FILE_TEST_DEPENDENCIES)}/`)
  : import.meta.url;
const requireDependency = createRequire(new URL('./linkFileTab.actual.test.mjs', dependencyBase));
const { transformSync } = requireDependency('esbuild');
const { commitCreatedTabSnapshot } = await import(new URL('./tabCreationCommit.mjs', dependencyBase));
const { createProjectTabSaveQueue } = await import(new URL('./projectTabSaveQueue.mjs', dependencyBase));
const linkedFiles = await import(new URL('./tabLinkedFiles.mjs', dependencyBase));

const source = fs.readFileSync(new URL('./linkFileTab.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
function fixture() {
  const owner = { id: 'owner', commandType: 'codex', cwd: '/fixture', tabType: 'terminal', createdAt: 100 };
  const workspace = { tabs: new Map([['owner', owner]]) }, queue = createProjectTabSaveQueue();
  const state = { openProjects: new Map([['p', workspace]]) };
  let created = 0, published = 0, persists = 0, rollback = 0, persistHook, allocationHook;
  const events = [];
  state.createTabAfterCurrent = async (_p, name, cwd, options) => {
    created++;
    const id = created === 1 ? 'file' : `file-${created}`;
    const file = { id, name, cwd, ...options };
    events.push({ phase: 'allocate', id });
    await allocationHook?.(file);
    const result = await commitCreatedTabSnapshot({ queue, projectId: 'p',
      isWorkspaceCurrent: () => state.openProjects.get('p') === workspace,
      getCurrentTabs: () => workspace.tabs,
      buildCandidateTabs: base => new Map([...base, [id, file]]),
      persist: async () => { persists++; events.push({ phase: 'persist', id }); await persistHook?.(file); return { success: true }; },
      publish: tabs => { published++; events.push({ phase: 'publish', id }); workspace.tabs = tabs; },
      canPublish: options.canPublish });
    if (result.success !== true) { rollback++; events.push({ phase: 'rollback', id }); return ''; }
    return id;
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, window: { require: () => path },
    require: name => {
      if (name === './tabLinkedFiles.mjs') return linkedFiles;
      assert.equal(name, '../store/useWorkspaceStore');
      return { useWorkspaceStore: { getState: () => state } };
    } });
  return { state, workspace, owner, link: module.exports.linkFileTab,
    afterAllocation: hook => { allocationHook = hook; }, events,
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

function addFiles(f, count, parentId = 'owner', prefix = 'existing', workspace = f.workspace) {
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}-${i}`;
    workspace.tabs.set(id, { id, tabType: 'file', filePath: `/fixture/${id}.md`, visualParentTabId: parentId });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const limitMessage = /up to 10 files.*Unlink a file.*file stays on disk/;

test('9 -> 10 is admitted; the eleventh new link is refused before allocation', async () => {
  const f = fixture(); addFiles(f, 9);
  assert.equal((await f.link('/fixture/tenth.md', 'owner')).reused, false);
  assert.equal(linkedFiles.collectTabLinkedFileTree(f.state.openProjects, 'owner').length, 10);
  const before = f.counts();
  await assert.rejects(f.link('/fixture/eleventh.md', 'owner'), limitMessage);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(before, { created: 1, published: 1, persists: 1, rollback: 0 });
  assert.equal([...f.workspace.tabs.values()].some(tab => tab.filePath === '/fixture/eleventh.md'), false);
});

test('an existing exact owner/path is reused at and above 10 without allocation or persistence', async () => {
  for (const count of [10, 12]) {
    const f = fixture(); addFiles(f, count);
    const existing = f.workspace.tabs.get('existing-1');
    existing.filePath = '/fixture/context.md';
    const result = await f.link('/fixture/sub/../context.md', 'owner');
    assert.equal(result.reused, true);
    assert.equal(result.fileTabId, existing.id);
    assert.equal(result.filePath, existing.filePath);
    assert.deepEqual(f.counts(), { created: 0, published: 0, persists: 0, rollback: 0 });
    await assert.rejects(f.link('/fixture/new.md', 'owner'), limitMessage);
    assert.equal(f.workspace.tabs.size, count + 1);
  }
});

test('two concurrent distinct links at 9 share the real project lane: only one persists and publishes', async () => {
  const f = fixture(); addFiles(f, 9);
  const started = deferred(), finish = deferred();
  f.beforePersist(async () => { started.resolve(); await finish.promise; });
  const first = f.link('/fixture/first.md', 'owner');
  await started.promise;
  const second = f.link('/fixture/second.md', 'owner');
  assert.equal(f.counts().created, 2);
  assert.equal(f.counts().persists, 1);
  assert.equal(f.counts().published, 0);
  finish.resolve();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.match(outcomes[1].reason.message, limitMessage);
  assert.deepEqual(f.counts(), { created: 2, published: 1, persists: 1, rollback: 1 });
  assert.equal(linkedFiles.collectTabLinkedFileTree(f.state.openProjects, 'owner').length, 10);
  assert.deepEqual(f.events.map(event => `${event.phase}:${event.id}`),
    ['allocate:file', 'persist:file', 'allocate:file-2', 'publish:file', 'rollback:file-2']);
});

test('a link added during allocation is observed before persistence', async () => {
  const f = fixture(); addFiles(f, 9);
  f.afterAllocation(() => { addFiles(f, 1, 'owner', 'late'); });
  await assert.rejects(f.link('/fixture/attempt.md', 'owner'), limitMessage);
  assert.deepEqual(f.counts(), { created: 1, published: 0, persists: 0, rollback: 1 });
  assert.equal(f.workspace.tabs.has('file'), false);
});

test('in-place family growth while persistence waits is rechecked immediately before publish', async () => {
  const f = fixture(); addFiles(f, 9); addFiles(f, 1, 'other-owner', 'moved');
  // Same Map, entries and tab object identities: only the final canPublish
  // guard sees this relation change, not the creation commit's Map check.
  f.beforePersist(() => { f.workspace.tabs.get('moved-1').visualParentTabId = 'owner'; });
  await assert.rejects(f.link('/fixture/attempt.md', 'owner'), limitMessage);
  assert.deepEqual(f.counts(), { created: 1, published: 0, persists: 1, rollback: 1 });
  assert.equal(f.workspace.tabs.has('file'), false);
});

test('nested files count toward the same owner cap and existing links are preserved', async () => {
  const f = fixture(); addFiles(f, 8); addFiles(f, 1, 'existing-1', 'nested');
  const before = f.workspace.tabs.get('nested-1');
  assert.equal((await f.link('/fixture/tenth.md', 'owner')).reused, false);
  await assert.rejects(f.link('/fixture/eleventh.md', 'owner'), limitMessage);
  assert.equal(f.workspace.tabs.get('nested-1'), before);
  assert.equal(before.visualParentTabId, 'existing-1');
  assert.equal(linkedFiles.collectTabLinkedFileTree(f.state.openProjects, 'owner').length, 10);
});

test('file-family counting spans catalogs but stops at independent AI and ignores unlinked files', async () => {
  const f = fixture(); addFiles(f, 8);
  const foreign = { tabs: new Map() };
  f.state.openProjects.set('other-project', foreign);
  addFiles(f, 1, 'existing-1', 'cross-catalog', foreign);
  f.workspace.tabs.set('ai-child', { id: 'ai-child', tabType: 'terminal', commandType: 'codex', visualParentTabId: 'owner' });
  addFiles(f, 15, 'ai-child', 'child-files');
  addFiles(f, 15, null, 'unlinked', foreign);
  assert.equal((await f.link('/fixture/tenth.md', 'owner')).reused, false);
  await assert.rejects(f.link('/fixture/eleventh.md', 'owner'), limitMessage);
  assert.equal(linkedFiles.collectTabLinkedFileTree(f.state.openProjects, 'owner').length, 10);
  assert.equal(linkedFiles.collectTabLinkedFileTree(f.state.openProjects, 'ai-child').length, 15);
  await assert.rejects(f.link('/fixture/child-new.md', 'ai-child'), limitMessage);
});

test('another AI can link the same path when the first AI is full', async () => {
  const f = fixture(); addFiles(f, 10);
  f.workspace.tabs.set('other-ai', { id: 'other-ai', tabType: 'claude-sdk', cwd: '/fixture' });
  const result = await f.link('/fixture/existing-1.md', 'other-ai');
  assert.equal(result.reused, false);
  assert.equal(result.parentTabId, 'other-ai');
  assert.equal(f.workspace.tabs.get(result.fileTabId).visualParentTabId, 'other-ai');
  assert.equal(linkedFiles.collectTabLinkedFileTree(f.state.openProjects, 'owner').length, 10);
  assert.equal(linkedFiles.collectTabLinkedFileTree(f.state.openProjects, 'other-ai').length, 1);
});

test('archived/deleted file rows and non-file children do not consume active file places', async () => {
  const f = fixture(); addFiles(f, 9); addFiles(f, 4, 'owner', 'inactive');
  ['archived', 'isArchived', 'archivedAt', 'deleted'].forEach((flag, i) => {
    f.workspace.tabs.get(`inactive-${i + 1}`)[flag] = true;
  });
  f.workspace.tabs.set('shell', { id: 'shell', tabType: 'terminal', visualParentTabId: 'owner' });
  addFiles(f, 12, 'shell', 'shell-files');
  assert.equal((await f.link('/fixture/tenth.md', 'owner')).reused, false);
  await assert.rejects(f.link('/fixture/eleventh.md', 'owner'), limitMessage);
});

test('an over-limit closing owner still rejects even reuse before allocation', async () => {
  const f = fixture(); addFiles(f, 12); f.owner.aiClosing = true;
  await assert.rejects(f.link('/fixture/existing-1.md', 'owner'), /target tab is closing/);
  assert.deepEqual(f.counts(), { created: 0, published: 0, persists: 0, rollback: 0 });
});

test('a closed/replaced workspace during allocation retains the original owner guard', async () => {
  const f = fixture();
  f.afterAllocation(() => { f.state.openProjects.set('p', { tabs: new Map([['owner', f.owner]]) }); });
  await assert.rejects(f.link('/fixture/context.md', 'owner'), /target tab/);
  assert.deepEqual(f.counts(), { created: 1, published: 0, persists: 0, rollback: 1 });
  assert.equal(f.workspace.tabs.has('file'), false);
});
