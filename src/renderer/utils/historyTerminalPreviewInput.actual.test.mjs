import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import * as rules from './historyTerminalPreviewHandoff.mjs';
import { stabilizeHistoryRevealAnchor } from './historyRevealAnchor.mjs';

// Execute the complete shipping layout effect with controlled React/DOM/frame
// boundaries. The browser default scroll deliberately follows the two layout
// commits, as in the captured return→wheel→preview-rebase race. No React mount
// or native/compositor claim is made by these controls.
const source = fs.readFileSync(process.env.HISTORY_PREVIEW_INPUT_SOURCE
  || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('useLayoutEffect(() => {', source.indexOf('// Exact live-preview → canonical-row handoff.'));
const end = source.indexOf('\n  }, [', start);
assert.ok(start > 0 && end > start);
const callback = source.slice(start + 'useLayoutEffect('.length, end) + '\n  }';
const compiled = transformSync('(' + callback + ')', { loader: 'ts', target: 'es2022' }).code;

function boundary({ returned = true, input = true, atBottom = false } = {}) {
  const initial = 26554, height = 30469, client = 782, writes = [], frames = [], listeners = new Set(), diagnostics = [];
  let top = initial, machineOffset = 0, previewPresent = true;
  const ref = current => ({ current });
  const row = { getAttribute: () => 'older-row', closest: () => wrapper };
  const wrapper = { querySelector: () => row,
    getBoundingClientRect: () => ({ top: 252 + initial - top + machineOffset, bottom: 1452 + initial - top + machineOffset }) };
  const preview = { getBoundingClientRect: () => ({ top: 3000, height: 200 }) };
  const scroller = { isConnected: true, scrollHeight: height, clientHeight: client,
    get scrollTop() { return top; }, set scrollTop(value) { writes.push(value); top = value; },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => wrapper,
    querySelectorAll: selector => selector === '[data-item-index]' ? [wrapper] : [row],
    contains: value => value === wrapper,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const pending = { previewId: 'preview-1', canonicalIdentity: 'source:canonical', canonicalTextHash: null,
    ownerKey: 'owner', ownerGeneration: 1, presentationVisit: returned ? 1 : 2,
    anchorKind: atBottom ? 'tail' : 'reading-row', readingUnitKey: 'older-row', anchorOffsetPx: atBottom ? null : 252,
    bottomGapPx: atBottom ? 0 : null, gestureGeneration: 0, gestureAt: 0,
    followBottom: atBottom, scrollOwnerToken: null, phase: 'waiting-row', requestedAt: 0 };
  const c = { ...rules,
    terminalPreviewClearHandoff: pending, terminalPreviewClearHandoffRef: ref(pending),
    historyPresentationProofRef: ref({ presented: true, visit: 2 }),
    terminalPreviewRef: ref({ previewId: pending.previewId }), historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(1),
    historyUserGestureGenerationRef: ref(input ? 1 : 0), historyUserGestureAtRef: ref(input ? 100 : 0), historyPointerScrollActiveRef: ref(false),
    isAtBottomRef: ref(atBottom), virtuosoScrollerRef: ref(scroller), panelRef: ref({ querySelector: () => previewPresent ? preview : null }),
    terminalPreviewAnchorSettleCancelRef: ref(null), terminalPreviewAnchorSettleSignalRef: ref(null),
    terminalPreviewHandoffGuardDigestRef: ref(''), historyRestoreTokenRef: ref(0), historyRestoreInFlightRef: ref(0),
    displayEntries: [{ uuid: 'canonical', role: 'assistant', sourceIdentity: pending.canonicalIdentity }],
    displayUnitsRef: ref([{}]), historyOwnerDomId: 'owner-dom', historyLivePresentationIdentities: entry => [entry.sourceIdentity],
    resolveTerminalPreviewCanonicalTarget: () => ({ canonicalUuid: 'canonical', domUuid: 'canonical', unitIndex: 0 }),
    publishTerminalPreviewClearHandoff: next => { c.terminalPreviewClearHandoffRef.current = next; c.terminalPreviewClearHandoff = next; },
    setTerminalPreview: next => { previewPresent = next !== null; },
    historyScrollSeekController: { stampMachineScrollCooldown() {} }, historyDiag: text => diagnostics.push(text),
    CSS: { escape: value => value }, tabId: 'owned-tab', toolType: 'codex',
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    stabilizeHistoryRevealAnchor: options => stabilizeHistoryRevealAnchor({ ...options, requestFrame: fn => frames.push(fn) }),
  };
  const commit = () => new Function(...Object.keys(c), 'return ' + compiled)(...Object.values(c))();
  return { c, scroller, writes, diagnostics, initial,
    commits() { commit(); commit(); },
    browserWheel(delta) { top += delta; for (const fn of [...listeners]) fn(); },
    machineMove(delta) { machineOffset += delta; for (const fn of [...listeners]) fn(); },
  };
}

for (const returned of [true, false]) test(`first wheel retains its displacement when adoption ${returned ? 'rebases on return' : 'already owns this visit'}`, () => {
  const b = boundary({ returned, input: true });
  b.commits();
  b.browserWheel(-1050);
  assert.equal(b.scroller.scrollTop, b.initial - 1050, 'the machine must not undo the browser default wheel');
  assert.equal(b.c.terminalPreviewRef.current, null, 'exact canonical adoption still clears the preview');
  assert.equal(b.c.terminalPreviewClearHandoffRef.current, null, 'data handoff completes instead of remaining stuck');
  assert.equal(b.c.historyRestoreInFlightRef.current, 0, 'its own position lease is released');
  assert.equal(b.writes.length, 0, 'a revoked anchor does not write even the old coordinate');
});

test('without new input canonical geometry compensation and data adoption remain active', () => {
  const b = boundary({ input: false }); b.commits(); b.machineMove(80);
  assert.equal(b.scroller.scrollTop, b.initial + 80);
  assert.equal(b.c.terminalPreviewRef.current, null);
});

test('a gesture after stabilization started cancels that owner before a position signal', () => {
  const b = boundary({ returned: false, input: false }); b.commits();
  b.c.historyUserGestureGenerationRef.current++; b.c.historyUserGestureAtRef.current = 100;
  b.browserWheel(-1050);
  assert.equal(b.scroller.scrollTop, b.initial - 1050);
  assert.equal(b.c.historyRestoreInFlightRef.current, 0);
});

test('position cancellation preserves exact data identity and survives a later presentation rebase', () => {
  const initial = { previewId: 'p', canonicalIdentity: 'exact', canonicalTextHash: 'hash', previewItemIds: ['a', 'b'],
    ownerKey: 'owner', ownerGeneration: 1, presentationVisit: 1, phase: 'waiting-row', anchorKind: 'preview', anchorOffsetPx: -20 };
  const cancelled = rules.cancelHistoryTerminalPreviewHandoffScroll(initial);
  assert.equal(cancelled.canonicalIdentity, initial.canonicalIdentity);
  assert.equal(cancelled.canonicalTextHash, initial.canonicalTextHash);
  assert.equal(cancelled.previewItemIds, initial.previewItemIds);
  assert.equal(cancelled.phase, initial.phase);
  assert.equal(cancelled.anchorKind, 'stationary');
  assert.equal(cancelled.anchorOffsetPx, null);
  assert.equal(rules.historyTerminalPreviewHandoffAction({ handoff: cancelled, ownsWrite: true, canonicalInPresentation: false }), 'waiting-canonical');
  assert.equal(rules.historyTerminalPreviewHandoffAction({ handoff: cancelled, ownsWrite: true, canonicalInPresentation: true }), 'clear-preview');
  const b = boundary({ returned: true, input: false });
  const carried = rules.cancelHistoryTerminalPreviewHandoffScroll(b.c.terminalPreviewClearHandoff);
  b.c.terminalPreviewClearHandoff = carried; b.c.terminalPreviewClearHandoffRef.current = carried;
  b.commits(); b.browserWheel(-1050);
  assert.equal(b.scroller.scrollTop, b.initial - 1050);
  assert.equal(b.writes.length, 0, 'a later visit must not reacquire the cancelled position lease');
  assert.equal(b.c.terminalPreviewClearHandoffRef.current, null);
});
