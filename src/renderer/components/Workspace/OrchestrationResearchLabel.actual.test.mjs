import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import { transformSync } from 'esbuild';
import * as details from '../../utils/orchestrationDetails.mjs';
import * as projection from '../../utils/orchestrationRunProjection.mjs';

const source = fs.readFileSync(new URL('./OrchestrationStatusChip.tsx', import.meta.url), 'utf8');
const rowSource = fs.readFileSync(new URL('./RequestTrackerRow.tsx', import.meta.url), 'utf8');
const evaluate = (code, require) => {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(code, { loader: 'tsx', format: 'cjs' }).code,
    { module, exports: module.exports, require, React, window: { require: () => ({
      ipcRenderer: { invoke: () => { throw Error('Display must not invoke IPC'); } },
    }) } });
  return module.exports;
};
const rows = evaluate(rowSource, name => {
  if (name === 'react') return React;
  throw Error(name);
});
const base = Object.freeze({ runId: 'saved-run', runKind: 'external-research', sourceTabId: 'source',
  sourceTabName: 'Source session', targetTabId: null, targetTabName: 'ChatGPT · 6-astra',
  targetProjectName: 'SC Desktop', externalResearchProvider: 'chatgpt',
  externalResearchModel: '6-astra', externalResearchEffort: 'pro', externalResearchMode: 'chat',
  createdAt: 1792310000000, status: 'running', externalResearchJobId: 'noted_saved-run' });

// Execute the whole component and real row/icon markup. Only retained hook state,
// dock placement, message transport and Tooltip's overlay host are controlled.
function render(run, { history = false, tabId = 'source' } = {}) {
  let state = 0;
  const hooks = { ...React,
    useState: initial => {
      const ordinal = state++;
      return [ordinal === 0 ? [run] : ordinal === 1 ? history
        : ordinal === 2 ? new Set([run.runId]) : typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useRef: value => ({ current: value }), useEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn,
  };
  const component = evaluate(source, name => {
    if (name === 'react') return hooks;
    if (name === 'lucide-react') return icons;
    if (name.endsWith('/Tooltip')) return { __esModule: true,
      default: ({ children, content, actionBar }) => React.createElement('section', null,
        children, React.createElement('aside', { 'data-test-tooltip': true }, content, actionBar)) };
    if (name === './RequestTrackerRow') return rows;
    if (name === './TabMessageTracker') return { TabMessageTracker: () => null };
    if (name.endsWith('/useTabMessages')) return { useTabMessages: () => ({ threads: [], listError: null }) };
    if (name.endsWith('/useRequestDockLayout')) return { useRequestDockLayout: () => ({ visible: true }) };
    if (name.endsWith('/tabMessageProjection')) return { tabMessageVisibleInTracker: () => false };
    if (name.endsWith('/requestTrackerVisibility.mjs')) return { isRequestSuccessPresentation: () => false };
    if (name.endsWith('/useWorkspaceStore')) return {};
    if (name.endsWith('/orchestrationRunProjection.mjs')) return projection;
    if (name.endsWith('/orchestrationDetails.mjs')) return details;
    throw Error(name);
  }).OrchestrationStatusChip;
  return renderToStaticMarkup(React.createElement(component, { tabId, panelOpen: true, effectiveWidth: 320 }));
}

for (const [model, effort, expected] of [
  ['6-astra', 'pro', 'ChatGPT · 6 Pro'],
  ['6', 'xhigh', 'ChatGPT · 6 X High'],
  ['6', 'high', 'ChatGPT · 6 High'],
  ['6', 'medium', 'ChatGPT · 6 Medium'],
  ['6', 'instant', 'ChatGPT · 6 Instant'],
]) test(`saved ${model}/${effort} appears in the active link, hover and History`, () => {
  const run = Object.freeze({ ...base, externalResearchModel: model, externalResearchEffort: effort });
  const before = JSON.stringify(run);
  const active = render(run);
  assert.ok(active.includes(`SC Desktop: ${expected}`), 'active link accessible label');
  assert.ok(active.includes(`>${expected}</span>`), 'visible active link and hover executor');
  assert.ok(active.includes('data-test-tooltip'));
  const history = render(run, { history: true });
  assert.ok(history.includes(`SC Desktop · ${expected}`), 'saved History target subtitle');
  assert.equal(JSON.stringify(run), before, 'display cannot rewrite the saved request');
});

test('completed and cancelled saved records are relabelled without reviving their active link', () => {
  for (const status of ['completed', 'cancelled']) {
    const run = Object.freeze({ ...base, status, resultComplete: true, notificationSuppressed: true });
    const markup = render(run, { history: true });
    assert.ok(markup.includes('SC Desktop · ChatGPT · 6 Pro'));
    assert.ok(markup.includes('data-orchestration-run-id="saved-run"'));
    assert.ok(!markup.includes('data-orchestration-active-run="saved-run"'));
    assert.equal(run.status, status);
  }
});

test('other explicit efforts survive without interpreting mode as effort or assuming Pro', () => {
  for (const [effort, expected] of [['low', 'Low'], ['max', 'Max'], ['standard', 'Standard'],
    ['extended', 'Extended'], ['future-effort', 'future-effort'], ['  XHIGH  ', 'X High']]) {
    assert.equal(details.orchestrationLinkedName({ ...base, externalResearchModel: '6',
      externalResearchEffort: effort }, 'source'), `ChatGPT · 6 ${expected}`);
  }
  assert.equal(details.orchestrationLinkedName({ ...base, externalResearchEffort: null,
    externalResearchMode: 'work' }, 'source'), base.targetTabName);
  assert.equal(details.orchestrationLinkedName({ ...base, externalResearchModel: null }, 'source'), base.targetTabName);
  assert.equal(details.orchestrationLinkedName({ ...base, externalResearchEffort: null,
    targetTabName: 'ChatGPT · 6 Instant' }, 'source'), 'ChatGPT · 6 Instant');
});

test('native targets, incoming source names and other providers retain their own identity', () => {
  const native = { ...base, runKind: 'agent', targetTabId: 'target', targetTabName: 'Native task' };
  assert.equal(details.orchestrationLinkedName(native, 'source'), 'Native task');
  assert.equal(details.orchestrationLinkedName(native, 'target'), 'Source session');
  assert.equal(details.orchestrationLinkedName(base, 'other'), 'Source session');
  assert.equal(details.orchestrationLinkedName({ ...base, externalResearchProvider: 'claude',
    externalResearchModel: 'opus', externalResearchEffort: 'high' }, 'source'), 'Claude · opus High');
  assert.equal(details.orchestrationLinkedName({ ...base, externalResearchProvider: null }, 'source'), base.targetTabName);
  assert.ok(render({ ...native, sourceTabId: 'other' }).includes('Source session'));
});

test('display changes no request IDs, browser/provider options or source ownership', () => {
  assert.match(source, /ipcRenderer\.invoke\('orchestration:list-for-tab', tabId\)/);
  assert.match(source, /ipcRenderer\.on\('orchestration:changed', onChanged\)/);
  assert.equal((source.match(/orchestrationLinkedName\(run, tabId\)/g) || []).length, 3);
  const run = Object.freeze({ ...base, options: Object.freeze({ model: '6-astra', effort: 'pro', mode: 'chat' }),
    browserInstanceId: 'original-browser', requestFingerprint: 'immutable', sourceSessionId: 'original-source' });
  const before = JSON.stringify(run);
  assert.equal(details.orchestrationLinkedName(run, 'source'), 'ChatGPT · 6 Pro');
  assert.equal(JSON.stringify(run), before);
});
