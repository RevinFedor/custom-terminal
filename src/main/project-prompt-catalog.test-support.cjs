'use strict';
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const observed = new WeakMap();

// Tests wait only on real service publications/errors, never readiness polling.
function observe(service) {
  let emitter = observed.get(service);
  if (!emitter) {
    emitter = new EventEmitter(); emitter.setMaxListeners(50); observed.set(service, emitter);
    const original = service.onChanged;
    service.onChanged = payload => { original?.(payload); emitter.emit('change', payload); };
  }
  return emitter;
}
async function ready(service, run) {
  const emitter = observe(service);
  for (;;) {
    let changed;
    const signal = new Promise(resolve => { changed = payload => { if (['ready', 'failed'].includes(payload.state)) resolve(payload); }; });
    emitter.on('change', changed);
    try { return await run(); }
    catch (error) {
      if (error.code !== 'prompt_catalog_preparing') throw error;
      // Mock watchers do not retain the real Electron event loop. Retain ONLY
      // the already-owned coalescer while this controlled test awaits its event.
      for (const slot of service.prepared.slots.values()) slot.timer?.ref?.();
      await signal;
    }
    finally { emitter.off('change', changed); }
  }
}
const tab = (service, id) => ready(service, () => service.listTab(id));
const project = (service, id) => ready(service, () => service.listProject(id));
const usage = (service, root) => ready(service, () => service.usageForRoot(root));
function controlledFence(connection, read = () => 'stable') {
  return () => ({ connection, schema: 1, external: read(), changes: 0, committed: 0, transaction: false });
}
// Explicit adapter of a sync fake, declared at the test site. It is not used by
// product code and is not evidence for actual async FS behavior.
function asyncFake(sync) {
  const stat = value => ({ ...sync.statSync(value), dev: 1, ino: 1, mtimeMs: 0, ctimeMs: 0,
    isFile: () => !sync.statSync(value).isDirectory(), isSymbolicLink: () => false });
  return { stat: async value => stat(value), lstat: async value => stat(value),
    realpath: async value => sync.realpathSync(value),
    opendir: async value => { const rows = sync.readdirSync(value, { withFileTypes: true }); let index = 0;
      return { read: async () => rows[index++] || null, close: async () => {} }; } };
}
module.exports = { ready, tab, project, usage, observe, controlledFence, asyncFake, realAsync: fs.promises };
