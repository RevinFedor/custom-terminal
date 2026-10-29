import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import * as activity from './historyOperationActivity.mjs';
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(relative, imports) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const compiled = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error('unexpected import ' + name);
  }, module, module.exports);
  return module.exports.default;
}
const Chip = load('../components/UI/BackgroundTabOperationChip.tsx', { react: React });
test.afterEach(() => {
  for (const op of activity.getHistoryOperationActivities()) activity.dismissHistoryOperationActivity(op.id);
});
function component(state, native = {}, react = React, ui = { getState: () => ({ showToast() {} }) }) {
  const workspace = selector => selector(state);
  workspace.getState = () => state;
  return load('../components/UI/HistoryOperationBackgroundStatus.tsx', {
    react,
    '../../store/useWorkspaceStore': { useWorkspaceStore: workspace },
    '../../store/useRewindOperationStore': { useRewindOperationStore: selector => selector({ operationsByKey: native }) },
    '../../store/useUIStore': { useUIStore: ui },
    '../../utils/historyOperationActivity.mjs': activity,
    './BackgroundTabOperationChip': { default: Chip, __esModule: true },
  });
}
const stateFor = () => ({
  view: 'workspace', activeProjectId: 'P', splitPanes: [{ tabId: 'B' }],
  openProjects: new Map([['P', { currentView: 'terminal', tabs: new Map([
    ['A', { name: 'Source operation tab' }], ['B', { name: 'Current tab' }],
  ]) }]]),
  getEffectiveTabId: () => 'B',
});

test('actual global chip renders delete/native Rewind without mounting the owner and hides over visible source', () => {
  const op = activity.beginHistoryOperationActivity({ tabId: 'A', kind: 'delete' });
  const state = stateFor();
  const Component = component(state);
  const html = () => renderToStaticMarkup(React.createElement(Component));
  assert.match(html(), /data-background-tab-operation="УДАЛЕНИЕ"/);
  assert.match(html(), /title="Source operation tab"/);
  assert.match(html(), /background-tab-operation-spin/);
  state.splitPanes = [{ tabId: 'A' }, { tabId: 'B' }];
  assert.equal(html(), '', 'source is visible in a different window, even though B has focus');
  state.view = 'home';
  assert.match(html(), /УДАЛЕНИЕ/);
  op.finish('identity rejected');
  assert.match(html(), /УДАЛЕНИЕ: ОШИБКА/);
  assert.match(html(), /title="identity rejected"/);
  activity.dismissHistoryOperationActivity(op.id);
  const Native = component(state, { old: { opId: 'native-1', tabId: 'A', phase: 'committing' } });
  assert.match(renderToStaticMarkup(React.createElement(Native)), /data-background-tab-operation="REWIND"/);
});

function toastStore() {
  const source = fs.readFileSync(new URL('../store/useUIStore.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('useUIStore.ts', source, ts.ScriptTarget.Latest, true);
  const properties = new Map();
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ['showToast', 'removeToast'].includes(node.name.getText(ast))) {
      properties.set(node.name.getText(ast), node.initializer.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(properties.size, 2, 'execute the actual common toast store, including its default timer');
  let now = 0;
  const timers = new Set(), state = { toasts: [] };
  const context = vm.createContext({
    set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    get: () => state,
    setTimeout: (callback, delay) => { const timer = { callback, due: now + delay }; timers.add(timer); return timer; },
  });
  for (const [key, value] of properties) state[key] = vm.runInContext(value, context);
  return { getState: () => state, timers,
    advance(ms) { now += ms; for (const timer of [...timers]) if (timer.due <= now) {
      timers.delete(timer); timer.callback();
    } },
  };
}

function hookRenderer(state, native = {}, ui = toastStore()) {
  let refIndex = 0;
  const refs = [], effects = [];
  const react = { ...React, useSyncExternalStore: (_subscribe, get) => get(),
    useMemo: fn => fn(), useRef: value => refs[refIndex++] ||= { current: value },
    useEffect: effect => effects.push(effect) };
  const Component = component(state, native, react, ui);
  return { ui, render() {
    refIndex = 0;
    const tree = Component();
    while (effects.length) effects.shift()();
    return tree;
  } };
}

test('completed JSONL Rewind uses the actual common toast timer, not a permanent result chip', async () => {
  const op = activity.beginHistoryOperationActivity({ tabId: 'A', kind: 'rewind' });
  op.finish();
  const state = stateFor();
  const calls = [];
  state.openTabById = async (id, options) => {
    calls.push([id, options]);
    return true;
  };
  const renderer = hookRenderer(state);
  const tree = renderer.render();
  assert.equal(React.Children.toArray(tree.props.children).length, 0, 'no untimed success chip');
  assert.equal(activity.getHistoryOperationActivities().length, 0);
  const toast = renderer.ui.getState().toasts[0];
  assert.equal(toast.type, 'success'); assert.equal(toast.persistent, false);
  assert.match(toast.message, /Rewind/); assert.equal(toast.actionLabel, 'Source operation tab');
  await toast.onAction();
  assert.equal(calls[0][0], 'A');
  renderer.render();
  assert.equal(renderer.ui.getState().toasts.length, 1, 'rerenders do not emit another success');
  renderer.ui.advance(2499); assert.equal(renderer.ui.getState().toasts.length, 1);
  renderer.ui.advance(1); assert.equal(renderer.ui.getState().toasts.length, 0, 'shared default 2500ms removes it');
});

test('native success is temporary presentation and does not clear the native operation store', () => {
  const native = { old: { opId: 'native-success', tabId: 'A', phase: 'done' } };
  const renderer = hookRenderer(stateFor(), native);
  assert.equal(React.Children.toArray(renderer.render().props.children).length, 0);
  assert.equal(renderer.ui.getState().toasts.length, 1);
  renderer.render(); assert.equal(renderer.ui.getState().toasts.length, 1);
  renderer.ui.advance(2500); assert.equal(renderer.ui.getState().toasts.length, 0);
  renderer.render(); assert.equal(renderer.ui.getState().toasts.length, 0, 'no replay after expiry');
  assert.equal(native.old.phase, 'done');
});

test('running operation has no dismiss timer; failure survives time and visibility until explicit close', async () => {
  const op = activity.beginHistoryOperationActivity({ tabId: 'A', kind: 'rewind' });
  const state = stateFor(); state.openTabById = async () => true;
  const renderer = hookRenderer(state);
  assert.equal(React.Children.toArray(renderer.render().props.children)[0].props.pending, true);
  assert.equal(renderer.ui.timers.size, 0);
  op.finish('source mismatch');
  let chip = React.Children.toArray(renderer.render().props.children)[0];
  assert.equal(chip.props.failed, true);
  renderer.ui.advance(60_000); assert.equal(activity.getHistoryOperationActivities().length, 1);
  state.splitPanes = [{ tabId: 'A' }]; renderer.render();
  state.splitPanes = [{ tabId: 'B' }];
  chip = React.Children.toArray(renderer.render().props.children)[0];
  assert.equal(chip.props.failed, true, 'opening its surface does not erase the failure');
  await chip.props.onOpen({ stopPropagation() {} });
  assert.equal(activity.getHistoryOperationActivities().length, 1);
  chip.props.onDismiss(); assert.equal(activity.getHistoryOperationActivities().length, 0);
});

test('visible completion does not duplicate the owner toast or create a global success card', () => {
  const op = activity.beginHistoryOperationActivity({ tabId: 'A', kind: 'rewind' });
  op.finish();
  const state = stateFor(); state.splitPanes = [{ tabId: 'A' }];
  const renderer = hookRenderer(state); renderer.render();
  assert.equal(renderer.ui.getState().toasts.length, 0);
  assert.equal(activity.getHistoryOperationActivities().length, 0);
});

test('microphone and history use the same actual chip renderer in the global Toast container', () => {
  const source = fs.readFileSync(new URL('../components/UI/Toast.tsx', import.meta.url), 'utf8');
  assert.match(source, /<HistoryOperationBackgroundStatus\s*\/>/);
  assert.match(source, /<BackgroundTabOperationChip label="RECORDING"/);
  assert.match(renderToStaticMarkup(React.createElement(Chip, { label: 'RECORDING', tabName: 'Mic owner', onOpen() {} })),
    /data-background-tab-operation="RECORDING"/);
});
