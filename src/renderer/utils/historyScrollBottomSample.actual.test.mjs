import assert from 'node:assert/strict';
import nodeTest, { after } from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { historyContentDistanceFromBottom, isHistoryAtContentBottom } from './historyBottomGeometry.mjs';
import { HISTORY_TAIL_PIN_THRESHOLD_PX, reconcileHistoryTailFollowIntent } from './historyBottomScroll.mjs';
import { historyPresentationOwnsWrite } from './historyPresentationOwnership.mjs';

// Full current callback is extracted from the actual component. Only the
// one historical duplicated-getter statement is a differential fixture.
// Controlled refs/DOM/timers below do not mount React or measure native latency.
const target = process.env.NOTED_HISTORY_SCROLL_SOURCE || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url);
assert.equal(Boolean(process.env.NOTED_HISTORY_SCROLL_SOURCE), Boolean(process.env.NOTED_HISTORY_SCROLL_SHA256));
assert(fs.statSync(target).size <= 2 * 1024 * 1024);
const source = fs.readFileSync(target, 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
if (process.env.NOTED_HISTORY_SCROLL_SHA256) assert.equal(sha(source), process.env.NOTED_HISTORY_SCROLL_SHA256);
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(ast.parseDiagnostics.length, 0);
const found = [];
function visit(n) {
  if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'handleScroll' && n.initializer
    && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(ast) === 'useCallback') found.push(n.initializer.arguments[0]);
  ts.forEachChild(n, visit);
}
visit(ast);
assert.equal(found.length, 1); assert(ts.isArrowFunction(found[0]));
const actual = found[0].getText(ast);
const next = 'const physicalPinned = distFromBottom <= HISTORY_TAIL_PIN_THRESHOLD_PX;';
const previous = 'const physicalPinned = isHistoryAtContentBottom(el);';
assert.equal(actual.split(next).length, 2, 'actual single-sample branch required');
const variants = { post: actual, pre: actual.replace(next, previous) }, code = {}, receipts = [];
for (const [stage, callback] of Object.entries(variants)) {
  const generated = ts.transpileModule('globalThis.__actualHandleScroll = (' + callback + ');',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  assert.equal(generated.diagnostics?.length || 0, 0);
  code[stage] = generated.outputText;
  receipts.push({ stage, sourceSHA256: sha(source), callbackSHA256: sha(callback), generatedSHA256: sha(code[stage]),
    sourceStart: found[0].getStart(ast), sourceEnd: found[0].end,
    boundary: stage === 'post' ? 'full actual current callback' : 'full current callback with only historical duplicate statement restored' });
}
assert.equal(HISTORY_TAIL_PIN_THRESHOLD_PX, 4);
const ref = current => ({ current });
const plain = value => JSON.parse(JSON.stringify(value));
const results = [], distinguishing = [], measuredGetterCounts = {};
function test(name, run) { nodeTest(name, () => { run(); results.push({ name, status: 'PASS' }); }); }
function red(name, run) {
  let failure;
  try { run(); } catch (error) { failure = error; }
  assert(failure instanceof assert.AssertionError, name + ': expected an actual observed-result assertion failure');
  distinguishing.push({ name, status: 'RED as expected', reason: failure.message.split('\n')[0] });
}

// Product callback bodies are used whole. These are controlled external
// boundaries/DOM properties, not reimplementations of scroll decisions.
function fixture(stage = 'post', options = {}, mutant) {
  const geometry = { scrollHeight: 1000, scrollTop: 796, clientHeight: 200, ...options.geometry };
  const reads = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  const pairReads = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  const measuredGeometryHelper = helper => (...args) => {
    const before = { ...reads }, value = helper(...args);
    for (const name of Object.keys(reads)) pairReads[name] += reads[name] - before[name];
    return value;
  };
  const calls = { intent: [], cancelled: 0, offsets: [], positions: [], anchors: [], layouts: [], capture: 0, trace: 0, seek: 0, diagnostics: [] };
  function scroller(values, count = reads) {
    const element = { isConnected: true, querySelectorAll: () => [] };
    for (const name of Object.keys(reads)) Object.defineProperty(element, name, {
      configurable: true, get() { count[name]++; return values[name]; },
      set(value) { throw Error('unexpected direct scroll geometry write: ' + name + '=' + value); },
    });
    return element;
  }
  const element = scroller(geometry), timers = new Map(); let nextTimer = 0;
  const env = {
    performance: { now: () => 1000 }, Date: { now: () => 123456 },
    historyContentDistanceFromBottom: measuredGeometryHelper(historyContentDistanceFromBottom),
    isHistoryAtContentBottom: measuredGeometryHelper(isHistoryAtContentBottom), HISTORY_TAIL_PIN_THRESHOLD_PX,
    reconcileHistoryTailFollowIntent, historyPresentationOwnsWrite,
    virtuosoScrollerRef: ref(options.missing ? null : element),
    historyResizeRef: ref({ active: () => options.resizing === true }),
    historyPresentationProofRef: ref({ presented: options.presented !== false, visit: 1, resumes: 0 }),
    dormantScrollLoggedRef: ref(false), isAtBottomRef: ref(options.intent === true),
    lastScrollTopRef: ref(options.previousTop ?? geometry.scrollTop),
    traceHistoryScrollEvent: () => { calls.trace++; },
    historyScrollSeekController: { setScroller() { calls.seek++; } },
    historyScrollerOwnerToken: () => 'owner-a:1', historyWheelDiagnostics: { observeScroll() {} },
    historyPointerScrollActiveRef: ref(options.pointer === true),
    historyForegroundPriority: { mark() {} }, HISTORY_FOREGROUND_PRIORITY_HOLD_MS: 0,
    hydrationBurstRef: ref({ since: 0, count: 5, tripped: true }),
    lastProgrammaticHistoryScrollRef: ref(null), tabId: 'tab-025c7369-39f8-4660-a786-2fdc7a7da5f0',
    panelDiagContextRef: ref(''), historyDiag: text => calls.diagnostics.push(text),
    historyUserGestureAtRef: ref(options.gesture ? 900 : -1000),
    historyUserScrollDirectionRef: ref(options.gesture || null),
    historyScrollInFlightRef: ref(null),
    historyTailPinScheduler: { cancel() { calls.cancelled++; } },
    setHistoryTailFollowIntent(value) { calls.intent.push(value); env.isAtBottomRef.current = value; },
    scrollArrowRef: ref({ style: { display: 'untouched' } }), scrollDirectionRef: ref('down'),
    historyRestoreInFlightRef: ref(false), viewportReadyOwnerKeyRef: ref('owner-a'), historyOwnerKeyRef: ref('owner-a'),
    updateHistoryMeasuredLayoutScrollTop: (...args) => calls.offsets.push(args),
    scrollSaveTimerRef: ref(null), scrollPositionKeyRef: ref('owner-a'),
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setHistoryScrollPosition: (...args) => calls.positions.push(args),
    captureHistoryAnchorFromDom(_element, followBottom) { calls.capture++; return { uuid: 'same-reading-uuid', offsetPx: 17.5, followBottom }; },
    setHistoryReadingAnchor: (...args) => calls.anchors.push(args), visibleRangeRef: ref({ start: 2, end: 3 }),
    mountWaveActiveRef: ref(false), displayUnitLayoutKeysRef: ref(['same-layout-identity']),
    virtuosoRef: ref({ getState(callback) { callback({ ranges: [{ startIndex: 2, endIndex: 3, size: 40 }] }); } }),
    saveHistoryMeasuredLayout: (...args) => calls.layouts.push(args),
  };
  vm.runInNewContext(mutant ? mutant(code[stage]) : code[stage], env, { filename: `actual-${stage}-handleScroll.js` });
  const flush = () => { const pending = [...timers.values()]; timers.clear(); for (const item of pending) item.callback(); };
  const observe = () => plain({ calls, direction: env.scrollDirectionRef.current, lastTop: env.lastScrollTopRef.current,
    intent: env.isAtBottomRef.current, arrow: env.scrollArrowRef.current.style.display, timerDelays: [...timers.values()].map(x => x.delay) });
  return { run: env.__actualHandleScroll, env, calls, reads, pairReads, geometry, element, scroller, timers, flush, observe };
}

test('exact whole PRE and POST callbacks preserve outputs while removing one three-getter geometry pass', () => {
  const pre = fixture('pre'), post = fixture('post'); pre.run(); post.run();
  assert.deepEqual(pre.observe(), post.observe());
  for (const name of Object.keys(pre.reads)) assert.equal(pre.reads[name] - post.reads[name], 1, name);
  assert.equal(post.reads.scrollHeight, 1); assert.equal(post.reads.clientHeight, 1);
  Object.assign(measuredGetterCounts, { wholeSynchronousCallback: { pre: { ...pre.reads }, post: { ...post.reads } },
    consecutiveBottomGeometryPair: { pre: { ...pre.pairReads }, post: { ...post.pairReads } },
    scope: 'actual extracted callback with counted controlled DOM properties, before deferred save; not measured R43 call counts' });
  red('actual PRE still performs duplicate bottom geometry getters', () => assert.equal(pre.reads.scrollHeight, 1));
});

test('4px threshold, subpixel positions, one-pixel sides and overscroll keep the same predicate', () => {
  for (const distance of [-1, 0, 3, 3.999, 4, 4.001, 5, 100, 150, 150.001, 151]) {
    const options = { geometry: { scrollTop: 800 - distance }, gesture: 'down', previousTop: 700 };
    const pre = fixture('pre', options), post = fixture('post', options); pre.run(); post.run();
    assert.deepEqual(pre.observe(), post.observe());
    assert.equal(post.calls.intent[0], distance <= 4, 'inclusive threshold: ' + distance);
    assert.equal(post.env.scrollArrowRef.current.style.display, distance > 150 ? '' : 'none', 'FAB threshold: ' + distance);
  }
});

test('new callback rereads one-pixel live height changes and a replacement actual scroller', () => {
  const value = fixture(); value.run();
  value.geometry.scrollHeight += 1; value.env.historyUserGestureAtRef.current = 900;
  value.env.historyUserScrollDirectionRef.current = 'down'; value.run();
  assert.deepEqual(value.calls.intent, [false, false]);
  value.geometry.scrollHeight -= 1; value.run(); assert.equal(value.calls.intent.at(-1), true);
  const freshReads = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  value.env.virtuosoScrollerRef.current = value.scroller({ scrollHeight: 1600, scrollTop: 1200, clientHeight: 200 }, freshReads);
  value.env.isAtBottomRef.current = false; value.run();
  assert.equal(value.calls.intent.at(-1), false); assert.equal(freshReads.scrollHeight, 1);
  assert.equal(freshReads.clientHeight, 1); assert(freshReads.scrollTop > 0);
});

test('physical proximity remains separate from following intent and an upward gesture still wins', () => {
  const quiet = fixture('post', { intent: false }); quiet.run(); assert.equal(quiet.calls.intent[0], false);
  const growing = fixture('post', { intent: true, geometry: { scrollTop: 700 } }); growing.run();
  assert.equal(growing.calls.intent[0], true, 'content growth alone does not cancel follow intent');
  const upward = fixture('post', { intent: true, gesture: 'up', previousTop: 796, geometry: { scrollTop: 795 } }); upward.run();
  assert.equal(upward.calls.intent[0], false); assert.equal(upward.calls.cancelled, 1);
});

test('missing, dormant and resize-owned paths retain their actual early returns', () => {
  for (const options of [{ missing: true }, { presented: false }, { resizing: true }]) {
    const pre = fixture('pre', options), post = fixture('post', options); pre.run(); post.run();
    assert.deepEqual(pre.observe(), post.observe()); assert.deepEqual(pre.reads, post.reads);
    assert.equal(post.calls.intent.length, 0); assert.equal(post.timers.size, 0);
    assert.equal(post.calls.trace, 0); assert.equal(post.calls.seek, 0);
  }
});

test('deferred save still reads later geometry and keeps UUID/offset plus semantic follow intent', () => {
  const pre = fixture('pre'), post = fixture('post'); pre.run(); post.run();
  pre.geometry.scrollTop = 732.25; post.geometry.scrollTop = 732.25;
  pre.flush(); post.flush(); assert.deepEqual(pre.observe(), post.observe());
  assert.deepEqual(post.calls.positions, [['owner-a', 732.25]]);
  assert.equal(post.calls.anchors[0][1].uuid, 'same-reading-uuid');
  assert.equal(post.calls.anchors[0][1].offsetPx, 17.5); assert.equal(post.calls.anchors[0][1].followBottom, false);
  assert.equal(post.calls.layouts.length, 1);
});

test('deferred old owner/visit/disconnection/restore work still cannot save', () => {
  for (const stale of [
    f => { f.env.scrollPositionKeyRef.current = 'owner-b'; },
    f => { f.env.historyPresentationProofRef.current = { presented: true, visit: 2 }; },
    f => { f.env.historyPresentationProofRef.current.presented = false; },
    f => { f.element.isConnected = false; },
    f => { f.env.historyRestoreInFlightRef.current = true; },
  ]) {
    const pre = fixture('pre'), post = fixture('post'); pre.run(); post.run(); stale(pre); stale(post); pre.flush(); post.flush();
    assert.deepEqual(pre.observe(), post.observe()); assert.equal(post.calls.positions.length, 0);
    assert.equal(post.calls.anchors.length, 0); assert.equal(post.calls.capture, 0); assert.equal(post.calls.layouts.length, 0);
  }
});

test('a later async Virtuoso state answer cannot cross owner or presentation visit', () => {
  for (const change of [f => { f.env.historyOwnerKeyRef.current = 'owner-b'; },
    f => { f.env.historyPresentationProofRef.current = { presented: true, visit: 2 }; }]) {
    const value = fixture(); let answer;
    value.env.virtuosoRef.current.getState = callback => { answer = callback; };
    value.run(); value.flush(); assert.equal(typeof answer, 'function'); change(value); answer({ ranges: [] });
    assert.equal(value.calls.layouts.length, 0);
  }
});

test('distinguishing actual-code mutants reject exclusive threshold, cross-call cache, and physical-as-intent', () => {
  const replacement = (before, after) => source => {
    assert.equal(source.split(before).length, 2, 'one exact generated mutation anchor'); return source.replace(before, after);
  };
  red('exclusive < threshold loses the real four-pixel boundary', () => {
    const value = fixture('post', { gesture: 'down' }, replacement('distFromBottom <= HISTORY_TAIL_PIN_THRESHOLD_PX', 'distFromBottom < HISTORY_TAIL_PIN_THRESHOLD_PX'));
    value.run(); assert.equal(value.calls.intent[0], true);
  });
  red('cross-callback cached distance hides one-pixel content growth', () => {
    const value = fixture('post', { gesture: 'down' }, replacement('historyContentDistanceFromBottom(el)',
      '(globalThis.__badCachedDistance ??= historyContentDistanceFromBottom(el))'));
    value.run(); value.geometry.scrollHeight += 1; value.env.isAtBottomRef.current = false; value.run();
    assert.equal(value.calls.intent[1], false);
  });
  red('physical-at-bottom alone must not become following intent', () => {
    const value = fixture('post', {}, source => {
      const pattern = /setHistoryTailFollowIntent\(reconcileHistoryTailFollowIntent\(\{[\s\S]*?\}\)\);/;
      assert(pattern.test(source)); return source.replace(pattern, 'setHistoryTailFollowIntent(physicalPinned);');
    });
    value.run(); assert.equal(value.calls.intent[0], false);
  });
});

after(() => {
const report = { version: 1, node: process.version, command: 'node --test src/renderer/utils/historyScrollBottomSample.actual.test.mjs',
  scope: 'AST-extracted full actual PRE/POST callback + real production bottom/follow/presentation helpers; controlled external dependencies; no mounted React/native performance claim',
  controls: results, distinguishing, measuredGetterCounts, extraction: receipts,
  anchorBoundary: 'captureHistoryAnchorFromDom is a controlled external stub: these tests verify exact UUID/offset pass-through and stale-write gates, not real DOM anchor extraction or native acceptance',
  summary: { passed: results.length, distinguishingRed: distinguishing.length } };
if (process.env.NOTED_HISTORY_SCROLL_REPORT) fs.writeFileSync(process.env.NOTED_HISTORY_SCROLL_REPORT, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report.summary) + '\n');

});
