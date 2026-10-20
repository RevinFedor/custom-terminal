'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizePaneStripRowPlacement: normalize, projectPaneStripRowPlacement: project,
  samePaneStripRowPlacement: same} = require('./pane-strip-row-placement.cjs');

const placement = (order, rowStartIds, width = 684) => ({version: 1, width, order, rowStartIds});
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Independent, deliberately small packing oracle for the reported geometry.
// This proves descriptor meaning, not CSS/DOM/native acceptance.
function packedRows(order, widths, forced = [], width = 684) {
  const rows = [];
  let used = 0;
  for (const id of order) {
    if (!rows.length || forced.includes(id) || used + widths[id] > width) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(id);
    used += widths[id];
  }
  return rows;
}

test('684px strip: Guide70 starts row3 with Portfolio199, though the row2 tail has 127px free', () => {
  const baseOrder = ['A', 'B', 'C', 'D', 'G', 'P', 'U'];
  const order = [...baseOrder]; // Intent changes rows even with identical flat order.
  const widths = {A: 400, B: 284, C: 280, D: 277, G: 70, P: 199, U: 200};
  assert.deepEqual(packedRows(order, widths), [['A', 'B'], ['C', 'D', 'G'], ['P', 'U']]);
  const result = project({baseOrder, order, sourceIds: ['G'], rowStartId: 'P', width: 684});
  assert.deepEqual(result, placement(order, ['G']));
  assert.deepEqual(packedRows(order, widths, result.rowStartIds), [['A', 'B'], ['C', 'D'], ['G', 'P', 'U']]);
  assert.equal(project({baseOrder, order, sourceIds: ['G'], width: 684}), null);
});

test('an actual source reorder preserves the complete target order and transfers an existing anchor break', () => {
  const baseOrder = ['A', 'B', 'C', 'D', 'P', 'U', 'G'];
  const order = ['A', 'B', 'C', 'D', 'G', 'P', 'U'];
  const result = project({current: placement(baseOrder, ['C', 'P']), baseOrder, order,
    sourceIds: ['G'], rowStartId: 'P', width: 684});
  assert.deepEqual(result, placement(order, ['C', 'G']));
  assert.equal(normalize(result, {order: order.slice(2), width: 684}), null, 'no partial target order');
});

test('row-start transfer is explicit; a previous-tail insertion keeps the anchor on its own row', () => {
  const baseOrder = ['A', 'B', 'P', 'U', 'G'];
  const order = ['A', 'B', 'G', 'P', 'U'];
  const input = {current: placement(baseOrder, ['P']), baseOrder, order, sourceIds: ['G'], width: 684};
  const tail = project(input);
  const row = project({...input, rowStartId: 'P'});
  assert.deepEqual(tail, placement(order, ['P']));
  assert.deepEqual(row, placement(order, ['G']));
  assert.equal(same(tail, row), false);
});

test('moving the source away clears its old break while unrelated anchors remain', () => {
  const baseOrder = ['A', 'G', 'P', 'U', 'V', 'W'];
  const current = placement(baseOrder, ['G', 'V']);
  const moved = ['A', 'P', 'U', 'V', 'W', 'G'];
  assert.deepEqual(project({current, baseOrder, order: moved, sourceIds: ['G'], width: 684}),
    placement(moved, ['V']));
  const leftStrip = ['A', 'P', 'U', 'V', 'W'];
  assert.deepEqual(project({current, baseOrder, order: leftStrip, sourceIds: ['G'], width: 684}),
    placement(leftStrip, ['V']));
  assert.equal(project({current: placement(baseOrder, ['G']), baseOrder, order: moved,
    sourceIds: ['G'], width: 684}), null);
});

test('a source block arrives from another strip without changing any foreign item', () => {
  const baseOrder = ['A', 'P', 'U', 'V'];
  const order = ['A', 'G', 'H', 'P', 'U', 'V'];
  assert.deepEqual(project({current: placement(baseOrder, ['P', 'V']), baseOrder, order,
    sourceIds: ['G', 'H'], rowStartId: 'P', width: 684}), placement(order, ['G', 'V']));
});

test('the whole multi-source set moves, including nonadjacent pickup items; its former breaks are removed', () => {
  const baseOrder = ['A', 'G', 'P', 'H', 'U', 'V'];
  const order = ['A', 'P', 'G', 'H', 'U', 'V'];
  assert.deepEqual(project({current: placement(baseOrder, ['G', 'H', 'V']), baseOrder, order,
    sourceIds: ['H', 'G'], rowStartId: 'U', width: 684}), placement(order, ['G', 'V']));
});

test('an anchor cannot reach past a foreign chip or silently narrow a partial source set', () => {
  const baseOrder = ['A', 'G', 'P', 'U', 'H', 'V'];
  const current = placement(baseOrder, ['P', 'V']);
  for (const [order, sourceIds, rowStartId] of [
    [['A', 'G', 'P', 'U', 'H', 'V'], ['G'], 'U'], // P is between source and anchor.
    [['A', 'G', 'P', 'U', 'H', 'V'], ['G', 'H'], 'P'], // Split incoming block.
    [['A', 'G', 'P', 'U', 'V'], ['G', 'H'], 'P'], // H did not arrive.
    [['A', 'G', 'P', 'U', 'H', 'V'], ['G'], 'G'], // Anchor is source.
    [['A', 'G', 'P', 'U', 'H', 'V'], ['G'], 'absent'],
    [['A', 'G', 'P', 'U', 'H', 'V'], ['G'], null],
  ]) {
    assert.deepEqual(project({current, baseOrder, order, sourceIds, rowStartId, width: 684}),
      placement(order, ['P', 'V']), JSON.stringify({order, sourceIds, rowStartId}));
  }
});

test('a coincidental anchor index cannot hide a foreign hole in a split source block', () => {
  const baseOrder = ['A', 'G', 'P', 'H', 'U', 'V'];
  // anchor = first + count, but P occupies a foreign hole in the source block.
  const order = ['A', 'G', 'P', 'U', 'H', 'V'];
  assert.deepEqual(project({current: placement(baseOrder, ['U', 'V']), baseOrder, order,
    sourceIds: ['G', 'H'], rowStartId: 'U', width: 684}), placement(order, ['U', 'V']));
});

test('insertion at the very beginning never creates a blank row or retains the transferred anchor break', () => {
  const baseOrder = ['A', 'P', 'G', 'U'];
  const order = ['G', 'A', 'P', 'U'];
  assert.deepEqual(project({current: placement(baseOrder, ['P']), baseOrder, order,
    sourceIds: ['G'], rowStartId: 'A', width: 684}), placement(order, ['P']));
  const first = ['G', 'P', 'U'];
  assert.equal(project({current: placement(['P', 'U', 'G'], ['P']),
    baseOrder: ['P', 'U', 'G'], order: first, sourceIds: ['G'], rowStartId: 'P', width: 684}), null);
  assert.equal(normalize(placement(first, ['G']), {order: first}), null);
});

test('a preserved non-source break becoming item zero is removed', () => {
  const baseOrder = ['G', 'P', 'U'];
  const order = ['P', 'U', 'G'];
  assert.equal(project({current: placement(baseOrder, ['P']), baseOrder, order,
    sourceIds: ['G'], width: 684}), null);
});

test('normalization canonicalizes break order and redundant first break without aliasing input', () => {
  const order = ['A', 'B', 'C', 'D'];
  const raw = placement([...order], ['D', 'A', 'B']);
  const result = normalize(raw, {order, width: 684});
  assert.deepEqual(result, placement(order, ['B', 'D']));
  assert.notEqual(result, raw);
  assert.notEqual(result.order, raw.order);
  assert.notEqual(result.order, order);
  assert.notEqual(result.rowStartIds, raw.rowStartIds);
  result.order[0] = 'changed';
  result.rowStartIds.push('changed');
  assert.deepEqual(raw, placement(order, ['D', 'A', 'B']));
});

test('stale full order, order membership, viewport width and unknown schemas read as natural reflow', () => {
  const order = ['A', 'P', 'U'];
  const raw = placement(order, ['P']);
  for (const stale of [['A', 'U', 'P'], ['A', 'P'], ['A', 'P', 'U', 'G'], ['A', 'P', 'P']])
    assert.equal(normalize(raw, {order: stale, width: 684}), null);
  for (const width of [683.49, 684.51, 900, 0, -1, NaN, Infinity, '684', null])
    assert.equal(normalize(raw, {order, width}), null);
  for (const width of [683.5, 684, 684.5])
    assert.deepEqual(normalize(raw, {order, width}), raw);
  assert.deepEqual(normalize(raw, {order}), raw);
  for (const value of [undefined, null, false, 1, 'metadata', [], {},
    {...raw, version: 2}, {...raw, version: '1'}, {...raw, width: 0}, {...raw, width: NaN},
    {...raw, width: Infinity}, {...raw, width: '684'}, {...raw, order: undefined},
    {...raw, order: new Array(3)}, {...raw, order: ['A', , 'U']},
    {...raw, rowStartIds: undefined}, {...raw, rowStartIds: new Array(1)}, {...raw, rowStartIds: ['P', 'P']},
    {...raw, rowStartIds: ['foreign']}, {...raw, rowStartIds: ['']}, {...raw, rowStartIds: [1]}])
    assert.equal(normalize(value, {order, width: 684}), null);
  assert.equal(normalize(raw), null);
  assert.equal(normalize(raw, null), null);
  assert.equal(normalize(placement([], []), {order: []}), null);
});

test('stale current metadata cannot preserve old anchors but fresh explicit intent can still create one', () => {
  const baseOrder = ['A', 'G', 'P', 'U', 'V'];
  const order = ['A', 'P', 'G', 'U', 'V'];
  for (const current of [placement(['G', 'A', 'P', 'U', 'V'], ['V']),
    placement(baseOrder, ['V'], 900), {...placement(baseOrder, ['V']), version: 2}]) {
    const input = {current, baseOrder, order, sourceIds: ['G'], width: 684};
    assert.equal(project(input), null);
    assert.deepEqual(project({...input, rowStartId: 'U'}), placement(order, ['G']));
  }
  const current = placement(baseOrder, ['V'], 684.25);
  assert.deepEqual(project({current, baseOrder, order, sourceIds: ['G'], width: 684}), placement(order, ['V']));
});

test('foreign reorder, membership change and malformed inputs do not acquire presentation authority', () => {
  const baseOrder = ['A', 'G', 'P', 'U'];
  const input = {current: placement(baseOrder, ['P']), baseOrder, order: baseOrder,
    sourceIds: ['G'], width: 684};
  for (const order of [['U', 'G', 'P', 'A'], ['A', 'G', 'P'], ['A', 'G', 'P', 'U', 'foreign'],
    ['A', 'G', 'G', 'P', 'U'], ['A', '', 'P', 'U'], null])
    assert.equal(project({...input, order, rowStartId: 'P'}), null);
  for (const sourceIds of [undefined, null, ['G', 'G'], [''], [1]])
    assert.equal(project({...input, sourceIds}), null);
  for (const width of [undefined, 0, NaN, Infinity, '684'])
    assert.equal(project({...input, width}), null);
  assert.equal(project({...input, baseOrder: ['A', 'A', 'G', 'P', 'U']}), null);
  assert.equal(project(), null);
  assert.equal(project(null), null);
  assert.deepEqual(project({...input, sourceIds: [], rowStartId: 'P'}), placement(baseOrder, ['P']));
});

test('all inputs remain immutable and results do not alias caller arrays', () => {
  const input = deepFreeze({current: placement(['A', 'G', 'P', 'U', 'V'], ['G', 'V']),
    baseOrder: ['A', 'G', 'P', 'U', 'V'], order: ['A', 'P', 'G', 'U', 'V'],
    sourceIds: ['G'], rowStartId: 'U', width: 684});
  const before = JSON.stringify(input);
  const result = project(input);
  assert.deepEqual(result, placement(input.order, ['G', 'V']));
  assert.deepEqual(normalize(input.current, {order: input.baseOrder, width: 684}), input.current);
  assert.equal(same(input.current, input.current), true);
  result.order.reverse();
  result.rowStartIds.reverse();
  assert.equal(JSON.stringify(input), before);
});

test('equality uses canonical breaks and exact widths; absent/invalid descriptors are equivalent to natural wrap', () => {
  const order = ['A', 'P', 'U', 'V'];
  const left = placement(order, ['P', 'V']);
  assert.equal(same(left, placement([...order], ['V', 'A', 'P'])), true);
  assert.equal(same(left, placement(order, ['P'])), false);
  assert.equal(same(left, placement(['A', 'U', 'P', 'V'], ['P', 'V'])), false);
  assert.equal(same(left, placement(order, ['P', 'V'], 684.25)), false);
  assert.equal(same(left, null), false);
  for (const value of [null, undefined, {}, {...left, version: 2}, placement(order, []), placement(order, ['A'])]) {
    assert.equal(same(value, null), true);
    assert.equal(same(value, left), false);
  }
});

test('large strips retain sparse unrelated anchors and all selected IDs', () => {
  const baseOrder = Array.from({length: 30000}, (_, index) => `tab-${index}`);
  const sourceIds = baseOrder.slice(100, 200);
  const order = [...baseOrder.slice(0, 100), ...baseOrder.slice(200, 20000),
    ...sourceIds, ...baseOrder.slice(20000)];
  const current = placement(baseOrder, ['tab-100', 'tab-5000', 'tab-20000', 'tab-25000']);
  const result = project({current, baseOrder, order, sourceIds, rowStartId: 'tab-20000', width: 684});
  assert.deepEqual(result.rowStartIds, ['tab-5000', 'tab-100', 'tab-25000']);
  assert.deepEqual(result.order, order);
  assert.equal(result.order.length, 30000);
});

test('array reads scale linearly for full normalization, projection and equality', () => {
  for (const size of [512, 4096]) {
    let reads = 0;
    const counted = array => new Proxy(array, {get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    }});
    const ids = Array.from({length: size}, (_, index) => `id-${index}`);
    const baseOrder = counted([...ids]);
    const sourceIds = counted(ids.slice(1, size / 2));
    const order = counted([ids[0], ...ids.slice(size / 2, size - 1),
      ...ids.slice(1, size / 2), ids[size - 1]]);
    const current = placement(counted([...ids]), counted(ids.slice(1)));
    const result = project({current, baseOrder, order, sourceIds, rowStartId: ids[size - 1], width: 684});
    assert.ok(result);
    assert.deepEqual(normalize(current, {order: baseOrder}), current);
    assert.equal(same(current, current), true);
    assert.ok(reads < 40 * size, `${size} items required ${reads} indexed reads`);
  }
});
