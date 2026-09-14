import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  DISPLAY_SIZE_KEYS, DISPLAY_SIZE_LIMITS, DISPLAY_PROFILES_STORAGE_KEY,
  DISPLAY_CONTEXT_CHANNEL, DISPLAY_CHANGED_CHANNEL,
  applyDisplayContext, pickDisplaySizes, readDisplayProfileMemory,
  serializeDisplayProfileMemory, updateDisplayProfileSizes,
  surfaceFontSizePatch, fontSizeShortcutDelta,
  installSurfaceFontShortcuts, subscribeDisplayContext,
} from './displayProfiles.mjs';

const require = createRequire(import.meta.url);
const { displayContext, attachDisplayProfiles } = require('../../main/display-profiles.js');
const odyssey = { key: 'display:42', label: 'Odyssey', internal: false, width: 2560, height: 1440, scaleFactor: 1 };
const macbook = { key: 'display:7', label: 'MacBook', internal: true, width: 1496, height: 967, scaleFactor: 2 };
const initial = (sizes = {}) => ({ ...pickDisplaySizes(sizes), activeDisplayKey: null, displayProfiles: {}, connectedDisplays: [] });
const snapshot = (current, displays = [odyssey, macbook]) => ({ current, displays });
const apply = (state, event) => ({ ...state, ...applyDisplayContext(state, event) });
const edit = (state, key, patch) => ({ ...state, ...updateDisplayProfileSizes(state, key, patch) });

test('first monitor inherits globals, all connected monitors inherit once independently', () => {
  let state = apply(initial({ tabSidebarWidth: 314, sidebarWidth: 420, historyFontSize: 19 }), snapshot(odyssey));
  assert.equal(state.historyFontSize, 19);
  assert.equal(state.displayProfiles[macbook.key].sizes.tabSidebarWidth, 314);
  assert.notEqual(state.displayProfiles[macbook.key].sizes, state.displayProfiles[odyssey.key].sizes);
  state = edit(state, odyssey.key, { historyFontSize: 21, sidebarWidth: 380 });
  state = apply(state, snapshot(macbook));
  assert.equal(state.historyFontSize, 19);
  assert.equal(state.sidebarWidth, 420);
  state = edit(state, macbook.key, { historyFontSize: 15, tabSidebarWidth: 180 });
  state = apply(state, snapshot(odyssey));
  assert.equal(state.historyFontSize, 21);
  assert.equal(state.tabSidebarWidth, 314);
  assert.equal(state.displayProfiles[macbook.key].sizes.historyFontSize, 15);
});

test('inactive and disconnected profile edits preserve every live size and survive restart', () => {
  let state = apply(initial(), snapshot(odyssey));
  const liveBefore = pickDisplaySizes(state);
  state = edit(state, macbook.key, { historyFontSize: 17, tabSidebarWidth: 155, notesTooltipFontSize: 20 });
  assert.deepEqual(pickDisplaySizes(state), liveBefore);
  state = apply(state, snapshot(odyssey, [odyssey]));
  state = edit(state, macbook.key, { sidebarWidth: 460 });
  const memory = readDisplayProfileMemory(serializeDisplayProfileMemory(state));
  state = { ...initial(memory.sizes), displayProfiles: memory.displayProfiles };
  state = apply(state, snapshot(macbook, [macbook]));
  assert.equal(state.historyFontSize, 17);
  assert.equal(state.tabSidebarWidth, 155);
  assert.equal(state.sidebarWidth, 460);
  assert.equal(state.notesTooltipFontSize, 20);
  assert.ok(state.displayProfiles[odyssey.key]);
});

test('later new monitors inherit the current sizes once; resolution and labels only update metadata', () => {
  let state = apply(initial(), snapshot(odyssey, [odyssey]));
  state = edit(state, odyssey.key, { historyFontSize: 18 });
  state = apply(state, snapshot(macbook));
  assert.equal(state.historyFontSize, 18);
  state = edit(state, macbook.key, { historyFontSize: 15 });
  const smaller = { ...macbook, label: 'Built-in Retina', width: 1280, height: 800, scaleFactor: 1.5 };
  state = apply(state, snapshot(smaller, [odyssey, smaller]));
  assert.equal(Object.keys(state.displayProfiles).length, 2);
  assert.equal(state.historyFontSize, 15);
  assert.equal(state.displayProfiles[macbook.key].display.width, 1280);
  assert.deepEqual(applyDisplayContext(state, snapshot(smaller, [odyssey, smaller])), {});
});

test('partial profile edits stay bounded, preserve siblings and ignore invalid fields', () => {
  let state = apply(initial(), snapshot(odyssey));
  state = edit(state, null, { terminalFontSize: 999, sidebarWidth: -20, historyFontSize: NaN, historyLetterSpacing: 2 });
  assert.equal(state.terminalFontSize, 24);
  assert.equal(state.sidebarWidth, 180);
  assert.equal(state.displayProfiles[odyssey.key].sizes.terminalFontSize, 24);
  assert.equal(state.historyFontSize, 13);
  assert.equal(state.displayProfiles[macbook.key].sizes.terminalFontSize, 13);
  assert.equal('historyLetterSpacing' in state, false);
  assert.deepEqual(updateDisplayProfileSizes(state, 'missing', { historyFontSize: 10 }), {});
  assert.deepEqual(readDisplayProfileMemory('{broken', { historyFontSize: 19 }).sizes, pickDisplaySizes({ historyFontSize: 19 }));
});

test('surface font adjustments share Settings fields and leave navigation sizes intact in the workspace', () => {
  const state = initial();
  const history = surfaceFontSizePatch(state, 'history', 1);
  assert.deepEqual(Object.keys(history).sort(), ['historyFontSize', 'historyComposerFontSize', 'aiSecondaryFontSize', 'timelineFontSize', 'timelineSummaryFontSize'].sort());
  assert.equal(history.historyComposerFontSize, 13);
  assert.equal(history.tabsFontSize, undefined);
  assert.equal(history.terminalFontSize, undefined);
  assert.deepEqual(surfaceFontSizePatch(state, 'terminal', -1), { terminalFontSize: 12 });
  assert.deepEqual(surfaceFontSizePatch(state, 'history', 0), {});
});

test('Electron display identity survives resolution/scale changes and distinguishes identical labels', () => {
  const native = { id: 42, label: 'Odyssey', internal: false, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
  assert.equal(displayContext(native).key, displayContext({ ...native, bounds: { width: 1920, height: 1080 }, scaleFactor: 2 }).key);
  assert.notEqual(displayContext(native).key, displayContext({ ...native, id: 43 }).key);
  assert.equal(displayContext({ ...native, id: -1 }), null);
});

test('main service chooses by BrowserWindow bounds, reacts without polling and cleans all listeners', () => {
  const native = (display, x) => ({ ...display, id: Number(display.key.split(':')[1]), bounds: { x, y: 0, width: display.width, height: display.height } });
  const external = native(odyssey, 0), internal = native(macbook, 2560);
  const screen = new EventEmitter();
  let displays = [external, internal];
  screen.getAllDisplays = () => displays;
  screen.getDisplayMatching = (bounds) => bounds.x >= 2560 ? internal : external;
  screen.getPrimaryDisplay = screen.getCursorScreenPoint = () => assert.fail('primary/cursor is not the window monitor');
  const window = new EventEmitter(), contents = new EventEmitter();
  let bounds = { x: 2650, y: 20, width: 1000, height: 700 };
  window.getBounds = () => bounds;
  window.isDestroyed = contents.isDestroyed = () => false;
  window.webContents = contents;
  const messages = [];
  const menuShortcutIgnores = [];
  contents.setIgnoreMenuShortcuts = (ignore) => menuShortcutIgnores.push(ignore);
  contents.send = (channel, context) => messages.push({ channel, context });
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => {
    assert.equal(handlers.has(channel), false);
    handlers.set(channel, handler);
  }, removeHandler: (channel) => handlers.delete(channel) };
  const dispose = attachDisplayProfiles(window, { screen, ipcMain });
  const nativeKeyEvent = { preventDefault: () => assert.fail('native guard must still deliver DOM keydown') };
  contents.emit('before-input-event', nativeKeyEvent, { meta: true, code: 'Equal' });
  contents.emit('before-input-event', nativeKeyEvent, { meta: true, code: 'KeyC' });
  contents.emit('before-input-event', nativeKeyEvent, { meta: true, code: 'Minus' });
  assert.deepEqual(menuShortcutIgnores, [true, false, true]);
  assert.equal(handlers.get(DISPLAY_CONTEXT_CHANNEL)({ sender: contents }).current.key, macbook.key);
  assert.throws(() => handlers.get(DISPLAY_CONTEXT_CHANNEL)({ sender: {} }), /main window/);
  contents.emit('did-finish-load');
  assert.equal(messages.at(-1).context.current.key, macbook.key);
  bounds = { ...bounds, x: 100 };
  window.emit('move');
  assert.equal(messages.at(-1).context.current.key, odyssey.key);
  const count = messages.length;
  window.emit('moved'); window.emit('resize');
  assert.equal(messages.length, count, 'unchanged snapshots are not broadcast');
  external.scaleFactor = 2;
  screen.emit('display-metrics-changed', {}, external, ['scaleFactor']);
  assert.equal(messages.at(-1).context.current.scaleFactor, 2);
  displays = [external];
  screen.emit('display-removed', {}, internal);
  assert.equal(messages.at(-1).context.displays.length, 1);
  displays = [external, internal];
  screen.emit('display-added', {}, internal);
  assert.equal(messages.at(-1).context.displays.length, 2);
  window.emit('closed'); dispose();
  assert.equal(handlers.size, 0);
  assert.equal(screen.eventNames().length, 0);
  assert.equal(window.eventNames().length, 0);
  assert.equal(contents.eventNames().length, 0);
  assert.equal(menuShortcutIgnores.at(-1), false);
  attachDisplayProfiles(window, { screen, ipcMain })();
  assert.equal(handlers.size, 0, 'a replacement window can attach the same IPC channel');
});

test('initial IPC response cannot overwrite a newer screen event; cleanup rejects late results', async () => {
  const ipc = new EventEmitter();
  let resolve;
  ipc.invoke = (channel) => {
    assert.equal(channel, DISPLAY_CONTEXT_CHANNEL);
    return new Promise((done) => { resolve = done; });
  };
  const applied = [];
  const dispose = subscribeDisplayContext(ipc, (context) => applied.push(context));
  ipc.emit(DISPLAY_CHANGED_CHANNEL, {}, snapshot(macbook));
  resolve(snapshot(odyssey));
  await Promise.resolve();
  assert.deepEqual(applied.map((context) => context.current.key), [macbook.key]);
  dispose();
  assert.equal(ipc.listenerCount(DISPLAY_CHANGED_CHANNEL), 0);
  const disposeAgain = subscribeDisplayContext(ipc, (context) => applied.push(context));
  disposeAgain(); resolve(snapshot(odyssey));
  await Promise.resolve();
  assert.equal(applied.length, 1);
});

test('Cmd± is captured with composer focus, raw terminal focus and sidebar focus; cleanup removes handlers', async () => {
  const handlers = new Map();
  const target = {
    addEventListener: (event, fn, capture) => { assert.equal(capture, true); handlers.set(event, fn); },
    removeEventListener: (event, fn, capture) => { assert.equal(capture, true); assert.equal(handlers.get(event), fn); handlers.delete(event); },
  };
  const element = (surface) => ({ isConnected: true, closest: (selector) => selector.startsWith('[inert]') ? null : ({ matches: () => surface === 'terminal' }) });
  const composer = element('history'), terminal = element('terminal');
  let context = { view: 'workspace', activeArea: 'workspace', tabId: 'A', fallbackSurface: 'history', blocked: false };
  const calls = [];
  const dispose = installSurfaceFontShortcuts(target, () => context, (...args) => calls.push(args));
  const press = (code, element) => {
    let prevented = false, stopped = false;
    handlers.get('keydown')({ code, metaKey: true, target: element, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
    assert.equal(prevented, true, 'Chromium zoom is prevented');
    assert.equal(stopped, true, 'composer and xterm do not swallow or duplicate the shortcut');
  };
  press('Equal', composer);
  assert.deepEqual(calls.pop(), ['history', 1]);
  handlers.get('focusin')({ type: 'focusin', target: terminal });
  press('Minus', terminal);
  assert.deepEqual(calls.pop(), ['terminal', -1]);
  handlers.get('pointerdown')({ type: 'pointerdown', target: composer });
  await Promise.resolve();
  press('NumpadAdd', terminal);
  assert.deepEqual(calls.pop(), ['history', 1], 'clicking transcript text works even if the old textarea keeps DOM focus');
  context = { ...context, tabId: 'B' };
  press('NumpadSubtract', terminal);
  assert.deepEqual(calls.pop(), ['terminal', -1], 'a remembered surface does not leak to another pane');
  context.activeArea = 'sidebar';
  press('Equal', composer);
  assert.deepEqual(calls.pop(), ['navigation', 1]);
  context.blocked = true;
  press('Equal', composer);
  assert.equal(calls.length, 0, 'Settings number input does not resize the background surface');
  assert.equal(fontSizeShortcutDelta({ code: 'Equal', metaKey: true, shiftKey: true }), 1);
  assert.equal(fontSizeShortcutDelta({ code: 'Equal', metaKey: true, altKey: true }), 0);
  dispose(); assert.equal(handlers.size, 0);
});

// Exercise the REAL store, bundled in memory only. No Electron/native modules,
// application launch, persistent user storage, or generated build artifacts.
const storeBundle = require('esbuild').build({
  stdin: {
    contents: `export { useUIStore } from './store/useUIStore';
      export { registerHistoryResizeSurface } from './utils/historyResizeAnchor.mjs';
      export { commitDisplayProfileChange } from './utils/displayProfileCommit.mjs';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], logLevel: 'silent',
}).then((result) => result.outputFiles[0].text);

async function loadStore(storage = new Map(), document) {
  const module = { exports: {} };
  const writes = [];
  vm.runInNewContext(await storeBundle, {
    module, exports: module.exports, require, console, document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); writes.push(key); },
      removeItem: (key) => storage.delete(key),
    },
  });
  return { ...module.exports, store: module.exports.useUIStore, writes, storage };
}

test('real UIStore migrates every legacy size and commits each existing setter atomically', async () => {
  const storage = new Map([
    ['noted-terminal-font-settings', JSON.stringify({ terminalFontSize: 17, mainTabsFontSize: 18, projectTabsFontSize: 15, sidebarFontSize: 19 })],
    ['tabSidebarWidth', '330'], ['sidebarWidth', '390'],
    ['noted-terminal-history-font-size', '20'], ['noted-terminal-notes-editor-font-size', '21'],
  ]);
  const { store, writes } = await loadStore(storage);
  const init = store.getState();
  assert.equal(init.tabsFontSize, 18);
  assert.equal(init.notesTooltipFontSize, 21);
  init.setDisplayContext(snapshot(odyssey));
  assert.equal(store.getState().displayProfiles[odyssey.key].sizes.tabSidebarWidth, 330);
  let notifications = 0;
  const unsubscribe = store.subscribe((state) => {
    notifications += 1;
    for (const field of DISPLAY_SIZE_KEYS) assert.equal(state[field], state.displayProfiles[state.activeDisplayKey].sizes[field], field);
  });
  for (const field of DISPLAY_SIZE_KEYS) {
    const action = `set${field[0].toUpperCase()}${field.slice(1)}`;
    const before = notifications, writeCount = writes.length;
    store.getState()[action](DISPLAY_SIZE_LIMITS[field][0] + 1);
    assert.equal(notifications, before + 1, action);
    assert.deepEqual(writes.slice(writeCount), [DISPLAY_PROFILES_STORAGE_KEY], 'one durable envelope per edit');
  }
  const before = notifications;
  store.getState().setDisplayContext(snapshot(odyssey));
  assert.equal(notifications, before, 'duplicate screen events do not notify store consumers');
  unsubscribe();
  const live = pickDisplaySizes(store.getState());
  store.getState().setDisplayProfileSizes(macbook.key, { historyFontSize: 23, tabSidebarWidth: 165 });
  assert.deepEqual(pickDisplaySizes(store.getState()), live);
  const reloaded = (await loadStore(storage)).store;
  reloaded.getState().setDisplayContext(snapshot(macbook));
  assert.equal(reloaded.getState().historyFontSize, 23);
  assert.equal(reloaded.getState().tabSidebarWidth, 165);
  assert.equal(reloaded.getState().displayProfiles[odyssey.key].sizes.historyFontSize, live.historyFontSize);
});

test('real UIStore keeps History spacing global and wrap defaults on only when absent', async () => {
  const { store, storage } = await loadStore();
  assert.equal(store.getState().paneTabStripWrap, true);
  assert.equal(store.getState().historyHorizontalPadding, 4);
  assert.equal(store.getState().historyLetterSpacing, 0);
  store.getState().setDisplayContext(snapshot(odyssey));
  store.getState().setHistoryHorizontalPadding(0);
  store.getState().setHistoryLetterSpacing(0.3);
  store.getState().setPaneTabStripWrap(false);
  store.getState().adjustSurfaceFontSizes('history', 1);
  assert.equal(store.getState().historyFontSize, 14);
  assert.equal(store.getState().historyComposerFontSize, 13);
  assert.equal(store.getState().tabsFontSize, 14);
  assert.equal(store.getState().terminalFontSize, 13);
  store.getState().setDisplayContext(snapshot(macbook));
  assert.equal(store.getState().historyFontSize, 13);
  assert.equal(store.getState().historyHorizontalPadding, 0);
  assert.equal(store.getState().historyLetterSpacing, 0.3);
  assert.equal('historyHorizontalPadding' in store.getState().displayProfiles[macbook.key].sizes, false);
  const reloaded = (await loadStore(storage)).store.getState();
  assert.equal(reloaded.paneTabStripWrap, false);
  assert.equal(reloaded.historyHorizontalPadding, 0);
  assert.equal(reloaded.historyLetterSpacing, 0.3);
});

test('monitor/UI/workspace writes share one History capture and finish after the DOM commit', async () => {
  const scope = { contains: () => true };
  const { store, registerHistoryResizeSurface, commitDisplayProfileChange } = await loadStore(new Map(), { body: scope });
  store.getState().setDisplayContext(snapshot(odyssey));
  const events = [];
  let workspaceDisplay = odyssey;
  const remove = [0, 1].map((id) => registerHistoryResizeSurface({ isConnected: true }, (reason) => {
    events.push(`capture:${id}:${reason}`);
    assert.equal(store.getState().activeDisplayKey, odyssey.key);
    assert.equal(workspaceDisplay.key, odyssey.key);
    return {
      activate: () => events.push(`activate:${id}`),
      finish: (changed) => {
        assert.equal(changed, true);
        assert.equal(store.getState().activeDisplayKey, macbook.key);
        assert.equal(workspaceDisplay.key, macbook.key);
        events.push(`finish:${id}`);
      },
    };
  }));
  try {
    commitDisplayProfileChange(() => {
      store.getState().setDisplayContext(snapshot(macbook));
      events.push('ui');
      workspaceDisplay = macbook;
      events.push('workspace');
    }, 'window-display-change', { commit: (update) => { update(); events.push('dom-commit'); } });
    assert.deepEqual(events, ['capture:0:window-display-change', 'capture:1:window-display-change',
      'activate:0', 'activate:1', 'ui', 'workspace', 'dom-commit', 'finish:0', 'finish:1']);
  } finally { remove.forEach((fn) => fn()); }
});

test('direct History font/padding/spacing setters and Cmd± use the existing anchor owner; inactive edits do not', async () => {
  const { store, registerHistoryResizeSurface } = await loadStore(new Map(), { body: { contains: () => true } });
  store.getState().setDisplayContext(snapshot(odyssey));
  let captures = 0, finishes = 0;
  const remove = registerHistoryResizeSurface({ isConnected: true }, () => {
    captures++;
    const before = { font: store.getState().historyFontSize, padding: store.getState().historyHorizontalPadding, spacing: store.getState().historyLetterSpacing };
    return {
      activate: () => {},
      finish: (changed) => {
        finishes++;
        assert.equal(changed, true);
        assert.notDeepEqual({ font: store.getState().historyFontSize, padding: store.getState().historyHorizontalPadding, spacing: store.getState().historyLetterSpacing }, before);
      },
    };
  });
  try {
    store.getState().setHistoryFontSize(18);
    store.getState().setHistoryHorizontalPadding(12);
    store.getState().setHistoryLetterSpacing(0.5);
    store.getState().adjustSurfaceFontSizes('history', 1);
    assert.equal(captures, 4);
    assert.equal(finishes, 4);
    store.getState().setDisplayProfileSizes(macbook.key, { historyFontSize: 20 });
    store.getState().setHistoryFontSize(19); // no change
    assert.equal(captures, 4);
  } finally { remove(); }
});
