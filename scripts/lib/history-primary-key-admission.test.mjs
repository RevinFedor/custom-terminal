import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { patchHistoryVirtuoso } from './history-virtuoso-measurement.mjs';
import { createHistoryPrimaryItemAdmission } from '../../src/renderer/utils/historyPrimaryItemAdmission.mjs';

// Use the real, hash-checked pinned distribution. This is an actual Hn/Lo
// control, not a local reconstruction of the virtualizer's callback order.
const require = createRequire(import.meta.url);
const path = process.env.HISTORY_VIRTUOSO_UPSTREAM_PATH
  || join(dirname(require.resolve('react-virtuoso')), 'index.mjs');
const upstream = readFileSync(path, 'utf8');
const patched = patchHistoryVirtuoso(upstream);

function listHarness(source = patched) {
  const start = source.indexOf('Hn = /* @__PURE__ */ E.memo(');
  const end = source.indexOf('\n}), hr =', start) + 3;
  assert.ok(start >= 0 && end > start);
  const events = [], effects = [], emissions = new Map();
  let values;
  const jsx = (type, props, key) => ({ type, props, ...(key === undefined ? {} : { key }) });
  const runtime = {
    E: { memo: fn => fn, useRef: value => ({ current: value }), useState: value => [value, () => {}],
      useLayoutEffect: fn => effects.push(fn) },
    A: name => values[name], Ct: () => () => {},
    on: (name, callback) => emissions.set(name, callback),
    Mn: () => ({ callbackRef: () => {} }), Jt: () => {}, fr: 'seek',
    ot: () => ({}), ao: () => ({}), G: jsx,
    Dt: (type, props, ...children) => jsx(type, { ...props, children }),
    mr: { position: 'sticky' }, pr: { display: 'inline-block' }, uo: { overflowAnchor: 'none' },
  };
  const Hn = new Function(...Object.keys(runtime), `return ${source.slice(start + 5, end)};`)(...Object.values(runtime));
  return {
    events, effects, emissions,
    render({ snapshot, root, matches = () => true, indexes, seeking = false, admission = true, context = {}, firstItemIndex = 0 }) {
      events.length = effects.length = 0;
      const gate = createHistoryPrimaryItemAdmission(root, snapshot, matches);
      const listState = { totalCount: snapshot.totalCount, firstItemIndex, offsetTop: 30, offsetBottom: 400,
        top: 30, bottom: 200, topItems: [], items: indexes.map(index => ({
          index, originalIndex: index - firstItemIndex, offset: index * 32, size: 32, data: undefined,
        })) };
      values = {
        listState, useWindowScroll: false, customScrollParent: undefined, trackItemSizes: true,
        itemSize: () => 32, log: () => {}, horizontalDirection: false,
        skipAnimationFrameInResizeObserver: true, EmptyPlaceholder: null, ScrollSeekPlaceholder: 'seek',
        ListComponent: 'list', ItemComponent: 'row', GroupComponent: 'group', groupIndices: [],
        isSeeking: seeking, alignToBottom: false, initialItemFinalLocationReached: true,
        itemContent: index => { events.push('body:' + index); assert.ok(gate.admit(index)); return snapshot.window.get(index); },
        groupContent: () => { throw new Error('unexpected grouped virtualizer'); },
        computeItemKey: index => { events.push('key:' + index); return gate.key(index); },
        context: { ...context, ...(admission ? {
          historyPrimaryItemAdmission: index => { events.push('admit:' + index); return gate.admit(index); },
          historyPrimaryPendingItem: (index, size) => {
            events.push('pending:' + index);
            return jsx('div', { 'data-history-primary-pending': '1',
              'data-history-primary-pending-rank': index, style: { height: size } },
            'history-primary-pending:' + snapshot.adoptionId + ':' + index);
          },
        } : {}) },
      };
      const tree = Hn({});
      return { tree, listState, gate, context: values.context };
    },
    layout() { for (const effect of effects.splice(0)) effect(); },
  };
}

// A finite fixture only. Production admission never receives this inventory.
const reference = [
  { index: 0, key: 'entry:source:\u0000\ud800😀', unit: { kind: 'entry', entry: { uuid: 'u0' } } },
  { index: 70, key: 'group:工具\u0000member', unit: { kind: 'group', key: '工具\u0000member' } },
  { index: 71, key: 'entry:' + 'long\udfff'.repeat(1500), unit: { kind: 'entry', entry: { uuid: 'u71' } } },
  { index: 956, key: 'entry:last', unit: { kind: 'entry', entry: { uuid: 'u956' } } },
];
function fixture(rows = [], adoptionId = 1, totalCount = 957) {
  const snapshot = { header: { leaseId: 'lease:' + adoptionId }, adoptionId, totalCount,
    addresses: new Map(rows.map(row => [row.index, { physicalKey: row.key, index: row.index }])),
    window: new Map(rows.map(row => [row.index, row.unit])) };
  const root = { current: snapshot, matchesSnapshotUnit: (cut, index, unit) => cut === root.current
    && cut.window.get(index) === unit && root.current.addresses.has(index) };
  return { snapshot, root };
}

test('the actual unpatched Hn calls computeItemKey before body, including an unprefetched jump', () => {
  const h = listHarness(upstream), { snapshot, root } = fixture([reference[0]]);
  assert.throws(() => h.render({ snapshot, root, indexes: [70, 71] }), /HISTORY_PRIMARY_KEY_NOT_ADMITTED/);
  assert.deepEqual(h.events, ['key:70']);
});

test('actual patched Hn admits every real key/body and excludes unknown rows from both callbacks', () => {
  const h = listHarness(), { snapshot, root } = fixture([reference[3]]);
  const commits = [];
  const { tree } = h.render({ snapshot, root, indexes: [955, 956],
    context: { historyOnPrimaryWindowCommit: value => commits.push(value) } });
  assert.deepEqual(h.events, ['admit:955', 'admit:956', 'pending:955', 'key:956', 'body:956']);
  assert.equal(tree.props.children[0].props['data-index'], undefined);
  assert.equal(tree.props.children[0].props['data-item-index'], undefined);
  assert.equal(tree.props.children[1].props.key, reference[3].key);
  h.layout();
  assert.equal(commits[0].totalCount, 957, 'no invented count zero while a window is unknown');
  assert.equal(commits[0].admittedCount, 1);
  assert.equal(commits[0].itemCount, 2);
  assert.equal(commits[0].stable, true, 'geometry alone is not a covered-body proof');
});

test('unseen range, address without body, eviction and metadata refresh never guess a synchronous key', () => {
  const h = listHarness(), { root, snapshot } = fixture([reference[0]]);
  h.render({ root, snapshot, indexes: [70, 71] });
  assert.deepEqual(h.events.filter(e => /^(key|body):/.test(e)), []);
  snapshot.addresses.set(70, { physicalKey: reference[1].key, index: 70 });
  h.render({ root, snapshot, indexes: [70] });
  assert.deepEqual(h.events, ['admit:70', 'pending:70'], 'address readiness is not body readiness');
  snapshot.window.set(70, reference[1].unit);
  const before = h.render({ root, snapshot, indexes: [70] }).tree.props.children[0].props.key;
  const next = fixture([reference[1]], 2).snapshot;
  root.current = next;
  h.render({ root, snapshot, indexes: [70] });
  assert.deepEqual(h.events, ['admit:70', 'pending:70'], 'old adoption cannot render after current cut moved');
  const after = h.render({ root, snapshot: next, indexes: [70] }).tree.props.children[0].props.key;
  assert.equal(after, before, 'ready semantic key does not contain lease/adoption/rank');
  next.window.delete(70); next.addresses.delete(70);
  h.render({ root, snapshot: next, indexes: [70] });
  assert.deepEqual(h.events, ['admit:70', 'pending:70'], 'evicted identity is not retained as a full key inventory');
});

test('exact strings, append, regroup and stale/async local composition retain their distinct outcomes', () => {
  const h = listHarness(), { root, snapshot } = fixture(reference);
  const tree = h.render({ root, snapshot, indexes: reference.map(row => row.index) }).tree;
  assert.deepEqual(tree.props.children.map(row => row.props.key), reference.map(row => row.key));
  assert.equal(snapshot.addresses.size, 4);
  for (const matches of [() => false, () => Promise.resolve(true)]) {
    h.render({ root, snapshot, indexes: [0, 70], matches });
    assert.equal(h.events.filter(e => /^(key|body):/.test(e)).length, 0);
  }
  const appended = fixture([...reference, { index: 957, key: 'entry:new', unit: { kind: 'entry', entry: { uuid: 'new' } } }], 3, 958).snapshot;
  root.current = appended;
  const after = h.render({ root, snapshot: appended, indexes: [956, 957] }).tree;
  assert.deepEqual(after.props.children.map(row => row.props.key), ['entry:last', 'entry:new']);
  const regrouped = fixture([{ ...reference[1], key: 'entry:changed', unit: { kind: 'entry', entry: { uuid: 'changed' } } }], 4).snapshot;
  root.current = regrouped;
  assert.equal(h.render({ root, snapshot: regrouped, indexes: [70] }).tree.props.children[0].props.key, 'entry:changed');
  assert.throws(() => createHistoryPrimaryItemAdmission(root, appended, () => true).key(956), /NOT_ADMITTED/);
});

test('actual Lo measurement excludes pending status DOM, including mixed ready/unknown windows', () => {
  const h = listHarness(), { root, snapshot } = fixture([reference[1]]);
  const tree = h.render({ root, snapshot, indexes: [70, 71] }).tree;
  const start = patched.indexOf('function Lo('), end = patched.indexOf('function In(', start);
  const Lo = new Function('ft', patched.slice(start, end) + '\nreturn Lo;')({ ERROR: 'error' });
  const children = tree.props.children.map(node => ({ dataset: Object.fromEntries(Object.entries(node.props)
    .filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), String(value)])),
    offsetHeight: 99 }));
  children.item = index => children[index];
  let measured = 0;
  const sizes = Lo(children, row => { measured++; return row.offsetHeight; }, 'offsetHeight', () => {});
  assert.equal(measured, 1, 'pending shell never becomes a measured physical row');
  assert.deepEqual(sizes, [{ startIndex: 70, endIndex: 70, size: 99 }]);
});

test('actual Hn rejects layout superseded by measurement and preserves legacy/seek behavior', () => {
  const { root, snapshot } = fixture(reference), h = listHarness(), commits = [];
  const rendered = h.render({ root, snapshot, indexes: [70, 71], seeking: true,
    context: { historyOnPrimaryWindowCommit: value => commits.push(value) } });
  assert.equal(rendered.tree.props.children[0].type, 'seek');
  assert.equal(h.events.some(e => e.startsWith('body:')), false);
  h.layout(); assert.equal(commits[0].stable, false);
  h.render({ root, snapshot, indexes: [70, 71], context: { historyOnPrimaryWindowCommit: value => commits.push(value) } });
  h.emissions.get('listState')({ ...rendered.listState, items: [] });
  h.layout(); assert.equal(commits.at(-1).stable, false);
  const old = listHarness(upstream), next = listHarness();
  const a = old.render({ root, snapshot, indexes: [70, 71], admission: false }).tree;
  const b = next.render({ root, snapshot, indexes: [70, 71], admission: false }).tree;
  // Ref functions are boundary adapters; compare the actual row outputs/order.
  assert.deepEqual(a.props.children, b.props.children);
  assert.deepEqual(old.events, next.events);
});
