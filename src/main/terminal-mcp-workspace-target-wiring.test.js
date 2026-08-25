'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const mcp = fs.readFileSync(path.join(root, 'mcp', 'terminal-server.mjs'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src', 'renderer', 'store', 'useWorkspaceStore.ts'), 'utf8');

test('Terminal MCP exposes one source-owned window target across creation and placement tools', () => {
  assert.match(mcp, /const WINDOW_TARGET_SCHEMA =/);
  assert.match(mcp, /name: 'create_window'[\s\S]*windowTarget: WINDOW_TARGET_SCHEMA/);
  assert.match(mcp, /name: 'open_tabs_in_window'[\s\S]*windowTarget: WINDOW_TARGET_SCHEMA/);
  assert.match(mcp, /name: 'create_tab'[\s\S]*windowTarget: WINDOW_TARGET_SCHEMA/);
  assert.match(mcp, /name: 'delegate_to_session'[\s\S]*windowTarget: WINDOW_TARGET_SCHEMA/);
  assert.match(mcp, /name: 'fork_tab'[\s\S]*windowTarget: WINDOW_TARGET_SCHEMA/);
});

test('new tabs use acknowledged Project API creation instead of fire-and-forget terminal create', () => {
  const start = mcp.indexOf("case 'create_tab':");
  const end = mcp.indexOf("case 'kill_process':", start);
  const block = mcp.slice(start, end);
  assert.match(block, /'\/api\/agent-tabs'/);
  assert.match(block, /'\/api\/terminal-tabs'/);
  assert.doesNotMatch(block, /'\/terminal\/create'/);
  assert.match(web, /parsed\.pathname === '\/api\/terminal-tabs'/);
  assert.match(web, /parsed\.pathname === '\/api\/agent-tabs'/);
});

test('renderer resolves and commits active or dormant workflow placement before agent launch', () => {
  assert.match(app, /const resolveBridgeCreationTarget = async/);
  assert.match(app, /const placeCreatedTab = async/);
  assert.match(app, /action === 'resolveWorkspaceCreationTarget'/);
  assert.match(app, /action === 'commitWorkspaceWindowAction'/);
  const createStart = app.indexOf("if (action === 'createAgentTab')");
  const createEnd = app.indexOf("if (action === 'setExternalRunMeta')", createStart);
  const create = app.slice(createStart, createEnd);
  assert.ok(create.indexOf('await placeCreatedTab') < create.indexOf('startFreshCodexSession'));
  assert.ok(create.indexOf('await placeCreatedTab') < create.indexOf("ipcRenderer.invoke('claude:run-command'"));
  assert.match(store, /commitWorkspaceWindowAction: \(request\) =>/);
  assert.match(store, /spacesWithLiveLayout\(st\.spaces, st\.activeSpaceId, st\)/);
  assert.match(store, /dropTabsFromWorkspaceLayout/);
  assert.match(store, /const targetIsVisible = target\.spaceId === get\(\)\.activeSpaceId/);
  assert.match(store, /shown && targetIsVisible/);
});

test('current context and list windows expose source placement instead of only UI focus', () => {
  assert.match(mcp, /\/api\/workspace\?sourceTabId=/);
  assert.match(app, /sourceContext:[\s\S]*preferredPlacement/);
  assert.match(web, /bridgeRequest\('describeWorkspaceLayout',[\s\S]*sourceTabId/);
});

test('orchestration persists cwd and window target before reserved target materialization', () => {
  assert.match(web, /targetWindowTarget: windowTarget/);
  assert.match(web, /windowTarget: run\.targetWindowTarget \|\| undefined/);
  assert.match(web, /cwd: run\.targetCwd \|\| undefined/);
  assert.match(web, /bridgeRequest\('resolveWorkspaceCreationTarget'/);
});
