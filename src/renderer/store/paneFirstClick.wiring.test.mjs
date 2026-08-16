// Первый клик по невыбранной панели — контракты, которых чистое правило не
// видит: КОГДА он гасится, ГДЕ показывается предупреждение и что жест не
// остаётся взведённым.

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

const guard = block(
  terminalArea,
  'const swallowNextClickRef = useRef(false);',
  '\n  useEffect(() => {\n    if (focusedEmptyPaneIndex < 0) return;',
);

test('гасится и `click`, а не только `pointerdown`', () => {
  // Раскрытие блоков (размышления, bash) висит на click, а click — ОТДЕЛЬНОЕ
  // событие: остановка pointerdown его не отменяет. Гашение только pointerdown
  // выглядело бы как фикс, пока каждая карточка продолжала раскрываться.
  assert.match(guard, /swallowNextClickRef\.current = true/);
  assert.match(guard, /addEventListener\('click', swallowIfArmed, true\)/);
  // …и в фазе ПЕРЕХВАТА, до обработчиков транскрипта.
  const clickAt = guard.indexOf("addEventListener('click', swallowIfArmed, true)");
  assert.ok(clickAt > 0, 'click listener must be registered in capture phase');
});

test('взведённый жест снимается, если клика так и не было', () => {
  // Иначе гашение «доживёт» до следующего, ни в чём не виноватого клика и
  // будет выглядеть случайным мёртвым кликом минутами позже.
  assert.match(guard, /const disarm = \(\)/);
  assert.match(guard, /addEventListener\('pointercancel', disarm, true\)/);
  assert.match(guard, /addEventListener\('blur', disarm\)/);
  // И всё снимается при размонтировании.
  const cleanup = block(guard, 'return () => {', '\n  }, [splitPaneCount]);');
  assert.match(cleanup, /removeEventListener\('click', swallowIfArmed, true\)/);
  assert.match(cleanup, /swallowNextClickRef\.current = false/);
});

test('решение принимает чистое правило, а не сам обработчик', () => {
  assert.match(guard, /shouldSwallowFirstPaneClick\(\{/);
  assert.match(guard, /paneIndex: idx/);
  assert.match(guard, /focusedIndex: st\.splitFocusedIndex/);
  // Панель всё равно получает фокус — жест обязан что-то делать.
  assert.match(guard, /st\.focusSplitPane\(idx\)/);
});

test('наведение подсвечивает панель заранее — и только невыбранную', () => {
  // Предупреждение должно быть ДО клика, иначе гашение читается как поломка.
  assert.match(globalsCss, /\[data-terminal-pane-wrapper\]\[data-split-pane-index\]:hover/);
  assert.match(globalsCss, /\[data-split-pane-focus-frame="0"\]\[data-split-pane-frame-state="idle"\]/);
  // CSS, а не состояние React: панель держит терминал и транскрипт, и
  // перерисовка на каждый вход курсора недопустима.
  assert.ok(
    !/onMouseEnter[^\n]*setPaneHover/.test(terminalArea),
    'hover must not be tracked in React state',
  );
});
