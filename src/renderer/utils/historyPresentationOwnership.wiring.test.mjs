import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const history = fs.readFileSync(path.join(workspaceDir, 'HistoryPanel.tsx'), 'utf8');
const pane = fs.readFileSync(path.join(workspaceDir, 'SplitPaneSurface.tsx'), 'utf8');
const terminalArea = fs.readFileSync(path.join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(workspaceDir, 'Workspace.tsx'), 'utf8');

test('presentation proof comes from actual pane visibility, never focus', () => {
  assert.match(pane, /presented: workspaceVisible && !dormant/);
  assert.match(pane, /const historySurfacePresented = externalPresentationRef\.current\.presented/);
  assert.match(pane, /PANE_LAYER_PRESENTATION_EVENT/);
  assert.match(pane, /actualPresented=\{historySurfacePresented\}/);
  assert.match(pane, /actualPresented=\{historySurfacePresented && sideHistoryOpen\}/);
  assert.match(pane, /presented: actualPresented/,
    'после первого показа владелец обновляется событием без рендера тяжёлой панели');
  assert.match(terminalArea, /const terminalSurfacePresented = resolveTerminalSurfacePresented\(\{/);
  assert.match(terminalArea, /presented: terminalSurfacePresented/);
  assert.match(terminalArea, /`split-pane:\$\{tabId\}:main`, model\.mainHistoryPresented/);
  assert.match(terminalArea, /PANE_LAYER_PRESENTATION_EVENT/);
  assert.match(history, /detail\?\.channel !== presentationChannel/);
  assert.match(history, /historyPresentationProofRef\.current = proof/);
  assert.doesNotMatch(pane, /presented=\{focused\}/);
  assert.match(workspace, /actualPresented=\{singleCenterAgentPresented[\s\S]{0,240}?historyPlacementForRender\.isOpen\}/);
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

test('externally managed stable visits avoid sync layout and re-arm only from structural or post-paint proof', () => {
  const start = history.indexOf('const applyPresentation =');
  const end = history.indexOf('const onPresentation =', start);
  assert.ok(start >= 0 && end > start);
  const apply = history.slice(start, end);
  assert.match(apply, /remountForChangedGeometry/);
  const sameStateStart = apply.indexOf('} else {');
  const stableGuard = apply.indexOf('if (!proof.presented || !geometryStable) return;', sameStateStart);
  assert.ok(sameStateStart >= 0 && stableGuard > sameStateStart);
  const sameStateBranch = apply.slice(sameStateStart, stableGuard);
  assert.match(sameStateBranch, /if \(!geometryStable\) \{/);
  assert.match(sameStateBranch, /historyTailPinScheduler\.cancel\(\)/);
  assert.match(sameStateBranch, /remountForChangedGeometry\(\)/);
  const stablePath = apply.slice(stableGuard);
  assert.match(stablePath, /!stableLayerHasContentNode\(\)/);
  assert.match(stablePath, /armHistoryViewportPaintProof\(\)/);
  const firstPaintBoundary = stablePath.indexOf('paintFrame1 = requestAnimationFrame');
  assert.ok(firstPaintBoundary > 0);
  assert.doesNotMatch(stablePath.slice(0, firstPaintBoundary), /getBoundingClientRect\(/,
    'workflow-switch commit must not force layout once per incoming History');
  assert.match(stablePath, /PRESENTATION_UNPAINTED_REARM/,
    'a zero-height row still restores the strict loader after the paint boundary');
  assert.doesNotMatch(stablePath, /setPresentationRestoreTick/);
  assert.match(apply, /geometryStable/);
  assert.match(apply, /publishHistorySurfacePresented\(\{/);
});

test('dormant prewarm and first visible visit keep one externally-managed Virtuoso key', () => {
  const persistentStart = pane.indexOf('function PersistentPaneHistory');
  const persistentEnd = pane.indexOf('/**\n * A split pane', persistentStart);
  const persistent = pane.slice(persistentStart, persistentEnd);
  assert.match(persistent, /const initialPresentedRef = useRef\(actualPresented\)/);
  assert.match(persistent, /presented=\{initialPresentedRef\.current\}/);
  assert.match(persistent, /presentationExternallyManaged/);
  assert.doesNotMatch(persistent, /presentationPrimed|setPresentationPrimed/,
    'first visibility must not flip the physical list from owner:visit to owner:mount');
});

test('stable compositor visits preserve one physical Virtuoso mount', () => {
  assert.match(
    history,
    /const restoredLayoutVisitKey = presentationExternallyManaged[\s\S]{0,180}?presentationRestoreTick[\s\S]{0,120}?historyOwnerVisit/,
  );
  assert.match(history, /key=\{restoredLayoutVisitKey\}/);
  assert.doesNotMatch(history, /key=\{historyOwnerKey \+ ':' \+ historyOwnerVisit\}/);
});

test('measured layout is addressed by exact display-unit identity', () => {
  assert.match(history, /const displayUnitLayoutKeys = useMemo\(/);
  assert.match(history, /historyMeasuredUnitKey\(unit\)/);
  assert.match(
    history,
    /getHistoryMeasuredLayout\(historyOwnerKey, displayUnitLayoutKeys\)/,
  );
  assert.doesNotMatch(history, /getHistoryMeasuredLayout\(historyOwnerKey, displayUnits\.length\)/);
  const saves = [...history.matchAll(/saveHistoryMeasuredLayout\(([\s\S]*?)\)/g)];
  assert.ok(saves.length >= 4);
  for (const save of saves) {
    assert.match(save[1], /layoutItemKeys/);
    assert.doesNotMatch(save[1], /layoutItems\s*$/);
  }
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
  // Same-state + stable geometry may prove paint, but must not version the
  // physical list or trigger another restore/convergence cycle.
  const stablePath = apply.slice(apply.lastIndexOf('if (!proof.presented || !geometryStable) return;'));
  assert.doesNotMatch(stablePath, /setPresentationRestoreTick|scrollRestoreGenRef\.current \+= 1/);
});

test('presentation hide revokes write proof before synchronously clearing gesture geometry', () => {
  const applyStart = history.indexOf('const applyPresentation =');
  const applyEnd = history.indexOf('const onPresentation =', applyStart);
  const apply = history.slice(applyStart, applyEnd);
  const proofWrite = apply.indexOf('historyPresentationProofRef.current = proof');
  const hideCleanup = apply.indexOf('historyPresentationHideCleanupRef.current?.()');
  assert.ok(proofWrite >= 0 && hideCleanup > proofWrite,
    'hidden pane must lose scroll-write ownership before bridge cancellation');
  assert.ok(
    [...history.matchAll(/historyPresentationHideCleanupRef\.current\?\.\(\)/g)].length >= 2,
    'both external and legacy presentation paths clean temporary geometry');

  const cleanupStart = history.indexOf('historyPresentationHideCleanupRef.current = () => {');
  const cleanupEnd = history.indexOf('useEffect(() => () => {', cleanupStart);
  const cleanup = history.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /historyScrollSeekController\.configuration\.exit\(0\)/);
  assert.match(cleanup, /releaseHistoryWheelGeometryFreeze\(false\)/);
  assert.match(cleanup, /removeAttribute\('data-history-geometry-bridge'\)/);
  assert.match(cleanup, /removeProperty\('--hp-history-geometry-bridge-y'\)/);
  assert.match(cleanup, /setHistorySeekGeometryMask\(scroller, false\)/);
});
