const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

test('settings and exclusions persist across reload; waiting jobs are not durable rules', async () => {
  const source = (await esbuild.build({ entryPoints: [path.join(__dirname, 'useAutoCompactStore.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], logLevel: 'silent',
  })).outputFiles[0].text;
  let saved = null; const writes = [];
  const ipc = {
    invoke: async (channel, payload) => {
      if (channel === 'app:getState') return saved;
      assert.equal(channel, 'app:setState'); assert.equal(payload.key, 'globalAutoCompact');
      saved = payload.value; writes.push(saved); return { success: true };
    },
    sendSync: (channel, payload) => { assert.equal(channel, 'app:setStateSync'); saved = payload.value; },
  };
  const load = () => {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require, console,
      window: { require: () => ({ ipcRenderer: ipc }) },
    });
    return module.exports;
  };
  const first = load();
  first.useAutoCompactStore.getState().updatePolicy({ enabled: true });
  assert.equal(writes.length, 0, 'loading state must not be overwritten');
  await first.hydrateAutoCompactStore();
  const store = first.useAutoCompactStore.getState();
  store.updatePolicy({ enabled: true, workflowIds: ['main'], percent: 63, scopeInitialized: true });
  store.setExcluded('tab-A', true); store.updatePolicy({ enabled: false }); store.updatePolicy({ enabled: true });
  store.setActivity('tab-A', { phase: 'waiting', message: 'waiting' });
  first.flushAutoCompactStoreSync();
  await new Promise((resolve) => setImmediate(resolve));
  const second = load(); await second.hydrateAutoCompactStore();
  const restored = second.useAutoCompactStore.getState();
  assert.equal(restored.policy.enabled, true); assert.equal(restored.policy.percent, 63);
  assert.equal(restored.policy.excludedTabIds.includes('tab-A'), true);
  assert.equal(restored.policy.workflowIds.join(','), 'main');
  assert.equal(Object.keys(restored.activities).length, 0);
});
