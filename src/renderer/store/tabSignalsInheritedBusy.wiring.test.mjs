// Every surface that draws a tab card must draw the SAME three signals.
//
// The bug this pins: the pane header chip showed no purple strip while the tab
// was waiting for a session it had delegated, at the exact moment the sidebar
// card showed one for that same tab. Nothing was broken in the orchestration
// state — the shared signals hook simply did not carry the third signal, so
// three of the four surfaces could not draw it even in principle, and only the
// sidebar (which asks the orchestration store itself) was right.
//
// Pinned as wiring rather than as a pure model test because the defect is not
// in any rule: each piece was correct on its own. What was missing was the
// connection between them, and only the source shows that.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const read = (name) => fs.readFileSync(path.join(workspaceDir, name), 'utf8');

const signals = read('TabSignals.tsx');
const chrome = read('SplitPaneChrome.tsx');
const rows = read('TabListRows.tsx');
const recent = read('PaneRecentTabsButton.tsx');
const switcher = read('TabSwitcherOverlay.tsx');

test('the shared signals hook answers about waiting for a delegated session', () => {
  // One place asks, so the surfaces cannot disagree — the reason this hook
  // exists at all.
  assert.match(signals, /useOrchestrationStore\(\(s\) => s\.inheritedBusyTabIds\.has\(tabId\)\)/);
  assert.match(signals, /inheritedBusy: boolean/);
});

test('own work outranks waiting in the shared hook', () => {
  // A tab answering its own turn must show its own colour: purple means "the
  // work is elsewhere", and painting it over live work states the opposite.
  assert.match(signals, /inheritedBusy: orchestrationBusy && !busy/);
});

test('the pane header chip draws the waiting strip', () => {
  // The reported symptom. The chip is the pane's copy of the tab card.
  assert.match(chrome, /useTabActivitySignals\(tabId\)/);
  assert.match(chrome, /const \{ hasProcess, busy, inheritedBusy \} = useTabActivitySignals/);
  const bar = chrome.slice(chrome.indexOf('<TabProcessBar'), chrome.indexOf('<TabStatusMarker'));
  assert.match(bar, /inheritedBusy=\{inheritedBusy\}/);
});

test('the shared row draws it too, and its callers pass it', () => {
  // TabListRows is rendered by the switcher AND by the pane's recent list; a
  // prop that stops at the row is a signal only one caller ever shows.
  const bar = rows.slice(rows.indexOf('<TabProcessBar'), rows.indexOf('<TabStatusMarker'));
  assert.match(bar, /inheritedBusy=\{inheritedBusy\}/);
  assert.match(recent, /const \{ hasProcess, busy, inheritedBusy \} = useTabActivitySignals/);
  assert.match(recent, /inheritedBusy=\{inheritedBusy\}/);
  assert.match(switcher, /inheritedBusy=\{isInheritedBusy\(tab\.id\)\}/);
});

test('the switcher reads the waiting set as a string, never as a Set', () => {
  // Zustand rule: a selector returning a fresh Set re-renders the overlay on
  // every store write. Same Fingerprint Pattern the rest of the app follows.
  const selector = switcher.slice(
    switcher.indexOf('const inheritedBusyKey = useOrchestrationStore('),
    switcher.indexOf('const inputRef'),
  );
  assert.match(selector, /\.sort\(\)\.join\(/);
  assert.doesNotMatch(selector, /=> s\.inheritedBusyTabIds\b(?!\s*\))/);
});
