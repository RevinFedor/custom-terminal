import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

const sliceFrom = (startText, endText) => {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `missing source boundary: ${startText}`);
  const end = source.indexOf(endText, start);
  assert.ok(end > start, `missing source boundary: ${endText}`);
  return source.slice(start, end);
};

test('the Footer contains only real preview/timing content, never synthetic reserve', () => {
  const footer = sliceFrom('const HistoryTerminalPreviewFooter =', '// Cheap stand-in row');
  assert.match(footer, /context\?\.terminalPreview/);
  assert.match(footer, /terminalPreviewCanonicalMaterialized/);
  assert.match(footer, /historyTerminalPreviewStatusLabel\(\{ canonicalMaterialized \}\)/);
  assert.doesNotMatch(footer, /Terminal output|JSONL|API output/i);
  assert.match(footer, /context\?\.responseTiming/);
  assert.doesNotMatch(footer, /tailSpacer|data-history-tail-spacer|aria-hidden="true"/);
});

test('preview revisions have one owner-bound tail pin only for a tail reader', () => {
  const effect = sliceFrom(
    'if (!terminalPreview || !isAtBottomRef.current) return;',
    '// Both PTY agents expose canonical incremental transcript records.',
  );
  assert.match(effect, /historyTailPinScheduler\.schedule\(/);
  assert.match(effect, /delayFrames: 2/);
  assert.equal(
    (effect.match(/historyTailPinScheduler\.schedule\(/g) || []).length,
    1,
    'one preview revision must have one scroll writer',
  );
  assert.doesNotMatch(effect, /\.scrollTop\s*=/, 'the effect delegates to the owner-bound scheduler');
});

test('an exact live replacement remains visible until the deferred durable projection catches up', () => {
  const presentation = sliceFrom(
    'const ownerLiveEntries =',
    '// Rewind owns the final presentation boundary.',
  );
  assert.match(presentation, /filterHistoryTerminalPreviewLiveDuplicate\(\{/);
  assert.match(presentation, /terminalPreviewCanonicalInDurableProjection/);
  assert.match(
    presentation,
    /canonicalIdentity: terminalPreviewCanonicalInDurableProjection/,
  );
  assert.match(presentation, /identitiesForEntry: historyLivePresentationIdentities/);
  assert.doesNotMatch(presentation, /\.content\s*===|\.text\s*===/);
});

test('canonical preview clear waits for the exact row and preserves its viewport anchor', () => {
  const handler = sliceFrom(
    'const onTerminalPreview =',
    "ipcRenderer.on('agent-transcript:terminal-preview'",
  );
  assert.match(handler, /detail\.action === 'clear'/);
  assert.match(handler, /detail\.reason === 'canonical-materialized'/);
  assert.match(handler, /canonicalIdentity/);
  assert.match(handler, /historyTerminalPreviewHandoffAnchor\(\{/);
  assert.match(handler, /followBottom = isAtBottomRef\.current/);
  assert.match(handler, /publishTerminalPreviewClearHandoff\(handoff\)/);

  const handoff = sliceFrom(
    '// Exact live-preview → canonical-row handoff.',
    'useEffect(() => {\n    const onTerminalPreviewDiagnosticResult',
  );
  assert.match(handoff, /resolveTerminalPreviewCanonicalTarget/);
  assert.match(handoff, /historyTerminalPreviewHandoffOwnsWrite/);
  assert.match(handoff, /canonicalInPresentation/);
  assert.match(
    handoff,
    /action === 'clear-preview' && !canonicalTarget[\s\S]*?setTerminalPreview\(null\)[\s\S]*?tail-exact-presentation-without-unit-target/,
    'an exact tail row already in the final presentation must not wait on a derived unit-map target',
  );
  assert.doesNotMatch(handoff, /canonicalDurable|waiting-durable/);
  assert.match(handoff, /HISTORY_TERMINAL_PREVIEW_DOM_PROBE_FRAMES/);
  assert.match(handoff, /terminalPreviewHandoffWakeSeq/);
  assert.match(handoff, /newestGestureIsReal/);
  assert.match(handoff, /historyTerminalPreviewHasNewUserGesture\(current/);
  assert.match(handoff, /gestureAt: historyUserGestureAtRef\.current/);
  assert.match(handoff, /historyTerminalPreviewHandoffAnchor\(\{/);
  assert.match(handoff, /previewOffsetPx: previewNode\.getBoundingClientRect\(\)\.top/);
  assert.match(handoff, /gestureGeneration: historyUserGestureGenerationRef\.current/);
  assert.match(handoff, /historyTerminalPreviewHandoffScrollTop\(\{/);
  assert.doesNotMatch(
    handoff,
    /if \(!canonicalTarget \|\| !targetNode\) return/,
    'tail ownership must not wait for a row DOM that only rangeChanged can mount',
  );
  assert.match(handoff, /phase: 'clearing-preview'/);
  assert.match(handoff, /phase: 'settling-row'/);
  assert.match(handoff, /stabilizeHistoryRevealAnchor\(\{/);
  assert.match(handoff, /hasUserGesture:/);
  assert.match(
    handoff,
    /if \(action === 'settling'\) \{[\s\S]*?terminalPreviewAnchorSettleSignalRef\.current\?\.\(\)/,
    'a durable projection commit must repair exact-row drift before paint',
  );
  assert.match(handoff, /terminalPreviewAnchorSettleSignalRef\.current = listener/);
  assert.match(handoff, /terminalPreviewAnchorSettleSignalRef\.current = null/);
  assert.match(handoff, /TERMINAL_PREVIEW_HANDOFF_DONE/);
  assert.ok(
    handoff.indexOf("if (action === 'clear-preview')")
      < handoff.indexOf('if (!preserveAnchor(action))'),
    'the duplicate Footer+row layout must clear before any anchor write',
  );
  assert.ok(
    handoff.indexOf('if (settling.anchorOffsetPx === null)')
      < handoff.indexOf('stabilizeHistoryRevealAnchor({'),
    'a tail reader must finish through bottom ownership without row-top stabilization',
  );
  assert.doesNotMatch(handoff, /attempts\s*<\s*180/);
  assert.doesNotMatch(handoff, /scrollToIndex/);
  assert.doesNotMatch(handoff, /keepHistoryTailPinnedAfterMutation/);
  assert.doesNotMatch(handoff, /tailSpacer|holdHistoryShrinkFrame/);
});

test('preview handoff ref is published atomically instead of mirrored by render', () => {
  const state = sliceFrom(
    'const [terminalPreviewClearHandoff, setTerminalPreviewClearHandoff]',
    'const [terminalPreviewHandoffWakeSeq',
  );
  assert.match(state, /publishTerminalPreviewClearHandoff/);
  assert.match(state, /terminalPreviewClearHandoffRef\.current = next/);
  assert.match(state, /setTerminalPreviewClearHandoff\(next\)/);
  assert.doesNotMatch(
    state,
    /terminalPreviewClearHandoffRef\.current = terminalPreviewClearHandoff/,
    'a concurrent render must not overwrite a newer IPC/layout transaction',
  );
});

test('Virtuoso range changes wake one bounded preview handoff probe', () => {
  const rangeHandler = sliceFrom(
    'rangeChanged={(range) => {',
    '// The first owner proof mounts only the actual viewport',
  );
  assert.match(rangeHandler, /scheduleTerminalPreviewHandoffWake\(/);
  assert.match(rangeHandler, /range-changed:/);

  const scheduler = sliceFrom(
    'const scheduleTerminalPreviewHandoffWake =',
    '// Terminal bytes can appear before Claude\/Codex',
  );
  assert.match(scheduler, /terminalPreviewHandoffWakeRafRef\.current/);
  assert.match(scheduler, /requestAnimationFrame\(/);
  assert.match(scheduler, /setTerminalPreviewHandoffWakeSeq/);
  assert.match(scheduler, /presentationVisit/);
  assert.match(scheduler, /ownerGeneration/);
  assert.equal(
    (scheduler.match(/requestAnimationFrame\(/g) || []).length,
    1,
    'one range signal is coalesced behind one animation frame',
  );
});

test('a newly presented persistent pane wakes a hidden canonical handoff', () => {
  const presentation = sliceFrom(
    'const applyPresentation =',
    'const onPresentation =',
  );
  assert.match(
    presentation,
    /terminalPreviewPresentationWakeRef\.current\?\.\([\s\S]*?'presentation-visit:' \+ proof\.visit/,
  );

  const scheduler = sliceFrom(
    'const scheduleTerminalPreviewHandoffWake =',
    '// Terminal bytes can appear before Claude\/Codex',
  );
  assert.match(scheduler, /pending\.presentationVisit !== presentation\.visit/);
  assert.match(scheduler, /TERMINAL_PREVIEW_HANDOFF_REBASE/);
  assert.match(scheduler, /terminalPreviewPresentationWakeRef\.current = scheduleTerminalPreviewHandoffWake/);
});

test('the removed second-bottom subsystem cannot be wired back accidentally', () => {
  assert.doesNotMatch(
    source,
    /historyTailSpacerRef|data-history-tail-spacer|holdHistoryShrinkFrame|armTailReserve/,
  );
});
