// Вкладка, созданная ЖЕСТОМ ОКНА, — обычная вкладка проекта.
//
// Раньше она помечалась «только для окна» (`windowScoped`) и пряталась из
// бокового списка: полоса чипов считалась её основной поверхностью навигации.
// Это делало живую вкладку НЕДОСТУПНОЙ — чип уходил из полосы (средний клик,
// перенос, чистка при возврате в пространство), и добраться до вкладки
// становилось нечем при живом shell и целой истории. Страховка «вернуть строку,
// когда размещения не осталось» опиралась на ответ, недостоверный ровно в этот
// момент, и вместо возврата давала фантомный «Терминал» после закрытия.
//
// Поле `windowScoped` осталось в схеме и переживает перезапуск (старые сессии
// его несут), но поведения за ним больше нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');
const repoRoot = path.resolve(rendererRoot, '..', '..');
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const chrome = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/SplitPaneChrome.tsx'), 'utf8');
const area = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/TerminalArea.tsx'), 'utf8');
const tabBar = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/TabBar.tsx'), 'utf8');
const app = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8');
const database = fs.readFileSync(path.join(repoRoot, 'src/main/database.js'), 'utf8');

test('двойной клик по полосе создаёт ОБЫЧНУЮ вкладку и ставит её чип', () => {
  assert.match(chrome, /createTabAfterCurrent\(owner, EMPTY_TAB_NAME, cwd, \{/);
  assert.match(chrome, /background: true,[\s\S]{0,200}visualParentTabId: '',/);
  assert.match(chrome, /addTabToSplitPaneStrip\(paneIndex, owner, newTabId\)/);
  // Ни одна точка создания больше не помечает вкладку «только для окна».
  assert.doesNotMatch(chrome, /windowScoped: true/);
  assert.doesNotMatch(area, /windowScoped: true/);
});

test('запуск в пустом окне тоже создаёт обычную строку, размещение — видимый commit', () => {
  assert.match(area, /const placeInTargetPane = \(createdTabId: string\) => \{/);
  assert.match(area, /current\.addTabToSplitPaneStrip\(paneIndex, targetProjectId, createdTabId\)/);
  assert.match(area, /createTabAfterCurrent\(targetProjectId, EMPTY_TAB_NAME, cwd, \{/);
  assert.match(area, /placeInTargetPane\(createdTabId\)/);
});

test('новая строка — СОСЕД текущей, после всего её поддерева', () => {
  // Вставка «сразу после» разрывала карточку родителя пополам: новая строка
  // вставала между ним и его детьми и выглядела оторванной от жеста.
  assert.match(store, /const afterVisualSubtreePlacement = \(rejectsInheritedParent \|\| options\?\.afterVisualSubtree === true\)/);
  assert.match(store, /resolveSiblingInsertionIndex\(\{/);
  assert.match(store, /parentOf: Object\.fromEntries\(/);
  const placement = store.slice(store.indexOf('const afterVisualSubtreePlacement ='), store.indexOf('const insertIndex = afterVisualSubtreePlacement'));
  assert.doesNotMatch(placement, /!targetGroupId/, 'visual subtree не перестаёт быть поддеревом внутри group');
});

test('живая вкладка не прячется из бокового списка ни при каком размещении', () => {
  assert.doesNotMatch(tabBar, /hiddenWindowScopedTabIds/);
  assert.match(tabBar, /const mainTabsBase = allTabs;/);
});

test('Shift+Cmd+T сначала отменяет локальное удаление chip, затем восстанавливает full-close', () => {
  assert.match(app, /const targetPaneIndex = ws\.splitPanes\.length > 0 \? ws\.splitFocusedIndex : -1/);
  assert.match(app, /ws\.restoreLastDetachedTabToSplitPane\(targetPaneIndex\)/);
  assert.match(app, /ws\.reopenLastClosedTab\(restoreProjectId, targetPaneIndex >= 0/);
  assert.ok(
    app.indexOf('restoreLastDetachedTabToSplitPane(targetPaneIndex)')
      < app.indexOf('ws.reopenLastClosedTab(restoreProjectId'),
    'local pane undo must win over an unrelated archived tab',
  );
  assert.match(store, /restoreLastDetachedTabToSplitPane: \(paneIndex\) => \{/);
  assert.match(store, /const keepFocusedEmpty = detachedPaneIndex === splitFocusedIndex/);
  assert.match(store, /if \(keepFocusedEmpty\) \{/);
  assert.match(store, /reopenLastClosedTab: \(projectId, options\) => \{/);
  assert.match(store, /background: paneTargetExists/);
  assert.match(store, /current\.addTabToSplitPaneStrip\(requestedPaneIndex, projectId, result\.tabId\)/);
});

test('поле переживает сохранение и восстановление — старые сессии не ломаются', () => {
  assert.match(database, /ALTER TABLE tabs ADD COLUMN window_scoped INTEGER DEFAULT 0/);
  assert.match(database, /ALTER TABLE tab_history ADD COLUMN window_scoped INTEGER DEFAULT 0/);
  assert.match(database, /windowScoped: t\.window_scoped === 1 \|\| undefined/);
  assert.match(database, /tab\.windowScoped \? 1 : 0/);
  assert.match(store, /windowScoped: entry\.window_scoped === 1 \|\| undefined/);
  assert.match(store, /windowScoped: tab\.windowScoped/);
});

test('закрытие вкладки стирает ВСЕ её следы размещения — иначе появляется фантом', () => {
  // «Где эта вкладка лежит» отвечали четыре источника: окна текущего
  // пространства, снимки остальных, полосы центра и запись «что показывало это
  // пространство». Последняя переживала закрытие, и любой вопрос о месте
  // закрытой вкладки отвечал «здесь» — это и порождало фантомную строку.
  const close = store.slice(
    store.indexOf('  closeTab: async (projectId, tabId, options) => {'),
    store.indexOf('  restoreTabHistoryEntry: async (projectId, historyId, options = {}) => {'),
  );
  assert.match(close, /dropTabFromAllPaneHistories\(get\(\)\.splitPanes, tabId\)/);
  assert.match(close, /dropTabFromAllPaneDetachedTabs\(get\(\)\.splitPanes, tabId\)/);
  assert.match(close, /dropTabsFromOtherSpaces\([\s\S]{0,180}?\[tabId\],[\s\S]{0,80}?dropTabFromAllPaneStrips,[\s\S]{0,80}?vacantPaneWithTabs/);
  assert.match(close, /dropTabFromAllPaneStrips\(get\(\)\.splitPanes, tabId\)/);
  assert.match(close, /if \(get\(\)\.activeSpaceTab\?\.tabId === tabId\) set\(\{ activeSpaceTab: null \}\)/);
});
