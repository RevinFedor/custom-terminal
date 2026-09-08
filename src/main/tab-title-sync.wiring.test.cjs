'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Inbox fallback title remains auto-owned and uses the shared tab-title coordinator', () => {
  const web = read('src/main/web-server.js');
  const app = read('src/renderer/App.tsx');
  assert.match(web, /const requestedTabName = cleanOptionalString\(body\.name, ''\)/);
  assert.match(web, /nameSetManually: !!requestedTabName/);
  assert.match(app, /nameSetManually: !!explicitName && nameSetManually !== false/);
  assert.match(app, /state\.markAiLaunchAutoTitle\(tabId, agent\)/);
});

test('manual and generated store renames publish one tab metadata event', () => {
  const store = read('src/renderer/store/useWorkspaceStore.ts');
  assert.match(store, /ipcRenderer\.send\('tab:metadata-changed'/);
  assert.match(store, /notifyTabNameChanged\(workspace\.projectId, tabId, cleanName, true, 'manual'\)/);
  assert.match(store, /options\.markNameSetManually \? 'manual' : 'auto'/);
});

test('tab metadata reaches the existing tab SSE topic and status remains re-queryable', () => {
  const main = read('src/main/main.js');
  const app = read('src/renderer/App.tsx');
  const web = read('src/main/web-server.js');
  assert.match(main, /ipcMain\.on\('tab:metadata-changed'/);
  assert.match(main, /webBroadcast\(tabId, \{\s*type: 'tab-metadata'/);
  assert.match(app, /name: tab\.name \|\| null/);
  assert.match(app, /nameSetManually: tab\.nameSetManually === true/);
  assert.match(web, /'done', 'tab-metadata', 'background-work'/);
  assert.match(web, /updateTabHistoryTitle\(archived\.historyId, name, true\)/);
  assert.match(web, /archived: true/);
});

test('the real main callback publishes exact tab identity and title', () => {
  const mainText = read('src/main/main.js');
  const source = ts.createSourceFile('main.js', mainText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let callback = null;
  const visit = (node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'ipcMain'
      && node.expression.name.text === 'on'
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'tab:metadata-changed') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  const published = [];
  const context = vm.createContext({
    path,
    srcMainDir: '/test/main',
    Date,
    require: () => ({ webBroadcast: (tabId, payload) => published.push({ tabId, payload }) }),
    console: { warn() {} },
  });
  const fn = vm.runInContext(`(${callback.getText(source)})`, context);
  fn(null, { projectId: 'project-A', tabId: 'tab-A', name: 'Shared title', source: 'auto', changedAt: 42 });
  assert.deepEqual(JSON.parse(JSON.stringify(published)), [{
    tabId: 'tab-A',
    payload: { type: 'tab-metadata', projectId: 'project-A', name: 'Shared title',
      nameSetManually: false, source: 'auto', changedAt: 42 },
  }]);
});

test('renaming an archived tab publishes the same reverse-sync event', () => {
  const mainText = read('src/main/main.js');
  const source = ts.createSourceFile('main.js', mainText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let callback = null;
  const visit = (node) => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'ipcMain'
      && node.expression.name.text === 'handle'
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'project:update-tab-history-title') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  const published = [];
  const context = vm.createContext({
    path,
    srcMainDir: '/test/main',
    Date,
    projectManager: { db: {
      db: { prepare: () => ({ get: () => ({ tab_id: 'archived-tab', project_id: '__noted_inbox__' }) }) },
      updateTabHistoryTitle: () => true,
    } },
    require: () => ({ webBroadcast: (tabId, payload) => published.push({ tabId, payload }) }),
    console: { warn() {} },
  });
  const fn = vm.runInContext(`(${callback.getText(source)})`, context);
  const result = fn(null, { id: 7, name: 'Archived shared title', nameSetManually: true });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true });
  assert.deepEqual(JSON.parse(JSON.stringify(published)), [{
    tabId: 'archived-tab',
    payload: { type: 'tab-metadata', projectId: '__noted_inbox__', name: 'Archived shared title',
      nameSetManually: true, source: 'manual', archived: true, changedAt: published[0].payload.changedAt },
  }]);
  assert.ok(Number.isFinite(published[0].payload.changedAt));
});
