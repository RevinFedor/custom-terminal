import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({
  entryPoints: [process.env.NOTED_PANE_WRAP_TEST_SOURCE || new URL('./paneTabDragBridge.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'],
});
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console: { log() {} },
  require: name => { assert.equal(name, 'react'); return { useSyncExternalStore() {} }; },
});
const { resolvePaneTabDropTarget: resolve, beginPaneTabDrag: begin,
  endPaneTabDrag: end, setPaneTabDragTarget: setTarget, claimPaneTabDragDrop: claim,
  observePaneTabStrip: observe, forgetPaneTabStrip: forget } = module.exports;
const {getPaneTabDragSnapshot:getSnapshot}=module.exports;

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

function unequalStrip() {
  const f = strip();
  f.chips.splice(0, f.chips.length,
    { id: 'guide', left: 10, right: 110, top: 10, bottom: 36 },
    { id: 'usage', left: 116, right: 366, top: 10, bottom: 36 });
  return f;
}
const usageSource = { ...source, rootTabId: 'usage', entries: [{ projectId: 'p', tabId: 'usage' }] };
const paneSurface = (ids, extra = {}) => ({ workflowId: 'a', windowId: 'w', paneKey: 'pane:0',
  baseEntries: ['guide', 'usage'].map(tabId => ({ projectId: 'p', tabId })),
  entries: ids.map(tabId => ({ projectId: 'p', tabId })), ...extra });
function showUsageFirst(f) {
  f.chips.splice(0, f.chips.length,
    { id: 'usage', left: 10, right: 260, top: 10, bottom: 36 },
    { id: 'guide', left: 266, right: 366, top: 10, bottom: 36 });
}

test('unequal chips reverse against the committed preview, with one read per shown order', () => {
  begin(usageSource);
  const f = unequalStrip(), owner = {};
  observe(owner, paneSurface(['guide', 'usage']));
  assert.equal(resolve(f.el, 240, ['usage'], 20).at, 1);
  setTarget(resolve(f.el, 40, ['usage'], 20));
  showUsageFirst(f);
  observe(owner, paneSurface(['usage', 'guide']));
  // x=160 is right of the OLD guide midpoint60, but left of its SHOWN midpoint316.
  assert.equal(resolve(f.el, 160, ['usage'], 20).at, 0);
  for (let i = 0; i < 20; i++) {
    observe(owner, paneSurface(['usage', 'guide']));
    assert.equal(resolve(f.el, 160, ['usage'], 20).at, 0);
  }
  assert.equal(f.reads(), 2, 'unrelated renders/pointer samples do not remeasure chips');
  assert.equal(resolve(f.el, 316, ['usage'], 20).at, 1);
  assert.equal(f.reads(), 2);
  forget(owner); end();
});

test('a requested preview does not advance geometry before its layout receipt', () => {
  begin(usageSource);
  const f = unequalStrip(), owner = {};
  observe(owner, paneSurface(['guide', 'usage']));
  setTarget(resolve(f.el, 40, ['usage'], 20));
  assert.equal(resolve(f.el, 160, ['usage'], 20).at, 1);
  assert.equal(f.reads(), 1);
  showUsageFirst(f);
  observe(owner, paneSurface(['usage', 'guide']));
  assert.equal(resolve(f.el, 160, ['usage'], 20).at, 0);
  forget(owner); end();
});

test('retained strips of another workflow cannot expire the visible strip geometry', () => {
  begin(usageSource);
  const f = unequalStrip(), owner = {}, dormant = {};
  observe(owner, paneSurface(['guide', 'usage']));
  setTarget(resolve(f.el, 40, ['usage'], 20));
  showUsageFirst(f);
  observe(dormant, paneSurface(['usage', 'guide'], { workflowId: 'other' }));
  assert.equal(resolve(f.el, 160, ['usage'], 20).at, 1);
  assert.equal(f.reads(), 1);
  observe(owner, paneSurface(['usage', 'guide']));
  assert.equal(resolve(f.el, 160, ['usage'], 20).at, 0);
  forget(dormant); forget(owner); end();
});

test('leaving and returning to a strip uses its restored base layout', () => {
  begin(usageSource);
  const f = unequalStrip(), owner = {};
  observe(owner, paneSurface(['guide', 'usage']));
  setTarget(resolve(f.el, 40, ['usage'], 20));
  showUsageFirst(f);
  observe(owner, paneSurface(['usage', 'guide']));
  assert.equal(resolve(f.el, 160, ['usage'], 20).at, 0);
  setTarget(null);
  const original = unequalStrip().chips;
  f.chips.splice(0, f.chips.length, ...original);
  observe(owner, paneSurface(['guide', 'usage']));
  assert.equal(resolve(f.el, 160, ['usage'], 20).at, 1);
  forget(owner); end();
});

test('group preview clamps vertical/horizontal strip targets and own body to its boundaries', () => {
  const grouped={...source,groupDrag:{boundary:{kind:'group',start:1,end:3},isCurrent:()=>true}};
  begin(grouped);
  for(const at of [-9,0,1,2,3,4,99]) {
    setTarget({zone:'strip',paneKey:'pane:0',paneIndex:0,spaceId:'a',at});
    assert.equal(getSnapshot().target.at,Math.max(1,Math.min(3,at)));
  }
  setTarget({zone:'body',paneKey:'pane:0',paneIndex:0,spaceId:'a',at:Infinity});
  assert.equal(getSnapshot().target.at,3);
  assert.equal(claim('d').target.at,3);
  end();
});

test('a locked group member never previews or claims another window/workflow', () => {
  begin({...source,groupDrag:{boundary:{kind:'group',start:1,end:3},isCurrent:()=>true}});
  for(const target of [
    {zone:'strip',paneKey:'pane:1',paneIndex:1,spaceId:'a',at:0},
    {zone:'body',paneKey:'pane:0',paneIndex:0,spaceId:'other',at:Infinity},
  ]) {setTarget(target);assert.equal(getSnapshot().target,null);assert.equal(claim('d'),null);}
  end();
});

test('stale group ownership refuses drop without another target or writer grant', () => {
  let current=true;
  begin({...source,groupDrag:{boundary:{kind:'group',start:1,end:3},isCurrent:()=>current}});
  setTarget({zone:'strip',paneKey:'pane:0',paneIndex:0,spaceId:'a',at:2});
  current=false;
  assert.equal(claim('d'),null);end();
  begin({...source,groupDrag:{boundary:{kind:'blocked',reason:'mixed'},isCurrent:()=>true}});
  assert.equal(getSnapshot().active,false);
});
