import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const history = fs.readFileSync(
  fileURLToPath(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url)),
  'utf8',
);
const timeline = fs.readFileSync(
  fileURLToPath(new URL('../components/Workspace/Timeline.tsx', import.meta.url)),
  'utf8',
);

test('scroll-seek state is owned by each mounted History panel', () => {
  assert.match(history, /createHistoryScrollSeekController/);
  assert.match(history, /scrollSeekConfiguration=\{historyScrollSeekController\.configuration\}/);
  assert.doesNotMatch(history, /let historyScrollSeekActive\s*=/);
  assert.doesNotMatch(history, /let historySeekScroller\s*=/);
  assert.doesNotMatch(history, /const historySeekSuppressors\s*=\s*new Set/);
});

test('Virtuoso scroller callback is stable and passes semantic owner identity', () => {
  assert.match(history, /const handleHistoryVirtuosoScrollerRef = useCallback/);
  assert.match(history, /scrollerRef=\{handleHistoryVirtuosoScrollerRef\}/);
  assert.doesNotMatch(history, /scrollerRef=\{\(el\) =>/);
  assert.match(history, /setScroller\(nextScroller, historyScrollerOwnerToken\(\)\)/);
});

test('deferred owner and externally unfocused pane suppress Escape through distinct owners', () => {
  assert.match(history, /inert=\{[^\n}]*staleOwnerCurtain/);
  assert.match(history, /interactionDisabled=\{staleOwnerCurtain\}/);
  assert.match(history, /agentInputSurface=\{agentInputSurface\s*&&\s*!staleOwnerCurtain\}/);
  // The stale-owner curtain is local React state and remains an immediate
  // boolean gate. Persistent pane focus changes imperatively, without
  // re-rendering the transcript, so it travels through the shared ref.
  assert.match(history, /suppressWindowEscape=\{staleOwnerCurtain\}/);
  assert.match(history, /suppressWindowEscapeRef=\{globalHotkeysSuppressedRef\}/);
  assert.match(history, /const globalHotkeysSuppressedRef = useRef\(suppressGlobalHotkeys\)/);
  assert.match(
    history,
    /if \(!presentationExternallyManaged\) \{\s*globalHotkeysSuppressedRef\.current = suppressGlobalHotkeys/,
    'legacy History still mirrors the React focus prop into the same ref',
  );
  assert.match(history, /globalHotkeysSuppressedRef\.current = !detail\.focused/);
  assert.match(
    history,
    /const effectiveSuppressWindowEscapeRef = suppressWindowEscapeRef\s*\|\|\s*localSuppressWindowEscapeRef/,
  );
  assert.match(
    history,
    /if \(suppressWindowEscape \|\| effectiveSuppressWindowEscapeRef\.current\) return/,
    'Escape interrupt must consult both the stale curtain and current pane focus',
  );
});

test('Timeline click binding and viewport visibility share one OSC mapping', () => {
  assert.match(timeline, /mapTimelinePromptBoundaries/);
  const calls = timeline.match(/mapTimelinePromptBoundaries\s*\(/g) || [];
  assert.ok(calls.length >= 2, 'binding and viewport paths must both use the shared mapping');
  assert.doesNotMatch(timeline, /bindEntryToPromptBoundary\(tabId, entry\.uuid, promptSeq - 1\)/);
});

test('an inner tool scroll does not also mutate outer History intent', () => {
  assert.match(history, /historyInnerOwnedWheelEvents\.add\(event\)/);
  assert.match(history, /historyInnerOwnedWheelEvents\.delete\(event\)/);
});
