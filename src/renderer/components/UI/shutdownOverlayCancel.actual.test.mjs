import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// The closing screen is the only place the user can change their mind, and the
// window is short: the app stops live AI sessions one by one, and the button
// must stay usable until the last one is gone ("она работает в тот момент,
// пока не закрылась последняя вкладка").
//
// This executes the REAL ShutdownOverlay component with a finite React-hook
// substitute. IPC is a controlled port; nothing is mounted or painted.
//
// Run: node --test src/renderer/components/UI/shutdownOverlayCancel.actual.test.mjs
const source = fs.readFileSync(
  process.env.SHUTDOWN_OVERLAY_PATH || new URL('./ShutdownOverlay.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;

const descendants = (node) => Array.isArray(node) ? node.flatMap(descendants)
  : !node || typeof node !== 'object' ? [] : [node, ...descendants(node.props?.children)];

function fixture() {
  const slots = [], sent = [], listeners = new Set();
  let cursor = 0, tree = null;
  const state = (initial) => {
    const i = cursor++;
    slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slots[i].value, (next) => {
      slots[i].value = typeof next === 'function' ? next(slots[i].value) : next;
    }];
  };
  const effect = (fn, deps) => {
    const i = cursor++;
    const previous = slots[i];
    if (!previous || deps.some((value, k) => value !== previous.deps[k])) {
      slots[i] = { deps, cleanup: previous?.cleanup };
      previous?.cleanup?.();
      slots[i].cleanup = fn();
    }
  };
  const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
  // esModuleInterop emits `react_1.default.createElement`, so the substitute
  // must carry the same default-namespace shape the real module has.
  const react = { useEffect: effect, useState: state, createElement, __esModule: true };
  react.default = react;
  const moduleRecord = { exports: {} };
  const context = {
    module: moduleRecord, exports: moduleRecord.exports,
    require: (name) => {
      if (name === 'react') return react;
      throw new Error(name);
    },
    React: { createElement },
    window: { require: () => ({ ipcRenderer: {
      on: (_channel, handler) => listeners.add(handler),
      removeListener: (_channel, handler) => listeners.delete(handler),
      send: (channel) => sent.push(channel),
    } }) },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  const Overlay = context.module.exports.default;
  const render = () => { cursor = 0; tree = Overlay(); return tree; };
  render();
  return {
    sent, render,
    publish: (payload) => { for (const handler of listeners) handler(null, payload); return render(); },
    node: (attribute) => descendants(tree).find(n => n?.props?.[attribute] !== undefined) || null,
    text: () => descendants(tree).flatMap(n => (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children]))
      .filter(value => typeof value === 'string' || typeof value === 'number').join(' ')
      .replace(/\s+/g, ' '),
    get listenerCount() { return listeners.size; },
  };
}

test('the button appears with the closing screen and sends exactly one cancel', () => {
  const h = fixture();
  assert.equal(h.render(), null, 'nothing is shown until main says so');
  h.publish({ show: true, tabsCount: 7, closedTabs: 0, cancellable: true });
  const button = h.node('data-shutdown-cancel');
  assert.ok(button, 'the user must have a way out while tabs are still closing');
  assert.equal(button.props.disabled, false);
  // No confirmation step: the press IS the decision, and a second question
  // would cost the very seconds that decide whether the cancel still helps.
  button.props.onClick();
  assert.deepEqual(h.sent, ['shutdown:cancel']);
  const pressed = h.render();
  assert.equal(descendants(pressed).find(n => n?.props?.['data-shutdown-cancel'])?.props.disabled, true,
    'the pressed button cannot be pressed again');
  assert.match(h.text(), /Отменяю…/);
});

test('progress counts stopped tabs, and the button dies with the last one', () => {
  const h = fixture();
  h.publish({ show: true, tabsCount: 3, closedTabs: 0, cancellable: true });
  assert.match(h.text(), /ОСТАНОВЛЕНО 0 ИЗ 3/);
  h.publish({ show: true, tabsCount: 3, closedTabs: 2, cancellable: true });
  assert.match(h.text(), /ОСТАНОВЛЕНО 2 ИЗ 3/);
  assert.equal(h.node('data-shutdown-cancel').props.disabled, false, 'one tab still alive — still cancellable');
  h.publish({ show: true, tabsCount: 3, closedTabs: 3, cancellable: true });
  assert.equal(h.node('data-shutdown-cancel').props.disabled, true,
    'nothing left to save once the last tab is gone');
});

test('an installer-owned quit shows no button at all', () => {
  // build:i-c quits expecting to relaunch; cancelling would leave it with
  // nothing to come back to.
  const h = fixture();
  h.publish({ show: true, tabsCount: 4, closedTabs: 0, cancellable: false });
  assert.equal(h.node('data-shutdown-cancel'), null);
  assert.doesNotMatch(h.text(), /Отмена/);
});

test('a progress frame does not erase the counts it omits', () => {
  // Main publishes the cancelling state as its own frame, with no tabsCount
  // or closedTabs. Treating absent as zero would reset the counter and
  // re-enable the button at the worst possible moment.
  const h = fixture();
  h.publish({ show: true, tabsCount: 5, closedTabs: 4, cancellable: true });
  h.publish({ show: true, cancelling: true });
  assert.match(h.text(), /ОСТАНОВЛЕНО 4 ИЗ 5/);
  assert.equal(h.node('data-shutdown-cancel').props.disabled, true);
});

test('a cancelled quit clears the screen and leaves it reusable', () => {
  const h = fixture();
  h.publish({ show: true, tabsCount: 2, closedTabs: 1, cancellable: true });
  h.node('data-shutdown-cancel').props.onClick();
  assert.equal(h.publish({ show: false }), null, 'the app is alive again, nothing on screen');
  // The next ⌘Q is a fresh flow: stale progress or a stuck "Отменяю…" would
  // show a button that looks already pressed.
  h.publish({ show: true, tabsCount: 2, closedTabs: 0, cancellable: true });
  assert.equal(h.node('data-shutdown-cancel').props.disabled, false);
  assert.match(h.text(), /Отмена/);
  assert.doesNotMatch(h.text(), /Отменяю…/);
});

test('the overlay tells the truth about what cancel cannot do', () => {
  const h = fixture();
  h.publish({ show: true, tabsCount: 3, closedTabs: 1, cancellable: true });
  assert.match(h.text(), /Уже остановленные сессии отмена не вернёт/);
  h.node('data-shutdown-cancel').props.onClick();
  h.render();
  assert.match(h.text(), /Оставшиеся сессии продолжат работу/);
});

test('no system wait-cursor, and the listener is retired on unmount', () => {
  // `cursor:'wait'` raises the macOS spinner over the whole window, which
  // reads as "the app froze" — exactly what this screen exists to deny.
  const h = fixture();
  h.publish({ show: true, tabsCount: 1, closedTabs: 0, cancellable: true });
  assert.equal(h.node('data-shutdown-cancel').props.style.cursor, 'pointer');
  h.publish({ show: true, tabsCount: 1, closedTabs: 1, cancellable: true });
  assert.equal(h.node('data-shutdown-cancel').props.style.cursor, 'default');
  assert.equal(h.listenerCount, 1, 'one listener, not one per render');
});
