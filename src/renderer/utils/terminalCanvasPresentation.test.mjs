import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveTerminalCanvasVisible,
  resolveTerminalSurfacePresented,
  shouldRepaintTerminalOnActivation,
} from './terminalCanvasPresentation.mjs';

test('pane and single-center surfaces share one actual-presentation contract', () => {
  assert.equal(resolveTerminalSurfacePresented({ inPane: true, shownInPane: true }), true);
  assert.equal(resolveTerminalSurfacePresented({ inPane: true, shownInPane: false }), false);
  assert.equal(resolveTerminalSurfacePresented({ centerPresented: true, terminalPresented: true }), true);
  assert.equal(resolveTerminalSurfacePresented({ centerPresented: true, terminalPresented: false }), false);
  assert.equal(resolveTerminalSurfacePresented({ centerPresented: true, appView: 'home' }), false);
});

test('a ready retained Canvas stays renderer-visible behind the outer opacity boundary', () => {
  assert.equal(resolveTerminalCanvasVisible({
    effectivePresented: false,
    retainCanvasPixels: true,
    ready: true,
  }), true);
  assert.equal(resolveTerminalCanvasVisible({
    effectivePresented: false,
    retainCanvasPixels: true,
    ready: false,
  }), false);
  assert.equal(resolveTerminalCanvasVisible({
    effectivePresented: false,
    retainCanvasPixels: false,
    ready: true,
  }), false);
});

test('warm activation repaints only when retained geometry really changed', () => {
  assert.equal(shouldRepaintTerminalOnActivation({
    retainCanvasPixels: true,
    dimensionsChanged: false,
  }), false);
  assert.equal(shouldRepaintTerminalOnActivation({
    retainCanvasPixels: true,
    dimensionsChanged: true,
  }), true);
  assert.equal(shouldRepaintTerminalOnActivation({
    retainCanvasPixels: false,
    dimensionsChanged: false,
  }), true);
});
