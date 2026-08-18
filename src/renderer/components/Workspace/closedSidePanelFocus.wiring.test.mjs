// A CLOSED side panel must be closed for the KEYBOARD too.
//
// Both side panels — the terminal and the transcript — stay MOUNTED while
// closed, and they have to: the terminal keeps its PTY geometry and scrollback,
// the transcript owns the docked composer and its scroll position. So "closed"
// is only `translateX(100%)` (or `width: 0`), and a translated element is still
// in the browser's focus order.
//
// What that cost, reported live 2026-08-17 22:22 MSK: pressing Tab walked focus
// into the off-screen xterm; the browser then scrolled the pane sideways to
// reveal what it had just focused, so the panel appeared to open by itself and
// dragged the whole layout, composer included. The next Cmd+] read as "opens
// again, closes only on the press after that" — the store flag was still
// `false`, so one press set it true and only the following one closed it.
//
// Pinned as wiring rather than as a pure model test because nothing here is a
// rule: each piece was correct. What was missing is that a visual close was not
// also a focus close, and only the source shows that.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), 'utf8');

const frame = read('FloatingTerminalFrame.tsx');
const history = read('HistoryPanel.tsx');

test('the closed side TERMINAL leaves the focus order', () => {
  // `inert`, not `tabIndex={-1}`: the whole SUBTREE must go: the thing Tab
  // actually lands on is xterm's helper textarea, a descendant.
  assert.match(frame, /inert=\{floating && !open\}/);
  // `tabIndex={-1}` on the frame would look like a fix and cover nothing: it
  // takes only THIS node out of the order, never its children. Matched as a JSX
  // attribute so the prose explaining that in the comment above does not count.
  assert.doesNotMatch(frame, /^\s*tabIndex=\{-1\}/m);
  // …and the visual close it mirrors is still there, so this cannot drift into
  // "inert while visible".
  assert.match(frame, /transform: open \? 'translateX\(0\)' : 'translateX\(100%\)'/);
});

test('the closed side TRANSCRIPT leaves the focus order', () => {
  // Same defect, same fix. Its two placements close differently — the free
  // panel slides off-edge, the embedded one shrinks to zero width — so the
  // condition names both rather than assuming one.
  assert.match(history, /inert=\{embedded \? \(!embeddedFill && !slideIn\) : !isOpen\}/);
});

test('the panels are still MOUNTED while closed', () => {
  // The whole reason inert is needed: unmounting would be the easy fix and is
  // the wrong one — the terminal would lose its PTY geometry and scrollback,
  // and the transcript owns the docked composer.
  assert.match(frame, /pointerEvents: open \? 'auto' : 'none'/);
  assert.match(history, /transform: embedded \? 'none' : \(slideIn \? 'translateX\(0\)' : 'translateX\(100%\)'\)/);
});
