import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupStripByProject,
  resolveStripOverflow,
  scrollOffsetForChip,
} from './paneStripLayout.mjs';

const e = (projectId, tabId) => ({ projectId, tabId });

test('иконка проекта одна на подряд идущие вкладки', () => {
  const runs = groupStripByProject([e('p1', 'a'), e('p1', 'b'), e('p2', 'c')]);
  assert.deepEqual(runs, [
    { projectId: 'p1', tabIds: ['a', 'b'] },
    { projectId: 'p2', tabIds: ['c'] },
  ]);
});

test('порядок полосы не переставляется ради иконок', () => {
  // Тот же проект по обе стороны чужого — ДВЕ группы, а не одна.
  // Полоса это карта, которую расставил человек; склейка ради экономии иконки
  // переставила бы его вкладки.
  const runs = groupStripByProject([e('p1', 'a'), e('p2', 'b'), e('p1', 'c')]);
  assert.deepEqual(runs.map((r) => r.projectId), ['p1', 'p2', 'p1']);
});

test('скрытые вкладки считаются с двух сторон отдельно', () => {
  const chips = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
    { left: 300, width: 100 },
  ];
  // Окно 100..300: первая ушла влево, последняя не влезла справа.
  assert.deepEqual(
    resolveStripOverflow({ chips, scrollLeft: 100, viewportWidth: 200 }),
    { hiddenLeft: 1, hiddenRight: 1 },
  );
  // Всё видно — счётчиков нет.
  assert.deepEqual(
    resolveStripOverflow({ chips, scrollLeft: 0, viewportWidth: 400 }),
    { hiddenLeft: 0, hiddenRight: 0 },
  );
});

test('частично видимая вкладка НЕ считается скрытой', () => {
  const chips = [{ left: 0, width: 100 }, { left: 100, width: 100 }];
  // Вторая видна наполовину — её видно и по ней можно кликнуть, значит она не
  // «скрыта». Иначе её назвали бы дважды: и полоской на экране, и числом.
  assert.deepEqual(
    resolveStripOverflow({ chips, scrollLeft: 0, viewportWidth: 150 }),
    { hiddenLeft: 0, hiddenRight: 0 },
  );
});

test('вкладка вплотную к краю не мигает в счётчике', () => {
  const chips = [{ left: 0, width: 100.4 }, { left: 100.4, width: 100 }];
  assert.equal(
    resolveStripOverflow({ chips, scrollLeft: 100, viewportWidth: 200 }).hiddenLeft,
    1,
  );
});

test('показанная вкладка подтягивается в видимую часть, но не дёргается зря', () => {
  const view = { scrollLeft: 100, viewportWidth: 200 };
  // Уже целиком видна — сдвига нет.
  assert.equal(scrollOffsetForChip({ chip: { left: 120, width: 60 }, ...view }), 100);
  // Ушла влево — подтягиваем ровно настолько, чтобы показалась.
  assert.equal(scrollOffsetForChip({ chip: { left: 40, width: 60 }, ...view }), 32);
  // Не влезла справа — так же минимально.
  assert.equal(scrollOffsetForChip({ chip: { left: 280, width: 60 }, ...view }), 148);
});
