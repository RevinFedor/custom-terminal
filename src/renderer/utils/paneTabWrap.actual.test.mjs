import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({
  entryPoints: [new URL('./paneTabDragBridge.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'],
});
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console: { log() {} },
  require: name => { assert.equal(name, 'react'); return { useSyncExternalStore() {} }; },
});
const { resolvePaneTabDropTarget: resolve, beginPaneTabDrag: begin,
  endPaneTabDrag: end, setPaneTabDragTarget: setTarget, claimPaneTabDragDrop: claim } = module.exports;

function strip({ paneKey = 'pane:0', spaceId = 'a', oldWrapValue = 'false' } = {}) {
  let writes = 0, reads = 0;
  const chips = ['a', 'b', 'c', 'd'].map((id, i) => ({ id,
    left: i % 2 * 110 + 10, right: i % 2 * 110 + 110,
    top: Math.floor(i / 2) * 36 + 10, bottom: Math.floor(i / 2) * 36 + 36 }));
  const el = {
    dataset: { paneKey, spaceId, paneTabDropZone: 'strip', paneTabStripWrap: oldWrapValue },
    clientWidth: 220, scrollWidth: 800, scrollTop: 0,
    get scrollLeft() { return 0; }, set scrollLeft(_) { writes++; },
    closest: selector => selector === '[data-pane-tab-drop-zone]' ? el : null,
    matches: () => true,
    getBoundingClientRect: () => ({ left: 0, right: 220, top: 0, bottom: 80, width: 220 }),
    querySelectorAll: () => { reads++; return chips.map(chip => ({
      dataset: { stripTabId: chip.id }, getBoundingClientRect: () => chip,
    })); },
  };
  return { el, chips, writes: () => writes, reads: () => reads };
}
const source = { owner: 'pane', rootTabId: 'd', entries: [{ projectId: 'p', tabId: 'd' }],
  sourcePaneKey: 'pane:0', sourceSpaceId: 'a' };

test('pane resolver uses row Y even when old strip metadata says single-row', () => {
  begin(source);
  const { el } = strip();
  assert.equal(resolve(el, 30, ['d'], 20).at, 0);
  assert.equal(resolve(el, 30, ['d'], 55).at, 2);
  assert.equal(resolve(el, 200, ['d'], 55).at, 3);
  end();
});

test('drag at either edge never scrolls the wrapped strip', () => {
  begin(source);
  const f = strip();
  for (const x of [0, 219, 400]) {
    const target = resolve(f.el, x, ['d'], 55);
    assert.equal(target.debug.wrap, true);
    assert.equal(target.debug.autoScrollDelta, 0);
  }
  assert.equal(f.writes(), 0);
  end();
});

test('moving preview does not change captured row boundaries or reread geometry', () => {
  begin(source);
  const f = strip();
  assert.equal(resolve(f.el, 30, ['d'], 55).at, 2);
  f.chips.forEach(chip => { chip.top += 500; chip.bottom += 500; chip.left += 500; chip.right += 500; });
  assert.equal(resolve(f.el, 30, ['d'], 55).at, 2);
  assert.equal(f.reads(), 1);
  end();
});

test('other windows and workflows have independent row geometry; release commits once', () => {
  begin(source);
  const a = strip(), b = strip({ paneKey: 'pane:1' }), c = strip({ spaceId: 'b' });
  resolve(a.el, 30, ['d'], 55);
  const target = resolve(b.el, 30, ['d'], 55);
  setTarget(target);
  assert.equal(claim('d').target.paneKey, 'pane:1');
  assert.equal(claim('d'), null);
  resolve(c.el, 30, ['d'], 55);
  assert.deepEqual([a.reads(), b.reads(), c.reads()], [1, 1, 1]);
  end();
  assert.equal(claim('d'), null);
});
