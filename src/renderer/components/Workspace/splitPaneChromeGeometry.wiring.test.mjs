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
const resizeFreeze = fs.readFileSync(path.join(here, '../../utils/splitResizeFreeze.mjs'), 'utf8');
const area = fs.readFileSync(path.join(here, 'TerminalArea.tsx'), 'utf8');

test('действия окна сохраняют геометрию wrap, Git находится в общей шапке', () => {
  assert.match(chrome, /data-split-pane-focus-actions/);
  assert.match(chrome, /const focusActionsVisible = focused && activeArea !== 'sidebar'/);
  assert.match(chrome, /data-wrap-reserved="1"/);
  assert.match(chrome, /data-visible=\{focusActionsVisible \? '1' : '0'\}/);
  // Скрытый блок всегда остаётся в потоке; focus не меняет перенос строк.
  assert.match(chrome, /position: 'relative'/);
  assert.match(chrome, /visibility: focusActionsVisible \? 'visible' : 'hidden'/);
  assert.doesNotMatch(chrome, /endInsetPx|focusActionsWidth/);
  assert.match(chrome, /inert=\{!focusActionsVisible\}/);
  // Git has one focused owner in the application toolbar. Window switching
  // remains reachable in every pane, outside the focus-only action block.
  const block = chrome.slice(
    chrome.indexOf('data-split-pane-focus-actions'),
    chrome.indexOf('data-split-strip-menu-button'),
  );
  assert.doesNotMatch(block, /<PersistentPaneGitStatus/);
  assert.match(block, /<HiddenWindowPicker/);
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
  assert.match(chrome, /import \{ freezePaneContentsForResize \} from/);
  assert.match(resizeFreeze, /wrapper\.style\.overflow = 'clip'/);
  assert.match(resizeFreeze, /content\.style\.width = `\$\{box\.width\}px`/);
  assert.match(resizeFreeze, /content\.style\.height = `\$\{box\.height\}px`/);
  const drag = chrome.slice(chrome.indexOf('const startDrag = ('), chrome.indexOf('return (\n    <div\n      ref={layerRef}'));
  assert.match(drag, /flushSync\(\(\) => \{/);
  assert.ok(drag.indexOf('commitSplitSizes(finalSizes)') < drag.indexOf('freeze.release('));
});

test('стор пишется ОДИН раз на законченное перетаскивание', () => {
  // Запись на каждый кадр перестраивала бы все окна; drag двигает DOM напрямую,
  // а стор узнаёт итог на отпускании.
  const drag = chrome.slice(chrome.indexOf('const startDrag = ('), chrome.indexOf('return (\n    <div\n      ref={layerRef}'));
  const release = drag.slice(drag.indexOf('const onUp = ('), drag.indexOf('cancelDragRef.current = () => {'));
  assert.match(release, /commitSplitSizes\(finalSizes\)/);
  assert.doesNotMatch(drag, /onMove[\s\S]{0,400}commitSplitSizes/);
});

test('шапка окна — стабильный сосед поверхностей, а не часть вкладки', () => {
  // Слои действительно siblings: живой drag ходит к ним через parentElement.
  assert.match(area, /data-terminal-pane-chrome-host=\{ownerKey\}/);
  assert.match(area, /data-split-pane-index=\{presented \? paneIndex : undefined\}/);
  assert.match(area, /<SplitDividerLayer \/>/);
});
