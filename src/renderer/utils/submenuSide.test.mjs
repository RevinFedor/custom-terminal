import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubmenuSide, submenuArrow, WIDEST_SUBMENU_WIDTH } from './submenuSide.mjs';

test('места справа хватает — раскрываемся вправо', () => {
  assert.equal(resolveSubmenuSide({
    menuLeft: 100, menuRight: 400, submenuWidth: 280, viewportWidth: 1000,
  }), 'right');
});

test('у правого края уходим влево', () => {
  // Меню кончается в 700, до края 100 — список шириной 280 не поместится.
  assert.equal(resolveSubmenuSide({
    menuLeft: 400, menuRight: 700, submenuWidth: 280, viewportWidth: 800,
  }), 'left');
});

test('решение принимается по САМОМУ ШИРОКОМУ списку, а не по каждому своему', () => {
  const geometry = { menuLeft: 400, menuRight: 700, viewportWidth: 900 };
  // Узкий список справа помещается…
  assert.equal(resolveSubmenuSide({ ...geometry, submenuWidth: 160 }), 'right');
  // …а широкий — уже нет. Меню одно, поэтому вправо уходят оба или ни один:
  // соседние строки, раскрывающиеся в разные стороны, заставляют искать список
  // заново на каждой.
  assert.equal(resolveSubmenuSide({ ...geometry, submenuWidth: WIDEST_SUBMENU_WIDTH }), 'left');
});

test('не помещается нигде — туда, где обрежется меньше', () => {
  // Слева 300, справа 100: слева видно больше.
  assert.equal(resolveSubmenuSide({
    menuLeft: 308, menuRight: 500, submenuWidth: 400, viewportWidth: 608,
  }), 'left');
  // Зеркальный случай.
  assert.equal(resolveSubmenuSide({
    menuLeft: 108, menuRight: 300, submenuWidth: 400, viewportWidth: 608,
  }), 'right');
});

test('вплотную к границе места — ещё помещается', () => {
  const geometry = { menuLeft: 400, menuRight: 700, submenuWidth: 280 };
  assert.equal(
    resolveSubmenuSide({ ...geometry, viewportWidth: 988 }),
    'right',
    'ровно 280 свободных пикселей плюс отступ',
  );
  assert.equal(
    resolveSubmenuSide({ ...geometry, viewportWidth: 987 }),
    'left',
    'на пиксель меньше — уже нет',
  );
});

test('стрелка обещает ту же сторону, куда откроется список', () => {
  assert.equal(submenuArrow('right'), '›');
  assert.equal(submenuArrow('left'), '‹');
});
