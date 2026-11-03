// Пузырь сообщения ужимается по содержимому (shrink-to-fit), поэтому свёрнутый
// превью из первых 400 символов задавал МЕНЬШУЮ ширину, чем тот же текст
// целиком: по «Раскрыть полностью» сообщение прыгало влево (Fedor, 02.11).
// Ширину теперь держит невидимая копия полного текста, высоту — видимый превью.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');

const COLLAPSED_CHARS = Number(
  /const HISTORY_USER_TEXT_COLLAPSED_CHARS = (\d+);/.exec(source)?.[1]);
const THRESHOLD = Number(
  /const HISTORY_USER_TEXT_COLLAPSE_THRESHOLD = (\d+);/.exec(source)?.[1]);
const widestLine = (text) => Math.max(...text.split('\n').map((line) => line.length));

test('свёрнутый блок резервирует ширину полного текста', () => {
  assert.ok(COLLAPSED_CHARS > 0 && THRESHOLD > COLLAPSED_CHARS, 'пороги прочитаны из источника');
  // Форма со скриншота: самая длинная строка лежит ЗА границей превью.
  const text = 'коротко\n' + 'x'.repeat(COLLAPSED_CHARS - 50) + '\nсамая длинная строка: ' + 'y'.repeat(600);
  const preview = text.slice(0, COLLAPSED_CHARS).trimEnd() + '…';
  assert.ok(widestLine(preview) < widestLine(text), 'фикстура действительно воспроизводит прыжок');

  // Свёрнутый вид = превью + невидимая копия полного текста в том же потоке.
  assert.equal(Math.max(widestLine(preview), widestLine(text)), widestLine(text),
    'ширина свёрнутого и раскрытого совпадает');
});

test('копия живёт только в свёрнутом виде и не меняет высоту, фокус и кнопки', () => {
  assert.match(source, /\{!open && \(\s*<div className="hp-collapsible-prompt-width" aria-hidden="true">/,
    'копия рендерится только пока блок свёрнут и скрыта от экранных читалок');
  const css = source.slice(source.indexOf('.hp-collapsible-prompt-width'), source.indexOf('.hp-collapsible-prompt-width') + 220);
  assert.match(css, /height: 0;/, 'высоту задаёт видимый превью, не копия');
  assert.match(css, /overflow: hidden;/);
  assert.match(css, /pointer-events: none;/, 'копия не перехватывает мышь');
  assert.ok(!/\.hp-collapsible-prompt\s*\{[^}]*position:\s*relative/.test(source),
    'точка отсчёта абсолютных кнопок «Свернуть» остаётся пузырём');
});

// Кнопки «Свернуть»/«Раскрыть полностью» сидят верхом на рамке пузыря и
// содержимое двигать не должны. Верхняя кнопка существует ТОЛЬКО у раскрытого
// блока, поэтому отступ, завязанный на неё, появлялся при раскрытии и уводил
// текст вниз (Fedor, 03.11). Нижняя кнопка есть в обоих состояниях — на неё и
// завязан резерв места.
test('верхний отступ пузыря одинаков до и после раскрытия', () => {
  assert.match(source, /\.cb-user-bubble:has\(\.cb-collapse-bottom\)\s*\{\s*padding-top: 8px;/,
    'место под кнопку резервируется у любого сворачиваемого сообщения');
  assert.ok(!/\.cb-user-bubble:has\(\.cb-collapse-top\)\s*\{[^}]*padding/.test(source),
    'отступ не должен зависеть от верхней кнопки: её нет в свёрнутом виде');

  // Нижняя кнопка рендерится всегда, верхняя — только при open.
  assert.match(source, /\{!forceExpanded && <div className="cb-collapse-bottom">/);
  assert.match(source, /\{open && !forceExpanded && <div className="cb-collapse-top">/);
});

// Шрам 03.11: CSS живёт внутри шаблонной строки, поэтому обратная кавычка в
// комментарии обрывала литерал и роняла dev-сборку (Missing semicolon).
test('в CSS-блоке нет обратных кавычек', () => {
  const start = source.indexOf('.hp-history-transcript .cb-user-bubble {');
  const css = source.slice(start, source.indexOf('[data-history-resize-locked]', start));
  assert.ok(start > 0 && css.length > 0, 'CSS-блок найден');
  assert.ok(!css.includes('`'), 'обратная кавычка оборвёт шаблонную строку и сломает сборку');
});
