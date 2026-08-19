// Вложенный список меню вкладки не должен уезжать за край окна.
//
// Корневое меню открывается у курсора и умеет вжиматься в окно. О вложенном это
// не говорит ничего: оно живёт правее строки, которая его открыла, и у правого
// края просто уходит за границу — «Move to window» показывал окна наполовину
// срезанными. Сторона была записана в разметке одиннадцать раз, поэтому не
// могла зависеть от того, где меню оказалось.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'TabBar.tsx'), 'utf8');

test('сторона вложенных списков не записана в разметке', () => {
  assert.ok(
    !/absolute left-full/.test(source),
    'вернулась запись стороны прямо в классах — у края окна список снова уедет',
  );
  const dynamic = (source.match(/submenuSide === 'left'/g) || []).length;
  assert.ok(dynamic >= 11, `подменю со считаемой стороной: ${dynamic}, ожидалось не меньше 11`);
});

test('решение принимается ПОСЛЕ того, как корневое меню вжато в окно', () => {
  // По прежнему положению первое открытие у края решало бы по координатам
  // предыдущего.
  const clampAt = source.indexOf('const { x, y } = clampMenuToViewport({');
  const sideAt = source.indexOf('setSubmenuSide(resolveSubmenuSide({');
  assert.ok(clampAt > 0 && sideAt > clampAt, 'сторона считается до вжатия меню в окно');
  const call = source.slice(sideAt, sideAt + 320);
  assert.match(call, /menuLeft: x,/);
  assert.match(call, /menuRight: x \+ rect\.width,/);
  assert.match(source, /submenuWidth: WIDEST_SUBMENU_WIDTH/);
});

test('стрелка строки обещает ту сторону, куда откроется список', () => {
  const arrows = (source.match(/submenuArrow\(submenuSide\)/g) || []).length;
  assert.ok(arrows >= 11, `стрелок, следующих за стороной: ${arrows}, ожидалось не меньше 11`);
  // Стрелка вправо, оставленная в строке с подменю, соврала бы при левом
  // раскрытии — направление обещано, и обещание обязано совпасть.
  for (const glyph of ['>›<', ">{'\\u203A'}<", ">{'›'}<"]) {
    assert.ok(!source.includes(glyph), `осталась записанная стрелка: ${glyph}`);
  }
});
