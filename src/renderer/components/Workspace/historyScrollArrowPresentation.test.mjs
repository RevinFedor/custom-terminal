// The scroll-to-bottom arrow must survive a workspace switch.
//
// Reported 01.11: switching between workspaces made the chevron disappear and
// it did not come back until the user moved the wheel. The arrow is written
// directly to `style.display` (it changes every scroll frame; React state
// would repaint the whole panel), so the node needs syncing from more than
// the scroll handler.
//
// Why a switch breaks it: for the CENTRE surface the node lives in
// `StationaryHistorySurfaceToggle`, which remounts on every change of the
// presented tab and comes back with `display:'none'` in its markup. The panel
// itself stays mounted and does not scroll, so no scroll event fires to
// restore it.
//
// These tests execute the REAL `syncScrollArrowVisibility` sliced out of
// HistoryPanel.tsx, so the threshold, the lookup and the re-query of a
// detached node are the shipped ones.
//
// Run: node --test src/renderer/components/Workspace/historyScrollArrowPresentation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const require = createRequire(resolve(REPO, 'package.json'));
const { transformSync } = require('esbuild');

const source = readFileSync(resolve(HERE, 'HistoryPanel.tsx'), 'utf8');
const from = source.indexOf('  const syncScrollArrowVisibility = useCallback(');
assert.ok(from > 0, 'syncScrollArrowVisibility must exist');
const to = source.indexOf('\n  }, [tabId]);', from);
assert.ok(to > from, 'the callback must be sliceable');
const body = source.slice(from, to + '\n  }, [tabId]);'.length);
const code = transformSync(body.replace('useCallback(', '(').replace(/\}, \[tabId\]\);$/, '});'),
  { loader: 'ts' }).code;

function build({ connected = true, distance = 400, hasScroller = true } = {}) {
  const node = { isConnected: connected, style: { display: 'none' } };
  const queried = [];
  const sandbox = {
    tabId: 'tab-probe',
    scrollArrowRef: { current: null },
    virtuosoScrollerRef: { current: hasScroller ? { marker: 'scroller' } : null },
    historyContentDistanceFromBottom: () => distance,
    CSS: { escape: value => value },
    document: {
      querySelector: selector => { queried.push(selector); return node; },
    },
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code.replace(/^\s*const syncScrollArrowVisibility =/, 'module.exports =') , sandbox);
  return { sync: sandbox.module.exports, node, queried, sandbox };
}

test('a presentation with no scroll event still reveals the arrow', () => {
  // The exact reported bug: the node is freshly mounted with display:'none'
  // and nothing scrolled.
  const { sync, node } = build({ distance: 400 });
  assert.equal(node.style.display, 'none', 'starts hidden, as the markup ships it');
  sync();
  assert.equal(node.style.display, '', 'the arrow is shown again after the switch');
});

test('near the bottom the arrow stays hidden', () => {
  const { sync, node } = build({ distance: 10 });
  sync();
  assert.equal(node.style.display, 'none');
});

test('the 150px threshold is exclusive on both sides', () => {
  const at = build({ distance: 150 });
  at.sync();
  assert.equal(at.node.style.display, 'none', '150 is not "far enough"');
  const past = build({ distance: 151 });
  past.sync();
  assert.equal(past.node.style.display, '', '151 is');
});

test('a passed measurement is used instead of re-reading geometry', () => {
  // The scroll handler already sampled scrollHeight/scrollTop/clientHeight for
  // its own decisions; reading them again would cost a second forced layout
  // per frame.
  let reads = 0;
  const { sync, node, sandbox } = build({ distance: 400 });
  sandbox.historyContentDistanceFromBottom = () => { reads++; return 400; };
  sync(500);
  assert.equal(reads, 0, 'no geometry read when the caller supplies one');
  assert.equal(node.style.display, '');
  sync();
  assert.equal(reads, 1, 'but a presentation-time call samples it itself');
});

test('a detached node is re-queried, scoped to this tab', () => {
  // Two panels can live in one window; the stationary host of the neighbour
  // carries its own node, so the lookup must not grab it.
  const { sync, queried } = build({ connected: false });
  sync();
  assert.equal(queried.length, 1);
  assert.equal(queried[0], '[data-history-scroll-to-bottom-tab="tab-probe"]');
});

test('a still-connected node is not re-queried', () => {
  const { sync, queried, sandbox, node } = build({ distance: 400 });
  sync();
  assert.equal(queried.length, 1, 'first call resolves the node');
  sandbox.scrollArrowRef.current = node;
  sync();
  assert.equal(queried.length, 1, 'a live node is reused, not searched again');
});

test('no scroller and no measurement leaves the arrow untouched', () => {
  // Before the first viewport exists there is nothing to decide from. Writing
  // a guess would flash the arrow on an empty panel.
  const { sync, node } = build({ hasScroller: false });
  node.style.display = 'seeded';
  sync();
  assert.equal(node.style.display, 'seeded');
});

test('a missing node is survivable', () => {
  const { sync, sandbox } = build();
  sandbox.document.querySelector = () => null;
  sandbox.scrollArrowRef.current = null;
  assert.doesNotThrow(() => sync());
});

test('the panel calls it from BOTH the scroll handler and the presentation', () => {
  // A structural check: the slice above proves the function behaves, this
  // proves it is actually wired to the two moments that matter. Losing the
  // presentation call is exactly the reported regression.
  const scrollCall = source.indexOf('syncScrollArrowVisibility(distFromBottom)');
  assert.ok(scrollCall > 0, 'the scroll handler must sync the arrow');
  const presentedBlock = source.indexOf("window.addEventListener('history-panel:surface-presented'");
  assert.ok(presentedBlock > 0);
  const effectStart = source.lastIndexOf('useEffect(() => {', presentedBlock);
  const inEffect = source.slice(effectStart, presentedBlock);
  assert.ok(inEffect.includes('syncScrollArrowVisibility()'),
    'the surface-presented handler must sync the arrow too');
});

test('the declaration precedes every use', () => {
  // `const` is not hoisted: declaring the callback after the effect that calls
  // it throws at presentation time, which is precisely when it is needed.
  const declaration = source.indexOf('const syncScrollArrowVisibility = useCallback(');
  const firstUse = source.indexOf('syncScrollArrowVisibility()');
  assert.ok(declaration > 0 && firstUse > 0);
  assert.ok(declaration < firstUse,
    'syncScrollArrowVisibility is used before it is declared');
});
