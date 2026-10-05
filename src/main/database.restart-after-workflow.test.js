const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-restart-all-db-'));
const electronPath = require.resolve('electron');
const previous = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => temp } } };
const DatabaseManager = require('./database');
if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath];
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('ALL workflows survive SQLite save/reopen, legacy selection coexists, clearing removes both', () => {
  let db = new DatabaseManager();
  try {
    const p = db.createEmptyProject('Restart ALL fixture');
    const tab = { tabId: p.id + '-tab-all', name: 'Restart all', cwd: p.path, commandType: 'generic',
      restartAfterTabIds: ['manual'], restartAfterWorkflowIds: ['chosen', '__workflow_unplaced__', 'chosen'],
      restartAfterCommand: './deploy.sh', restartAfterPaused: true };
    db.saveTabs(p.id, [tab]); db.close(); db = new DatabaseManager();
    const restored = db.getProjectById(p.id).tabs[0];
    assert.deepEqual(restored.restartAfterWorkflowIds, ['chosen', '__workflow_unplaced__']);
    assert.deepEqual(restored.restartAfterTabIds, ['manual']); assert.equal(restored.restartAfterPaused, true);
    assert.equal(restored.restartAfterCommand, './deploy.sh');
    db.saveTabs(p.id, [{ tabId: tab.tabId, name: tab.name, cwd: tab.cwd, commandType: 'generic' }]);
    const cleared = db.getProjectById(p.id).tabs[0];
    assert.equal(cleared.restartAfterWorkflowIds, undefined); assert.equal(cleared.restartAfterTabIds, undefined);
    assert.equal(cleared.restartAfterCommand, undefined); assert.equal(cleared.restartAfterPaused, undefined);
  } finally { db.close(); }
});

test('main active-loader subscription gate recognizes ALL even with no explicit tab IDs', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('const hasRestartAfterSubscription =', source.indexOf('function computeActiveLoaders'));
  const end = source.indexOf('\n\n  // tabId', start);
  assert.ok(start > 0 && end > start);
  const gate = vm.runInNewContext(source.slice(start, end) + '\nhasRestartAfterSubscription');
  assert.equal(gate({ restart_after_workflow_ids: '["chosen"]' }), true);
  assert.equal(gate({ restart_after_tab_ids: '["old-tab"]' }), true);
  assert.equal(gate({ restart_after_tab_id: 'legacy' }), true);
  assert.equal(gate({ restart_after_workflow_ids: '[]' }), false);
  assert.equal(gate({ restart_after_workflow_ids: '{broken' }), false);
  assert.match(source.slice(end, source.indexOf('const isAiRuntimeTab', end)), /SELECT [^\n]+restart_after_workflow_ids/);
});
