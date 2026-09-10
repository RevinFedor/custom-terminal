import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
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
function component(state, native = {}, react = React) {
  const workspace = selector => selector(state);
  workspace.getState = () => state;
  return load('../components/UI/HistoryOperationBackgroundStatus.tsx', {
    react,
    '../../store/useWorkspaceStore': { useWorkspaceStore: workspace },
    '../../store/useRewindOperationStore': { useRewindOperationStore: selector => selector({ operationsByKey: native }) },
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

test('actual completed chip navigates to its owner and dismisses only that completed operation', () => {
  const op = activity.beginHistoryOperationActivity({ tabId: 'A', kind: 'rewind' });
  op.finish();
  const state = stateFor();
  const calls = [];
  for (const key of ['showWorkspace', 'setViewingSubAgent', 'switchTab', 'setProjectView']) {
    state[key] = (...args) => calls.push([key, ...args]);
  }
  const hookless = { ...React, useSyncExternalStore: (_subscribe, get) => get(),
    useMemo: fn => fn(), useEffect() {} };
  const tree = component(state, {}, hookless)();
  const chips = React.Children.toArray(tree.props.children);
  assert.equal(chips[0].props.label, 'REWIND ГОТОВ');
  let stopped = false;
  chips[0].props.onOpen({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(calls[2], ['switchTab', 'P', 'A']);
  assert.equal(activity.getHistoryOperationActivities().length, 0);
});

test('microphone and history use the same actual chip renderer in the global Toast container', () => {
  const source = fs.readFileSync(new URL('../components/UI/Toast.tsx', import.meta.url), 'utf8');
  assert.match(source, /<HistoryOperationBackgroundStatus\s*\/>/);
  assert.match(source, /<BackgroundTabOperationChip label="RECORDING"/);
  assert.match(renderToStaticMarkup(React.createElement(Chip, { label: 'RECORDING', tabName: 'Mic owner', onOpen() {} })),
    /data-background-tab-operation="RECORDING"/);
});
