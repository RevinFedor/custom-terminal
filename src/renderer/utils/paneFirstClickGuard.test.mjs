import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldSwallowFirstPaneClick,
  FIRST_CLICK_PASSTHROUGH_SELECTORS,
  FIRST_CLICK_OVERLAY_SELECTORS,
} from './paneFirstClickGuard.mjs';

// DOM-free element: «я подхожу под эти селекторы (сам или через предка)».
// Правило вызывает только closest(), поэтому это весь контракт.
const el = (...selectors) => ({
  closest: (s) => (selectors.includes(s) ? {} : null),
});

const call = (over = {}) => shouldSwallowFirstPaneClick({
  target: el(),
  paneIndex: 1,
  focusedIndex: 0,
  button: 0,
  ...over,
});

test('первый клик по невыбранной панели поглощается', () => {
  // Это и есть баг, ради которого правило существует: клик по блоку
  // размышлений в соседней панели раскрывал его вместо перехода.
  assert.equal(call(), true);
  assert.equal(call({ target: el('[data-ai-transcript-block]') }), true);
});

test('в уже выбранной панели клик обычный', () => {
  assert.equal(call({ paneIndex: 0, focusedIndex: 0 }), false);
});

test('терминал получает даже первый клик', () => {
  // Клик по терминалу ставит курсор/выделяет текст, а не раскрывает карточку —
  // и ведёт себя одинаково основной поверхностью и боковой.
  assert.equal(call({ target: el('[data-terminal-layer-tab-id]') }), false);
  assert.equal(call({ target: el('.xterm') }), false);
  // …но НЕ рамка вокруг терминала: в терминальном режиме она занимает всю
  // панель и является предком в том числе транскрипта, поэтому пропуск по ней
  // отменял бы правило целиком (измерено живьём).
  assert.equal(call({ target: el('[data-floating-terminal]') }), true);
});

test('поле ввода получает даже первый клик', () => {
  // Иначе перед набором текста понадобилось бы два клика.
  assert.equal(call({ target: el('[data-ai-composer-surface]') }), false);
  assert.equal(call({ target: el('textarea') }), false);
  assert.equal(call({ target: el('.cm-editor') }), false);
});

test('оверлеи проверяются раньше панели', () => {
  // Меню панели рендерится ВНУТРИ её обёртки: спросив сначала про панель, мы
  // приняли бы клик по пункту меню за клик по работе и съели бы его.
  for (const s of FIRST_CLICK_OVERLAY_SELECTORS) {
    assert.equal(call({ target: el(s) }), false, s);
  }
});

test('правая и средняя кнопки не поглощаются', () => {
  // Правая открывает меню О чём-то, средняя удаляет — ни то ни другое не
  // означает «перейди в эту панель».
  assert.equal(call({ button: 2 }), false);
  assert.equal(call({ button: 1 }), false);
});

test('одиночный режим и отсутствие панели ничего не меняют', () => {
  assert.equal(call({ paneIndex: -1 }), false);
  assert.equal(call({ paneIndex: NaN }), false);
});

test('списки не пересекаются — один селектор, один смысл', () => {
  const all = [...FIRST_CLICK_PASSTHROUGH_SELECTORS, ...FIRST_CLICK_OVERLAY_SELECTORS];
  assert.equal(new Set(all).size, all.length);
});
