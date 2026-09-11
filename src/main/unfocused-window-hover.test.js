'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachUnfocusedWindowHover } = require('./unfocused-window-hover');

function fixture(platform = 'darwin') {
  const events = [];
  const contents = new EventEmitter();
  const win = new EventEmitter();
  const state = { focused: true, visible: true, minimized: false, destroyed: false,
    cursor: { x: 150, y: 100 }, bounds: { x: 100, y: 50, width: 500, height: 400 },
    pointer: { modifiers: [], buttonsDown: false } };
  Object.assign(contents, { isDestroyed: () => state.destroyed, sendInputEvent: event => events.push(event) });
  Object.assign(win, { webContents: contents, isDestroyed: () => state.destroyed,
    isFocused: () => state.focused, isVisible: () => state.visible,
    isMinimized: () => state.minimized, getContentBounds: () => state.bounds });
  const timers = new Map();
  let nextTimer = 0;
  const dispose = attachUnfocusedWindowHover(win, {
    platform, screen: { getCursorScreenPoint: () => state.cursor },
    readPointerState: () => state.pointer,
    setIntervalFn: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearIntervalFn: id => timers.delete(id), log: () => {},
  });
  return { win, state, events, timers, dispose,
    tick: () => { for (const fn of timers.values()) fn(); },
    blur: () => { state.focused = false; win.emit('blur'); },
    focus: () => { state.focused = true; win.emit('focus'); } };
}

test('inactive hover delivers only movement; unchanged position is idle', () => {
  const f = fixture();
  assert.equal(f.timers.size, 0);
  f.blur();
  assert.deepEqual(f.events, [{ type: 'mouseMove', x: 50, y: 50, modifiers: [] }]);
  f.tick(); f.tick();
  assert.equal(f.events.length, 1);
  f.state.cursor.x += 20;
  f.tick();
  assert.equal(f.events[1].x, 70);
  f.dispose();
});

test('Cmd+Tab-style focus with a stationary pointer never fabricates a click or leave', () => {
  const f = fixture();
  f.blur();
  f.state.pointer.modifiers = ['meta'];
  f.tick();
  assert.deepEqual(f.events.at(-1).modifiers, ['meta']);
  const count = f.events.length;
  f.focus(); f.tick();
  assert.equal(f.events.length, count);
  assert.equal(f.timers.size, 0);
  assert.ok(f.events.every(e => e.type === 'mouseMove'));
  f.dispose();
});

test('held mouse buttons and unavailable native state do not inject buttons-zero movement', () => {
  const f = fixture();
  f.state.pointer.buttonsDown = true;
  f.blur(); f.tick();
  assert.equal(f.events.length, 0);
  f.state.pointer = null;
  f.tick();
  assert.equal(f.events.length, 0);
  f.state.pointer = { modifiers: ['shift'], buttonsDown: false };
  f.tick();
  assert.deepEqual(f.events[0].modifiers, ['shift']);
  f.dispose();
});

test('leaving bounds clears hover once; returning and window movement refresh it', () => {
  const f = fixture();
  f.blur();
  f.state.cursor.x = 600; // right edge is outside
  f.tick(); f.tick();
  assert.deepEqual(f.events.map(e => e.type), ['mouseMove', 'mouseLeave']);
  f.state.cursor.x = 150;
  f.tick();
  f.state.bounds.x = 110;
  f.tick();
  assert.equal(f.events.at(-1).x, 40);
  f.dispose();
});

test('hide/minimize suspend tracking; restore, reload and repeated disposal are bounded', () => {
  const f = fixture();
  f.blur(); f.blur();
  assert.equal(f.timers.size, 1);
  f.state.visible = false; f.win.emit('hide');
  assert.equal(f.timers.size, 0);
  assert.equal(f.events.at(-1).type, 'mouseLeave');
  f.state.visible = true; f.win.emit('show');
  assert.equal(f.timers.size, 1);
  const count = f.events.length;
  f.win.webContents.emit('did-finish-load'); f.tick();
  assert.equal(f.events.length, count + 1);
  f.state.minimized = true; f.win.emit('minimize');
  assert.equal(f.timers.size, 0);
  f.win.emit('blur'); assert.equal(f.timers.size, 0);
  f.state.minimized = false; f.win.emit('restore');
  assert.equal(f.timers.size, 1);
  f.state.destroyed = true; f.win.emit('closed'); f.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.win.listenerCount('blur'), 0);
  assert.equal(f.win.webContents.listenerCount('did-finish-load'), 0);
});

test('other platforms retain their native event delivery', () => {
  const f = fixture('linux');
  f.blur(); f.tick(); f.dispose();
  assert.equal(f.events.length, 0);
  assert.equal(f.timers.size, 0);
});
