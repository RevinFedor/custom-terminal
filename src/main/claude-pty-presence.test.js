'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { projectClaudePtyPresence } = require('./claude-pty-presence');

test('startup settings keep Claude starting even after the first prompt glyph', () => {
  assert.deepEqual(projectClaudePtyPresence({
    hasTerm: true,
    hasBridge: true,
    promptReady: true,
    cliActive: true,
    localCommandActive: true,
    startupGatePending: true,
  }), {
    status: 'starting',
    isBusy: false,
    inputReady: false,
  });
});

test('gate completion exposes the same idle composer as active', () => {
  assert.deepEqual(projectClaudePtyPresence({
    hasTerm: true,
    hasBridge: true,
    promptReady: true,
    cliActive: true,
    startupGatePending: false,
  }), {
    status: 'active',
    isBusy: false,
    inputReady: true,
  });
});

test('a real user turn remains busy even while a startup gate is present', () => {
  assert.deepEqual(projectClaudePtyPresence({
    hasTerm: true,
    hasBridge: true,
    promptReady: true,
    cliActive: true,
    turnBusy: true,
    startupGatePending: true,
  }), {
    status: 'busy',
    isBusy: true,
    inputReady: false,
  });
});

test('a Claude process proven after main restart is starting, never inactive', () => {
  assert.deepEqual(projectClaudePtyPresence({
    hasTerm: true,
    processAlive: true,
  }), {
    status: 'starting',
    isBusy: false,
    inputReady: false,
  });
});

test('the same process becomes active only after the composer is proven', () => {
  assert.deepEqual(projectClaudePtyPresence({
    hasTerm: true,
    processAlive: true,
    promptReady: true,
  }), {
    status: 'active',
    isBusy: false,
    inputReady: true,
  });
});

test('unknown process lookup does not authorize Resume', () => {
  assert.deepEqual(projectClaudePtyPresence({
    hasTerm: true,
    processLookupUnknown: true,
  }), {
    status: 'unknown',
    isBusy: false,
    inputReady: false,
  });
});
