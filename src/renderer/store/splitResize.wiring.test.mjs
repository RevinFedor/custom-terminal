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

test('the split button greys out when refused instead of disappearing', () => {
  // Reported live: three panes open (one column + a stacked pair) and «кнопка,
  // отвечающая за разделение, тупо пропала». Two defects in one: the cap was
  // counted in panes rather than columns, and the control was mounted
  // CONDITIONALLY, so hitting it removed the button instead of explaining it.
  //
  // The caps themselves are gone (2026-08-17), so the only refusal left is an
  // unfilled placeholder — but the mounting rule outlives them: a control that
  // vanishes reads as a bug whatever made it unavailable.
  const row = block(chrome, 'export function SplitPaneAttachRow(', '\n/** Above every surface');
  assert.ok(!/\{canSplit && \(/.test(row), 'the button must not be conditionally mounted');
  assert.match(row, /splitAvailability\(splitPanes, paneIndex \?\? null\)/);
  // Both directions asked separately: a full column must not hide the
  // still-possible sideways split.
  assert.match(row, /splitCan\.horizontal/);
  assert.match(row, /splitCan\.vertical/);
  // And the disabled state must SAY why.
  assert.match(row, /Сначала выберите вкладку для пустой панели/);
});

test('"add to workspace" asks the model, never counts panes itself', () => {
  // It counted panes, which refused a third column while the screen still had
  // room. The count caps are gone now, but the rule that survives them is the
  // one that mattered: one place answers "can this still be split", and every
  // caller asks IT rather than re-deriving the answer from a number.
  const tabBar = read('..', 'components', 'Workspace', 'TabBar.tsx');
  assert.ok(!/const splitFull = splitPanes\.length >= 3;/.test(tabBar));
  assert.match(tabBar, /splitFull = !splitAvailability\(splitPanes, null\)\.horizontal/);
});

// ── Gestures around the drag ──────────────────────────────────────────────

test('the strips are the violet drag language, same as the sidebar handle', () => {
  assert.match(chrome, /SPLIT_DIVIDER_HOVER_BG = 'rgba\(99,102,241,0\.4\)'/);
  const layer = block(chrome, 'export function SplitDividerLayer()', '\n// Markdown/file content');
  assert.match(layer, /col-resize/);
  assert.match(layer, /row-resize/);
});

// ── Меню направления: иконка + одно слово ─────────────────────────────────

test('пункты меню направления называют только СТОРОНУ, глагол остаётся на кнопке', () => {
  // Было «Разделить: панель сверху» / «Разделить: панель снизу» — две длинные
  // строки, отличающиеся одним словом в самом конце. Чтобы выбрать, приходилось
  // дочитывать обе до конца, хотя вопрос у меню ровно один: с какой стороны.
  // Глагол уже назван кнопкой, которая это меню открыла.
  const row = block(chrome, 'export function SplitPaneAttachRow(', '\n/** Above every surface');
  assert.doesNotMatch(row, /label: 'Разделить: панель/);
  assert.match(row, /side: 'above' as const, label: 'Сверху', Icon: PanelTop/);
  assert.match(row, /side: 'below' as const, label: 'Снизу', Icon: PanelBottom/);
  // Иконка показывает ФОРМУ результата — без неё одно слово осталось бы без
  // подсказки, что вообще произойдёт.
  assert.match(chrome, /import \{[^}]*PanelBottom[^}]*PanelTop[^}]*\} from 'lucide-react'/);
  assert.match(row, /<Icon size=\{13\}/);
});
