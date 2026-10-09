import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const source = fs.readFileSync(new URL('./SpaceStrip.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('SpaceStrip.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback, controls;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'stopSessions') callback = node.getText(tree);
  if (ts.isJsxElement(node) && node.openingElement.attributes.getText(tree).includes('data-workflow-stop-controls')) controls = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree); assert.ok(callback); assert.ok(controls);
function fixture(result, deferred = false) {
  const writes = [], events = [], toasts = [], states = [];
  let release;
  const context = vm.createContext({ console: { log() {}, warn() {} }, id: 'work',
    crypto: { randomUUID: () => 'fixture-stop-action' }, performance: { now: () => 10 },
    stopSessionsInFlight: { current: false }, setStoppingSessions: value => states.push(value), setContextMenu() {},
    sendPendingTabs: new Set(['preparing']), inheritedBusyTabIds: new Set(['child']),
    busyTabs: new Map([['own', true], ['idle', false]]), pasteBusyTabs: new Map([['paste', true]]),
    useUIStore: { getState: () => ({ showToast: (...args) => toasts.push(args) }) },
    CustomEvent: class { constructor(type, value) { this.type = type; this.detail = value.detail; } },
    window: { dispatchEvent: event => events.push(event), require: () => ({ ipcRenderer: { invoke: (...args) => {
      writes.push(args);
      if (deferred) return new Promise(resolve => { release = () => resolve(result); });
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    } } }) },
  });
  vm.runInContext(transformSync('const ' + callback + '; globalThis.stopSessions = stopSessions;', { loader: 'ts' }).code, context);
  return { context, writes, events, toasts, states, release: () => release() };
}
const ack = { results: [{ tabId: 'sdk', kind: 'sdk', success: true }, { tabId: 'other', kind: 'sdk', success: false }],
  stoppedCount: 1, skippedCount: 1, failedCount: 1 };

test('actual click callback sends explicit workflow + local idle exclusions; all never uses execution project as workflow', async () => {
  const f = fixture(ack); await f.context.stopSessions('idle');
  assert.equal(f.writes[0][0], 'workflow:stop-sessions');
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[0][1])), { actionId: 'fixture-stop-action', workflowId: 'work', mode: 'idle',
    busyTabIds: ['preparing', 'child', 'own', 'paste'] });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].detail.tabId, 'sdk');
  assert.equal(f.toasts[0][1], 'error'); assert.match(f.toasts[0][0], /Ошибок: 1/);
  await f.context.stopSessions('all');
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[1][1])), { actionId: 'fixture-stop-action', workflowId: 'work', mode: 'all' });
});

test('actual click double activation and unknown IPC cannot invent success or stopped SDK signals', async () => {
  const f = fixture(ack, true), first = f.context.stopSessions('all');
  await f.context.stopSessions('all'); assert.equal(f.writes.length, 1); f.release(); await first;
  assert.deepEqual(f.states, [true, false]);
  const failed = fixture(new Error('private transport lost'));
  await failed.context.stopSessions('idle');
  assert.equal(failed.events.length, 0); assert.equal(failed.toasts[0][1], 'error');
  assert.match(failed.toasts[0][0], /не подтверждена/);
});

test('actual split-control JSX exposes both distinct accessible actions in one dense row', () => {
  const buttons = [], React = { createElement(type, props, ...children) {
    const element = { type, props, children }; if (type === 'button') buttons.push(element); return element;
  } };
  const modes = [], context = vm.createContext({ React, Square: () => null, CONTEXT_MENU_ROW_STYLE: { height: 28 },
    workflowMenuItemStyle: {}, stoppingSessions: false, stopSessions: mode => modes.push(mode) });
  vm.runInContext(transformSync('const view=' + controls + ';', { loader: 'tsx' }).code, context);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every(button => button.props['aria-label'] && button.props.style.height === 28));
  buttons.forEach(button => button.props.onClick()); assert.deepEqual(modes, ['idle', 'all']);
});
