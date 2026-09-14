import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';

const source = (name) => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const compiled = new Map(['GitStatusButton.tsx', 'FocusedWorkspaceGitStatus.tsx'].map((name) => [
  name, transformSync(source(name), { loader: 'tsx', format: 'cjs', target: 'es2022' }).code,
]));
const json = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tab = (id, cwd, rest = {}) => ({ id, cwd, name: id, ...rest });
function workspace(projectId, projectPath, tabs, activeTabId = tabs[0]?.id) {
  return { projectId, projectPath, tabs: new Map(tabs.map((t) => [t.id, t])), activeTabId,
    viewingSubAgentTabId: null, currentView: 'terminal' };
}
function fixture() {
  return { view: 'workspace', activeProjectId: 'A', focusedProjectId: 'A', splitFocusedIndex: 0,
    splitPanes: [{ projectId: 'A', tabId: 'a' }, { projectId: 'B', tabId: 'b' }],
    openProjects: new Map([
      ['A', workspace('A', '/main-a', [tab('a', '/worktree-a'), tab('a2', '/second-a'), tab('a3', '/worktree-a')])],
      ['B', workspace('B', '/main-b', [tab('b', '/repo-b')])],
    ]) };
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const node = (tree, predicate) => nodes(tree).find(predicate);
const text = (tree) => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join('') : text(tree?.props?.children || '');

// Exercise the actual TSX, hooks, effects, handlers and IPC arguments in Node.
// Only the renderer/DOM and Electron transport are stubbed; no app, native
// modules, repository mutations, browser installation or real timers run.
function harness({ saved = {}, watchGate = null, statusResult = null, generateResult = null,
  commitResult = null, readState = null, writeState = null } = {}) {
  let current, timerId = 0, wrapper, button, buttonKey;
  const timers = new Map(), listeners = new Map(), calls = [], writes = [], watched = new Set();
  const state = fixture();
  const persisted = new Map(Object.entries(saved));
  const runAfter = { tasks: new Map(),
    clearTask(projectKey, taskId) {
      calls.push(['clearTask', projectKey, taskId]);
      const task = runAfter.tasks.get(projectKey);
      if (!task || (taskId && task.id !== taskId)) return false;
      runAfter.tasks.delete(projectKey);
      return true;
    }, armTask() {} };
  let maxWatchers = 0;
  const rect = { top: 0, left: 700, right: 856, bottom: 22, width: 1300, height: 22 };
  const dom = { getBoundingClientRect: () => rect, contains: () => false, closest: () => dom };
  const ipc = {
    async invoke(channel, args) {
      calls.push([channel, json(args)]);
      if (channel === 'app:getState') return readState ? readState(args) : persisted.get(args) || null;
      if (channel === 'app:setState') {
        writes.push(json(args));
        if (writeState) {
          await writeState(args, writes.length);
          persisted.set(args.key, json(args.value));
        }
        // Deliberately leave reads stale: immediate remount must use memory.
        return { success: true };
      }
      if (channel === 'git:watch-status') {
        if (watchGate) await watchGate.promise;
        watched.add(args.projectPath);
        maxWatchers = Math.max(maxWatchers, watched.size);
      }
      if (channel === 'git:unwatch-status') watched.delete(args.projectPath);
      if (channel === 'git:generate-commit-message') return generateResult(args);
      if (channel === 'git:commit' && commitResult) return commitResult(args);
      if (channel === 'git:status') {
        const override = statusResult?.(args);
        if (override) return override;
        return { success: true, isRepo: true, repoRoot: args.projectPath.replace(/\/src$/, ''),
          repoName: args.projectPath, branch: args.projectPath, ahead: 0, behind: 0,
          changedCount: 1, summaryOnly: args.detail === 'summary',
          files: args.detail === 'summary' ? [] : [{ path: 'test.ts', xy: ' M', label: 'modified' }] };
      }
      return { success: true, commits: [], repositories: [], hasMore: false };
    },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeListener(name, fn) { listeners.get(name)?.delete(fn); },
  };
  const ui = { showToast() {} };
  const useWorkspaceStore = (selector) => selector(state);
  useWorkspaceStore.getState = () => state;
  state.getEffectiveTabId = () => state.openProjects.get(state.activeProjectId)?.activeTabId;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    Fragment: 'fragment', memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const owner = current, i = owner.index++;
      if (!(i in owner.slots)) owner.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [owner.slots[i], (value) => {
        if (!owner.mounted) return;
        const next = typeof value === 'function' ? value(owner.slots[i]) : value;
        if (!Object.is(next, owner.slots[i])) { owner.slots[i] = next; owner.dirty = true; }
      }];
    },
    useRef(initial) {
      const i = current.index++;
      return current.slots[i] ||= { current: initial };
    },
    useMemo(fn, deps) {
      const i = current.index++;
      if (!same(current.slots[i]?.deps, deps)) current.slots[i] = { deps, value: fn() };
      return current.slots[i].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = current.index++;
      if (!same(current.slots[i]?.deps, deps)) current.effects.push({ i, fn, deps });
    },
  };
  const modules = new Map();
  const mocks = {
    react: React,
    'react-dom': { createPortal: (children) => ({ type: 'portal', props: { children } }) },
    'lucide-react': new Proxy({}, { get: (_object, name) => name }),
    '../../hooks/usePointerGesture': { usePointerGesture: () => ({ start() {} }) },
    '../../utils/menuViewportClamp.mjs': { clampMenuToViewport },
    '../../store/useWorkspaceStore': { useWorkspaceStore },
    '../../store/useProjectsStore': { useProjectsStore: (select) => select({ projects: {} }) },
    '../../store/useUIStore': { useUIStore: (select) => select(ui) },
    '../../constants/systemProjects': { isInboxProjectId: (id) => id === '__noted_inbox__' },
    '../../store/useGitRunAfterStore': { gitRunAfterProjectKey: (id, path) => id || path,
      useGitRunAfterStore: (select) => select(runAfter) },
    './RunAfterTabPicker': { RunAfterTabPicker: 'RunAfterTabPicker' },
    '../UI/ControlHint': { default: 'ControlHint', __esModule: true },
  };
  const window = { require: () => ({ ipcRenderer: ipc, clipboard: {} }), innerWidth: 1400, innerHeight: 900,
    localStorage: { getItem: () => null }, addEventListener: ipc.on, removeEventListener: ipc.removeListener,
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const module = { exports: {} };
    vm.runInNewContext(compiled.get(name), {
      module, exports: module.exports, window, document: { body: dom, documentElement: dom },
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
      ResizeObserver: class { observe() {} disconnect() {} },
      require(id) {
        if (id === './GitStatusButton') return load('GitStatusButton.tsx');
        assert.ok(id in mocks, `unexpected import ${id}`);
        return mocks[id];
      },
    }, { filename: name });
    modules.set(name, module.exports);
    return module.exports;
  }
  function mount(component, props = {}) {
    const owner = { component, props, index: 0, slots: [], effects: [], mounted: true, dirty: true, tree: null };
    owner.render = () => {
      for (let passes = 0; owner.dirty; passes++) {
        assert.ok(passes < 30, 'bounded render/effect cycle');
        owner.dirty = false; owner.index = 0; owner.effects = []; current = owner;
        owner.tree = component(owner.props);
        for (const element of nodes(owner.tree)) if (element.props?.ref) element.props.ref.current ||= dom;
        for (const { i } of owner.effects) owner.slots[i]?.cleanup?.();
        for (const { i, fn, deps } of owner.effects) owner.slots[i] = { deps, cleanup: fn() };
      }
    };
    owner.unmount = () => {
      owner.mounted = false;
      for (const slot of owner.slots) slot?.cleanup?.();
    };
    owner.render();
    return owner;
  }
  const host = load('FocusedWorkspaceGitStatus.tsx');
  function sync() {
    if (!wrapper) wrapper = mount(host.default);
    else { wrapper.dirty = true; wrapper.render(); }
    const child = node(wrapper.tree, (n) => n.type === load('GitStatusButton.tsx').default);
    if (!child || child.props.key !== buttonKey) {
      button?.unmount(); button = null; buttonKey = child?.props.key;
      if (child) button = mount(child.type, child.props);
    } else { button.props = child.props; button.dirty = true; }
  }
  async function flush() {
    for (let i = 0; i < 40; i++) { await Promise.resolve(); button?.render(); }
  }
  return { state, calls, writes, watched, persisted, runAfter, sync, flush, targetKey: host.focusedWorkspaceGitTargetKey,
    get tree() { return button?.tree; }, get maxWatchers() { return maxWatchers; },
    find: (predicate) => node(button?.tree, predicate),
    async open() {
      const trigger = node(button?.tree, (n) => n.type === 'button' && n.props.title?.includes(' changed'));
      assert.ok(trigger && !trigger.props.disabled, 'ready Git trigger');
      trigger.props.onClick(); button.render(); await flush();
      assert.ok(node(button.tree, (n) => n.type === 'portal'));
    },
    type(placeholder, value, render = true) {
      const input = node(button?.tree, (n) => n.props?.placeholder === placeholder);
      assert.ok(input, placeholder); input.props.onChange({ target: { value } }); if (render) button.render();
    },
    runTimers() {
      for (const [id, fn] of [...timers]) if (timers.delete(id)) fn();
      button?.render();
    },
    destroy() { button?.unmount(); wrapper?.unmount(); },
  };
}

test('titlebar inserts Git immediately before CmdP', () => {
  assert.match(source('WorkspaceTitleBarTools.tsx'), /<FocusedWorkspaceGitStatus \/>\s*<Tooltip[^>]*>\s*<button\s+data-tab-switcher-toolbar-button/);
});

test('focused window uses its shown tab, independent of sidebar, active project, and strip order', () => {
  const h = harness();
  h.state.splitFocusedIndex = 1;
  h.state.splitPanes[1].tabs = [{ projectId: 'A', tabId: 'a' }, { projectId: 'B', tabId: 'b' }];
  const key = h.targetKey(h.state);
  assert.deepEqual(JSON.parse(key), { projectId: 'B', tabId: 'b', projectPath: '/main-b', tabCwd: '/repo-b' });
  h.state.focusedProjectId = 'unrelated';
  h.state.openProjects.get('A').tabs.get('a').name = 'busy rename';
  assert.equal(h.targetKey(h.state), key, 'irrelevant activity leaves a stable primitive snapshot');
});

test('vacancy, chooser, missing tab, absent cwd, and dashboard have no Git target', () => {
  const h = harness();
  for (const pane of [{ projectId: '', tabId: '' }, { projectId: 'A', tabId: '', selectedSlotId: 'chooser' },
    { projectId: 'A', tabId: 'a', selectedSlotId: 'chooser' }, { projectId: 'A', tabId: 'missing' },
    { projectId: 'A', tabId: 'a', displayHidden: true }]) {
    h.state.splitPanes = [pane]; assert.equal(h.targetKey(h.state), '');
  }
  h.state.splitPanes = [{ projectId: 'A', tabId: 'a' }];
  h.state.splitFocusedIndex = 4; assert.equal(h.targetKey(h.state), '');
  h.state.splitFocusedIndex = 0;
  h.state.openProjects.get('A').tabs.get('a').cwd = ''; assert.equal(h.targetKey(h.state), '');
  h.state.view = 'dashboard'; assert.equal(h.targetKey(h.state), '');
});

test('single centre follows the actually viewed child and ignores a stale child selection', () => {
  const h = harness();
  h.state.splitPanes = [];
  const ws = h.state.openProjects.get('A');
  ws.tabs.set('child', tab('child', '/child-tree', { parentTabId: 'a' }));
  ws.viewingSubAgentTabId = 'child';
  assert.equal(JSON.parse(h.targetKey(h.state)).tabCwd, '/child-tree');
  ws.tabs.get('child').parentTabId = 'other';
  assert.equal(JSON.parse(h.targetKey(h.state)).tabId, 'a');
  ws.currentView = 'home'; assert.equal(h.targetKey(h.state), '');
});

test('rapid A → B → A saves the unfinished draft before debounce and never restores an open popup', async () => {
  const h = harness(); h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'unfinished A'); h.type('Description', 'A detail');
  h.state.splitFocusedIndex = 1; h.sync(); await h.flush();
  assert.ok(!h.find((n) => n.type === 'portal'));
  assert.equal(h.writes.at(-1).value.commitDrafts['/worktree-a'].summary, 'unfinished A');
  await h.open(); h.type('Summary (required)', 'unfinished B');
  h.state.splitFocusedIndex = 0; h.sync();
  assert.match(text(h.tree), /worktree-a/, 'cache is available on the first render');
  await h.flush();
  assert.ok(!h.find((n) => n.type === 'portal'));
  await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'unfinished A');
  assert.equal(h.find((n) => n.props?.placeholder === 'Description').props.value, 'A detail');
  assert.equal(h.maxWatchers, 1);
  h.destroy(); await h.flush(); assert.equal(h.watched.size, 0);
});

test('same-project worktrees keep distinct drafts; another tab in the same repo closes popup and shares draft', async () => {
  const h = harness(); h.sync(); await h.flush(); await h.open(); h.type('Summary (required)', 'tree one');
  h.state.splitPanes[0].tabId = 'a2'; h.sync(); await h.flush(); await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, '');
  h.type('Summary (required)', 'tree two');
  h.state.splitPanes[0].tabId = 'a3'; h.sync(); await h.flush();
  assert.ok(!h.find((n) => n.type === 'portal'));
  await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'tree one');
  h.state.openProjects.get('A').tabs.get('a3').cwd = '/second-a'; h.sync(); await h.flush();
  assert.ok(!h.find((n) => n.type === 'portal'));
  await h.open(); assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'tree two');
  h.destroy();
});

test('migrates existing project draft to its own repo without restoring a saved pin/open flag', async () => {
  const h = harness({ saved: { 'noted-terminal.git.panel.A': {
    open: true, selectedRepoPath: '/second-a', summary: 'legacy draft', description: 'legacy detail',
  } } });
  h.sync(); await h.flush();
  assert.ok(!h.find((n) => n.type === 'portal'));
  assert.deepEqual([...h.watched], ['/worktree-a']);
  await h.open(); assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, '');
  h.state.splitPanes[0].tabId = 'a2'; h.sync(); await h.flush(); await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'legacy draft');
  h.destroy();
});

test('watch handoff waits for delayed startup and removes all watchers after a vacant target', async () => {
  const gate = deferred(), h = harness({ watchGate: gate }); h.sync(); await h.flush();
  h.state.splitFocusedIndex = 1; h.sync(); await h.flush();
  h.state.splitFocusedIndex = 0; h.sync(); await h.flush();
  assert.equal(h.calls.filter(([channel]) => channel === 'git:watch-status').length, 1);
  gate.resolve(); await h.flush();
  assert.equal(h.maxWatchers, 1); assert.deepEqual([...h.watched], ['/worktree-a']);
  h.state.splitPanes[0] = { projectId: '', tabId: '' }; h.sync(); await h.flush();
  assert.equal(h.tree, undefined); assert.equal(h.watched.size, 0);
  assert.ok(h.calls.filter(([channel]) => channel === 'git:status').every(([, args]) => args.detail === 'summary'));
  h.destroy();
});

test('a non-repository tab path does not fall back to the project checkout', async () => {
  const h = harness({ statusResult: () => ({ success: true, isRepo: false }) });
  h.sync(); await h.flush();
  assert.equal(h.tree, null);
  assert.ok(h.calls.filter(([channel]) => channel === 'git:status').every(([, args]) => args.projectPath === '/worktree-a'));
  h.destroy();
});

test('switching repositories preserves an already armed Run After task', async () => {
  const h = harness();
  h.runAfter.tasks.set('A', { id: 'armed', projectKey: 'A', repoPath: '/second-a', phase: 'waiting' });
  h.sync(); await h.flush();
  assert.equal(h.calls.filter(([channel]) => channel === 'clearTask').length, 0);
  h.destroy();
});

test('different cwd subdirectories share the canonical repository draft while project ownership stays separate', async () => {
  const h = harness();
  h.state.openProjects.get('A').tabs.get('a').cwd = '/worktree-a/src';
  h.sync(); await h.flush(); await h.open(); h.type('Summary (required)', 'canonical draft');
  h.state.splitPanes[0].tabId = 'a3'; h.sync(); await h.flush(); await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'canonical draft');
  h.state.openProjects.get('B').tabs.get('b').cwd = '/worktree-a';
  h.state.splitFocusedIndex = 1; h.sync(); await h.flush(); await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, '');
  h.destroy();
});

test('late status from the previous target cannot replace the current repository', async () => {
  const gate = deferred();
  const h = harness({ statusResult: (args) => args.projectPath === '/worktree-a' ? gate.promise : undefined });
  h.sync(); await h.flush();
  h.state.splitFocusedIndex = 1; h.sync(); await h.flush();
  gate.resolve({ success: true, isRepo: true, repoRoot: '/worktree-a', branch: 'late-old', files: [], changedCount: 77 });
  await h.flush();
  assert.match(text(h.tree), /repo-b/); assert.doesNotMatch(text(h.tree), /late-old/);
  h.destroy();
});

test('an in-flight generate-and-commit stays bound to its shown tab and original repo after focus changes', async () => {
  const gate = deferred(), h = harness({ generateResult: () => gate.promise });
  h.state.splitFocusedIndex = 1; // activeProjectId intentionally still A
  h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'old B draft');
  const action = h.find((n) => n.props?.title?.startsWith('Generate and commit.'));
  assert.ok(!action.props.disabled);
  const completing = action.props.onClick();
  const generate = h.calls.find(([channel]) => channel === 'git:generate-commit-message')[1];
  assert.equal(generate.projectPath, '/repo-b'); assert.equal(generate.projectId, 'B'); assert.equal(generate.tabId, 'b');
  h.state.splitFocusedIndex = 0; h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'new A draft');
  gate.resolve({ success: true, message: { summary: 'generated B', description: 'B body' } });
  await completing; await h.flush();
  const commits = h.calls.filter(([channel]) => channel === 'git:commit');
  assert.equal(commits.length, 1); assert.equal(commits[0][1].projectPath, '/repo-b');
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'new A draft');
  h.state.splitFocusedIndex = 1; h.sync(); await h.flush(); await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, '', 'completed commit clears its saved draft');
  h.destroy();
});

test('generation finishing after a same-project repo switch preserves its result without overwriting the new draft', async () => {
  const gate = deferred(), h = harness({ generateResult: () => gate.promise });
  h.sync(); await h.flush(); await h.open();
  const action = h.find((n) => n.props?.title?.startsWith('Generate commit message.'));
  const completing = action.props.onClick();
  h.state.splitPanes[0].tabId = 'a2'; h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'second repo draft');
  gate.resolve({ success: true, message: { summary: 'generated first repo', description: 'first body' } });
  await completing; await h.flush();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'second repo draft');
  h.state.splitPanes[0].tabId = 'a'; h.sync(); await h.flush(); await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'generated first repo');
  assert.equal(h.find((n) => n.props?.placeholder === 'Description').props.value, 'first body');
  h.destroy();
});

test('one click opens a cold panel during delayed hydration and stays open when the saved draft arrives', async () => {
  const gate = deferred(), h = harness({ readState: () => gate.promise });
  h.sync(); await h.flush();
  const trigger = h.find((n) => n.type === 'button' && n.props.title?.includes(' changed'));
  assert.ok(!trigger.props.disabled, 'hydration must not discard the opening click');
  await h.open();
  assert.ok(!h.find((n) => n.props?.placeholder === 'Summary (required)'), 'do not expose an empty editable draft before restoration');
  gate.resolve({ open: false, selectedRepoPath: '/worktree-a', summary: 'saved text' });
  await h.flush();
  assert.ok(h.find((n) => n.type === 'portal'), 'hydration preserves the explicit open intent');
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'saved text');
  h.destroy();
});

test('pending same-project A → B → A saves finish in order and persist the newest drafts', async () => {
  const gate = deferred(), h = harness({ writeState: (_args, count) => count === 1 ? gate.promise : undefined });
  h.sync(); await h.flush(); await h.open(); h.type('Summary (required)', 'A first');
  h.runTimers(); await h.flush(); assert.equal(h.writes.length, 1);
  h.state.splitPanes[0].tabId = 'a2'; h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'B text'); h.runTimers(); await h.flush();
  h.state.splitPanes[0].tabId = 'a'; h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'A newest'); h.runTimers(); await h.flush();
  assert.equal(h.writes.length, 1, 'a pending older write must finish before any newer write starts');
  gate.resolve(); await h.flush();
  const saved = h.persisted.get('noted-terminal.git.panel.A');
  assert.equal(saved.commitDrafts['/worktree-a'].summary, 'A newest');
  assert.equal(saved.commitDrafts['/second-a'].summary, 'B text');
  h.destroy();
});

test('a detached generation cannot overwrite a newer revision after A → B → A, even when text was changed back', async () => {
  const gate = deferred(), h = harness({ generateResult: () => gate.promise, writeState() {} });
  h.sync(); await h.flush(); await h.open(); h.type('Summary (required)', 'original');
  const completing = h.find((n) => n.props?.title?.startsWith('Generate commit message.')).props.onClick();
  h.state.splitFocusedIndex = 1; h.sync(); await h.flush();
  h.state.splitFocusedIndex = 0; h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'changed'); h.type('Summary (required)', 'original');
  gate.resolve({ success: true, message: { summary: 'stale generated text', description: 'stale body' } });
  await completing; await h.flush();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'original');
  assert.equal(h.find((n) => n.props?.placeholder === 'Description').props.value, '');
  h.runTimers(); await h.flush();
  assert.equal(h.persisted.get('noted-terminal.git.panel.A').commitDrafts['/worktree-a'].summary, 'original');
  h.destroy();
});

test('late commit completion cannot clear a newly typed draft after remount', async () => {
  const gate = deferred(), h = harness({ commitResult: () => gate.promise, writeState() {} });
  h.sync(); await h.flush(); await h.open(); h.type('Summary (required)', 'submitted');
  const completing = h.find((n) => n.type === 'button' && text(n).startsWith('Commit 1')).props.onClick();
  h.state.splitFocusedIndex = 1; h.sync(); await h.flush();
  h.state.splitFocusedIndex = 0; h.sync(); await h.flush(); await h.open();
  h.type('Summary (required)', 'next unfinished'); h.type('Description', 'new body');
  gate.resolve({ success: true }); await completing; await h.flush();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'next unfinished');
  assert.equal(h.find((n) => n.props?.placeholder === 'Description').props.value, 'new body');
  h.runTimers(); await h.flush();
  assert.equal(h.persisted.get('noted-terminal.git.panel.A').commitDrafts['/worktree-a'].summary, 'next unfinished');
  h.destroy();
});

test('typing before the next React commit invalidates an in-flight generation', async () => {
  const gate = deferred(), h = harness({ generateResult: () => gate.promise });
  h.sync(); await h.flush(); await h.open();
  const completing = h.find((n) => n.props?.title?.startsWith('Generate commit message.')).props.onClick();
  h.type('Summary (required)', 'just typed', false);
  gate.resolve({ success: true, message: { summary: 'stale generated', description: 'stale' } });
  await completing; await h.flush();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'just typed');
  h.destroy();
});

test('closing the loading panel is preserved when hydration finally completes', async () => {
  const gate = deferred(), h = harness({ readState: () => gate.promise });
  h.sync(); await h.flush(); await h.open();
  h.find((n) => n.type === 'button' && n.props.title?.includes(' changed')).props.onClick();
  await h.flush();
  gate.resolve({ open: true, selectedRepoPath: '/worktree-a', summary: 'saved' });
  await h.flush(); assert.ok(!h.find((n) => n.type === 'portal'));
  h.destroy();
});

for (const editBeforeGeneration of [true, false]) {
  test(`generate-and-commit preserves a newer draft edited ${editBeforeGeneration ? 'before generation' : 'during commit'}`, async () => {
    const generation = deferred(), commit = deferred();
    const h = harness({ generateResult: () => generation.promise, commitResult: () => commit.promise, writeState() {} });
    h.sync(); await h.flush(); await h.open();
    const completing = h.find((n) => n.props?.title?.startsWith('Generate and commit.')).props.onClick();
    if (!editBeforeGeneration) {
      generation.resolve({ success: true, message: { summary: 'generated', description: 'generated body' } });
      await h.flush();
      assert.equal(h.calls.filter(([channel]) => channel === 'git:commit').length, 1);
    }
    h.state.splitFocusedIndex = 1; h.sync(); await h.flush();
    h.state.splitFocusedIndex = 0; h.sync(); await h.flush(); await h.open();
    h.type('Summary (required)', 'newer draft'); h.type('Description', 'newer body');
    if (editBeforeGeneration) {
      generation.resolve({ success: true, message: { summary: 'generated', description: 'generated body' } });
      await h.flush();
    }
    const submitted = h.calls.filter(([channel]) => channel === 'git:commit');
    assert.equal(submitted.length, 1); assert.equal(submitted[0][1].summary, 'generated');
    assert.equal(submitted[0][1].projectPath, '/worktree-a');
    commit.resolve({ success: true }); await completing; await h.flush();
    assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'newer draft');
    assert.equal(h.find((n) => n.props?.placeholder === 'Description').props.value, 'newer body');
    h.runTimers(); await h.flush();
    assert.equal(h.persisted.get('noted-terminal.git.panel.A').commitDrafts['/worktree-a'].summary, 'newer draft');
    h.destroy();
  });
}

for (const action of ['generate', 'generate-commit']) {
  test(`the same completed Run After ${action} is consumed once across A → B → A remounts`, async () => {
    const h = harness({ saved: { 'noted-terminal.git.panel.A': {
      selectedRepoPath: '/worktree-a', summary: 'previous draft', description: 'previous body',
    } } });
    const completed = { id: 'A:completed-task', projectKey: 'A', repoPath: '/worktree-a',
      phase: 'success', action, result: { summary: 'generated result', description: 'generated body' } };
    h.runAfter.tasks.set('A', completed);
    h.sync(); await h.flush(); await h.open();
    assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value,
      action === 'generate' ? 'generated result' : '', 'first consumption still applies the result');
    assert.equal(h.find((n) => n.props?.placeholder === 'Description').props.value,
      action === 'generate' ? 'generated body' : '');
    assert.ok(h.find((n) => n.type === 'button' && n.props.title?.includes('completed')), 'success feedback remains visible');
    h.type('Summary (required)', 'typed after consumption'); h.type('Description', 'new unfinished body');
    h.state.splitFocusedIndex = 1; h.sync(); await h.flush();
    h.state.splitFocusedIndex = 0; h.sync(); await h.flush(); await h.open();
    assert.equal(h.runAfter.tasks.get('A'), completed, 'the same task is still successful before its clear timer');
    assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'typed after consumption');
    assert.equal(h.find((n) => n.props?.placeholder === 'Description').props.value, 'new unfinished body');
    assert.ok(h.find((n) => n.type === 'button' && n.props.title?.includes('completed')), 'remount retains feedback without reapplying');
    h.runTimers(); await h.flush();
    assert.deepEqual(h.calls.filter(([channel]) => channel === 'clearTask'), [['clearTask', 'A', completed.id]],
      'the original deferred clear survives unmount and runs once');
    assert.equal(h.runAfter.tasks.has('A'), false);
    h.destroy();
  });
}

test('a background Run After success is first applied on return, and a distinct next task still applies', async () => {
  const h = harness();
  const first = { id: 'A:first', projectKey: 'A', repoPath: '/worktree-a', phase: 'success', action: 'generate',
    result: { summary: 'background result', description: 'background body' } };
  h.state.splitFocusedIndex = 1;
  h.runAfter.tasks.set('A', first);
  h.sync(); await h.flush();
  assert.equal(h.calls.filter(([channel]) => channel === 'clearTask').length, 0);
  h.state.splitFocusedIndex = 0; h.sync(); await h.flush(); await h.open();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'background result');
  h.type('Summary (required)', 'edited first result');
  // Replacement identity must be consumed even while the first receipt exists.
  const second = { ...first, id: 'A:second', result: { summary: 'second result', description: 'second body' } };
  h.runAfter.tasks.set('A', second); h.sync(); await h.flush();
  assert.equal(h.find((n) => n.props?.placeholder === 'Summary (required)').props.value, 'second result');
  h.runTimers(); await h.flush();
  assert.deepEqual(h.calls.filter(([channel]) => channel === 'clearTask'),
    [['clearTask', 'A', first.id], ['clearTask', 'A', second.id]]);
  assert.equal(h.runAfter.tasks.has('A'), false);
  assert.equal(h.calls.filter(([channel]) => channel === 'git:generate-commit-message' || channel === 'git:commit').length, 0,
    'result consumption never reruns the background action');
  h.destroy();
});
