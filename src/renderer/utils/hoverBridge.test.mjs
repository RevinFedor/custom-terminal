import test from 'node:test';
import assert from 'node:assert/strict';
import { pointInRect, pointInGap, pointInHoverCluster } from './hoverBridge.mjs';

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test('точка внутри блока и на его границе с допуском', () => {
  const r = rect(100, 100, 200, 140);
  assert.equal(pointInRect(r, 150, 120), true);
  assert.equal(pointInRect(r, 201, 120), true, 'допуск по краю');
  assert.equal(pointInRect(r, 210, 120), false);
  assert.equal(pointInRect(null, 150, 120), false);
});

test('зазор по горизонтали: курсор между правым краем панели и списком справа', () => {
  const panel = rect(100, 100, 300, 400);
  const menu = rect(306, 120, 500, 380);
  // Ровно посреди шести пикселей — там, где раньше окно закрывалось.
  assert.equal(pointInGap(panel, menu, 303, 200), true);
  // Ниже общей высоты обоих блоков — уже не зазор.
  assert.equal(pointInGap(panel, menu, 303, 460), false);
});

test('зазор по вертикали: полоска кнопок над панелью', () => {
  const rail = rect(100, 60, 300, 88);
  const panel = rect(100, 94, 300, 400);
  assert.equal(pointInGap(rail, panel, 200, 91), true);
  assert.equal(pointInGap(rail, panel, 340, 91), false, 'вбок от обоих блоков');
});

test('соприкасающиеся блоки не порождают зазор во весь охват', () => {
  const a = rect(100, 100, 300, 200);
  const b = rect(150, 150, 350, 250);
  // Пересекаются по обеим осям: мостить нечего, иначе «зазором» стал бы
  // прямоугольник 100..350 × 100..250 и окно не закрылось бы никогда.
  assert.equal(pointInGap(a, b, 320, 120), false);
});

test('курсор держит окно на панели, на открытом из неё списке и в зазоре', () => {
  const panel = rect(600, 100, 900, 500);
  const menu = rect(340, 120, 594, 460);
  const rail = rect(600, 66, 900, 94);
  const cluster = (x, y) => pointInHoverCluster({
    hub: panel,
    satellites: [rail, menu, null],
    x,
    y,
  });

  assert.equal(cluster(700, 300), true, 'панель');
  assert.equal(cluster(450, 300), true, 'список');
  assert.equal(cluster(597, 300), true, 'зазор между панелью и списком');
  assert.equal(cluster(700, 92), true, 'зазор под полоской кнопок');
  assert.equal(cluster(200, 300), false, 'левее списка — снаружи');
  assert.equal(cluster(700, 600), false, 'ниже панели — снаружи');
});

test('без панели кластера нет: закрывать нечего и держать нечем', () => {
  assert.equal(pointInHoverCluster({ hub: null, satellites: [rect(0, 0, 10, 10)], x: 5, y: 5 }), false);
});
