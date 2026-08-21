import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  resolveTerminalGeometry,
} from './terminalMinimumGeometry.mjs';

test('места хватает — берём измеренное, обрезки нет', () => {
  const res = resolveTerminalGeometry({ cols: 120, rows: 40 });
  assert.deepEqual(
    res,
    { cols: 120, rows: 40, clippedX: false, clippedY: false, clipped: false },
  );
});

test('окно уже минимума — терминал шире окна и честно об этом говорит', () => {
  const res = resolveTerminalGeometry({ cols: 12, rows: 40 });
  assert.equal(res.cols, TERMINAL_MIN_COLS);
  assert.equal(res.rows, 40);
  assert.equal(res.clippedX, true);
  assert.equal(res.clippedY, false);
  assert.equal(res.clipped, true);
});

test('окно ниже минимума — терминал выходит за нижний край', () => {
  const res = resolveTerminalGeometry({ cols: 120, rows: 4 });
  assert.equal(res.rows, TERMINAL_MIN_ROWS);
  assert.equal(res.clippedY, true);
});

test('окно 50×50 пикселей — терминал всё равно рабочий', () => {
  const res = resolveTerminalGeometry({ cols: 2, rows: 1 });
  assert.deepEqual(
    { cols: res.cols, rows: res.rows, clipped: res.clipped },
    { cols: TERMINAL_MIN_COLS, rows: TERMINAL_MIN_ROWS, clipped: true },
  );
});

test('мерить пока нечего — отдаём минимум, но обрезкой это не называем', () => {
  for (const empty of [null, undefined, { cols: 0, rows: 0 }, { cols: NaN, rows: NaN }]) {
    const res = resolveTerminalGeometry(empty);
    assert.equal(res.cols, TERMINAL_MIN_COLS);
    assert.equal(res.rows, TERMINAL_MIN_ROWS);
    assert.equal(res.clipped, false, 'нулевой бокс — это «ещё не мерили», а не «не влезло»');
  }
});

test('минимум можно задать снаружи; нулевым он не становится и измеренное не уменьшает', () => {
  assert.equal(resolveTerminalGeometry({ cols: 5, rows: 5 }, { cols: 80, rows: 30 }).cols, 80);
  // Минимум только поднимает: обнулить его — значит вернуться к измеренному,
  // а не сжать терминал до одной колонки.
  const zeroed = resolveTerminalGeometry({ cols: 5, rows: 5 }, { cols: 0, rows: 0 });
  assert.deepEqual({ cols: zeroed.cols, rows: zeroed.rows, clipped: zeroed.clipped },
    { cols: 5, rows: 5, clipped: false });
});

test('высота минимума примерно вдвое меньше ширины', () => {
  assert.ok(TERMINAL_MIN_ROWS * 2 <= TERMINAL_MIN_COLS + 12);
  assert.ok(TERMINAL_MIN_ROWS * 2 >= TERMINAL_MIN_COLS - 12);
});
