import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const storeSource = read('../store/useWorkspaceStore.ts');
const tree = ts.createSourceFile('store.ts', storeSource, ts.ScriptTarget.Latest, true);
function nodeOf(ast, name, predicate) {
  let found; function visit(n) { if (!found && predicate(n) && n.name?.getText(ast) === name) found = n; ts.forEachChild(n, visit); }
  visit(ast); assert.ok(found, name); return found;
}
const method = name => `${name}: ${nodeOf(tree, name, ts.isPropertyAssignment).initializer.getText(tree)}`;
const decl = (ast, name) => `const ${nodeOf(ast, name, ts.isVariableDeclaration).getText(ast)};`;
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture() {
  const tab = { id: 'child', name: 'parent_fork', commandType: 'codex', cwd: '/fixture' };
  const workspace = { projectId: 'p', tabs: new Map([[tab.id, tab]]) };
  const snapshots = new Map([['child', { sessionType: 'codex', autoTitleEligible: true, autoTitleMode: 'fork', name: 'parent_fork' }]]);
  const pending = new Map(), saved = [], intent = new Map();
  const state = { openProjects: new Map([['p', workspace]]) };
  const ctx = { console: { warn() {} }, module: { exports: {} }, get: () => state, set: patch => Object.assign(state, patch),
    aiLaunchSnapshots: snapshots, autoTabTitleIntents: intent, clearPendingAutoTabTitle: id => pending.delete(id),
    notifyTabNameChanged() {}, saveTabsThenNotifyProjectLayoutChanged: (_p, tabs) => saved.push({ ...tabs.get('child') }),
    normalizeGeneratedTabName: value => value.trim(), getNextAvailableName: value => value,
    shouldAttemptAutoTabTitleArmForSessionWrite: () => true, getAutoTabTitleIntent: id => intent.get(id),
    logAutoTabTitleArmSkip() {}, armPendingAutoTabTitle: (id, toolType, sessionId, options) => pending.set(id, { tabId: id, toolType, sessionId, ...options }),
  };
  vm.runInNewContext(compile(decl(tree, 'getAutoTabTitleArmSkipReason') + decl(tree, 'maybeArmPendingAutoTabTitle')
    + '\nmodule.exports={' + ['renameTab', 'autoRenameTab', 'restoreRejectedAiLaunchSnapshot'].map(method).join(',') + ',arm:maybeArmPendingAutoTabTitle};'), ctx);
  Object.assign(state, ctx.module.exports);
  return { tab, workspace, snapshots, pending, state, saved };
}

test('manual rename while fork prepares survives launch rollback and never re-arms at first SID', () => {
  const f = fixture();
  f.state.renameTab('p', 'child', 'Моя ветка');
  f.state.arm('child', 'codex', undefined, 'new-session', true, 'detected');
  assert.equal(f.pending.size, 0, 'old auto snapshot cannot rearm after a manual edit');
  assert.equal(f.state.restoreRejectedAiLaunchSnapshot('child', 'codex'), true);
  assert.equal(f.tab.name, 'Моя ветка'); assert.equal(f.tab.nameSetManually, true);
  assert.equal(f.saved.at(-1).name, 'Моя ветка'); assert.equal(f.saved.at(-1).nameSetManually, true);
});
test('unchanged inline edit is not manual; ordinary first prompt and explicit refresh remain available', () => {
  const f = fixture(); f.state.renameTab('p', 'child', 'parent_fork');
  assert.equal(f.tab.nameSetManually, undefined);
  f.state.arm('child', 'codex', undefined, 'child-session', false, 'detected'); assert.equal(f.pending.size, 1);
  assert.equal(f.state.autoRenameTab('child', 'Первое сообщение'), true);
  f.state.renameTab('p', 'child', 'Ручное');
  assert.equal(f.state.autoRenameTab('child', 'Позднее AI'), false);
  assert.equal(f.state.autoRenameTab('child', 'Явное обновление', { overrideManualName: true, markNameSetManually: true }), true);
});

const coordinator = ts.createSourceFile('coordinator.ts', read('./autoTabTitleCoordinator.ts'), ts.ScriptTarget.Latest, true);
for (const stage of ['read', 'generation']) test(`actual title coordinator discards a late ${stage} after manual rename`, async () => {
  const f = fixture(); f.tab.codexSessionId = 'C';
  const item = { tabId: 'child', toolType: 'codex', sessionId: 'C', mode: 'fork' };
  let release, entered; const waiting = new Promise(r => entered = r), gate = new Promise(r => release = r);
  let generated = 0, consumed = 0;
  Object.assign(f.state, { getPendingAutoTabTitle: () => item, setTabTitleNaming() {}, clearPendingAutoTabTitle() {} });
  const ctx = { console: { warn() {} }, pendingByKey: new Map([['key', item]]), inFlight: new Set(), rerunAfterFlight: new Set(),
    findTab: () => ({ tab: f.tab }), currentSessionId: tab => tab.codexSessionId,
    useWorkspaceStore: { getState: () => f.state }, finishPending: () => consumed++,
    readTabTitlePromptFromSession: async () => { if (stage === 'read') { entered(); await gate; } return { ok: true, sourcePrompt: 'first child prompt' }; },
    generateTabTitleFromPrompt: async () => { generated++; if (stage === 'generation') { entered(); await gate; } return 'AI title'; },
    usePromptsStore: { getState: () => ({ getPromptById: () => ({}) }) }, TAB_TITLE_PROMPT_ID: 'title',
  };
  const attempt = vm.runInNewContext(compile(decl(coordinator, 'attemptAutoTitle') + '\nattemptAutoTitle;'), ctx);
  const work = attempt('key', 'fixture'); await waiting;
  f.state.renameTab('p', 'child', 'Моя ветка'); release(); await work;
  assert.equal(f.tab.name, 'Моя ветка'); assert.equal(consumed, 1);
  assert.equal(generated, stage === 'read' ? 0 : 1);
});

test('actual shared card prioritizes inline rename over pending label; manual label remains visible', () => {
  const source = read('../components/Workspace/TabCard.tsx');
  const ast = ts.createSourceFile('card.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expression = nodeOf(ast, 'titleContents', ts.isVariableDeclaration).initializer.getText(ast);
  const render = (children, pending) => vm.runInNewContext(compile('const value=' + expression + ';value;'), {
    React, chooser: false, tabType: 'terminal', empty: false, children, pending,
    TabPendingOperation: 'pending-operation', TabSessionAvailabilityMarker: 'availability',
    tabName: 'Моя ветка', fullWidth: false, truncate: false, label: null, trailingActions: null, availability: {},
  });
  const input = React.createElement('input', { value: 'Моя ветка' });
  const editing = render(input, 'Создание форка…');
  assert.equal(editing.props.children[1], input, 'real pane rename input is not hidden by pending status');
  const p = ts.createSourceFile('pending.tsx', read('../components/Workspace/TabPendingOperation.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = nodeOf(p, 'resolveTabPendingOperationLabel', ts.isFunctionDeclaration).getText(p).replace('export ', '');
  const label = vm.runInNewContext(compile(fn + '\nresolveTabPendingOperationLabel;'));
  assert.equal(label({ pendingOperation: 'Создание форка…', nameSetManually: true, name: 'Моя ветка' }), 'Моя ветка');
  assert.equal(label({ pendingOperation: 'Создание форка…' }), 'Создание форка…');
  assert.equal(label({ aiClosing: true, nameSetManually: true, name: 'Моя ветка' }), 'остановка сессии...');
});

test('pending Timeline is a lightweight exact-target placeholder, never a parent reader', () => {
  const source = read('../components/Workspace/ForkPendingTimeline.tsx');
  const module = { exports: {} };
  const tab = { pendingOperation: 'Создание форка…' };
  vm.runInNewContext(compile(source), { module, exports: module.exports, require: name => {
    if (name === 'react') return { ...React, default: React };
    if (name === '../../store/useWorkspaceStore') return { useWorkspaceStore: select => select({
      openProjects: new Map([['p', { tabs: new Map([['child', tab]]) }]]) }) };
    throw Error('unexpected reader/subscription: ' + name);
  } });
  const render = module.exports.default;
  assert.equal(render({ projectId: 'p', tabId: 'child', hasSession: false }).props['data-fork-pending-timeline'], 'child');
  assert.equal(render({ projectId: 'p', tabId: 'parent', hasSession: false }), null);
  assert.equal(render({ projectId: 'p', tabId: 'child', hasSession: true }), null);
  tab.pendingOperation = undefined;
  assert.equal(render({ projectId: 'p', tabId: 'child', hasSession: false }), null);
});

test('actual pane rename compares against the edit baseline, not an async title that arrived during edit', () => {
  const source = read('../components/Workspace/PaneTabChip.tsx');
  const tree = ts.createSourceFile('chip.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const writes = [], ctx = { renameDraft: 'parent_fork', renameOriginal: { current: 'parent_fork' },
    tabName: 'AI title arrived', projectId: 'p', tabId: 'child', setRenaming() {},
    useWorkspaceStore: { getState: () => ({ renameTab: (...args) => writes.push(args) }) } };
  const commit = vm.runInNewContext(compile(decl(tree, 'commitRename') + ';commitRename;'), ctx);
  commit(); assert.deepEqual(writes, [], 'unchanged blur must keep the completed AI title');
  ctx.renameDraft = 'Моя ветка'; commit(); assert.deepEqual(writes, [['p', 'child', 'Моя ветка']]);
  assert.match(source, /renameOriginal\.current = current;\s*setRenameDraft\(current\)/);
  assert.match(source, /renameOriginal\.current = tabName;\s*setRenameDraft\(tabName\)/);
});
