import test from 'node:test';
import assert from 'node:assert/strict';
import { focusedMcpCwd, externalMcpServers, hubConfigurationNotice, hasHubInventory, mcpRegistrationLabel } from './mcpCatalogPresentation.mjs';

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

const sharedNames = ['browser', 'electron', 'ios', 'knowledge', 'sc-desktop', 'terminal'];
const sharedCatalog = { servers: sharedNames.map(name => ({ name, hubServer: name, enabled: true })) };

test('failed and not-yet-read hub status cannot report all configured routes missing', () => {
  for (const status of [null, undefined, {}, { down: true, servers: [] },
    { down: true, servers: [{ name: 'terminal' }] }, { servers: null }]) {
    assert.equal(hasHubInventory(status), false);
    assert.equal(hubConfigurationNotice(status, sharedCatalog), null);
    const rows = externalMcpServers(sharedCatalog, []);
    assert.equal(rows.length, 6, 'configured registrations stay visible without inventing their health');
    assert.deepEqual(rows.map(server => mcpRegistrationLabel(server, status)), Array(6).fill('статус неизвестен'));
  }
});

test('a successful empty or partial inventory still reports genuinely missing routes', () => {
  for (const servers of [[], [{ name: 'terminal' }]]) {
    const status = { down: false, servers };
    assert.equal(hasHubInventory(status), true);
    assert.match(hubConfigurationNotice(status, sharedCatalog), /отсутствующие в хабе: browser/);
    const rows = externalMcpServers(sharedCatalog, servers);
    assert.equal(rows.length, servers.length ? 5 : 6);
    assert.ok(rows.every(server => mcpRegistrationLabel(server, status) === 'нет в хабе'));
  }
});

test('maintenance errors preserve inventory and disabled/external registration meanings', () => {
  const status = { servers: sharedNames.map(name => ({ name, up: true, initialized: true })),
    browserMaintenance: { held: true, code: 'research_ingress_storage_invalid' } };
  assert.equal(hasHubInventory(status), true);
  assert.equal(hubConfigurationNotice(status, sharedCatalog), null);
  assert.deepEqual(externalMcpServers(sharedCatalog, status.servers), []);
  assert.equal(mcpRegistrationLabel(sharedCatalog.servers[0], status), 'в хабе');
  for (const snapshot of [null, status]) {
    assert.equal(mcpRegistrationLabel({ enabled: false, hubServer: 'browser' }, snapshot), 'отключён');
    assert.equal(mcpRegistrationLabel({ enabled: true, source: 'plugin' }, snapshot), 'настроен');
  }
});
