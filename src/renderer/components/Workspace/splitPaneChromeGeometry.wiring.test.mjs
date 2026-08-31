// Шапка окна: что кому принадлежит, и почему граница у окна одна.
//
// Три отдельных шрама, у которых общий корень — «окно» нарисовано несколькими
// узлами, и каждый решал за себя:
//
//  • Git и деление отвечают про рабочее место, три точки — про саму полосу
//    вкладок. Пока видимость решалась у каждой кнопки отдельно, правило жило в
//    трёх местах и разъезжалось.
//  • У трёх точек коробка была уже ряда и не доходила до края шапки: справа
//    оставалась мёртвая полоска, где курсор ничего не подсвечивал.
//  • Во время перетаскивания перегородки двигалась только поверхность вкладки,
//    а стабильная шапка с рамкой оставалась на старой границе — на экране это
//    читалось как ВТОРАЯ, призрачная перегородка.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chrome = fs.readFileSync(path.join(here, 'SplitPaneChrome.tsx'), 'utf8');
const area = fs.readFileSync(path.join(here, 'TerminalArea.tsx'), 'utf8');

test('Git и деление: scroll следует фокусу, wrap держит блок постоянно', () => {
  assert.match(chrome, /data-split-pane-focus-actions/);
  assert.match(chrome, /const focusActionsVisible = stripWrap \|\| \(focused && activeArea !== 'sidebar'\)/);
  assert.match(chrome, /data-wrap-pinned=\{stripWrap \? '1' : undefined\}/);
  assert.match(chrome, /data-visible=\{focusActionsVisible \? '1' : '0'\}/);
  // Невидимый блок absolute/hidden, поэтому чёрной layout-распорки нет. Его
  // измеренная ширина живёт trailing reserve внутри scroll-content.
  assert.match(chrome, /position: focusActionsVisible \? 'relative' : 'absolute'/);
  assert.match(chrome, /visibility: focusActionsVisible \? 'visible' : 'hidden'/);
  assert.match(chrome, /const hiddenFocusReservePx/);
  assert.match(chrome, /endInsetPx=\{hiddenFocusReservePx\}/);
  assert.match(chrome, /inert=\{!focusActionsVisible\}/);
  // Обе кнопки — внутри блока, а не рядом с ним.
  const block = chrome.slice(
    chrome.indexOf('data-split-pane-focus-actions'),
    chrome.indexOf('data-split-strip-menu-button'),
  );
  assert.match(block, /<GitStatusButton/);
  assert.match(block, /<Columns2 size=\{12\} \/>/);
});

test('три точки видимы всегда и держат квадратную коробку до правого края', () => {
  const dots = chrome.slice(
    chrome.indexOf('data-split-strip-menu-button'),
    chrome.indexOf('<MoreVertical size={13} />'),
  );
  // Ширина равна высоте ряда — квадрат, а не «подобрана под иконку».
  assert.match(dots, /width: chipH,/);
  assert.match(dots, /alignSelf: 'stretch'/);
  // Поле шапки съедается, иначе справа остаётся мёртвая полоска.
  assert.match(dots, /marginRight: -8,/);
  // Видимость кнопки не зависит от фокуса.
  assert.doesNotMatch(dots, /focused/);
});

test('живая геометрия окна применяется ОДНИМ снимком ко всем его слоям', () => {
  // Поверхность вкладки и стабильная шапка — разные узлы (шапка не должна
  // перемонтироваться при смене показанного чипа). Двигать надо оба, иначе
  // одна граница едет за курсором, а вторая стоит на месте — призрачная
  // перегородка.
  assert.match(chrome, /const PANE_GEOMETRY_LAYER_SELECTOR = \[/);
  assert.match(chrome, /'\[data-terminal-pane-wrapper\]\[data-pane-event-index\]',/);
  assert.match(chrome, /'\[data-terminal-pane-chrome-host\]\[data-split-pane-index\]',/);
  assert.match(chrome, /function applyPaneGeometryToDom\(/);
  // Оба писателя — и живой drag, и сброс после отмены — идут через него.
  const writers = chrome.match(/applyPaneGeometryToDom\(host, panes,/g) || [];
  assert.equal(writers.length, 2, 'живой drag и сброс геометрии');
  // Своей копии цикла по узлам ни у кого не осталось.
  const inlineWrites = chrome.match(/el\.style\.left = `\$\{rect\.leftPct\}%`/g) || [];
  assert.equal(inlineWrites.length, 1, 'единственное место, где пишется прямоугольник');
});

test('тяжёлое содержимое не получает промежуточную геометрию divider drag', () => {
  assert.match(chrome, /function freezePaneContentsForResize\(host: HTMLElement\)/);
  assert.match(chrome, /wrapper\.style\.overflow = 'clip'/);
  assert.match(chrome, /content\.style\.width = `\$\{box\.width\}px`/);
  assert.match(chrome, /content\.style\.height = `\$\{box\.height\}px`/);
  const drag = chrome.slice(chrome.indexOf('const startDrag = ('), chrome.indexOf('return (\n    <div\n      ref={layerRef}'));
  assert.match(drag, /flushSync\(\(\) => \{/);
  assert.ok(drag.indexOf('commitSplitSizes(finalSizes)') < drag.indexOf('freeze.release()'));
});

test('стор пишется ОДИН раз на законченное перетаскивание', () => {
  // Запись на каждый кадр перестраивала бы все окна; drag двигает DOM напрямую,
  // а стор узнаёт итог на отпускании.
  const drag = chrome.slice(chrome.indexOf('const startDrag = ('), chrome.indexOf('return (\n    <div\n      ref={layerRef}'));
  assert.match(drag, /const onUp = \(\) => \{[\s\S]{0,1200}commitSplitSizes\(finalSizes\)/);
  assert.doesNotMatch(drag, /onMove[\s\S]{0,400}commitSplitSizes/);
});

test('шапка окна — стабильный сосед поверхностей, а не часть вкладки', () => {
  // Слои действительно siblings: живой drag ходит к ним через parentElement.
  assert.match(area, /data-terminal-pane-chrome-host=\{ownerKey\}/);
  assert.match(area, /data-split-pane-index=\{presented \? paneIndex : undefined\}/);
  assert.match(area, /<SplitDividerLayer \/>/);
});
