import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupOverflowByKind,
  groupStripByProject,
  paneStripOverflowStateKey,
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
  const clipped = resolveStripOverflow({ chips, scrollLeft: 100, viewportWidth: 200 });
  assert.equal(clipped.hiddenLeft, 1);
  assert.equal(clipped.hiddenRight, 1);
  // Всё видно — счётчиков нет.
  const whole = resolveStripOverflow({ chips, scrollLeft: 0, viewportWidth: 400 });
  assert.equal(whole.hiddenLeft, 0);
  assert.equal(whole.hiddenRight, 0);
});

test('частично видимая вкладка НЕ считается скрытой', () => {
  const chips = [{ left: 0, width: 100 }, { left: 100, width: 100 }];
  // Вторая видна наполовину — её видно и по ней можно кликнуть, значит она не
  // «скрыта». Иначе её назвали бы дважды: и полоской на экране, и числом.
  const half = resolveStripOverflow({ chips, scrollLeft: 0, viewportWidth: 150 });
  assert.equal(half.hiddenLeft, 0);
  assert.equal(half.hiddenRight, 0);
});

test('вкладка вплотную к краю не мигает в счётчике', () => {
  const chips = [{ left: 0, width: 100.4 }, { left: 100.4, width: 100 }];
  assert.equal(
    resolveStripOverflow({ chips, scrollLeft: 100, viewportWidth: 200 }).hiddenLeft,
    1,
  );
});

test('скрытые вкладки называются поимённо, а не только числом', () => {
  // Счётчик красится в цвет своего агента, значит одного числа мало: нужно
  // знать, КТО именно уехал за край.
  const chips = [
    { left: 0, width: 100, tabId: 'a' },
    { left: 100, width: 100, tabId: 'b' },
    { left: 200, width: 100, tabId: 'c' },
  ];
  const res = resolveStripOverflow({ chips, scrollLeft: 100, viewportWidth: 100 });
  assert.deepEqual(res.hiddenLeftIds, ['a']);
  assert.deepEqual(res.hiddenRightIds, ['c']);
  assert.equal(res.hiddenLeft, 1);
  assert.equal(res.hiddenRight, 1);
});

test('одинаковый badge не скрывает смену точного tab-owner', () => {
  const groups = [{ kind: 'claude', count: 1 }];
  const before = paneStripOverflowStateKey({
    hiddenLeftIds: ['tab-a'],
    leftGroups: groups,
  });
  const after = paneStripOverflowStateKey({
    hiddenLeftIds: ['tab-b'],
    leftGroups: groups,
  });
  assert.notEqual(before, after);
  assert.match(before, /LI:tab-a/);
  assert.match(after, /LI:tab-b/);
});

test('квадратик на каждый вид, в порядке появления в полосе', () => {
  // Порядок — первое появление, не «сначала кого больше»: полоса это карта,
  // которую расставил человек, и счётчики её продолжают за краем окна.
  const kind = { a: 'codex', b: 'claude', c: 'claude', d: 'codex' };
  assert.deepEqual(
    groupOverflowByKind(['a', 'b', 'c', 'd'], (id) => kind[id]),
    [{ kind: 'codex', count: 2 }, { kind: 'claude', count: 2 }],
  );
  // Вкладка без агента — свой вид, а не «непонятно что»: серый квадратик
  // честнее, чем приписать её чужому цвету.
  assert.deepEqual(
    groupOverflowByKind(['x'], () => undefined),
    [{ kind: 'default', count: 1 }],
  );
  assert.deepEqual(groupOverflowByKind([], () => 'claude'), []);
});

test('уже полностью видимый активируемый чип не двигает полосу', () => {
  const view = { scrollLeft: 100, viewportWidth: 200 };
  // Обе границы намеренно вплотную к viewport. Внутренний «запас» здесь
  // превращал корректный клик в лишнее движение полосы.
  assert.equal(scrollOffsetForChip({ chip: { left: 100, width: 60 }, ...view }), 100);
  assert.equal(scrollOffsetForChip({ chip: { left: 240, width: 60 }, ...view }), 100);
  assert.equal(scrollOffsetForChip({ chip: { left: 120, width: 60 }, ...view }), 100);
});

test('обрезанный чип доезжает минимально до ближайшего видимого края', () => {
  const view = { scrollLeft: 100, viewportWidth: 200 };
  // Ушла влево — левый край чипа совмещается с левым краем viewport.
  assert.equal(scrollOffsetForChip({ chip: { left: 40, width: 60 }, ...view }), 40);
  // Не влезла справа — правый край совмещается с правым, без лишнего inset.
  assert.equal(scrollOffsetForChip({ chip: { left: 280, width: 60 }, ...view }), 140);
});

test('перед reveal перечитывается viewport после смены footprint badge-stack', () => {
  const chip = { left: 230, right: 290 };

  // До появления стека «×N» чип целиком помещается и не должен двигаться.
  assert.equal(scrollOffsetForChip({
    chip,
    viewport: { left: 100, right: 300 },
    scrollLeft: 100,
  }), 100);

  // После layout стек Claude+Codex реально отнял место справа. Геометрия
  // скроллера, а не предполагаемая ширина badge, задаёт новую границу.
  assert.equal(scrollOffsetForChip({
    chip,
    viewport: { left: 100, right: 276 },
    scrollLeft: 100,
  }), 114);
});
