import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTabCardBackground,
  resolveTabCardTextColor,
  resolveTabCardMetrics,
  resolveSplitAttachRowHeight,
  resolveTabCardBoxHeight,
  resolveTabCardBottomOverhang,
  SPLIT_ATTACH_PATH_LINE_H,
  TAB_CARD_LINE_HEIGHT,
} from './tabCardVisual.mjs';

// Stand-in for tabChrome's adjustRgbaAlpha: records what was asked of it, so
// the tests can assert "brightened ITS OWN colour" rather than a literal.
const adjust = (color, delta) => `${color}+${delta}`;

test('an uncoloured tab gets a neutral tint on hover', () => {
  assert.equal(
    resolveTabCardBackground({ bgColor: 'transparent', hasColor: false, hovered: true }, adjust),
    'rgba(255,255,255,0.12)',
  );
});

// THE BUG: the pane header painted a flat white wash over the tab on hover, so
// a green tab flashed a washed-out grey-green and read as a different widget
// than the same tab in the sidebar. Hover must brighten the tab's own colour.
test('a coloured tab brightens its OWN colour on hover, never a white wash', () => {
  const bg = resolveTabCardBackground({ bgColor: 'rgba(16,80,60,0.5)', hasColor: true, hovered: true }, adjust);
  assert.equal(bg, 'rgba(16,80,60,0.5)+0.08');
  assert.ok(!bg.includes('255,255,255'), 'hover must not replace the colour with white');
});

test('active outranks hover and selected', () => {
  assert.equal(
    resolveTabCardBackground({ bgColor: 'c', hasColor: true, active: true, hovered: true, selected: true }, adjust),
    'c+0.25',
  );
});

test('selected outranks hover', () => {
  assert.equal(
    resolveTabCardBackground({ bgColor: 'c', hasColor: true, selected: true, hovered: true }, adjust),
    'c+0.1',
  );
});

test('a resting coloured tab shows its colour unchanged', () => {
  assert.equal(resolveTabCardBackground({ bgColor: 'c', hasColor: true }, adjust), 'c');
});

test('a resting uncoloured tab keeps a faint plate, not transparency', () => {
  assert.equal(resolveTabCardBackground({ bgColor: 'transparent', hasColor: false }, adjust), 'rgba(255,255,255,0.04)');
});

test('the name is dim at rest and bright once the card matters', () => {
  assert.equal(resolveTabCardTextColor({}), '#888');
  assert.equal(resolveTabCardTextColor({ hovered: true }), '#fff');
  assert.equal(resolveTabCardTextColor({ active: true }), '#fff');
  assert.equal(resolveTabCardTextColor({ selected: true }), '#fff');
});

const geo = { paddingX: 6, paddingY: 3, paddingLeft: 16, borderRadius: 6, gap: 4 };

test('metrics come from the user settings, not from per-surface literals', () => {
  const m = resolveTabCardMetrics(geo, { fontSize: 14 });
  assert.equal(m.borderRadius, 6);
  assert.equal(m.fontSize, 14);
  assert.equal(m.padding, '3px 6px 3px 6px');
});

test('a status marker widens the left inset so the name clears it', () => {
  assert.equal(resolveTabCardMetrics(geo, { fontSize: 14, hasStatusMarker: true }).padding, '3px 6px 3px 16px');
});

test('a visible task lane shifts padding up, keeping the text centred', () => {
  assert.equal(resolveTabCardMetrics(geo, { fontSize: 14, showTaskLane: true }).padding, '1px 6px 5px 6px');
});

// THE OTHER BUG: the squares sat inside the card's bottom edge instead of
// across it. They mark the boundary — sitting fully inside says nothing.
test('the task lane hangs BELOW the bottom edge, not inside it', () => {
  assert.ok(resolveTabCardMetrics(geo, { fontSize: 14, showTaskLane: true }).laneBottomPx < 0);
});

test('the overhang never reaches the next card', () => {
  const m = resolveTabCardMetrics({ ...geo, gap: 4 }, { fontSize: 14, nextCardClearancePx: 1 });
  assert.equal(m.laneBottomPx, -3); // 4px gap − 1px clearance
});

test('with no gap between cards the lane stops overhanging entirely', () => {
  assert.equal(resolveTabCardMetrics({ ...geo, gap: 0 }, { fontSize: 14 }).laneBottomPx, 0);
});

test('missing or broken settings degrade to defaults instead of NaN', () => {
  const m = resolveTabCardMetrics(undefined, {});
  assert.equal(m.padding, '3px 6px 3px 6px');
  assert.equal(m.fontSize, 14);
  assert.ok(Number.isFinite(m.laneBottomPx));
  const bad = resolveTabCardMetrics({ paddingX: 'x', gap: null }, { fontSize: 'y' });
  assert.ok(!bad.padding.includes('NaN'));
  assert.equal(bad.fontSize, 14);
});

// ── attach-row height ──────────────────────────────────────────────────────

// The frozen contract: default Settings land EXACTLY on the classic 26px, so
// shipping this change moves nothing for anyone who has not touched Размеры.
test('attach row is exactly the classic 26 at default settings', () => {
  assert.equal(resolveSplitAttachRowHeight(geo, { fontSize: 14 }), 26);
  assert.equal(resolveSplitAttachRowHeight(undefined, {}), 26);
});

// THE BUG: the row was a hard 26 while the chip obeys Settings — a taller chip
// overflowed the row over the pane separator above, and which of the two drew
// on top flipped with focus (sibling paint order). The row must always contain
// the chip it hosts.
test('a chip made taller by settings grows the row instead of overflowing it', () => {
  const bigFont = resolveSplitAttachRowHeight(geo, { fontSize: 18 });
  const chipH = Math.ceil(18 * TAB_CARD_LINE_HEIGHT) + 3 * 2 + 2;
  assert.ok(bigFont >= chipH, `row ${bigFont} must fit chip ${chipH}`);
  assert.ok(bigFont > 26);

  const bigPad = resolveSplitAttachRowHeight({ ...geo, paddingY: 8 }, { fontSize: 14 });
  assert.ok(bigPad >= Math.ceil(14 * TAB_CARD_LINE_HEIGHT) + 8 * 2 + 2);
});

test('a chip made smaller than the classic row does not shrink the row', () => {
  assert.equal(resolveSplitAttachRowHeight({ ...geo, paddingY: 0 }, { fontSize: 10 }), 26);
});

test('broken settings degrade to the default 26, never NaN', () => {
  assert.equal(resolveSplitAttachRowHeight({ paddingY: 'x' }, { fontSize: 'y' }), 26);
  assert.equal(
    resolveSplitAttachRowHeight({ paddingY: 'x' }, { fontSize: 'y', withPath: true }),
    26 + resolveTabCardBottomOverhang({ gap: 'x' }) + SPLIT_ATTACH_PATH_LINE_H,
  );
});

// Живой баг (2026-08-18): зелёное число заполнения контекста легло НА строку
// пути — на скриншоте оно сидело поперёк хвоста «…/custom-terminal».
//
// Метки карточки свисают ниже её коробки НАМЕРЕННО: полоска квадратов, которая
// заканчивается внутри карточки, ничего не говорит о границе. В боковом списке
// они свисают в зазор перед следующей карточкой, и зазор их же и ограничивает.
// Под чипом в шапке следующей карточки нет — там строка пути, и место под
// свес надо зарезервировать.
test('шапка резервирует место под свес меток чипа', () => {
  const overhang = resolveTabCardBottomOverhang(geo);
  assert.ok(overhang > 0, 'при обычном зазоре метки свисают');
  const chipOnly = resolveSplitAttachRowHeight(geo, { fontSize: 14 });
  const withPath = resolveSplitAttachRowHeight(geo, { fontSize: 14, withPath: true });
  assert.equal(withPath, chipOnly + overhang + SPLIT_ATTACH_PATH_LINE_H);
});

test('свес ограничен зазором между карточками — тем же, что и в списке', () => {
  // Ноль зазора — метки не выходят наружу, и резервировать нечего.
  assert.equal(resolveTabCardBottomOverhang({ gap: 0 }), 0);
  // Меньше свеса — свес обрезается зазором, а не наоборот.
  assert.equal(resolveTabCardBottomOverhang({ gap: 2 }), 2);
  // Больше — упирается в долю самой метки (полоска задач: зазор минус 1px,
  // который она оставляет соседней карточке).
  assert.equal(resolveTabCardBottomOverhang({ gap: 10 }), 9);
  assert.equal(resolveTabCardBottomOverhang(undefined), 3);
});

// The path line moved INTO the header (2026-08-17, from a full-width row of its
// own). Whoever positions content below the header must get the whole height
// from this one resolver — a second line the callers do not know about is the
// same bug as the old hard-coded 26, one line lower.
test('the path line is part of the header height, on top of the chip row', () => {
  const seam = resolveTabCardBottomOverhang(geo) + SPLIT_ATTACH_PATH_LINE_H;
  const withoutPath = resolveSplitAttachRowHeight(geo, { fontSize: 14 });
  const withPath = resolveSplitAttachRowHeight(geo, { fontSize: 14, withPath: true });
  assert.equal(withPath, withoutPath + seam);
  // …and it rides on the SETTINGS-derived row, not on the 26 floor: a taller
  // chip must still fit above the path.
  const bigWithPath = resolveSplitAttachRowHeight(geo, { fontSize: 18, withPath: true });
  assert.equal(bigWithPath, resolveSplitAttachRowHeight(geo, { fontSize: 18 }) + seam);
  assert.ok(bigWithPath > withPath);
});

test('высота чипа — ОДИН ответ и для строки, и для кнопок рядом с ней', () => {
  // Кнопки окна равняются по чипу, а не по всей шапке: в режиме переноса она
  // выше на столько строк, сколько заняли вкладки. Пока обе высоты выводятся
  // из одной функции, разойтись им негде; второе вычисление рядом с кнопками
  // и есть способ их развести.
  const geo = { paddingY: 3, gap: 4 };
  const chip = resolveTabCardBoxHeight(geo, { fontSize: 14 });
  assert.equal(chip, 25);
  // Строка = чип + 1px воздуха, но не ниже классических 26.
  assert.equal(resolveSplitAttachRowHeight(geo, { fontSize: 14 }), Math.max(26, chip + 1));
  // Растёт вместе с настройками — тем же шагом, что и строка.
  const bigChip = resolveTabCardBoxHeight(geo, { fontSize: 18 });
  assert.ok(bigChip > chip);
  assert.equal(resolveSplitAttachRowHeight(geo, { fontSize: 18 }), Math.max(26, bigChip + 1));
  // Мусор на входе не роняет: те же значения по умолчанию, что у строки.
  assert.equal(resolveTabCardBoxHeight({ paddingY: 'x' }, { fontSize: 'y' }), 25);
});
