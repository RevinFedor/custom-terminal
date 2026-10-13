import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Test the client's admission/evidence helpers, not a replacement Electron UI.
const source = fs.readFileSync(new URL('./history-research-tools-e2e.mjs', import.meta.url), 'utf8');
const readinessSource = source.slice(source.indexOf('function historyReadiness('), source.indexOf('\nfunction captureHitPoint('));
const captureSource = source.slice(source.indexOf('function captureHitPoint('), source.indexOf('\nconst [leaseArg'));
const readiness = vm.runInNewContext('(' + readinessSource + ')');
function root(overrides = {}) {
  const state = { presented: '1', viewportReady: '1', resizeLock: null, loader: false, stale: false, inert: false, ...overrides };
  return { state,
    getAttribute: name => state[({ 'data-history-presented': 'presented', 'data-history-viewport-ready': 'viewportReady', 'data-history-resize-locked': 'resizeLock' })[name]],
    querySelector: selector => selector.includes('viewport-loader') ? state.loader : state.stale,
    closest: () => state.inert,
  };
}
test('ready requires the exact presented viewport with no input or paint gate', () => {
  assert.equal(readiness(root()).ready, true);
  for (const blocked of [{ presented: '0' }, { viewportReady: '0' }, { resizeLock: 'settling' },
    { resizeLock: 'dragging' }, { loader: true }, { stale: true }, { inert: true }]) {
    assert.equal(readiness(root(blocked)).ready, false, JSON.stringify(blocked));
  }
});
test('old viewport proof never releases a later resize transaction early', () => {
  const n = root({ resizeLock: 'settling', loader: true });
  assert.equal(readiness(n).ready, false);
  n.state.resizeLock = null;
  assert.equal(readiness(n).ready, false, 'React loader must disappear as well');
  n.state.loader = false;
  assert.equal(readiness(n).ready, true);
});
test('hit evidence uses fresh post-resize geometry and retains the rejected node', () => {
  let actualPoint;
  const owner = { getAttribute: () => 'research-group' };
  const target = { tagName: 'BUTTON', getAttribute: () => 'group', closest: selector => selector.includes('pane') ? owner : null,
    getBoundingClientRect: () => ({ x: 20, y: 50, width: 300, height: 24, toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height }; } }),
    contains: () => false };
  const blocker = { tagName: 'DIV', getAttribute: () => 'resize-surface', closest: target.closest };
  const capture = vm.runInNewContext('(' + captureSource + ')', {
    document: { elementFromPoint: (x, y) => { actualPoint = { x, y }; return blocker; } },
    getComputedStyle: () => ({ pointerEvents: 'none', visibility: 'visible' }),
    innerWidth: 536, innerHeight: 1000, devicePixelRatio: 2,
  });
  const evidence = capture(target, 'group-empty-right');
  assert.deepEqual(actualPoint, { x: 288, y: 62 });
  assert.equal(evidence.hit, false);
  assert.equal(evidence.hitNode.class, 'resize-surface');
  assert.equal(evidence.rect.width, 300);
  assert.equal(evidence.owner, 'research-group');
  assert.equal(evidence.viewport.dpr, 2);
});
test('a rejected point is logged before assertion, never discarded', () => {
  const record = source.indexOf("mark(step + ':before', actual)");
  const assertion = source.indexOf("assert.ok(actual.hit");
  assert.ok(record > 0 && assertion > record);
  assert.ok(source.indexOf("await waitHistoryReady('layout-' + width + '-' + font)") > 0);
});
