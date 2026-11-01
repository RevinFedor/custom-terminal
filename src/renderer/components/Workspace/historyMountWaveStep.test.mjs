// Executes the REAL mount-wave step function (sliced out of HistoryPanel.tsx and
// run through esbuild + vm) against a fake scroller, and drives it the way the
// panel does: step -> React commit -> layout-effect ack -> next step.
//
// Source under test: NOTED_TEST_HISTORY_SOURCE or the panel next to this file.
// Needs a TypeScript-aware loader for the one real import; run it as
//   node --experimental-strip-types --test src/renderer/components/Workspace/historyMountWaveStep.test.mjs
// Written by an adversarial review of the stub-exclusion fix: the sibling
// `historyMountWaveDrain.test.cjs` only pins selector TEXT and still passes if
// the gate is disabled, so this one runs the step and fails on pre-fix source
// (S1/S2/S5).
// Modelled outside the sliced function (kept honest by the source assertions in
// the first test): the two render branches (rowStub before asShell) and the
// layout-effect ack that accumulates realUuids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const require = createRequire(resolve(REPO, 'package.json'));
const { transformSync } = require('esbuild');
const { pickHistoryMountWaveTarget } = await import(
  pathToFileURL(resolve(REPO, 'src/renderer/utils/historyMeasuredLayout.ts')).href
);

const sourcePath = process.env.NOTED_TEST_HISTORY_SOURCE
  || resolve(HERE, 'HistoryPanel.tsx');
const source = readFileSync(sourcePath, 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

const from = source.indexOf('mountWaveStepRef.current = () => {');
const to = source.indexOf('// Wave lifecycle: register the lane', from);
assert.ok(from > 0 && to > from, 'step function must be sliceable');
const stepCode = transformSync(source.slice(from, to), { loader: 'ts' }).code;

const OWNER = 'owner-1';

// Evaluates exactly the selector grammar the step uses; anything else throws so
// the harness can never silently agree with a selector it does not understand.
function selectorMatches(selector, attrs) {
  const token = /^(?::not\(\[([\w-]+)\]\)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\])/;
  const checks = [];
  for (let rest = selector; rest.length;) {
    const m = token.exec(rest);
    if (!m) throw new Error('harness: unsupported selector fragment: ' + rest);
    rest = rest.slice(m[0].length);
    if (m[1]) checks.push((a) => !(m[1] in a));
    else if (m[3] !== undefined) checks.push((a) => a[m[2]] === m[3].replace(/\\(.)/g, '$1'));
    else checks.push((a) => m[2] in a);
  }
  return checks.every((check) => check(attrs));
}

const makeNode = (attrs, top) => ({
  attrs,
  getAttribute: (name) => (name in attrs ? attrs[name] : null),
  hasAttribute: (name) => name in attrs,
  getBoundingClientRect: () => ({ top, bottom: top + 100, height: 100 }),
});

function createWorld(rows, { shellUuids = rows.map((row) => row.uuid), batchSize = 1 } = {}) {
  const world = { rows, logs: [], clock: 0, rearm: false };
  world.state = { visitKey: 'v1', realUuids: new Set(), done: false, interruptEpoch: 0 };
  world.meta = {
    visitKey: 'v1', shellUuids: new Set(shellUuids), heightLookup: () => 100, heightsFrom: 'avg',
    startedAt: 0, steps: 0, upgraded: 0, maxStepMs: 0, batchSize, stepStartedAt: 0,
    pendingStepUuids: null, pendingStepToken: 0, clearStepInterrupt: null, stepEndMark: null,
    keepBottom: false, loggedStart: false, bankedDone: false,
  };
  world.scroller = {
    isConnected: true, nodes: [], scrollTop: 0, scrollHeight: 2000, clientHeight: 800,
    getBoundingClientRect: () => ({ top: 0, bottom: 800 }),
    querySelectorAll: (selector) => world.scroller.nodes.filter((node) => selectorMatches(selector, node.attrs)),
  };
  // Mirrors renderHistoryUnit: rowStub branch first, then asShell, else real.
  world.render = () => {
    world.scroller.nodes = world.rows.filter((row) => row.mounted !== false).map((row, index) => {
      const attrs = { 'data-uuid': row.uuid, 'data-history-row-owner': OWNER };
      const waveActive = !world.state.done && world.meta.visitKey === 'v1';
      if (row.rowStub) {
        attrs['data-history-mount-shell'] = '1';
        attrs['data-history-row-stub'] = '1';
      } else if (waveActive && world.meta.shellUuids.has(row.uuid) && !world.state.realUuids.has(row.uuid)) {
        attrs['data-history-mount-shell'] = '1';
      } else {
        attrs['data-history-row-real'] = '1';
      }
      return makeNode(attrs, index * 100);
    });
  };
  // Mirrors the layout effect: only the commit CONTAINING the step's set acks it.
  world.ack = () => {
    const { meta, state } = world;
    if (!meta.pendingStepUuids) return false;
    if (!meta.pendingStepUuids.every((uuid) => state.realUuids.has(uuid))) return false;
    meta.steps += 1;
    meta.upgraded += meta.pendingStepUuids.length;
    meta.pendingStepToken = 0;
    meta.pendingStepUuids = null;
    meta.batchSize = Math.min(3, meta.batchSize + 1);
    return true;
  };
  const context = {
    mountWaveMetaRef: { current: world.meta },
    mountWaveLaneRef: { current: { wants: false, visible: () => true, run() {} } },
    historyDiag: (message) => world.logs.push(message),
    restoredLayoutVisitKeyRef: { current: 'v1' },
    mountWaveRenderStateRef: { get current() { return world.state; } },
    historyScrollSeekController: { isActive: () => false },
    virtuosoScrollerRef: { current: world.scroller },
    CSS: { escape: (value) => String(value).replace(/[^\w-]/g, (c) => '\\' + c) },
    historyOwnerDomId: OWNER, tabId: 'tab-0123456789abcdef',
    historyOwnerDigest: () => 'digest', historyOwnerKeyRef: { current: 'ownerKey' },
    performance: { now: () => world.clock++ },
    startTransition: (fn) => fn(),
    setMountWaveRenderState: (update) => {
      world.state = typeof update === 'function' ? update(world.state) : update;
    },
    historyScrollInFlightRef: { current: null },
    pickHistoryMountWaveTarget,
    mountWaveStepSequenceRef: { current: 0 },
    isHistoryAtContentBottom: () => false,
    markRendererActivity: () => () => {},
    historyPresentationProofRef: { current: { presented: true } },
    historyForegroundPriority: { registerInterruptibleBackgroundWork: () => () => {} },
    requestHistoryMountWaveStep: () => { world.rearm = true; },
    mountWaveStepRef: { current: null },
  };
  vm.runInNewContext(stepCode, context);
  world.step = context.mountWaveStepRef.current;
  world.run = ({ maxWakes = 300, afterCommit = null } = {}) => {
    world.render();
    let wakes = 0;
    let stalled = false;
    while (wakes < maxWakes && !world.state.done) {
      world.step();
      wakes += 1;
      if (world.state.done) break;
      if (!world.meta.pendingStepUuids) { stalled = true; break; }
      world.render();
      world.ack();
      afterCommit?.(world, wakes);
      world.render();
    }
    world.render();
    return {
      wakes, stalled, done: world.state.done, steps: world.meta.steps,
      upgraded: world.meta.upgraded, real: [...world.state.realUuids],
    };
  };
  return world;
}

const stub = (uuid) => ({ uuid, rowStub: true });
const entry = (uuid) => ({ uuid });

test('harness model still matches the render and ack code it stands in for', () => {
  const stubAt = source.indexOf('if ((presentedEntry as any).rowStub) {');
  const shellAt = source.indexOf('const asShell =');
  assert.ok(stubAt > 0 && shellAt > stubAt, 'rowStub branch must precede asShell');
  assert.ok(squash(source.slice(shellAt, shellAt + 420)).includes(
    'mountWaveActive && waveMeta?.visitKey === restoredLayoutVisitKey && waveMeta.shellUuids.has(presentedEntry.uuid) && !mountWaveRenderState.realUuids.has(presentedEntry.uuid)',
  ), 'asShell predicate changed: update the harness render model');
  assert.ok(squash(source).includes(
    'const landed = meta.pendingStepUuids.every( (uuid) => mountWaveRenderState.realUuids.has(uuid), );',
  ), 'layout-effect ack changed: update the harness ack model');
});

test('S1 viewport holds only stubs: wave must drain, not keep upgrading stub uuids', () => {
  const world = createWorld([stub('a'), stub('b'), stub('c')]);
  const result = world.run();
  assert.equal(result.done, true, `wave never drained: ${JSON.stringify(result)}`);
  assert.equal(result.steps, 0);
  assert.deepEqual(result.real, [], 'a stub uuid must never enter realUuids');
  assert.ok(world.logs.some((line) => line.startsWith('MOUNT_WAVE_DONE')));
});

test('S2 two wave shells plus three stubs: upgrade exactly the shells, then drain', () => {
  const world = createWorld([stub('s1'), entry('w1'), stub('s2'), entry('w2'), stub('s3')]);
  const result = world.run();
  assert.equal(result.done, true, `wave never drained: ${JSON.stringify(result)}`);
  assert.deepEqual([...result.real].sort(), ['w1', 'w2']);
  assert.equal(result.steps, 2);
});

test('S3 empty row window waits (05.08 guard): no DONE, no upgrades', () => {
  const world = createWorld([]);
  const result = world.run();
  assert.equal(result.done, false);
  assert.equal(result.stalled, true);
  assert.ok(!world.logs.some((line) => line.startsWith('MOUNT_WAVE_DONE')));
});

test('S4 only real rows mounted: nothing to upgrade, drains with zero steps', () => {
  const world = createWorld([entry('r1'), entry('r2')], { shellUuids: [] });
  const result = world.run();
  assert.equal(result.done, true);
  assert.equal(result.steps, 0);
});

test('S5 a stub hydrated mid-wave becomes a wave shell and is upgraded (no stuck row)', () => {
  const rows = [entry('w1'), stub('s1'), stub('s2')];
  const world = createWorld(rows);
  const result = world.run({
    afterCommit: (w, wake) => { if (wake === 1) w.rows[1] = entry('s1'); },
  });
  assert.equal(result.done, true, JSON.stringify(result));
  assert.deepEqual([...result.real].sort(), ['s1', 'w1']);
  const finalNodes = world.scroller.nodes.map((n) => [n.attrs['data-uuid'],
    n.hasAttribute('data-history-row-real') ? 'real' : n.hasAttribute('data-history-row-stub') ? 'stub' : 'shell']);
  assert.deepEqual(finalNodes, [['w1', 'real'], ['s1', 'real'], ['s2', 'stub']]);
});

test('S6 (observation) rows hydrated after a stubs-only DONE mount real in one commit', (t) => {
  const world = createWorld([stub('a'), stub('b'), stub('c'), stub('d'), stub('e')]);
  const result = world.run({ maxWakes: 60 });
  world.rows.forEach((row, i) => { world.rows[i] = entry(row.uuid); });
  world.render();
  const realNow = world.scroller.nodes.filter((n) => n.hasAttribute('data-history-row-real')).length;
  const shellNow = world.scroller.nodes.filter((n) => n.hasAttribute('data-history-mount-shell')).length;
  t.diagnostic(`done=${result.done} wakes=${result.wakes} steps=${result.steps} realInLandingCommit=${realNow} shellsInLandingCommit=${shellNow} realUuidsBeforeLanding=${result.real.length}`);
});

const kinds = (world) => world.scroller.nodes.map((n) => [n.attrs['data-uuid'],
  n.hasAttribute('data-history-row-real') ? 'real' : n.hasAttribute('data-history-row-stub') ? 'stub' : 'shell']);

test('S7 hidden panel parked on stubs, then shown at the tail: who protects the first presented paint?', (t) => {
  const rows = [stub('top1'), stub('top2'), stub('top3'),
    { ...entry('tail1'), mounted: false }, { ...entry('tail2'), mounted: false }, { ...entry('tail3'), mounted: false }];
  const world = createWorld(rows);
  const hidden = world.run({ maxWakes: 40 });
  rows.forEach((row, i) => { rows[i] = { ...row, mounted: i >= 3 }; });
  world.render();
  const shown = kinds(world).filter(([uuid]) => uuid.startsWith('tail'));
  t.diagnostic(`hidden: done=${hidden.done} wakes=${hidden.wakes} | after show tail rows: ${JSON.stringify(shown)}`);
  globalThis.__s7 = { done: hidden.done, shown };
});

test('S8 visible mixed window, stubs hydrate after the wave settles: how many mount real in the landing commit?', (t) => {
  const rows = [entry('w1'), stub('s1'), stub('s2'), stub('s3')];
  const world = createWorld(rows);
  const result = world.run({ maxWakes: 60 });
  [1, 2, 3].forEach((i) => { rows[i] = entry(rows[i].uuid); });
  world.render();
  const k = kinds(world);
  t.diagnostic(`done=${result.done} wakes=${result.wakes} steps=${result.steps} | landing commit: ${JSON.stringify(k)}`);
});

test('S9 eight stubs fill the viewport, all hydrate after the wave settled: how many mount real in one commit?', (t) => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(stub);
  const world = createWorld(rows);
  const result = world.run({ maxWakes: 60 });
  rows.forEach((row, i) => { rows[i] = entry(row.uuid); });
  world.render();
  const k = kinds(world);
  t.diagnostic(`S9 done=${result.done} wakes=${result.wakes} steps=${result.steps} realInLandingCommit=${k.filter(([, kind]) => kind === 'real').length} shellsInLandingCommit=${k.filter(([, kind]) => kind === 'shell').length}`);
});
