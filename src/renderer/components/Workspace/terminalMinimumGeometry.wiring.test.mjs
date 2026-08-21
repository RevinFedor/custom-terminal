// Минимальная геометрия терминала — места, где она встречается с раскладкой.
//
// Само правило живёт в utils/terminalMinimumGeometry.mjs и покрыто там. Здесь
// закреплено то, что чистая модель проверить не может: что терминал действительно
// перестал зависеть от размера окна, а обрезка названа вслух.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const terminal = fs.readFileSync(path.join(here, 'Terminal.tsx'), 'utf8');
const frame = fs.readFileSync(path.join(here, 'FloatingTerminalFrame.tsx'), 'utf8');

test('размер терминала считает НАШЕ правило, а не пол fit-адаптера', () => {
  // fit.fit() зажимает 2 колонки × 1 строку: в маленьком окне терминал
  // формально «помещался», но пользоваться им было нельзя.
  assert.match(terminal, /resolveTerminalGeometry\(fit\.proposeDimensions\(\)\)/);
  assert.doesNotMatch(terminal, /^\s*fit\.fit\(\);\s*$/m, 'fit.fit() снова вернул бы чужой минимум');
  // Ровно одна точка, где РЕШАЕТСЯ размер: два измерителя разошлись бы, и PTY
  // с канвой переносили бы строки по-разному. Второй вызов — диагностический
  // снимок «что предлагал измеритель» в логе активации, он ничего не применяет.
  const calls = (terminal.match(/[\w?.]*\.proposeDimensions\(\)/g) || []);
  assert.deepEqual(calls, ['fit.proposeDimensions()', 'fit?.proposeDimensions()']);
});

test('смена размера чистит рендерер — это делал fit-адаптер за нас', () => {
  assert.match(
    terminal,
    /_renderService\?\.clear\(\);[\s\S]{0,200}term\.resize\(geometry\.cols, geometry\.rows\)/,
  );
});

test('PTY получает ровно применённый размер', () => {
  assert.match(terminal, /cols: colsAfter,\s*\n\s*rows: rowsAfter,/);
});

test('терминал не помещается — об этом сказано, а не спрятано', () => {
  assert.match(terminal, /setTerminalClipped\(geometry\.clipped\)/);
  assert.match(terminal, /data-terminal-clipped=\{tabId\}/);
  assert.match(terminal, /терминал не помещается/);
  // Сообщение, а не орган управления: кликов не ловит.
  assert.match(terminal, /data-terminal-clipped=\{tabId\}[\s\S]{0,600}pointerEvents: 'none'/);
});

test('боковой терминал не ужимается под узкое окно', () => {
  // maxWidth:100% послушно сжимал панель вместе с терминалом — в узком окне
  // «боковой терминал открывается, а там нихуя нет».
  assert.match(frame, /maxWidth: 'none',/);
  assert.doesNotMatch(frame, /maxWidth: '100%',/);
});
