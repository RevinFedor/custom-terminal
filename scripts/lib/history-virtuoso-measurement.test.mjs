import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  HISTORY_VIRTUOSO_PATCH_MARKER,
  HISTORY_VIRTUOSO_UPSTREAM_SHA256,
  HISTORY_VIRTUOSO_VERSION,
  historyVirtuosoMeasurementEsbuildPlugin,
  historyVirtuosoMeasurementVitePlugin,
  patchHistoryVirtuoso,
} from './history-virtuoso-measurement.mjs';

const require = createRequire(import.meta.url);
const upstreamPath = join(dirname(require.resolve('react-virtuoso')), 'index.mjs');
const upstream = readFileSync(upstreamPath, 'utf8');
const patched = patchHistoryVirtuoso(upstream);
const hash = (source) => createHash('sha256').update(source).digest('hex');

// These boundaries are in the hash-pinned distribution. Execute its real Mn,
// De, Lo, and In bodies below, not a rewritten model of their behavior.
function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `missing ${name}/${nextName} boundary`);
  return source.slice(start, end);
}

function extractCall(source, caller) {
  const callerStart = source.indexOf(`${caller} = /* @__PURE__ */ E.memo(`);
  assert.ok(callerStart >= 0, `missing ${caller}`);
  const start = source.indexOf('Mn(', callerStart);
  const end = source.indexOf('\n  ),', start) + '\n  )'.length;
  assert.ok(start > callerStart && end > start, `missing ${caller} measurement call`);
  return source.slice(start, end);
}

function callArguments(source, caller, context) {
  const values = {
    Mn: (...args) => args,
    o: 'size-ranges', I: 'item-size', p: 'track-sizes', e: false,
    Jt: 'noop', c: 'scroll-state', w: 'log', R: 'gap', s: 'custom-parent',
    h: 'horizontal', m: context, d: 'table-track', v: 'table-log', n: 'list-state',
    A: (name) => `A:${name}`, M: (name) => `M:${name}`,
  };
  return new Function(...Object.keys(values), `return ${extractCall(source, caller)};`)(...Object.values(values));
}

function forbidPositionWrites(node) {
  for (const name of ['scrollTop', 'scrollLeft']) {
    const value = node[name] ?? 0;
    Object.defineProperty(node, name, {
      get: () => value,
      set: () => assert.fail(`unexpected position write: ${name}`),
    });
  }
  node.style = new Proxy({}, { set: () => assert.fail('unexpected style/anchor write') });
  node.scrollTo = node.scrollBy = node.setAttribute = () => assert.fail('unexpected position/attribute write');
  return node;
}

function hookHarness(source = patched) {
  const events = [];
  const batches = [];
  const states = [];
  const gaps = [];
  const observers = [];
  const frames = [];
  const slots = [];
  let cursor = 0;
  let expectedHooks;
  let layoutEffects = [];
  let rendered;
  let attached;
  let phase = 'idle';
  const rows = [
    { dataset: { index: '5', knownSize: '20' }, offsetHeight: 20, offsetWidth: 50 },
    { dataset: { index: '6', knownSize: '20' }, offsetHeight: 20, offsetWidth: 50 },
  ];
  rows.item = (index) => rows[index];
  const scroller = forbidPositionWrites({
    dataset: { virtuosoScroller: 'true' },
    lastElementChild: { dataset: { viewportType: 'element' } },
    scrollHeight: 900, offsetHeight: 200, scrollTop: 310,
    scrollWidth: 1600, offsetWidth: 600, scrollLeft: 90,
  });
  const list = forbidPositionWrites({
    children: rows, offsetParent: {}, parentElement: { dataset: {}, parentElement: scroller },
  });
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  function slot(kind) {
    assert.equal(phase, 'render', `${kind} must be called during render`);
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind };
    assert.equal(slots[index].kind, kind, 'hook order changed');
    return slots[index];
  }
  function memo(kind, factory, deps) {
    const current = slot(kind);
    if (!sameDeps(current.deps, deps)) {
      current.value = factory();
      current.deps = deps;
    }
    return current.value;
  }
  const E = {
    useCallback: (callback, deps) => memo('callback', () => callback, deps),
    useMemo: (factory, deps) => memo('memo', factory, deps),
    useRef: (initial) => {
      const current = slot('ref');
      current.value ??= { current: initial };
      return current.value;
    },
    useLayoutEffect: (callback, deps) => {
      const current = slot('layout');
      if (!sameDeps(current.deps, deps)) layoutEffects.push(callback);
      current.deps = deps;
    },
    useEffect: () => assert.fail('no new passive effect/subscription'),
  };
  class ResizeObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    deliver() {
      if (this.targets.size) this.callback([...this.targets].map((target) => ({ target })));
    }
  }
  const runtime = {
    E,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: (callback) => { events.push('queue-frame'); frames.push(callback); },
    getComputedStyle: () => ({ rowGap: '7px', columnGap: '9px' }),
    _t: (_element, value) => value,
    ft: { ERROR: 'error', WARN: 'warn' },
    setTimeout: () => assert.fail('no new timer'),
    setInterval: () => assert.fail('no new interval'),
    queueMicrotask: () => assert.fail('no new microtask'),
  };
  const body = [
    extractFunction(source, 'De', 'Mn'),
    extractFunction(source, 'Mn', 'Lo'),
    extractFunction(source, 'Lo', 'In'),
    extractFunction(source, 'In', '$e'),
    'return Mn;',
  ].join('\n');
  const Mn = new Function(...Object.keys(runtime), body)(...Object.values(runtime));
  const args = [
    (value) => { events.push('sizes'); batches.push(value); },
    (row, dimension) => { events.push(`measure:${phase}`); return row[dimension]; },
    true,
    (value) => { events.push('scroll-state'); states.push(value); },
    () => assert.fail('unexpected measurement warning'),
    (value) => { events.push('gap'); gaps.push(value); },
    undefined, false, false,
  ];
  return {
    events, batches, states, gaps, observers, frames, rows, scroller, list,
    render({ opt, track = true, skipFrame = false, horizontal = false, customParent, renderState = {} } = {}) {
      phase = 'render';
      cursor = 0;
      layoutEffects = [];
      const currentArgs = [...args];
      currentArgs[2] = track;
      currentArgs[6] = customParent;
      currentArgs[7] = horizontal;
      currentArgs[8] = skipFrame;
      if (opt !== undefined) currentArgs.push(opt, renderState);
      rendered = Mn(...currentArgs);
      expectedHooks ??= cursor;
      assert.equal(cursor, expectedHooks, 'hook count changed');
      phase = 'idle';
      return rendered;
    },
    attach(node = list) {
      phase = 'commit';
      events.push('commit');
      attached?.(null);
      rendered.callbackRef(node);
      attached = rendered.callbackRef;
      phase = 'idle';
    },
    layout() {
      phase = 'layout';
      const callbacks = layoutEffects;
      layoutEffects = [];
      for (const callback of callbacks) assert.equal(callback(), undefined);
      phase = 'idle';
    },
    paint() { events.push('paint'); },
    unmount() { attached?.(null); attached = undefined; },
    resize() {
      phase = 'resize';
      observers.at(-1).deliver();
      phase = 'idle';
    },
    flushFrames() {
      phase = 'frame';
      for (const callback of frames.splice(0)) callback();
      phase = 'idle';
    },
  };
}

test('pinned distribution changes only Mn and the Hn call; other callers stay byte-identical', () => {
  assert.equal(HISTORY_VIRTUOSO_VERSION, '4.18.7');
  assert.equal(hash(upstream), HISTORY_VIRTUOSO_UPSTREAM_SHA256);
  assert.equal(patched.split(HISTORY_VIRTUOSO_PATCH_MARKER).length - 1, 1);
  assert.equal(
    upstream.replace(extractFunction(upstream, 'Mn', 'Lo'), extractFunction(patched, 'Mn', 'Lo'))
      .replace(extractCall(upstream, 'Hn'), extractCall(patched, 'Hn')),
    patched,
  );
  assert.equal(extractCall(patched, 'Or'), extractCall(upstream, 'Or'));
  assert.equal(patchHistoryVirtuoso(upstream), patched, 'pure transform is deterministic');
});

test('actual Hn call forwards only the optional predicate; Table still passes nine arguments', () => {
  const opt = () => true;
  const originalArgs = callArguments(upstream, 'Hn', { historyMeasureBeforePaint: opt });
  const args = callArguments(patched, 'Hn', { historyMeasureBeforePaint: opt });
  assert.deepEqual(args.slice(0, 9), originalArgs);
  assert.equal(args.length, 11);
  assert.equal(args[9], opt);
  assert.equal(args[10], 'list-state');
  for (const context of [null, undefined, {}, 'ordinary-context']) {
    assert.equal(callArguments(patched, 'Hn', context)[9], undefined);
  }
  const tableArgs = callArguments(patched, 'Or', 'table-item-size');
  assert.equal(tableArgs.length, 9);
  assert.deepEqual(tableArgs, callArguments(upstream, 'Or', 'table-item-size'));
});

test('opted-in commit measures fresh DOM in layout before paint through the original streams', () => {
  const h = hookHarness();
  let allowed = false;
  let predicateCalls = 0;
  const measured = h.render({ opt: () => { predicateCalls++; return allowed; } });
  assert.equal(predicateCalls, 0, 'predicate must not be captured during render');
  assert.equal(measured.ref.current, null);
  assert.equal(h.batches.length, 0);
  h.rows[0].offsetHeight = h.rows[1].offsetHeight = 37;
  allowed = true;
  h.attach();
  assert.equal(measured.ref.current, h.list);
  assert.equal(h.batches.length, 0, 'ref attachment alone must retain upstream behavior');
  h.layout();
  h.paint();
  assert.equal(predicateCalls, 1);
  assert.deepEqual(h.batches, [[{ startIndex: 5, endIndex: 6, size: 37 }]]);
  assert.deepEqual(h.states, [{ scrollHeight: 900, scrollTop: 310, viewportHeight: 200 }]);
  assert.deepEqual(h.gaps, [7]);
  assert.deepEqual(h.events, ['commit', 'measure:layout', 'measure:layout', 'scroll-state', 'gap', 'sizes', 'paint']);
  assert.equal(h.frames.length, 0, 'no extra animation frame');
  h.layout();
  h.flushFrames();
  assert.equal(h.batches.length, 1, 'one batch from this commit, no background work');
});

test('every commit checks the fresh predicate; toggling opt-in preserves hooks and observer identity', () => {
  const h = hookHarness();
  let presented = true;
  let resizing = false;
  const opt = () => presented && !resizing;
  const first = h.render({ opt });
  h.attach();
  resizing = true;
  h.layout();
  assert.equal(h.batches.length, 0, 'resize guard changed after render');
  const observerCallback = h.observers[0].callback;
  for (const size of [37, 66]) {
    resizing = false;
    h.render({ opt });
    h.rows[0].offsetHeight = h.rows[1].offsetHeight = size;
    h.attach();
    h.layout();
    assert.equal(h.batches.at(-1)[0].size, size);
  }
  h.render({ opt });
  h.attach();
  presented = false;
  h.layout();
  for (const disabled of [undefined, null, false, true, 1, 'enabled', {}, () => false]) {
    const measured = h.render({ opt: disabled });
    assert.equal(measured.ref, first.ref);
    h.attach();
    h.layout();
  }
  assert.equal(h.batches.length, 2);
  assert.equal(h.observers.length, 1, 'opt-in must not resubscribe ResizeObserver');
  assert.equal(h.observers[0].callback, observerCallback);
  h.render({ opt: () => true });
  h.attach();
  h.layout();
  assert.equal(h.batches.length, 3, 're-enabled commit gets a batch');
});

test('hidden, untracked, missing and unmounted refs suppress layout measurement', () => {
  const h = hookHarness();
  h.render({ opt: () => true });
  h.layout();
  assert.equal(h.batches.length, 0, 'no mounted list');
  h.render({ opt: () => true });
  h.attach();
  h.list.offsetParent = null;
  h.layout();
  h.resize();
  h.flushFrames();
  assert.equal(h.batches.length, 0, 'hidden DOM');
  h.list.offsetParent = {};
  const untracked = h.render({ opt: () => true, track: false });
  h.attach();
  assert.equal(untracked.ref.current, null);
  // Also exercise Mn's own n guard with a stale ref, independently of De.
  untracked.ref.current = h.list;
  h.layout();
  untracked.ref.current = null;
  assert.equal(h.batches.length, 0, 'track=false');
  h.render({ opt: () => true });
  h.attach();
  h.unmount();
  h.layout();
  h.resize();
  h.flushFrames();
  assert.equal(h.batches.length, 0, 'unmount before layout');
  assert.equal(h.observers[0].targets.size, 0);
  assert.equal(h.states.length, 0);
  assert.equal(h.gaps.length, 0);
});

test('unrelated context commits do not remeasure an unchanged list', () => {
  const h = hookHarness();
  const opt = () => true, renderState = {};
  h.render({ opt, renderState }); h.attach(); h.layout();
  const events = h.events.filter(e => e.startsWith('measure:')).length;
  for (let i = 0; i < 40; i++) {
    h.render({ opt, renderState }); h.attach(); h.layout();
  }
  assert.equal(h.events.filter(e => e.startsWith('measure:')).length, events);
  h.render({ opt, renderState: {} }); h.attach(); h.layout();
  assert.equal(h.events.filter(e => e.startsWith('measure:')).length, events + 2);
});

for (const skipFrame of [false, true]) {
  test(`natural ResizeObserver callback is unchanged (skip frame: ${skipFrame})`, () => {
    const h = hookHarness();
    let optedIn = true;
    const opt = () => optedIn;
    h.render({ opt, skipFrame });
    h.attach();
    h.layout();
    const observer = h.observers[0];
    const callback = observer.callback;
    optedIn = false;
    h.render({ opt, skipFrame });
    h.attach();
    h.layout();
    assert.equal(h.batches.length, 1);
    h.rows[0].offsetHeight = h.rows[1].offsetHeight = 66;
    h.resize();
    assert.equal(h.batches.length, skipFrame ? 2 : 1);
    assert.equal(h.frames.length, skipFrame ? 0 : 1);
    h.flushFrames();
    assert.deepEqual(h.batches.at(-1), [{ startIndex: 5, endIndex: 6, size: 66 }]);
    assert.equal(h.batches.length, 2, 'opt-in does not gate the existing resize path');
    assert.equal(observer.callback, callback);
    assert.equal(h.observers.length, 1);
    h.unmount();
    h.resize();
    h.flushFrames();
    assert.equal(h.batches.length, 2);
  });
}

test('nine-argument callers match upstream resize behavior and add no position writes', () => {
  function scenario(source) {
    const h = hookHarness(source);
    h.render();
    h.attach();
    h.layout();
    assert.equal(h.batches.length, 0);
    h.rows[0].offsetHeight = h.rows[1].offsetHeight = 43;
    h.resize();
    h.flushFrames();
    h.list.offsetParent = null;
    h.resize();
    h.flushFrames();
    h.unmount();
    return { events: h.events, batches: h.batches, states: h.states, gaps: h.gaps };
  }
  assert.deepEqual(scenario(patched), scenario(upstream));
});

test('the added batch reuses custom-parent and horizontal measurement without position writes', () => {
  const h = hookHarness();
  const customParent = forbidPositionWrites({ scrollWidth: 2500, offsetWidth: 450, scrollLeft: 128 });
  h.render({ opt: () => true, horizontal: true, customParent });
  h.attach();
  h.layout();
  assert.deepEqual(h.batches, [[{ startIndex: 5, endIndex: 6, size: 50 }]]);
  assert.deepEqual(h.states, [{ scrollHeight: 2500, scrollTop: 128, viewportHeight: 450 }]);
  assert.deepEqual(h.gaps, [9]);
});

test('hash mismatch is actionable even when all replacement anchors still match', () => {
  const changed = `${upstream}\n// upstream changed\n`;
  assert.throws(() => patchHistoryVirtuoso(changed), (error) => {
    assert.match(error.message, /react-virtuoso@4\.18\.7.*SHA-256 mismatch/);
    assert.ok(error.message.includes(HISTORY_VIRTUOSO_UPSTREAM_SHA256));
    assert.ok(error.message.includes(hash(changed)));
    assert.match(error.message, /pristine pinned dependency/);
    assert.match(error.message, /update the pinned hash, replacements, and tests together/);
    return true;
  });
});

test('every exact replacement refuses missing or duplicate anchors', () => {
  for (const [label, anchor] of [
    ['Mn signature', 'function Mn(t, e, n, o, r, s, i, l, c) {'],
    ['Mn measurement return', '  return De(d, n, c);\n}'],
    ['Hn list measurement call', extractCall(upstream, 'Hn')],
  ]) {
    for (const [count, source] of [[0, upstream.replace(anchor, '')], [2, `${upstream}\n${anchor}`]]) {
      assert.throws(() => patchHistoryVirtuoso(source), (error) => {
        assert.ok(error.message.includes(`${label}: expected exactly 1 replacement, found ${count}`));
        assert.ok(error.message.includes(hash(source)));
        return true;
      });
    }
  }
});

test('marker, repeated patch, stripped-marker patch and non-string input are refused', () => {
  for (const source of [patched, `${upstream}\n${HISTORY_VIRTUOSO_PATCH_MARKER}`]) {
    assert.throws(() => patchHistoryVirtuoso(source), /patch marker already present \(double patch\)/);
  }
  assert.throws(() => patchHistoryVirtuoso(patched.replace(HISTORY_VIRTUOSO_PATCH_MARKER, '')), /expected exactly 1 replacement, found 0/);
  for (const source of [undefined, null, Buffer.from(upstream), 42]) {
    assert.throws(() => patchHistoryVirtuoso(source), TypeError);
  }
});

test('Vite runs pre, merges prebundle exclusion, and transforms only the ESM distribution', async () => {
  const { mergeConfig } = await import('vite');
  const plugin = historyVirtuosoMeasurementVitePlugin();
  assert.equal(plugin.enforce, 'pre');
  const existing = { optimizeDeps: { exclude: ['other'], include: ['keep'], esbuildOptions: { target: 'esnext' } } };
  const snapshot = structuredClone(existing);
  const config = mergeConfig(existing, plugin.config(existing));
  assert.deepEqual(config.optimizeDeps.exclude, ['other', 'react-virtuoso']);
  assert.deepEqual(config.optimizeDeps.include, ['keep']);
  assert.equal(config.optimizeDeps.esbuildOptions.target, 'esnext');
  assert.deepEqual(existing, snapshot, 'config hook must not mutate the parent config');
  for (const id of [
    upstreamPath,
    '/frozen/react-virtuoso/dist/index.mjs',
    '/root/node_modules/.pnpm/react-virtuoso@4.18.7/node_modules/react-virtuoso/dist/index.mjs?v=abc',
    'C:\\frozen\\react-virtuoso\\dist\\index.mjs',
  ]) {
    assert.deepEqual(plugin.transform(upstream, id), { code: patched, map: null });
  }
  for (const id of [
    '/src/index.mjs', '/react-virtuoso/dist/index.cjs', '/react-virtuoso/dist/index.mjs.map',
    '/other-react-virtuoso/dist/index.mjs', '/react-virtuoso/dist/index.mjs/child',
    '\0/react-virtuoso/dist/index.mjs', '/react-virtuoso/dist/other.mjs',
  ]) {
    assert.equal(plugin.transform('unrelated source', id), null, id);
  }
  assert.throws(() => plugin.transform(`${upstream}\n`, upstreamPath), /SHA-256 mismatch/);
  assert.throws(() => plugin.transform(patched, upstreamPath), /double patch/);
});

function esbuildLoad(plugin) {
  const registrations = [];
  plugin.setup({ onLoad: (options, callback) => registrations.push({ ...options, callback }) });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].namespace, 'file');
  return registrations[0];
}

test('esbuild onLoad agrees byte-for-byte with Vite and provides the module resolveDir', async () => {
  const registration = esbuildLoad(historyVirtuosoMeasurementEsbuildPlugin());
  assert.ok(registration.filter.test(upstreamPath));
  assert.ok(registration.filter.test('C:\\copy\\react-virtuoso\\dist\\index.mjs'));
  for (const id of ['/react-virtuoso/dist/index.cjs', '/x-react-virtuoso/dist/index.mjs', '/react-virtuoso/dist/index.mjs.map']) {
    assert.equal(registration.filter.test(id), false);
  }
  const loaded = await registration.callback({ path: upstreamPath });
  assert.deepEqual(loaded, {
    contents: historyVirtuosoMeasurementVitePlugin().transform(upstream, upstreamPath).code,
    loader: 'js', resolveDir: dirname(upstreamPath),
  });
});

test('frozen standalone adapter imports and esbuild bundles the real patch without disk writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'noted-history-virtuoso-adapter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapterPath = join(dir, 'history-virtuoso-measurement.mjs');
  const moduleDir = join(dir, 'react-virtuoso', 'dist');
  const moduleFile = join(moduleDir, 'index.mjs');
  await mkdir(moduleDir, { recursive: true });
  await copyFile(new URL('./history-virtuoso-measurement.mjs', import.meta.url), adapterPath);
  await writeFile(moduleFile, upstream);
  await chmod(adapterPath, 0o444);
  await chmod(moduleFile, 0o444);
  const frozen = await import(pathToFileURL(adapterPath).href);
  assert.equal(frozen.patchHistoryVirtuoso(upstream), patched);
  const { build } = await import('esbuild');
  const resolutions = [];
  const result = await build({
    entryPoints: [moduleFile], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
    plugins: [frozen.historyVirtuosoMeasurementEsbuildPlugin(), {
      name: 'check-frozen-resolve-dir',
      setup(builder) {
        builder.onResolve({ filter: /^react(?:-dom)?($|\/)/ }, (args) => {
          resolutions.push(args);
          assert.equal(realpathSync(args.resolveDir), realpathSync(moduleDir));
          return { path: args.path, external: true };
        });
      },
    }],
  });
  assert.ok(resolutions.length >= 2, 'React imports must resolve relative to the copied distribution');
  assert.equal(result.outputFiles.length, 1);
  assert.match(result.outputFiles[0].text, /historyMeasureBeforePaint/);
  assert.equal(await readFile(moduleFile, 'utf8'), upstream, 'copied distribution remains pristine');
  assert.equal(await readFile(upstreamPath, 'utf8'), upstream, 'installed distribution remains pristine');
});

test('esbuild refuses drift and double patch rather than falling back to an unpatched file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'noted-history-virtuoso-refusal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleDir = join(dir, 'react-virtuoso', 'dist');
  const moduleFile = join(moduleDir, 'index.mjs');
  await mkdir(moduleDir, { recursive: true });
  const registration = esbuildLoad(historyVirtuosoMeasurementEsbuildPlugin());
  for (const [source, message] of [[`${upstream}\n`, /SHA-256 mismatch/], [patched, /double patch/]]) {
    await writeFile(moduleFile, source);
    await assert.rejects(registration.callback({ path: moduleFile }), message);
    assert.equal(await readFile(moduleFile, 'utf8'), source);
  }
});
