// Рабочие пространства — места, где они встречаются с остальным приложением.
//
// Сами правила живут в workspaceSpacesModel.mjs и покрыты там. Здесь закреплено
// то, что чистая модель проверить не может: как пространства переживают
// перезапуск, кто чистит их окна и чем полоса НЕ должна быть.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const strip = fs.readFileSync(path.join(workspaceDir, 'SpaceStrip.tsx'), 'utf8');
const map = fs.readFileSync(path.join(workspaceDir, 'PaneMap.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(workspaceDir, 'Workspace.tsx'), 'utf8');
const snapshot = fs.readFileSync(path.join(here, '..', 'utils', 'sessionSnapshot.mjs'), 'utf8');

test('раскладка остаётся на верхнем уровне, пространство её СНИМАЕТ и КЛАДЁТ', () => {
  // Поля раскладки читают десятки мест. Завернуть каждое чтение в «раскладку
  // текущего пространства» значило бы переписать их все ради одного нового слоя
  // — и первое же забытое чтение молча смотрело бы в чужую раскладку.
  assert.match(store, /captureSpaceLayout\(st\)/);
  assert.match(store, /set\(\{ spaces: res\.spaces, activeSpaceId: res\.activeSpaceId, \.\.\.layout \}\)/);
});

test('пространства переживают перезапуск, и старая раскладка становится первым', () => {
  // Человек закрыл приложение с разложенными окнами и обязан увидеть их же, а
  // не пустое «main».
  assert.match(snapshot, /spaces:/);
  assert.match(snapshot, /activeSpaceId:/);
  assert.match(store, /restoreSpaces\(sessionState as any, restoredLayout\)/);
  // Текущему кладём ВЫЧИЩЕННУЮ раскладку: обе описывают одно, но мёртвые
  // вкладки убраны только в первой.
  assert.match(store, /\{ \.\.\.space\.layout, \.\.\.restoredLayout \}/);
});

test('раскладка чужого пространства чистится при ВОЗВРАТЕ в него', () => {
  // Пока в пространство не вернулись, его окна могут указывать на вкладки,
  // закрытые за это время; вкладки проектов, не открытых в этом запуске, на
  // старте вообще неизвестны. Момент возврата — первый, когда ответ «жива ли
  // вкладка» достоверен.
  const body = store.slice(store.indexOf('switchWorkspaceSpace: (id) =>'));
  assert.match(body.slice(0, 2000), /sanitizePanes\(layout\.splitPanes/);
  assert.match(body.slice(0, 2000), /packSplitSizes\(scrubbed\.panes/);
});

test('закрытая вкладка убирается из окон ВСЕХ пространств', () => {
  // Раскладка остальных лежит в снимках, обычные пути её не видят — чип,
  // указывающий на закрытую вкладку, дожил бы до возврата и нарисовался бы там
  // окном без разметки.
  assert.match(store, /dropTabsFromOtherSpaces\(st\.spaces, st\.activeSpaceId, \[tabId\]/);
  // И при закрытии ПРОЕКТА — пачкой, а не по вкладке за раз.
  assert.match(store, /const doomed = Array\.from\(workspace\?\.tabs\.keys\(\) \|\| \[\]\)/);
});

test('клик по вкладке из другого пространства ведёт ТУДА, а не заводит второе место', () => {
  // Вкладка, разложенная в другом пространстве, уже имеет своё место; открыть
  // её здесь значило бы завести ей второе. Переход стоит ПЕРЕД правилом окон,
  // чтобы то отработало уже в нужной раскладке.
  const at = store.indexOf('const holder = get().workspaceSpaceIndexOfTab(tabId)');
  const paneRule = store.indexOf('const splitRes = resolveSplitActivation(splitPanes, splitFocusedIndex, projectId, tabId)');
  assert.ok(at > 0 && at < paneRule, 'переход в пространство идёт до правила окон');
});

test('полоса читает пространства строкой, а не массивом', () => {
  // Селектор, отдающий объекты, — новая ссылка на каждую запись в стор
  // (правило Fingerprint).
  assert.match(strip, /s\.spaces\.map\(\(x\) => `\$\{x\.id\}:\$\{x\.name\}`\)\.join\(','\)/);
});

test('полоса стоит НАД окнами и внутри рабочей области', () => {
  // Пространство помнит раскладку окон — значит говорит про то, что справа от
  // бокового списка, а не про сам список.
  const center = workspace.indexOf('data-workspace-center');
  const at = workspace.indexOf('<SpaceStrip />');
  assert.ok(at > center, 'внутри центральной колонки');
  assert.ok(at < workspace.indexOf('<TerminalArea'), 'выше окон');
});

test('жесты полосы — те же, что у вкладок', () => {
  // Человек уже умеет это делать этажом ниже; другой набор жестов на соседней
  // строке читался бы как другая сущность.
  assert.match(strip, /onDoubleClick=\{\(e\) => \{\n\s+e\.stopPropagation\(\);\n\s+useWorkspaceStore\.getState\(\)\.addWorkspaceSpace\(\)/);
  assert.match(strip, /onContextMenu=/);
  assert.match(strip, /removeWorkspaceSpace\(id\)/);
  // Переименование начинается с ВЫДЕЛЕННЫМ текстом, и выделяем ровно один раз:
  // `ref` зовётся на каждую букву, и повторный select() стирал бы набранное.
  assert.match(strip, /node\.select\(\)/);
  assert.match(strip, /focusedRef\.current = true/);
});

test('карта в списке рисует раскладку ТОГО пространства, где вкладка лежит', () => {
  // Вопрос «где она открыта» не перестаёт иметь ответ оттого, что смотрят в
  // другую раскладку.
  assert.match(map, /const at = s\.workspaceSpaceIndexOfTab\(tabId\)/);
  // Чужое помечается РАМКОЙ и номером, а не приглушением: самый блёклый цвет
  // уже занят чужими окнами, ниже него ничего нет.
  assert.match(map, /boxShadow: foreign \? 'inset 0 0 0 1px/);
  assert.match(map, /PANE_MAP_SPACE_SLOT_W_PX/);
  // Место под цифру резервируется всегда — иначе имена вкладок дёргаются.
  assert.match(map, /color: foreign \? '#b9b9c0' : 'transparent'/);
});
