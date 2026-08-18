import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldWrapControlBar,
  shouldShedControlBarReadings,
  CONTROL_BAR_CLUSTER_MIN_GAP_PX,
} from './controlBarWrap.mjs';

test('wraps once the two clusters would touch', () => {
  // The reported case: a split pane at roughly half the window width, both
  // clusters at their natural size.
  assert.equal(
    shouldWrapControlBar({ availableWidth: 620, leftWidth: 380, rightWidth: 300 }),
    true,
  );
});

test('stays on one line while there is room', () => {
  assert.equal(
    shouldWrapControlBar({ availableWidth: 1300, leftWidth: 380, rightWidth: 300 }),
    false,
  );
});

test('the required gap is what decides the borderline case', () => {
  // Exactly touching, zero gap → wrap: overlapping by 0px still reads as two
  // controls glued together.
  const exact = { availableWidth: 680, leftWidth: 380, rightWidth: 300 };
  assert.equal(shouldWrapControlBar(exact), true);
  // One px of slack beyond the gap → fits.
  assert.equal(
    shouldWrapControlBar({ ...exact, availableWidth: 680 + CONTROL_BAR_CLUSTER_MIN_GAP_PX + 1 }),
    false,
  );
});

test('an unmeasured bar never wraps', () => {
  // Zeros mean "not measured yet", not "fits in nothing" — wrapping there would
  // make every bar flash two lines on mount.
  assert.equal(shouldWrapControlBar({ availableWidth: 0, leftWidth: 0, rightWidth: 0 }), false);
  assert.equal(shouldWrapControlBar({ availableWidth: 620, leftWidth: 0, rightWidth: 300 }), false);
  assert.equal(shouldWrapControlBar({ availableWidth: 620, leftWidth: 380, rightWidth: 0 }), false);
  assert.equal(
    shouldWrapControlBar({ availableWidth: NaN, leftWidth: 380, rightWidth: 300 }),
    false,
  );
});

test('a hidden bar (width 0) does not wrap', () => {
  // A collapsed/hidden container reports 0 for everything; wrapping on that would
  // leave the bar stacked when it comes back.
  assert.equal(
    shouldWrapControlBar({ availableWidth: 0, leftWidth: 380, rightWidth: 300 }),
    false,
  );
});

// ── В композере переносить нельзя: вторая строка вернула бы ту самую высоту,
//    ради которой панель туда и переехала. Вместо переноса гаснут показания. ──

test('показания гаснут, когда одна строка не вмещает всё', () => {
  assert.equal(
    shouldShedControlBarReadings({
      availableWidth: 380,
      leftWidth: 240,
      rightWidth: 200,
      readingsWidth: 70,
    }),
    true,
  );
});

test('пока места хватает, показания остаются', () => {
  assert.equal(
    shouldShedControlBarReadings({
      availableWidth: 900,
      leftWidth: 240,
      rightWidth: 200,
      readingsWidth: 70,
    }),
    false,
  );
});

test('спрятанные показания не возвращаются от того, что без них стало влезать', () => {
  // Ловушка, ради которой в правиле есть отдельный признак: спрятав показания,
  // мы сами уменьшили нужную ширину. Наивный пересчёт ответил бы «влезает», они
  // вернулись бы, ширина снова выросла — и так по кругу на одной ширине окна.
  const hiddenLeft = 240 - 70;
  assert.equal(
    shouldShedControlBarReadings({
      availableWidth: 380,
      leftWidth: hiddenLeft,
      rightWidth: 200,
      readingsWidth: 70,
      readingsHidden: true,
    }),
    true,
    'сравнивать надо с шириной, которая нужна ВМЕСТЕ с показаниями',
  );
});

test('после реального расширения окна показания возвращаются', () => {
  const hiddenLeft = 240 - 70;
  assert.equal(
    shouldShedControlBarReadings({
      availableWidth: 900,
      leftWidth: hiddenLeft,
      rightWidth: 200,
      readingsWidth: 70,
      readingsHidden: true,
    }),
    false,
  );
});

test('когда показаний нет вообще, гасить нечего', () => {
  // У Codex нет чипа кэша, у свежей вкладки нет процента контекста. Ответить
  // «прячь» здесь значило бы пообещать ширину, которой не появится.
  assert.equal(
    shouldShedControlBarReadings({
      availableWidth: 200,
      leftWidth: 240,
      rightWidth: 200,
      readingsWidth: 0,
    }),
    false,
  );
});

test('неизмеренная панель не прячет показания', () => {
  assert.equal(
    shouldShedControlBarReadings({
      availableWidth: 0,
      leftWidth: 0,
      rightWidth: 0,
      readingsWidth: 0,
    }),
    false,
  );
  assert.equal(
    shouldShedControlBarReadings({
      availableWidth: 380,
      leftWidth: 0,
      rightWidth: 200,
      readingsWidth: 70,
    }),
    false,
  );
});

test('both measurements of the same bar must agree (prod 17.08 #185)', () => {
  // Причина падения «Something went wrong» (React #185, 20:34 и 20:41): панель
  // считала ширину дважды и РАЗНЫМИ способами. Один замер суммировал детей
  // (нужная ширина), второй брал scrollWidth — а он у левого блока равен
  // выданной ширине из-за распорки в конце. На одной и той же панели два
  // ответа расходились, каждый переписывал чужой, и каждая запись давала новый
  // рендер: бесконечный круг.
  const availableWidth = 620;
  const contentLeft = 380;   // реальная сумма детей
  const scrollWidthLeft = availableWidth; // распорка растянула блок на всю ширину
  const right = 180;
  const byContent = shouldWrapControlBar({
    availableWidth, leftWidth: contentLeft, rightWidth: right,
  });
  const byScrollWidth = shouldWrapControlBar({
    availableWidth, leftWidth: scrollWidthLeft, rightWidth: right,
  });
  assert.equal(byContent, false, 'по реальной ширине содержимого — влезает');
  assert.equal(byScrollWidth, true, 'по scrollWidth — «не влезает», и это ложь');
  assert.notEqual(
    byContent, byScrollWidth,
    'расхождение и есть причина: оба замера обязаны использовать сумму детей',
  );
});

test('a stable width gives a stable answer (no oscillation)', () => {
  // Прямая проверка устойчивости: повторные замеры при неизменной ширине
  // обязаны давать один и тот же ответ, иначе круг перерисовок неизбежен.
  const args = { availableWidth: 620, leftWidth: 380, rightWidth: 300 };
  const answers = new Set([
    shouldWrapControlBar(args),
    shouldWrapControlBar(args),
    shouldWrapControlBar(args),
  ]);
  assert.equal(answers.size, 1);
});
