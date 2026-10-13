const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-task-plan-db-'));
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: (name) => name === 'userData' ? tempRoot : tempRoot,
    },
  },
};
const DatabaseManager = require('./database');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];

test('task plan survives saveTabs, stale renderer payloads, and archive restore data', (t) => {
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

  const project = manager.createEmptyProject('Task plan test');
  const tabId = 'task-plan-test-tab';
  const baseTab = {
    tabId,
    name: 'План',
    cwd: tempRoot,
    tabType: 'terminal',
  };

  manager.saveTabs(project.id, [baseTab], true);
  const applied = manager.applyTabTaskPlanOperations(tabId, [
    { type: 'add_task', id: 'root', title: 'Унифицировать настройки приложений', shortTitle: 'Настройки', body: '  Полный текст\r\n\t**Markdown**\n\n' },
    { type: 'add_subtask', taskId: 'root', id: 'mode', title: 'Добавить выбор Chat / Work' },
    { type: 'archive_task', taskId: 'root' },
  ], 'terminal-mcp');
  assert.equal(applied.document.revision, 1);

  manager.saveTabs(project.id, [{ ...baseTab, name: 'Переименованный таб', taskPlan: { version: 1, revision: 0, items: [], history: { past: [], future: [] } } }]);
  const afterStaleSave = manager.getTabTaskPlan(tabId);
  assert.equal(afterStaleSave.revision, 1);
  assert.equal(afterStaleSave.items.length, 0);
  assert.equal(afterStaleSave.archivedItems[0].subtasks[0].id, 'mode');
  assert.equal(afterStaleSave.archivedItems[0].shortTitle, 'Настройки');
  assert.equal(afterStaleSave.archivedItems[0].body, '  Полный текст\r\n\t**Markdown**\n\n');

  const restoredProject = manager.getProjectById(project.id);
  assert.equal(restoredProject.tabs[0].taskPlan.archivedItems[0].id, 'root');

  const historyId = manager.archiveTab(project.id, { ...baseTab, taskPlan: afterStaleSave });
  assert.ok(historyId);
  const history = manager.getTabHistory(project.id);
  const archivedPlan = JSON.parse(history[0].task_plan);
  assert.equal(archivedPlan.revision, 1);
  assert.equal(archivedPlan.archivedItems[0].title, 'Унифицировать настройки приложений');
  assert.equal(archivedPlan.archivedItems[0].body, '  Полный текст\r\n\t**Markdown**\n\n');
});
