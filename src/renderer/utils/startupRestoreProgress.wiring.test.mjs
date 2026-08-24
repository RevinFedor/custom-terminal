import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const here = path.dirname(new URL(import.meta.url).pathname);
const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');
const store = fs.readFileSync(path.join(here, '..', 'store', 'useWorkspaceStore.ts'), 'utf8');

test('startup screen spans state read, terminal restore, layout and auto-resume', () => {
  const restore = store.slice(store.indexOf('restoreSession: async () =>'));
  assert.ok(restore.indexOf('set({ isRestoring: true })') < restore.indexOf("ipcRenderer.invoke('app:getState', SESSION_KEY)"));
  assert.match(restore, /phase: 'projects'/);
  assert.match(restore, /phase: 'tabs'/);
  assert.match(restore, /phase: 'layout'/);
  assert.match(restore, /phase: 'agents'/);
  assert.match(app, /subscribeStartupRestoreProgress/);
  assert.match(app, /completeStartupRestore\(\{ failed: failedCount \}\)/);
  assert.match(app, /startupNeedsTerminalLayer/);
  assert.match(app, /data-startup-restore-modal/);
  assert.match(app, /isRestoring \|\| \(startupRestoreProgress\.blocking && !startupNeedsTerminalLayer\)/);
});
