import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../..');
const panel = fs.readFileSync(
  path.join(repoRoot, 'renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

/**
 * Кнопка состояния агента под курсором меняет вид: показывает, что случится по
 * клику («остановить» / «запустить») вместо того, что происходит сейчас.
 *
 * Инцидент 2026-08-18: подсветка ЗАЛИПАЛА. Пользователь наводил курсор, уходил
 * на другую вкладку — и там кнопка продолжала показывать «остановить», пока он
 * снова не наведётся на неё и не уведёт курсор.
 *
 * Причина (замерено в Chromium): состояние «курсор над кнопкой» хранилось в
 * памяти и поднималось/опускалось по событиям входа и ухода. Когда узел кнопки
 * УДАЛЯЮТ из документа прямо под курсором — а это происходит при каждом
 * перестроении разметки: смена владельца истории, вход и выход из сплита,
 * переключение вкладок — события ухода не приходит вовсе: уходить уже неоткуда.
 * Флаг оставался поднятым, а новый узел получал его уже поднятым.
 *
 * Замер сравнил два способа на одном и том же сценарии:
 *   узел удалён под курсором → курсор ушёл → узел создан заново
 *     • флаг в памяти: остался поднятым (залипание);
 *     • :hover:          false (верно).
 * И на обратном: курсор вернулся — подсветка появилась снова.
 *
 * Разница принципиальная, а не в качестве реализации: :hover — не запомненный
 * факт, а ответ на вопрос «курсор над этим узлом сейчас», и у нового узла он
 * вычисляется заново. Поэтому лечение — отдать решение браузеру, а не добавлять
 * сбросы флага в местах, где мы догадались, что узел исчезает.
 */

/** Разметка самой кнопки: `<button ... data-agent-status-row`, а не селектор
 *  `[data-agent-status-row]` из таблицы стилей, который идёт в файле раньше. */
const buttonMarkup = () => {
  const start = panel.indexOf('\n          data-agent-status-row\n');
  assert.ok(start > 0, 'разметка кнопки состояния должна существовать');
  const end = panel.indexOf('</button>', start);
  assert.ok(end > start);
  return panel.slice(start, end);
};

test('состояния «курсор над кнопкой» в памяти больше нет', () => {
  // Любой возврат к флагу возвращает залипание: невозможно перечислить все
  // места, где узел удаляют под курсором.
  assert.doesNotMatch(panel, /statusHover/);
  const button = buttonMarkup();
  assert.doesNotMatch(button, /onMouseEnter/, 'подсветку решает браузер, не обработчик');
  assert.doesNotMatch(button, /onMouseLeave/, 'обработчик ухода не срабатывает при удалении узла');
});

test('подсветка и оба значка переключаются одним и тем же правилом', () => {
  // Через :hover, поэтому «что случится по клику» и «что происходит сейчас»
  // не могут разойтись во времени: не бывает кадра с обоими значками сразу.
  assert.match(panel, /\[data-agent-status-row\]\[data-agent-status-action='stop'\]:hover \{\s*\n\s*background-color: rgba\(220, 38, 38, 0\.20\);/);
  assert.match(panel, /\[data-agent-status-row\]\[data-agent-status-action='start'\]:hover \{\s*\n\s*background-color: rgba\(255, 255, 255, 0\.08\);/);
  assert.match(panel, /\[data-agent-status-row\] > \[data-agent-status-hover-glyph\] \{ display: none; \}/);
  assert.match(panel, /\[data-agent-status-row\]:hover > \[data-agent-status-hover-glyph\] \{ display: block; \}/);
});

test('кнопка не остаётся пустой, пока действие не определено', () => {
  // В этом состоянии значка действия нет вовсе. Безусловное правило «под
  // курсором прячем значок состояния» оставило бы пустой квадрат.
  assert.match(
    panel,
    /\[data-agent-status-row\]\[data-agent-status-action='stop'\]:hover > \[data-agent-status-idle-glyph\],\s*\n\[data-agent-status-row\]\[data-agent-status-action='start'\]:hover > \[data-agent-status-idle-glyph\] \{\s*\n\s*display: none;/,
  );
});

test('встроенный фон не перебивает правило подсветки', () => {
  // Поймано замером: значки менялись, а фон — нет. Встроенный стиль сильнее
  // правила из таблицы, поэтому даже `transparent` здесь ломает подсветку.
  // Только СОБСТВЕННЫЙ стиль кнопки. У значка «стоп» внутри свой фон — он
  // законен: правило подсветки красит кнопку, а не значок.
  const button = buttonMarkup();
  const ownStyleStart = button.indexOf('style={{');
  assert.ok(ownStyleStart > 0);
  const ownStyle = button.slice(ownStyleStart, button.indexOf('}}\n', ownStyleStart));
  assert.doesNotMatch(ownStyle, /\bbackground: /);
  assert.doesNotMatch(ownStyle, /\bbackgroundColor: /);
  // И сам факт, что фон отдан таблице стилей, зафиксирован в коде.
  assert.match(button, /Фон здесь НЕ задаётся вовсе/);
});

test('оба значка присутствуют в разметке одновременно', () => {
  // Видимостью распоряжается только браузер; если значок действия рисовать по
  // условию в коде, вернётся исходная зависимость от состояния в памяти.
  assert.match(panel, /data-agent-status-hover-glyph/);
  assert.match(panel, /data-agent-status-idle-glyph/);
});
