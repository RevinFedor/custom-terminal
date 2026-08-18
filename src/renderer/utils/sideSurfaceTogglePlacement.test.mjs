import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const button = read('src/renderer/components/Workspace/SideSurfaceToggleButton.tsx');
const history = read('src/renderer/components/Workspace/HistoryPanel.tsx');
const terminal = read('src/renderer/components/Workspace/Terminal.tsx');
const rail = read('src/renderer/components/Workspace/PromptQueueOverlay.tsx');

/**
 * «Выдвинуть вторую поверхность» — пара со стрелкой вниз над полем ввода, у
 * правого края. Кнопка нужна в ДВУХ поверхностях (History в центре и терминал в
 * центре), причём смысл жеста зеркальный: выдвигается та поверхность, которой
 * сейчас нет в центре.
 *
 * Здесь закреплено то, что легко разъехалось бы молча: один компонент на оба
 * места, одинаковый размер с соседней стрелкой, и отсутствие второй копии
 * переключателя в боковом рейле.
 */

test('кнопка одна на две поверхности, а не две копии развилки', () => {
  // Развилка «что выдвигать» существует в одном месте. Две копии разошлись бы при
  // первой правке, и одна поверхность тихо осталась бы с прежним поведением.
  assert.match(history, /import SideSurfaceToggleButton from '\.\/SideSurfaceToggleButton'/);
  assert.match(terminal, /import SideSurfaceToggleButton from '\.\/SideSurfaceToggleButton'/);
  for (const source of [history, terminal]) {
    assert.match(source, /<SideSurfaceToggleButton\s+tabId=\{tabId\}\s+size=\{28\}\s*\/>/);
    // Ни одна из поверхностей не решает сама, что выдвигать.
    assert.doesNotMatch(source, /data-side-surface-toggle=\{/);
  }
});

test('переключатель читает раскладку в момент клика, а не из замыкания', () => {
  // Реверс мог случиться между рендером и нажатием: по устаревшему значению мы
  // переключили бы не ту поверхность.
  const toggle = button.slice(button.indexOf('const toggle ='), button.indexOf('const surfaceName'));
  assert.match(toggle, /useUIStore\.getState\(\)/);
  assert.match(toggle, /resolveTabTerminalPrimary\(state, tabId\)/);
});

test('иконка называет выдвигаемую поверхность и потому меняется при реверсе', () => {
  // Единственное в этой кнопке, что зависит от раскладки, — и здесь так и надо:
  // сам жест меняет смысл. (В отличие от кнопки состояния агента, где такая
  // зависимость была багом.)
  assert.match(button, /terminalIsPrimary \? Bot : SquareTerminal/);
});

test('пара над полем: кнопка раскладки у края, стрелка слева от неё', () => {
  // Стрелка отступает на ширину кнопки + 2px. Числа обязаны совпадать с size=28,
  // иначе кнопки наедут друг на друга или разъедутся.
  assert.match(history, /right: mainSurface\s*\n?\s*\? centerRightInset \+ HISTORY_COMPOSER_SIDE_INSET \+ 28 \+ 2/);
  assert.match(terminal, /right: terminalArrowRightInset \+ 16 \+ \(isTerminalCentre \? 28 \+ 2 : 0\)/);
});

test('правый край кнопки совпадает с правым краем рамки поля ввода', () => {
  // Рамка рисует вертикальную линию, по которой глаз выравнивает всё, что стоит
  // над ней. Отступ обязан быть ОДНИМ числом на рамку и на кнопку: пока их было
  // два (16 у рамки, 12 у кнопки), кнопка стояла на 4px правее линии.
  assert.match(history, /const HISTORY_COMPOSER_SIDE_INSET = 16;/);
  assert.match(history, /right: centerRightInset \+ HISTORY_COMPOSER_SIDE_INSET,/);
  // Отступ рамки берётся из ТОЙ ЖЕ константы. Как именно он задан — раньше
  // `left/right` у абсолютной панели, сейчас `padding` у обычной строки колонки —
  // не важно; важно, что число одно, иначе кнопка снова встанет мимо линии.
  assert.match(history, /paddingLeft: overlayComposer \? HISTORY_COMPOSER_SIDE_INSET/);
  assert.match(history, /paddingRight: overlayComposer \? HISTORY_COMPOSER_SIDE_INSET/);
  // Прежние независимые числа не должны вернуться ни с одной стороны.
  assert.doesNotMatch(history, /right: centerRightInset \+ 12,/);
  assert.doesNotMatch(history, /paddingLeft: overlayComposer \? 16/);
});

test('значок масштабируется вместе с квадратом кнопки', () => {
  // При переносе менялся размер квадрата (21px в рейле → 28px у поля). Значок
  // обязан вырасти вместе с ним, иначе снаружи это выглядит как «увеличил только
  // фон»: то же изображение в поле вдвое большего размера. Доля взята с соседней
  // стрелки — 16px значка в 28px квадрате.
  assert.match(button, /const SIDE_SURFACE_GLYPH_RATIO = 16 \/ 28;/);
  assert.match(button, /<Icon size=\{Math\.round\(size \* SIDE_SURFACE_GLYPH_RATIO\)\}/);
  assert.doesNotMatch(button, /size \* 0\.5/);
});

test('кнопка раскладки не исчезает от прокрутки, в отличие от стрелки', () => {
  // Стрелка появляется только когда прокрутили вверх. Орган управления
  // раскладкой так вести себя не может — за ним пришлось бы охотиться.
  const historySlot = history.slice(
    history.indexOf('data-history-side-surface-toggle'),
    history.indexOf('Scroll-to-bottom arrow'),
  );
  assert.ok(historySlot.length > 0);
  assert.doesNotMatch(historySlot, /showScrollButton|scrollArrowRef/);
  const terminalSlot = terminal.slice(
    terminal.indexOf('data-terminal-side-surface-toggle'),
    terminal.indexOf('Scroll-to-bottom button'),
  );
  assert.ok(terminalSlot.length > 0);
  assert.doesNotMatch(terminalSlot, /showScrollButton/);
});

test('в терминале кнопка есть только когда он держит центр', () => {
  // Иначе на экране оказались бы две кнопки одного переключателя: своя у центра
  // и своя у панели, приткнутой сбоку.
  assert.match(terminal, /active && presentedProp && isTerminalCentre &&/);
  // В боковой History её тоже нет — она принадлежит центральной поверхности.
  assert.match(history, /\{mainSurface && \(/);
});

test('обе стрелки вниз одного размера', () => {
  // Одна и та же по смыслу кнопка выглядела в двух поверхностях по-разному:
  // 28px в History и 36px в терминале.
  assert.match(terminal, /width: '28px',\s*\n\s*height: '28px',/);
  assert.match(history, /width: 28,\s*\n\s*height: 28,/);
});

test('в боковом рейле копии переключателя не осталось', () => {
  // Два одинаковых переключателя в разных углах — это не два способа, а
  // непонятно, какой из них «настоящий».
  assert.doesNotMatch(rail, /data-rail-surface-toggle=\{terminalIsPrimary/);
  assert.doesNotMatch(rail, /showTerminalToggle/);
  // Вместе с кнопкой удалено её состояние: писатели без читателя — мёртвый код,
  // который следующий человек примет за работающий.
  assert.doesNotMatch(rail, /secondarySurfaceOpen/);
  assert.doesNotMatch(rail, /const onToggleTerminal/);
  // Кнопка Timeline на месте — она про другую поверхность.
  assert.match(rail, /data-rail-surface-toggle="timeline"/);
});
