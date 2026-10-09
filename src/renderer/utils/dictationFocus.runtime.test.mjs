import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { resolveFocusedTerminalSelection } from './focusedTerminalContext.mjs';
import * as registry from './dictationChipRegistry.mjs';

const source = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const start = source.indexOf("        if (action === 'dictationChipBegin')");
const end = source.indexOf("        if (action === 'dictationChipProgress')", start);
assert.ok(start >= 0 && end > start);
const compiled = ts.transpileModule('globalThis.begin = async (payload) => { const action = "dictationChipBegin";\n'
  + source.slice(start, end) + '\n};', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(kind = 'body', activeTab = 'A', extraSettle) {
  registry.__resetDictationChips();
  const hosts = new Map();
  class Element {
    constructor(tagName, tabId = null) { this.tagName = tagName; this.tabId = tabId; this.isContentEditable = tagName === 'DIV'; this.type = 'text'; this.classList = { contains: () => tagName === 'TEXTAREA' }; }
    closest() { return this.tabId ? hosts.get(this.tabId) : null; }
    matches() { return this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.isContentEditable; }
    getAttribute(name) { return name === 'data-history-composer-tab-id' ? this.tabId : null; }
    hasAttribute() { return false; }
  }
  for (const tabId of ['A', 'B']) {
    const host = new Element('SECTION', tabId);
    host.contains = node => node?.tabId === tabId;
    hosts.set(tabId, host);
  }
  const nodes = { body: new Element('BODY'), xterm: new Element('TEXTAREA'), sdk: new Element('DIV'),
    search: new Element('INPUT'), A: new Element('DIV', 'A'), B: new Element('DIV', 'B') };
  nodes.xterm.closest = selector => selector === '[data-terminal-layer-tab-id]'
    ? { getAttribute: () => 'restored-ac19d5db-b394-4b23-826f-43df8e6dad2a' } : null;
  const doc = { activeElement: nodes[kind], querySelector: selector => hosts.get(selector.match(/="(.*?)"/)?.[1]) || null };
  const state = { view: 'workspace', activeProjectId: 'P', splitPanes: [],
    openProjects: new Map([['P', { currentView: 'terminal', activeTabId: activeTab, tabs: new Map([['A', { name: 'A' }], ['B', { name: 'B' }]]) }]]) };
  const listeners = new Map(), timers = new Map(), inserted = [], logs = [];
  let next = 0, result = null;
  const window = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; },
    dispatchEvent(event) { inserted.push(event.detail.tabId); event.detail.settle(true); if (extraSettle !== undefined) event.detail.settle(extraSettle); },
  };
  const context = vm.createContext({ ...registry, Element, HTMLElement: Element, document: doc, window,
    CSS: { escape: value => value }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    clearTimeout: id => timers.delete(id), queueMicrotask, resolveFocusedTerminalSelection,
    editableDictation: { offer: node => ['INPUT','TEXTAREA'].includes(node.tagName) ? { version: 2, surface: 'editable', tabId: 'field-test', targetId: 'field-test' } : null },
    useWorkspaceStore: { getState: () => state }, reply: (_ok, value) => { result = value; return value; },
    console: { log: (...args) => logs.push(args.join(' ')) },
  });
  vm.runInContext(compiled, context);
  return { inserted, timers, listeners, logs, get result() { return result; },
    begin: () => context.begin({ chipId: 'vr-303', label: 'speech', waitForFocusMs: 6000 }),
    focus(kind) { doc.activeElement = nodes[kind]; listeners.get('focusin')?.({ target: doc.activeElement }); },
    timeout() { for (const timer of [...timers.values()]) timer.fn(); },
  };
}

for (const kind of ['xterm', 'sdk', 'search']) test(`already focused ${kind} chooses ordinary paste immediately`, async () => {
  const h = fixture(kind);
  void h.begin(); await flush();
  assert.equal(h.result?.accepted, false);
  assert.equal(h.result?.reason, 'other-input-focused');
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.inserted, []);
});

test('focused xterm and native fields offer their own receipt protocol without routing rich editors through a textarea', async () => {
  for (const kind of ['xterm','sdk','search']) {
    const h = fixture(kind); await h.begin();
    assert.equal(h.result?.accepted, false);
    assert.equal(h.result?.clipboardReceipt?.version, kind === 'xterm' ? 1 : kind === 'search' ? 2 : undefined);
    assert.equal(h.result?.clipboardReceipt?.tabId, kind === 'xterm'
      ? 'restored-ac19d5db-b394-4b23-826f-43df8e6dad2a' : kind === 'search' ? 'field-test' : undefined);
  }
});

test('no selected input still waits and inserts on a later History focus', async () => {
  const h = fixture(); void h.begin(); await flush();
  assert.equal(h.result, null);
  h.focus('B'); await flush();
  assert.equal(h.result.accepted, true);
  assert.deepEqual(h.inserted, ['B']);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('late xterm focus releases the wait without inserting a future History chip', async () => {
  const h = fixture(); void h.begin(); await flush();
  h.focus('xterm'); await flush();
  assert.equal(h.result?.reason, 'other-input-focused');
  assert.equal(h.timers.size, 0);
  h.focus('B'); await flush();
  assert.deepEqual(h.inserted, []);
});

test('the actually focused History input wins over a stale selected-tab pointer', async () => {
  const h = fixture('B', 'A'); void h.begin(); await flush();
  assert.equal(h.result?.accepted, true);
  assert.equal(h.result?.tabId, 'B');
  assert.deepEqual(h.inserted, ['B']);
});

test('absence of a chosen input retains the bounded wait and cleans up on timeout', async () => {
  const h = fixture(); void h.begin(); await flush();
  assert.equal([...h.timers.values()][0].ms, 6000);
  h.timeout(); await flush();
  assert.equal(h.result.reason, 'composer-focus-timeout');
  assert.equal(h.listeners.size, 0);
  assert.deepEqual(h.inserted, []);
});

test('the first synchronous insertion receipt cannot be overwritten by a duplicate settle', async () => {
  const h = fixture('B', 'A', false); void h.begin(); await flush();
  assert.equal(h.result?.accepted, true);
  assert.deepEqual(h.inserted, ['B']);
});
