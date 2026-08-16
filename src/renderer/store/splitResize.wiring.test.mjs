// Resizable split dividers — the wiring contracts the pure model cannot see.
//
// The model owns the fraction math (splitSizes.test.mjs); these pin HOW the
// app talks to it: the live drag must not write the store per mousemove, the
// memo must read the committed sizes, and persistence must carry them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), 'utf8');
const store = read('useWorkspaceStore.ts');
const chrome = read('..', 'components', 'Workspace', 'SplitPaneChrome.tsx');
const terminalArea = read('..', 'components', 'Workspace', 'TerminalArea.tsx');
const snapshot = read('..', 'utils', 'sessionSnapshot.mjs');
const gestures = read('..', 'utils', 'keyboardOwnerGesture.mjs');

function block(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

// ── One store write per finished drag ─────────────────────────────────────

test('the live drag repositions the DOM; only mouseup commits to the store', () => {
  const layer = block(chrome, 'export function SplitDividerLayer()', '\n// Markdown/file content');
  const onMove = block(layer, 'const onMove = (ev: MouseEvent) => {', 'const stopListening');
  // A commitSplitSizes (or any set()) inside onMove would rebuild the whole
  // terminals memo — every pane of every project — at pointer speed.
  assert.ok(!onMove.includes('commitSplitSizes'), 'onMove must not write the store');
  assert.ok(!/set\(\{/.test(onMove), 'onMove must not write the store');
  assert.match(onMove, /applyLiveGeometry\(next\)/);
  const onUp = block(layer, 'const onUp = () => {', 'cancelDragRef.current = stopListening');
  assert.match(onUp, /commitSplitSizes\(finalSizes\)/);
});

test('commit packs against the CURRENT panes, and an equal split stores null', () => {
  const commit = block(store, 'commitSplitSizes: (sizes) => {', '\n  },');
  assert.match(commit, /packSplitSizes\(get\(\)\.splitPanes, sizes\)/);
  assert.match(commit, /saveSession\(\)/, 'a finished drag must persist');
  // No-op guard: dblclick-reset on an already-equal layout writes nothing.
  assert.match(commit, /packed === null && prev === null\) return/);
});

// ── The memo follows the committed sizes ──────────────────────────────────

test('the terminals memo reads splitSizes, or a later rebuild snaps panes back', () => {
  // Key: the memo's subscription string must carry a sizes fingerprint —
  // without it, a rebuild triggered by anything else (tab created, view
  // switched) would repaint the wrappers at the EQUAL split.
  const layerKey = block(terminalArea, 'const activeLayerKey = useWorkspaceStore', '});');
  assert.match(layerKey, /splitSizesFingerprint\(s\.splitSizes\)/);
  // And the rect calls must actually pass the sizes through.
  const memoBody = block(terminalArea, 'const terminals = useMemo(() => {', '\n  }, [');
  const rectCalls = memoBody.match(/splitPaneRectStyle\(paneIndex, splitPanes(, splitSizes)?\)/g) || [];
  assert.ok(rectCalls.length >= 2, 'expected the pane and empty-pane rect calls');
  for (const call of rectCalls) {
    assert.match(call, /, splitSizes\)/, `rect call ignores sizes: ${call}`);
  }
});

test('the divider layer is a SIBLING of the pane wrappers', () => {
  // applyLiveGeometry finds the wrappers via parentElement — the layer must
  // mount in the same host, right next to {terminals}.
  const host = block(terminalArea, '{terminals}', 'currentView === \'terminal\'');
  assert.match(host, /<SplitDividerLayer \/>/);
});

// ── Persistence ───────────────────────────────────────────────────────────

test('the session snapshot carries splitSizes (both save paths share it)', () => {
  assert.match(snapshot, /splitSizes: state\.splitSizes \?\? null/);
  assert.match(snapshot, /'splitSizes',/, 'field list guards the two writers');
});

test('restore re-packs sizes against the SANITIZED panes', () => {
  // A pane whose tab died over the restart shrinks the structure; its sizes
  // must self-clean instead of shadowing the next layout with a stale shape.
  const restore = block(store, 'const restoredSplit = sanitizePanes(', 'RestoreSession] done');
  assert.match(restore, /splitSizes: packSplitSizes\(restoredSplit\.panes/);
});

test('a split STARTED from single mode opens equal, not at the dead layout\'s sizes', () => {
  // The read-time drift rule cannot catch this: a dead 2-column layout's
  // sizes still COUNT-match a fresh 2-column one, so each single-mode entry
  // point must clear them explicitly. The markers are the IMPLEMENTATION
  // forms — `name: (args) => {` — because the interface declares the same
  // names first and a bare `name: (` marker reads the type, not the code.
  const entryPoints = [
    'addTabToSplit: (projectId, tabId) => {',
    'addEmptySplitPane: (afterPaneIndex) => {',
    'addVerticalSplitPane: (atPaneIndex, side) => {',
  ];
  for (const marker of entryPoints) {
    const body = block(store, marker, '\n  },');
    assert.match(body, /splitPanes\.length === 0 \? \{ splitSizes: null \}/, marker);
  }
});

// ── The split button at the limit ─────────────────────────────────────────

test('the split button greys out at the limit instead of disappearing', () => {
  // Reported live: three panes open (one column + a stacked pair) and «кнопка,
  // отвечающая за разделение, тупо пропала». Two defects in one: the cap was
  // counted in panes rather than columns, and the control was mounted
  // CONDITIONALLY, so hitting it removed the button instead of explaining it.
  const row = block(chrome, 'export function SplitPaneAttachRow(', '\n/** Above every surface');
  assert.ok(!/\{canSplit && \(/.test(row), 'the button must not be conditionally mounted');
  assert.match(row, /splitAvailability\(splitPanes, paneIndex \?\? null\)/);
  // Both directions asked separately: three full columns must not hide the
  // still-possible vertical split.
  assert.match(row, /splitCan\.horizontal/);
  assert.match(row, /splitCan\.vertical/);
  // And the disabled state must SAY why.
  assert.match(row, /Рабочая область заполнена/);
});

test('"add to workspace" is capped by COLUMNS, not by the pane count', () => {
  // A stacked pair is two panes in ONE column; counting panes refused a third
  // column while the screen still had room for it.
  const tabBar = read('..', 'components', 'Workspace', 'TabBar.tsx');
  assert.ok(!/const splitFull = splitPanes\.length >= 3;/.test(tabBar));
  assert.match(tabBar, /splitFull = !splitAvailability\(splitPanes, null\)\.horizontal/);
});

// ── Gestures around the drag ──────────────────────────────────────────────

test('grabbing a divider does not move the keyboard owner', () => {
  // A resize is about GEOMETRY, not "I want to type here": without this, a
  // drag started while the keyboard was in the sidebar would flip ownership
  // and flash the pane frame mid-drag.
  const neutral = block(gestures, 'OWNERSHIP_NEUTRAL_SELECTORS', ']);');
  assert.match(neutral, /\[data-split-divider\]/);
});

test('the strips are the violet drag language, same as the sidebar handle', () => {
  assert.match(chrome, /SPLIT_DIVIDER_HOVER_BG = 'rgba\(99,102,241,0\.4\)'/);
  const layer = block(chrome, 'export function SplitDividerLayer()', '\n// Markdown/file content');
  assert.match(layer, /col-resize/);
  assert.match(layer, /row-resize/);
});
