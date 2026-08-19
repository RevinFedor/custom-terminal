// Клик по невыбранной панели: он ФОКУСИРУЕТ её и при этом доходит до цели.
//
// Раньше первый клик по невыбранной панели гасился (чтобы случайное попадание
// не раскрыло блок размышлений). Правило снято по запросу 2026-08-17: на
// практике оно читалось как мёртвый клик, а случайное раскрытие отменить
// дешевле, чем клик, который ничего не сделал. Тест держит противоположный
// контракт — гашения нет ни в каком виде.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), 'utf8');
const terminalArea = read('..', 'components', 'Workspace', 'TerminalArea.tsx');
const globalsCss = read('..', 'styles', 'globals.css');

function block(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

const paneFocus = block(
  terminalArea,
  'const onPointerDown = (e: PointerEvent) => {',
  '\n    };',
);

test('клик по панели только переводит фокус и никого не глотает', () => {
  assert.match(paneFocus, /st\.focusSplitPane\(idx, /);
  assert.doesNotMatch(paneFocus, /stopPropagation/);
  assert.doesNotMatch(paneFocus, /preventDefault/);
  // Ни следа старого механизма во всём файле.
  assert.doesNotMatch(terminalArea, /swallowNextClickRef/);
  assert.doesNotMatch(terminalArea, /shouldSwallowFirstPaneClick/);
});

test('правая и средняя кнопки по-прежнему не двигают фокус', () => {
  // ПКМ открывает меню О чём-то, средняя — убирает; ни то ни другое не
  // означает «хочу работать здесь», и увод фокуса вытаскивал поверхность
  // из-под только что открытого меню.
  assert.match(paneFocus, /if \(e\.button !== 0\) return;/);
});

test('клик, закрывающий меню, не достаётся панели', () => {
  const guardAt = paneFocus.indexOf('notePointerDownForDismissal(document)');
  const focusAt = paneFocus.indexOf('focusSplitPane(idx,');
  assert.ok(guardAt >= 0, 'expected the dismissal guard');
  assert.ok(focusAt > guardAt, 'the guard must run BEFORE focus moves');
});

test('наведение подсвечивает невыбранную панель — рамкой из CSS, не из состояния', () => {
  assert.match(globalsCss, /\[data-terminal-pane-wrapper\]\[data-split-pane-index\]:hover/);
  assert.match(globalsCss, /\[data-split-pane-focus-frame="0"\]\[data-split-pane-frame-state="idle"\]/);
  // CSS, а не состояние React: панель держит терминал и транскрипт, и
  // перерисовка на каждый вход курсора недопустима.
  assert.ok(
    !/onMouseEnter[^\n]*setPaneHover/.test(terminalArea),
    'hover must not be tracked in React state',
  );
});
