import test from 'node:test';
import assert from 'node:assert/strict';
import { focusedMcpCwd, externalMcpServers, hubConfigurationNotice } from './mcpCatalogPresentation.mjs';

test('catalog follows the shown cwd, including Inbox, and falls back to project root for Home/chooser', () => {
  const inbox = { activeTabId: 'a', currentView: 'terminal', projectPath: '/home', tabs: new Map([
    ['a', { id: 'a', cwd: '/worktree' }], ['child', { id: 'child', parentTabId: 'a', cwd: '/child' }],
  ]) };
  const state = { activeProjectId: 'inbox', focusedProjectId: 'inbox', splitPanes: [], splitFocusedIndex: 0,
    openProjects: new Map([['inbox', inbox]]) };
  assert.equal(focusedMcpCwd(state), '/worktree');
  inbox.viewingSubAgentTabId = 'child'; assert.equal(focusedMcpCwd(state), '/child');
  inbox.currentView = 'home'; assert.equal(focusedMcpCwd(state), '/home');
  state.splitPanes = [{ projectId: 'inbox', tabId: 'a' }]; assert.equal(focusedMcpCwd(state), '/worktree');
  state.splitPanes[0].selectedSlotId = 'chooser'; assert.equal(focusedMcpCwd(state), '/home');
  state.splitPanes[0].projectId = ''; assert.equal(focusedMcpCwd(state), null);
});

test('only hub-owned routes are merged; disabled and plugin registrations remain visible', () => {
  const external = externalMcpServers({ servers: [
    { name: 'alias', hubServer: 'terminal' }, { name: 'terminal', hubServer: null },
    { name: 'plugin-server', source: 'plugin' }, { name: 'disabled', enabled: false },
  ] });
  assert.deepEqual(external.map(s => s.name), ['terminal', 'plugin-server', 'disabled']);
});

test('missing hub routes and disabled native registrations remain visible', () => {
  const catalog = { servers: [
    { name: 'browser-alias', enabled: true, hubServer: 'browser' },
    { name: 'terminal-alias', enabled: true, hubServer: 'terminal' },
    { name: 'disabled-alias', enabled: false, hubServer: 'terminal' },
  ] };
  assert.deepEqual(externalMcpServers(catalog, [{ name: 'terminal' }]).map(row => row.name),
    ['browser-alias', 'disabled-alias']);
  assert.match(hubConfigurationNotice({ servers: [{ name: 'terminal' }] }, catalog), /browser/);
});

test('healthy active children cannot hide unresolved or unapplied configuration', () => {
  const status = { servers: [{ name: 'terminal', up: true, initialized: true }], configurationApplied: false,
    desiredConfiguration: { error: null, needsReview: true, entries: [{ name: 'browser', state: 'unconfigured' }] } };
  assert.match(hubConfigurationNotice(status), /browser/);
  assert.match(hubConfigurationNotice(status), /не подтверждено/);
  status.desiredConfiguration = { error: null, needsReview: false, entries: [{ name: 'browser', state: 'disabled' }] };
  status.configurationApplied = true;
  assert.equal(hubConfigurationNotice(status), null);
  status.desiredConfiguration.error = 'profile_invalid';
  assert.match(hubConfigurationNotice(status), /profile_invalid/);
});
