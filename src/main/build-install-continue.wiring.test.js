'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const webSource = fs.readFileSync(path.join(root, 'src/main/web-server.js'), 'utf8');

test('graceful shutdown persists the exact provider snapshot before replacement', () => {
  assert.match(mainSource, /persistShutdownInterruptedAgentSnapshot\(activeAiSessions, 'before-quit'\)/);
  assert.match(mainSource, /persistShutdownInterruptedAgentSnapshot\(activeAiSessions, 'will-quit'\)/);
  assert.match(mainSource, /captureStartupInterruptedAgentSnapshot\(\);/);
  assert.match(mainSource, /startupInterruptedAgentSnapshot,/);
});

test('replacement app exposes the frozen startup target snapshot without renderer ownership', () => {
  assert.match(webSource, /startupInterruptedAgentSnapshot: startupInterruptedSnapshotFn/);
  assert.match(webSource, /parsed\.pathname === '\/api\/build-continue-targets'/);
  assert.match(webSource, /return sendJson\(res, 200, \{ ok: true, snapshot \}\)/);
});
