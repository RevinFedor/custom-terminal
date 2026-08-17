import assert from 'node:assert/strict';
import test from 'node:test';

import { tabListRevealScrollTop } from './tabListRevealScroll.mjs';

// Список: окно 300px, строки по 30px, содержимого на 1000px (максимум
// прокрутки = 700).
const list = { viewHeight: 300, rowHeight: 30, contentHeight: 1000 };

test('строка стремится в СЕРЕДИНУ окна', () => {
  // Строка на 500, окно стоит в самом верху — она не видна.
  const next = tabListRevealScrollTop({ ...list, rowTop: 500, viewTop: 0 });
  // Над строкой и под ней должно остаться поровну: (300 - 30) / 2 = 135.
  assert.equal(next, 365);
  const topInView = 500 - next;
  assert.equal(topInView, 135);
  assert.equal(list.viewHeight - (topInView + list.rowHeight), 135, 'снизу столько же');
});

test('у НАЧАЛА списка середина недостижима — упираемся в верх, без пустоты', () => {
  // Вторая строка при прокрученном вниз списке: центр требовал бы
  // отрицательного scrollTop.
  const next = tabListRevealScrollTop({ ...list, rowTop: 30, viewTop: 700 });
  assert.equal(next, 0);
});

test('у КОНЦА списка — упираемся в низ, лишнего скролла нет', () => {
  // Последняя строка (970..1000) при списке в самом верху.
  const next = tabListRevealScrollTop({ ...list, rowTop: 970, viewTop: 0 });
  assert.equal(next, 700, 'ровно максимум прокрутки, не дальше');
});

test('строка, которую видно целиком, список не двигает', () => {
  // Окно 300..600, строка 400..430 — внутри.
  assert.equal(tabListRevealScrollTop({ ...list, rowTop: 400, viewTop: 300 }), null);
  // Ровно у верхнего края видимой области — тоже видно целиком.
  assert.equal(tabListRevealScrollTop({ ...list, rowTop: 300, viewTop: 300 }), null);
  // И у нижнего.
  assert.equal(tabListRevealScrollTop({ ...list, rowTop: 570, viewTop: 300 }), null);
});

test('частично видимая строка центрируется', () => {
  // Окно 300..600, строка 585..615 — торчит снизу.
  const next = tabListRevealScrollTop({ ...list, rowTop: 585, viewTop: 300 });
  assert.equal(next, 450);
});

test('список короче окна — прокручивать нечего', () => {
  assert.equal(tabListRevealScrollTop({
    viewHeight: 300, rowHeight: 30, contentHeight: 200, rowTop: 60, viewTop: 0,
  }), null);
});

test('уже стоим ровно там, куда собирались, — null вместо повторной записи', () => {
  const next = tabListRevealScrollTop({ ...list, rowTop: 500, viewTop: 0 });
  assert.equal(tabListRevealScrollTop({ ...list, rowTop: 500, viewTop: next }), null);
});

test('строка выше окна тоже идёт в середину, а не прижимается к верху', () => {
  // Окно 600..900, строка 100..130.
  const next = tabListRevealScrollTop({ ...list, rowTop: 100, viewTop: 600 });
  assert.equal(next, 0, 'ближе к началу списка, чем половина окна — упор в верх');
  // А из середины списка — честный центр.
  const mid = tabListRevealScrollTop({ ...list, rowTop: 400, viewTop: 700 });
  assert.equal(mid, 265);
});
