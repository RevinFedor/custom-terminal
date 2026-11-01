'use strict';

// The mount wave's only termination test is "no shells left in my list". Two
// different renderers emit `data-history-mount-shell`: the wave's own shells,
// which it upgrades, and bounded-window stubs, which only main can hydrate.
// Counting stubs made the test unreachable, so the wave re-upgraded its own
// rows indefinitely — one live visit logged rows=5 upgraded=141207 steps=47238
// while 44 healthy waves stayed at upgraded≈rows.
//
// These are source contracts only, and a weak control on their own: neutralising
// the gate these selectors feed (`shellNodes.length < 0`) still passes all five.
// The behavioural control is the sibling `historyMountWaveStep.test.mjs`, which
// runs the real step function and fails on pre-fix source. Keep both: this file
// pins the selector text and the paired diagnostic counters, that one pins the
// behaviour. Runtime acceptance is the installed build's own MOUNT_WAVE_DONE
// never printing `upgraded > rows` (7 of 61 waves did before the fix); the ratio
// `upgraded/rows ≈ 1` is NOT the metric — 20 of 25 healthy waves with rows ≥ 50
// sit below 0.1, because the drain switches the tail in one commit.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'HistoryPanel.tsx'), 'utf8');

const STUB_ATTR = 'data-history-row-stub';
const SHELL_ATTR = 'data-history-mount-shell';

function drainSelector() {
  const anchor = source.indexOf('const shellNodes = scroller.querySelectorAll(');
  assert.ok(anchor > 0, 'the wave drain query must stay in HistoryPanel');
  const selector = source.slice(anchor, source.indexOf(');', anchor));
  assert.ok(selector.includes(SHELL_ATTR), 'drain query must still select shells');
  return selector;
}

test('the drain query ignores stubs the wave can never upgrade', () => {
  const selector = drainSelector();
  assert.match(
    selector,
    new RegExp(`\\[${SHELL_ATTR}\\]:not\\(\\[${STUB_ATTR}\\]\\)`),
    'a mounted bounded-window stub must not keep the wave stepping',
  );
  assert.ok(
    selector.includes('data-history-row-owner'),
    'the drain query must stay scoped to this list owner',
  );
});

test('the stub renderer is the reason the two markers must be told apart', () => {
  const stubRender = source.indexOf(`${STUB_ATTR}="1"`);
  assert.ok(stubRender > 0, 'stub rows must keep their own marker');
  const block = source.slice(stubRender - 400, stubRender + 200);
  assert.ok(
    block.includes(`${SHELL_ATTR}="1"`),
    'stub rows still carry the shell marker, which is exactly why the drain query must exclude them',
  );
});

test('wave shells stay distinguishable from stubs', () => {
  const asShell = source.indexOf('const asShell =');
  assert.ok(asShell > 0, 'the wave shell branch must stay');
  const render = source.indexOf(`${SHELL_ATTR}="1"`, asShell);
  const block = source.slice(render, render + 400);
  assert.ok(
    !block.includes(STUB_ATTR),
    'a wave shell must never carry the stub marker, or the drain query would skip real work',
  );
});

test('an empty row window still waits instead of declaring the wave done', () => {
  const guard = source.indexOf('const anyOwnerRows = scroller.querySelectorAll(');
  assert.ok(guard > 0, 'the empty-window guard must survive this change');
  const block = source.slice(guard, guard + 320);
  assert.ok(
    !block.includes(`:not([${STUB_ATTR}])`),
    'the mounted-rows guard counts ANY owner row; narrowing it would reintroduce the one-giant-commit regression',
  );
  assert.match(block, /if \(anyOwnerRows === 0\) return;/,
    'zero mounted rows must keep waiting for rangeChanged');
});

test('diagnostic call sites keep reporting shells and stubs separately', () => {
  const pairs = source.split(`querySelectorAll('[${SHELL_ATTR}]')`).length - 1;
  assert.ok(pairs >= 2, 'diagnostic shell counters must stay');
  const stubCounters = source.split(`querySelectorAll('[${STUB_ATTR}]')`).length - 1;
  assert.equal(pairs, stubCounters,
    'every diagnostic shell count must keep its paired stub count, so logs stay readable');
});
