import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { createStore } from 'zustand/vanilla';
import * as selection from '../utils/restartAfterCommand.mjs';
import { tabAllowsShellActions, resolveTabExecutionRole } from '../utils/emptyTab.mjs';
import { UNPLACED_WORKFLOW_ID } from '../utils/workflowVisuals.mjs';
import { tabSidebarProjectFingerprint } from '../utils/tabSidebarProjectFingerprint.mjs';

const source = fs.readFileSync(new URL('./useWorkspaceStore.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true);
const variable = name => ast.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
  .find(d => d.name.getText(ast) === name);
const factory = variable('useWorkspaceStore').initializer.arguments[0];
let object = factory.body.statements.find(ts.isReturnStatement).expression;
while (ts.isParenthesizedExpression(object)) object = object.expression;
const names = ['setTabRestartAfterTarget', 'toggleTabRestartAfterWorkflow', 'setTabRestartAfterCommand',
  'setTabRestartAfterPaused', 'consumeRestartAfterTriggerIdle'];
const code = transformSync('module.exports = {' + names.map(name => {
  const property = object.properties.find(p => p.name?.getText(ast) === name);
  assert.ok(property, name); return property.getText(ast);
}).join(',\n') + '};', { loader: 'ts', format: 'cjs' }).code;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const shell = { id: 'shell' };
  const ai = (id, extra = {}) => ({ id, commandType: 'codex', ...extra });
  const workspace = (id, tabs) => ({ projectId: id, tabs: new Map(tabs.map(t => [t.id, t])) });
  const writes = [];
  const store = createStore((set, get) => {
    const module = { exports: {} };
    vm.runInNewContext(code, { module, set, get, ...selection, tabAllowsShellActions, UNPLACED_WORKFLOW_ID,
      console: { error() {} }, logRestartAfterState() {}, saveTabs: (projectId, tabs) => writes.push({ projectId, tabs: plain([...tabs.values()]) }) });
    return { ...module.exports,
      // Owner, visible workspace and subscribed workflow deliberately differ.
      activeProjectId: 'owner', activeSpaceId: 'other',
      openProjects: new Map([['owner', workspace('owner', [shell])],
        ['p', workspace('p', [ai('a'), ai('sdk', { commandType: undefined, tabType: 'claude-sdk' }),
          ai('child', { parentTabId: 'a' }), { id: 'script', commandType: 'generic' }])],
        ['q', workspace('q', [ai('b', { commandType: 'gemini' })])], ['loose', workspace('loose', [ai('loose-ai')])]]),
      spaces: [{ id: 'chosen', projectIds: ['p'] }, { id: 'other', projectIds: ['owner', 'q'] }],
    };
  });
  return { store, shell, writes, all: (id = 'chosen') => store.getState().toggleTabRestartAfterWorkflow('owner', 'shell', id),
    ids: () => selection.getRestartAfterTriggerIds(shell, store.getState()),
    consume: (id, natural = true) => plain(store.getState().consumeRestartAfterTriggerIdle(id, natural)) };
}

test('ALL subscribes to the picker workflow, includes future typed AI/SDK tabs, not shell/child/other scopes', () => {
  const f = fixture(); f.all(); assert.equal(f.shell.commandType, 'generic');
  assert.deepEqual(f.ids(), ['a', 'sdk']); assert.deepEqual(f.consume('a'), [{ tabId: 'shell' }]);
  assert.deepEqual(f.consume('b'), []); assert.deepEqual(f.consume('child'), []);
  f.store.getState().openProjects.get('p').tabs.set('future', { id: 'future', commandType: 'claude' });
  assert.ok(f.ids().includes('future')); assert.equal(f.consume('future').length, 1);
  assert.deepEqual(f.writes.at(-1).tabs[0].restartAfterWorkflowIds, ['chosen']);
});

test('a second ALL click clears every explicit/workflow choice, command and pause without changing Terminal role', () => {
  const f = fixture(), s = f.store.getState(); s.setTabRestartAfterTarget('owner', 'shell', 'b'); f.all();
  s.setTabRestartAfterCommand('owner', 'shell', './deploy.sh'); s.setTabRestartAfterPaused('owner', 'shell', true);
  f.all(); assert.deepEqual(f.ids(), []); assert.equal(selection.hasRestartAfterSubscription(f.shell), false);
  for (const key of ['restartAfterWorkflowIds', 'restartAfterTabIds', 'restartAfterTabId', 'restartAfterCommand', 'restartAfterPaused']) assert.equal(f.shell[key], undefined);
  assert.equal(f.shell.commandType, 'generic'); assert.deepEqual(f.consume('a'), []);
});

test('manual exception exits ALL but retains other current selections; ALL again restores the whole live set', () => {
  const f = fixture(), s = f.store.getState(); s.setTabRestartAfterTarget('owner', 'shell', 'b'); f.all();
  s.setTabRestartAfterTarget('owner', 'shell', 'a'); assert.deepEqual(f.ids().sort(), ['b', 'sdk']);
  assert.equal(f.shell.restartAfterWorkflowIds, undefined);
  f.all(); assert.deepEqual(f.ids().sort(), ['a', 'b', 'sdk']); f.all(); assert.deepEqual(f.ids(), []);
});

test('pause and non-natural completion preserve ALL without executing, even when a scope becomes temporarily empty', () => {
  const f = fixture(), s = f.store.getState(); f.all(); s.setTabRestartAfterCommand('owner', 'shell', './deploy.sh');
  assert.deepEqual(f.consume('a', false), []); s.setTabRestartAfterPaused('owner', 'shell', true); assert.deepEqual(f.consume('a'), []);
  s.openProjects.get('p').tabs.clear(); assert.equal(selection.hasRestartAfterSubscription(f.shell), true);
  s.setTabRestartAfterPaused('owner', 'shell', false);
  s.openProjects.get('p').tabs.set('new', { id: 'new', commandType: 'codex' });
  assert.deepEqual(f.consume('new'), [{ tabId: 'shell', command: './deploy.sh' }]);
});

test('live membership follows project/workflow moves, deletion and unplaced group; duplicate project parents use first', () => {
  const f = fixture(), s = f.store.getState(); f.all(); s.spaces[0].projectIds = ['p', 'q'];
  assert.equal(f.consume('b').length, 1); s.spaces[0].projectIds = []; assert.deepEqual(f.consume('a'), []);
  s.spaces = s.spaces.filter(w => w.id !== 'chosen'); assert.deepEqual(f.ids(), []);
  f.all(UNPLACED_WORKFLOW_ID); assert.deepEqual(f.ids().sort(), ['a', 'loose-ai', 'sdk']);
});

test('ALL changes sidebar projection and never commits an AI owner to shell automation', () => {
  const f = fixture(), s = f.store.getState(), ws = s.openProjects.get('owner');
  const before = tabSidebarProjectFingerprint(ws); f.all(); assert.notEqual(tabSidebarProjectFingerprint(ws), before);
  s.toggleTabRestartAfterWorkflow('p', 'a', 'chosen'); assert.equal(s.openProjects.get('p').tabs.get('a').restartAfterWorkflowIds, undefined);
  assert.equal(resolveTabExecutionRole({ restartAfterWorkflowIds: ['chosen'] }), 'terminal');
});

test('all existing restore/save projections include workflow subscriptions, including create-after and shutdown', () => {
  const projections = source.split('\n').filter(line => /^\s*restartAfterTabIds:/.test(line));
  assert.equal(projections.length, 6);
  for (const line of projections) assert.ok(source.includes(line + '\n' + line.replaceAll('restartAfterTabIds', 'restartAfterWorkflowIds')), line);
});
