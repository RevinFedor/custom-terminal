const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-provider-state-db-'));
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: () => tempRoot,
    },
  },
};
const DatabaseManager = require('./database');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];

test('stale full tab saves cannot erase or resurrect main-owned startup settings', (t) => {
  let manager;
  try {
    manager = new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }

  t.after(() => {
    manager.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const project = manager.createEmptyProject('Provider state persistence test');
  const tabId = 'claude-provider-state-tab';
  const staleTab = {
    tabId,
    name: 'Claude',
    cwd: tempRoot,
    commandType: 'claude',
    providerState: { type: 'anthropic' },
  };
  manager.saveTabs(project.id, [staleTab], true);

  const pending = {
    type: 'anthropic',
    startupModel: 'haiku',
    startupEffort: 'medium',
  };
  manager.updateTabProviderState(tabId, pending);
  manager.saveTabs(project.id, [{ ...staleTab, name: 'Started with stale renderer state' }]);

  let restored = manager.getProjectById(project.id).tabs.find((tab) => tab.tabId === tabId);
  assert.deepEqual(restored.providerState, pending,
    'Start-triggered full save must preserve the just-selected next-launch pair');

  manager.updateTabProviderState(tabId, { type: 'anthropic' });
  manager.saveTabs(project.id, [{
    ...staleTab,
    name: 'Ready with stale pending state',
    providerState: pending,
  }]);

  restored = manager.getProjectById(project.id).tabs.find((tab) => tab.tabId === tabId);
  assert.deepEqual(restored.providerState, { type: 'anthropic' },
    'a stale renderer save must not resurrect an intent consumed after proven startup');

  const fastIntent = {
    type: 'anthropic',
    codexFastIntent: false,
    codexFastIntentRevision: 2,
  };
  manager.updateTabProviderState(tabId, fastIntent);
  manager.saveTabs(project.id, [{ ...staleTab, name: 'Fast off with stale renderer state' }]);
  restored = manager.getProjectById(project.id).tabs.find((tab) => tab.tabId === tabId);
  assert.deepEqual(restored.providerState, fastIntent,
    'a false Fast intent must remain durable across a stale full-tab save');

  const settingsIntent = {
    type: 'anthropic',
    codexSettingsIntentModel: 'gpt-5.6-sol',
    codexSettingsIntentEffort: 'max',
    codexSettingsIntentRevision: 4,
    codexSettingsIntentAppliedRevision: 4,
    codexSettingsIntentAppliedOwnerId: 'writer-a',
  };
  manager.updateTabProviderState(tabId, settingsIntent);
  manager.saveTabs(project.id, [{ ...staleTab, name: 'Settings intent with stale renderer state' }]);
  restored = manager.getProjectById(project.id).tabs.find((tab) => tab.tabId === tabId);
  assert.deepEqual(restored.providerState, settingsIntent,
    'revisioned Codex model/effort intent must survive stale full-tab saves');
});
