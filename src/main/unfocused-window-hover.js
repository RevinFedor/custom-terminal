'use strict';

let nativePointer = null;
let nativeAttempted = false;

// Chromium does not forward macOS mouse movement to a non-key window. Read
// only current state, without a global input tap or a focus-changing helper.
function readMacPointerState() {
  if (!nativeAttempted) {
    nativeAttempted = true;
    try {
      const cg = require('koffi').load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      nativePointer = {
        flags: cg.func('uint64 CGEventSourceFlagsState(int stateID)'),
        button: cg.func('bool CGEventSourceButtonState(int stateID, uint32 button)'),
      };
    } catch (error) {
      console.warn('[Window:Hover] native pointer state unavailable: ' + error.message);
    }
  }
  if (!nativePointer) return null;
  try {
    const flags = Number(nativePointer.flags(0)); // combined session state
    const modifiers = [];
    for (const [mask, name] of [[0x20000, 'shift'], [0x40000, 'control'], [0x80000, 'alt'], [0x100000, 'meta']]) {
      if (flags & mask) modifiers.push(name);
    }
    return {
      modifiers,
      buttonsDown: [0, 1, 2].some(button => nativePointer.button(0, button)),
    };
  } catch {
    return null;
  }
}

function attachUnfocusedWindowHover(win, {
  screen,
  platform = process.platform,
  readPointerState = readMacPointerState,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = message => console.log(message),
} = {}) {
  if (platform !== 'darwin') return () => {};
  const contents = win.webContents;
  let timer = null;
  let lastPoint = null;
  let lastKey = null;
  let moves = 0;
  let disposed = false;
  const canSend = () => !win.isDestroyed() && !contents.isDestroyed();
  const eligible = () => canSend() && win.isVisible() && !win.isMinimized() && !win.isFocused();

  const leave = () => {
    if (lastPoint && canSend()) {
      try { contents.sendInputEvent({ ...lastPoint, type: 'mouseLeave' }); } catch {}
    }
    lastPoint = null;
    lastKey = null;
  };
  const stop = (reason, clearHover) => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
      log('[Window:Hover] tracking=off reason=' + reason + ' moves=' + moves);
    }
    if (clearHover) leave();
    // Focus hands the current hover back to native input; a synthetic leave
    // here would erase feedback just before the first real click arrives.
    lastPoint = null;
    lastKey = null;
  };
  const sample = () => {
    if (!eligible()) { stop('not-visible-or-focused', false); return; }
    const pointer = readPointerState();
    // Never manufacture buttons=0 movement over a real held-button gesture.
    // In particular, it would cancel the sidebar's drag/selection owner.
    if (!pointer || pointer.buttonsDown) { lastKey = null; return; }
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    if (cursor.x < bounds.x || cursor.x >= bounds.x + bounds.width
      || cursor.y < bounds.y || cursor.y >= bounds.y + bounds.height) {
      leave();
      return;
    }
    const point = {
      x: Math.floor(cursor.x - bounds.x),
      y: Math.floor(cursor.y - bounds.y),
      modifiers: pointer.modifiers,
    };
    const key = [point.x, point.y, ...point.modifiers].join(':');
    if (key === lastKey) return;
    try {
      contents.sendInputEvent({ type: 'mouseMove', ...point });
      lastPoint = point;
      lastKey = key;
      moves += 1;
    } catch {
      lastKey = null;
    }
  };
  const start = () => {
    if (disposed || timer !== null || !eligible()) return;
    moves = 0;
    // This samples an otherwise unavailable pointer, not async readiness.
    // Idle positions are deduplicated; focused/hidden windows do no polling.
    timer = setIntervalFn(sample, 32);
    timer.unref?.();
    log('[Window:Hover] tracking=on');
    sample();
  };
  const onFocus = () => stop('focus', false);
  const onHide = () => stop('hidden', true);
  const onReload = () => { lastKey = null; };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop('closed', false);
    for (const event of ['blur', 'show', 'restore']) win.removeListener(event, start);
    win.removeListener('focus', onFocus);
    win.removeListener('hide', onHide);
    win.removeListener('minimize', onHide);
    win.removeListener('closed', dispose);
    contents.removeListener('did-finish-load', onReload);
  };
  for (const event of ['blur', 'show', 'restore']) win.on(event, start);
  win.on('focus', onFocus);
  win.on('hide', onHide);
  win.on('minimize', onHide);
  win.on('closed', dispose);
  contents.on('did-finish-load', onReload);
  start();
  return dispose;
}

module.exports = { attachUnfocusedWindowHover };
