// Три уборки в верхних поверхностях, закреплённые к исходникам.
//
// 1. Четыре кнопки Timeline свёрнуты в одну с раскрывающимся списком.
// 2. Встроенная browser-вкладка удалена целиком.
// 3. Полоса кнопок во всю ширину окна удалена, её содержимое разъехалось по
//    своим хозяевам.
//
// Все три — про одно и то же: поверхность занимала постоянное место за работу,
// которая делается редко, не делается вовсе или делается в другом месте.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(here, ...parts), 'utf8');

const titleBarTools = read('WorkspaceTitleBarTools.tsx');
const timelineTools = read('TimelineToolsButton.tsx');

test('инструменты Timeline занимают одно место, а не четыре', () => {
  // Было четыре чипа подряд: groups / AI / tab / all. Три из четырёх нажимают
  // редко, а ширины в строке не хватало всем остальным. Подписи при этом
  // пришлось ужать до «tab» и «all» — по ним не догадаться, что они делают.
  assert.match(titleBarTools, /<TimelineToolsButton/);
  assert.ok(!/data-usage-summary-controls/.test(titleBarTools), 'ряд из четырёх чипов удалён');
  // Стили чипов уехали вместе с кнопками: копия, оставшаяся без пользователя,
  // через месяц разойдётся с оригиналом.
  assert.ok(!/summaryChipStyle/.test(titleBarTools));
  assert.ok(!/outlineChipStyle/.test(titleBarTools));
});

test('свёрнутая кнопка всё равно показывает, что работа идёт', () => {
  // Главный риск сворачивания: скрыть работу, которая уже запущена, — и тогда
  // её запустят второй раз. Поэтому на самой кнопке остаются живые признаки:
  // значок групп «дышит» при сборке, счётчик показывает остаток пересказов,
  // а включённый авто подсвечивает кнопку целиком.
  assert.match(timelineTools, /const busy = outlineGenerating \|\| summaryRunning;/);
  assert.match(timelineTools, /const active = open \|\| busy \|\| summaryTabAuto \|\| summaryGlobalAuto;/);
  assert.match(timelineTools, /outlineGenerating \? 'animate-pulse text-purple-300' : ''/);
  assert.match(timelineTools, /summaryRunning\s*\n?\s*\?\s*<span[^>]*>\{summaryDone\}\/\{summaryTotal\}/);
});

test('в раскрытом списке у каждого действия есть человеческое пояснение', () => {
  // Ради этого сворачивание и делалось: в столбик ширина уже не дефицит,
  // поэтому «tab» и «all» стали фразами, а не обрубками.
  assert.match(timelineTools, /Авто в этой вкладке/);
  assert.match(timelineTools, /Авто во всех вкладках/);
  assert.match(timelineTools, /Разбить всю текущую сессию на смысловые группы/);
  assert.match(timelineTools, /Пересказать заново все мои сообщения в этой сессии/);
  // Список открывается ВНИЗ от кнопки и прижат к её правому краю: кнопка стоит
  // в правой половине тулбара, растущий вправо список ушёл бы за окно.
  assert.match(timelineTools, /top: rect\.bottom \+ 6/);
  assert.match(timelineTools, /Math\.min\(rect\.right - MENU_WIDTH/);
});

test('встроенной browser-вкладки больше нет ни в одном слое', () => {
  const files = [
    'src/renderer/store/useWorkspaceStore.ts',
    'src/renderer/components/Workspace/TerminalArea.tsx',
    'src/renderer/components/Workspace/Workspace.tsx',
    'src/renderer/components/Workspace/SplitPaneSurface.tsx',
    'src/renderer/components/Workspace/MicButton.tsx',
    'src/renderer/components/Workspace/WorkspaceTitleBarTools.tsx',
    'src/renderer/components/Workspace/SidebarToolsRow.tsx',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(repo, file), 'utf8');
    assert.ok(!/tabType === 'browser'/.test(source), file + ' ещё проверяет тип browser');
    assert.ok(!/tabType !== 'browser'/.test(source), file + ' ещё проверяет тип browser');
    assert.ok(!/BrowserTab/.test(source), file + ' ещё знает про компонент');
  }
  assert.ok(!fs.existsSync(path.join(here, 'BrowserTab.tsx')), 'компонент удалён');
  // Тип вкладки больше не допускает 'browser' — иначе он бы вернулся первым же
  // копипастом.
  const store = fs.readFileSync(path.join(repo, 'src/renderer/store/useWorkspaceStore.ts'), 'utf8');
  assert.match(store, /export type TabType = 'terminal' \| 'claude-sdk' \| 'file';/);
});

test('старые browser-вкладки из базы открываются как обычный терминал', () => {
  // Удалить тип мало: у пользователя в базе такие строки уже лежат, и рендерер
  // про этот тип больше не знает — без приведения вкладка стала бы «пустой,
  // которую никто не умеет показать».
  const db = fs.readFileSync(path.join(repo, 'src/main/database.js'), 'utf8');
  assert.match(db, /tabType: \(!t\.tab_type \|\| t\.tab_type === 'browser'\) \? 'terminal' : t\.tab_type/);
  // И то же самое на пути восстановления из истории закрытых вкладок.
  const home = read('ProjectHome.tsx');
  assert.match(home, /entry\.tab_type === 'file' \? 'file' : entry\.tab_type === 'claude-sdk' \? 'claude-sdk' : 'terminal'/);
});

test('право встраивать чужой сайт в окно выключено вместе с вкладкой', () => {
  // webviewTag включали ровно ради этой вкладки. Оставлять включённым право
  // встроить произвольную страницу внутрь приложения без того, кто им
  // пользуется, — лишняя поверхность.
  const main = fs.readFileSync(path.join(repo, 'src/main/main.js'), 'utf8');
  assert.ok(!/webviewTag: true/.test(main));
});
