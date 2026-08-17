// Прокрутка бокового списка к активной строке — контракты проводки, которых
// чистое правило (tabListRevealScroll.mjs) не видит.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), 'utf8');
const tabBar = read('..', 'components', 'Workspace', 'TabBar.tsx');

test('обе точки, двигающие список, спрашивают ОДНО правило', () => {
  // Их две: автопрокрутка при смене активной вкладки и явный запрос «покажи
  // строку» (Ctrl+Tab / Cmd+P / фокус панели). Две копии арифметики разошлись
  // бы: одна прижимала бы строку к краю, другая вела к середине.
  const calls = tabBar.match(/tabListRevealScrollTop\(\{/g) || [];
  assert.equal(calls.length, 2, 'ожидаются ровно два вызова общего правила');
  // И никакой самодельной геометрии рядом (ищем ВЫЗОВЫ, не упоминания в
  // комментариях — про scrollIntoView там объяснение, почему его тут нет).
  assert.doesNotMatch(tabBar, /scrollTop = rowBottom - scroll/);
  assert.doesNotMatch(tabBar, /\.scrollIntoView\(/);
});

test('высота содержимого передаётся — без неё нельзя упереться в конец', () => {
  // Правило зажимает результат в [0, максимум прокрутки]; максимум считается
  // из scrollHeight. Забыть его — значит уехать в пустоту под последней
  // строкой, добиваясь недостижимой середины.
  const calls = tabBar.split('tabListRevealScrollTop({').slice(1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const args = call.slice(0, call.indexOf('})'));
    assert.match(args, /contentHeight: \w+\.scrollHeight/);
    assert.match(args, /viewHeight: \w+\.clientHeight/);
    assert.match(args, /viewTop: \w+\.scrollTop/);
  }
});

test('позиция меряется относительно скроллера, а не через offsetTop', () => {
  // Карточка строки лежит в своей position:relative обёртке, поэтому
  // offsetTop ≈ 0 у ВСЕХ строк: список слетал бы в начало на каждом клике.
  const calls = tabBar.split('tabListRevealScrollTop({').slice(1);
  for (const call of calls) {
    const args = call.slice(0, call.indexOf('})'));
    assert.match(args, /rowTop: rect\.top/);
    assert.match(args, /rowHeight: rect\.height/);
  }
  assert.match(tabBar, /measureVerticalRowFlipRect\(/);
});

test('запрос «покажи строку» одноразовый — по номеру, и счётчик модульный', () => {
  // Поле живёт в сторе и после обработки; без счётчика возврат в проект
  // переигрывал старый запрос и утаскивал список к вкладке прошлого визита.
  // Счётчик обязан пережить размонтирование (поход в Dashboard), поэтому он
  // модульный, а не useRef.
  assert.match(tabBar, /^let consumedTabListRevealSeq = 0;$/m);
  assert.match(tabBar, /if \(tabListRevealRequest\.seq === consumedTabListRevealSeq\) return;/);
  // Номер помечается обработанным ПОСЛЕ проверки скроллера: экземпляр без
  // списка (владелец меню чужого проекта) не должен съедать чужой запрос.
  const scrollerAt = tabBar.indexOf('// No scroller — this instance cannot handle the request');
  const consumeAt = tabBar.indexOf('consumedTabListRevealSeq = tabListRevealRequest.seq;');
  assert.ok(scrollerAt > 0 && consumeAt > scrollerAt);
});
