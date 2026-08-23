import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const history = fs.readFileSync(path.join(workspaceDir, 'HistoryPanel.tsx'), 'utf8');
const pane = fs.readFileSync(path.join(workspaceDir, 'SplitPaneSurface.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(workspaceDir, 'Workspace.tsx'), 'utf8');

test('presentation proof comes from actual pane visibility, never focus', () => {
  assert.match(pane, /const historySurfacePresented = workspaceVisible && !dormant/);
  assert.match(pane, /actualPresented=\{historySurfacePresented\}/);
  assert.match(pane, /actualPresented=\{historySurfacePresented && sideHistoryOpen\}/);
  assert.match(pane, /presented: actualPresented/,
    'после первого показа владелец обновляется событием без рендера тяжёлой панели');
  assert.match(history, /detail\?\.channel !== presentationChannel/);
  assert.match(history, /historyPresentationProofRef\.current = proof/);
  assert.doesNotMatch(pane, /presented=\{focused\}/);
  assert.match(workspace, /presented=\{workspaceView === 'workspace'[\s\S]{0,240}?historyPlacementForRender\.isOpen\}/);
  assert.match(history, /data-history-presented=\{presented \? '1' : '0'\}/);
  assert.match(history, /data-history-presentation-visit=\{historyPresentationVisit\}/);
});

test('a dormant scroll exits before mutating semantic follow or saved position', () => {
  const start = history.indexOf('const handleScroll = useCallback');
  const end = history.indexOf('// Keep entries ref fresh', start);
  const handler = history.slice(start, end);
  const gate = handler.indexOf('if (!presentation.presented)');
  assert.ok(gate >= 0);
  assert.ok(gate < handler.indexOf('setHistoryTailFollowIntent'));
  assert.ok(gate < handler.indexOf('setHistoryScrollPosition'));
  assert.match(handler, /const savePresentationVisit = presentation\.visit/);
  assert.match(handler, /historyPresentationOwnsWrite\([\s\S]{0,140}?savePresentationVisit/);
  assert.match(handler, /SCROLL_SAVE_SKIP/);
});

test('presentation visit versions deferred writers and reuses the common restore', () => {
  assert.match(history, /:p' \+ \(proof\.presented \? '1' : '0'\) \+ ':v' \+ proof\.visit/);
  assert.match(history, /initialLoadDoneRef\.current = false;[\s\S]{0,260}?historyTailPinScheduler\.cancel\(\)/);
  const restoreStart = history.indexOf('// Restore the reading position once per owner');
  const restoreEnd = history.indexOf('// Terminal bytes can appear', restoreStart);
  const restore = history.slice(restoreStart, restoreEnd);
  assert.match(restore, /if \(!presentationAtRestore\.presented\) return/);
  assert.match(restore, /presentation-change/);
  assert.match(restore, /PRESENTATION_RESTORE/);
});

test('the exact painted-surface proof consumes viewport pending before Timeline is released', () => {
  const publisherStart = history.indexOf('const publishHistorySurfacePresented = useCallback');
  const publisherEnd = history.indexOf('// Virtuoso now renders display UNITS', publisherStart);
  assert.ok(publisherStart >= 0 && publisherEnd > publisherStart);
  const publisher = history.slice(publisherStart, publisherEnd);
  const consumeAt = publisher.indexOf('consumeHistoryViewportPaintProof');
  const recordAt = publisher.indexOf('recordHistorySurfacePresented');
  const dispatchAt = publisher.indexOf("window.dispatchEvent(new CustomEvent('history-panel:surface-presented'");
  assert.ok(consumeAt >= 0, 'surface publisher must consume the History loader proof');
  assert.ok(recordAt > consumeAt, 'Timeline replay is recorded only after the loader proof is accepted');
  assert.ok(dispatchAt > recordAt, 'live Timeline release follows the same accepted proof');
  assert.match(publisher, /presentationVisit/);

  const calls = [...history.matchAll(/publishHistorySurfacePresented\(\{([\s\S]*?)\n\s*\}\);/g)];
  assert.ok(calls.length >= 3, 'row, empty-state, and external-presentation paths publish proof');
  for (const call of calls) {
    assert.match(call[1], /presentationVisit:/, 'every proof identifies the exact visible visit');
  }
});

test('externally managed stable visits do not re-arm viewport pending', () => {
  const start = history.indexOf('const applyPresentation =');
  const end = history.indexOf('const onPresentation =', start);
  assert.ok(start >= 0 && end > start);
  const apply = history.slice(start, end);
  assert.doesNotMatch(apply, /setViewportProofRequired\(true\)/);
  assert.doesNotMatch(apply, /setViewportReadyOwnerKey\(''\)/);
  assert.match(apply, /geometryStable/);
  assert.match(apply, /publishHistorySurfacePresented\(\{/);
});

test('same-state external handoff still gets one exact paint-proof opportunity', () => {
  const start = history.indexOf('const applyPresentation =');
  const end = history.indexOf('const onPresentation =', start);
  assert.ok(start >= 0 && end > start);
  const apply = history.slice(start, end);
  assert.match(apply, /const presentationChanged =/);
  assert.doesNotMatch(
    apply,
    /if \(previous\.presented === proof\.presented && previous\.visit === proof\.visit\) return/,
  );
  assert.match(apply, /PRESENTATION_PROBE_SAME_STATE/);
  assert.match(apply, /const historyProofPending = viewportReadyOwnerKeyRef\.current !== ownerAtSchedule/);
  assert.match(apply, /const surfaceProofPending = surfacePresentedOwnerRef\.current !== proofKeyAtSchedule/);
  assert.match(apply, /if \(!historyProofPending && !surfaceProofPending\) return/);
  // Same-state handoff may prove paint, but must not version presentation or
  // trigger another restore/convergence cycle.
  const sameState = apply.slice(apply.indexOf('} else {'), apply.indexOf('if (!proof.presented || !geometryStable) return;', apply.indexOf('} else {')) + 70);
  assert.doesNotMatch(sameState, /setPresentationRestoreTick|scrollRestoreGenRef\.current \+= 1/);
});
