import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { canRetainPointerPublication, freezeOutlineData, readonlyDragSnapshot } from './pointerPublication.js';
import { usesCommandHierarchy, commandNavigationMode, rebaseHierarchyModifier, usesFolderHover, folderApproachBlocksSlot } from './hierarchyModifier.js';

import { snapRect } from '../index.js';

import {
  COLLAPSIBLE_DWELL_INTERVAL,
  EDGE_ACTIVATION_DISTANCE,
  EDGE_ZONE_SIZE,
  HORIZONTAL_PREVIEW_START,
  HORIZONTAL_THRESHOLD,
  HORIZONTAL_Y_TOLERANCE,
  MAX_SCROLL_STEP,
  ROW_HEIGHT,
  VERTICAL_REBASE_DISTANCE,
  assertValidOutline,
  boundaryFromGeometry,
  boundaryFromPointer,
  createEdgeGesture,
  detachedBoundaryTops,
  edgeScrollVelocity,
  findNodeLocation,
  flattenVisible,
  getSubtreeIds,
  forestAnchorOffset,
  horizontalIntent,
  indentNode,
  outdentNode,
  prepareDrag,
  projectVerticalMove,
  updateEdgeGesture,
} from '../core/index.js';
import {
  DEFAULT_POINTER_THRESHOLD,
  advanceFolderDwell,
  createOutlineDndSessionId,
  findOutlineNode,
  isAcceptedCallbackResult,
  isPointInsideGestureRegion,
  isPointInsideRect,
  leaseForScrollPosition,
  mergeControlledOutline,
  nextFolderRowExpansion,
  normalizeOutsidePointerPolicy,
  reserveForScrollTarget,
  resolveHorizontalMovePolicy,
  setOutlineExpanded,
  shouldToggleFolderRowClick,
  shouldTrackExpansionPromise,
} from './pointer.js';
import {
  allowsLayoutAnimationForMotionPreference,
  changedOutlineLayoutKeys,
  layoutFlipDelta,
  layoutAnimationBudgetReason,
  layoutAnimationCancelReason,
  normalizeLayoutAnimation,
} from './layoutAnimation.js';

const DEFAULT_IGNORE_SELECTOR = [
  '[data-outline-dnd-ignore]',
  'button',
  'input',
  'textarea',
  'select',
  'a',
].join(',');

const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const domNodeKey = (id) => `${typeof id}:${String(id)}`;

function publicDragState(drag, revision) {
  if (!drag) return null;
  if (drag.phase === 'pending') {
    return {
      phase: 'pending',
      sessionId: drag.sessionId,
      sourceId: drag.sourceId,
      pointerId: drag.pointerId,
      startX: drag.startX,
      startY: drag.startY,
      pointerX: drag.pointerX,
      pointerY: drag.pointerY,
      previewRevision: revision,
    };
  }

  return {
    phase: drag.phase,
    sessionId: drag.sessionId,
    sourceId: drag.sourceId,
    sourceIds: drag.sourceIds,
    sourceRootIds: drag.sourceRootIds,
    sourceContext: drag.sourceContext,
    externalOwnerKey: drag.externalOwnerKey,
    pointerId: drag.pointerId,
    startX: drag.startX,
    startY: drag.startY,
    pointerX: drag.pointerX,
    pointerY: drag.pointerY,
    boundary: drag.boundary,
    pointerBoundary: drag.pointerBoundary,
    preferredDepth: drag.preferredDepth,
    resolvedDepth: drag.resolvedDepth,
    currentParentId: drag.currentParentId,
    slot: drag.slot,
    feedback: drag.feedback,
    edge: drag.edge,
    edgeOrigin: drag.edgeOrigin ?? null,
    edgeGesture: drag.edgeGesture,
    navigationMode: drag.navigationMode,
    hierarchyMode: drag.hierarchyMode === true,
    navigationDwell: drag.navigationDwell,
    scrollReserve: drag.scrollReserve,
    scrollCeiling: drag.scrollCeiling,
    lastAnchor: drag.lastAnchor,
    expansionPendingIds: [...drag.pendingExpansionIds],
    layoutChangeAxis: drag.layoutChangeAxis ?? null,
    externalTarget: drag.externalTarget ?? null,
    previewRevision: revision,
  };
}

function releasePointerCapture(drag) {
  const element = drag?.captureElement;
  if (!element || typeof element.releasePointerCapture !== 'function') return;
  try {
    if (!element.hasPointerCapture || element.hasPointerCapture(drag.pointerId)) {
      element.releasePointerCapture(drag.pointerId);
    }
  } catch {
    // Capture may already have been released by the browser.
  }
}

function acquirePointerCapture(drag) {
  const element = drag?.captureElement;
  if (!element || typeof element.setPointerCapture !== 'function') return;
  try {
    if (!element.hasPointerCapture || !element.hasPointerCapture(drag.pointerId)) {
      element.setPointerCapture(drag.pointerId);
    }
  } catch {
    // Window listeners keep the active drag alive when capture is unavailable.
  }
}

function sourceElement(scroller, sourceId) {
  if (!scroller) return null;
  return [...scroller.querySelectorAll('[data-outline-dnd-row]')]
    .find((element) => element.dataset.outlineDndKey === domNodeKey(sourceId)) || null;
}

export function expansionCallback(callbacks, reason) {
  if (reason === 'pointer-toggle') {
    return callbacks.onToggle || callbacks.onExpansionRequest || null;
  }
  return callbacks.onExpansionRequest || callbacks.onToggle || null;
}

export function semanticVerticalSlotUnchanged(projected, drag) {
  return projected?.boundary === drag?.boundary
    && projected?.slot?.parentId === drag?.slot?.parentId
    && projected?.slot?.index === drag?.slot?.index;
}

// External host targets are allowed to coexist with outline navigation.
// `Cmd` still freezes/reveals folders while the pointer is over the outline,
// but a host may give that same held gesture a precise destination outside the
// outline (for example a terminal window).  Keep the payload construction pure
// so the modifier contract is testable without mounting React.
export function resolvePointerExternalTarget({
  drag,
  event,
  previewOutline,
  resolveExternalTarget,
} = {}) {
  if (!drag || typeof resolveExternalTarget !== 'function') return null;
  return resolveExternalTarget({
    clientX: event?.clientX ?? drag.pointerX,
    clientY: event?.clientY ?? drag.pointerY,
    startX: drag.startX,
    startY: drag.startY,
    sourceId: drag.sourceId,
    sourceIds: drag.sourceIds,
    sourceNode: drag.prepared?.sourceNode ?? drag.sourceNode,
    sourceRootIds: drag.sourceRootIds,
    sourceNodes: drag.prepared?.sourceNodes,
    sourceContext: drag.sourceContext,
    previewOutline,
    metaKey: !!(event?.metaKey || drag.navigationMode || drag.hierarchyMode),
    navigationMode: drag.navigationMode === true,
  }) ?? null;
}

export function axisOwnedLayoutDelta(axis, delta) {
  return {
    x: axis === 'horizontal' ? Number(delta?.x || 0) : 0,
    y: axis === 'vertical' ? Number(delta?.y || 0) : 0,
  };
}

export function useOutlineDnd({
  outline = [],
  disabled = false,
  externalDrag = null,
  getDragSource,
  validateDragSource,
  scopeKey,
  onCommit,
  onExternalCommit,
  onExpansionRequest,
  onToggle,
  onLog,
  onDiagnostic,
  canHorizontalMove,
  canUseVerticalSlot,
  resolveExternalTarget,
  createSessionId = createOutlineDndSessionId,
  pointerThreshold = DEFAULT_POINTER_THRESHOLD,
  rowHeight = null,
  horizontalThreshold = HORIZONTAL_THRESHOLD,
  horizontalPreviewStart = HORIZONTAL_PREVIEW_START,
  horizontalYTolerance = HORIZONTAL_Y_TOLERANCE,
  hierarchyModifier = null,
  pointerPublication = 'frame',
  sourceFollow = null,
  verticalRebaseDistance = VERTICAL_REBASE_DISTANCE,
  edgeZoneSize = EDGE_ZONE_SIZE,
  edgeScrollStep = MAX_SCROLL_STEP,
  edgeActivationDistance = EDGE_ACTIVATION_DISTANCE,
  folderDwellInterval = COLLAPSIBLE_DWELL_INTERVAL,
  ignoreSelector = DEFAULT_IGNORE_SELECTOR,
  outsidePointerPolicy = 'cancel',
  layoutAnimation = true,
} = {}) {
  const controlledOutline = Array.isArray(outline) ? outline : [];
  const scrollerRef = useRef(null);
  const controlledOutlineRef = useRef(controlledOutline);
  const previewOutlineRef = useRef(controlledOutline);
  const dragRef = useRef(null);
  const scrollLeaseRef = useRef(null);
  const scrollSpacerElementRef = useRef(null);
  const revisionRef = useRef(0);
  const immutableOutlineRef = useRef(null);
  const ownerEpochRef = useRef(0), scopeLifetimeRef = useRef(scopeKey);
  if (scopeLifetimeRef.current !== scopeKey) {
    scopeLifetimeRef.current = scopeKey; ownerEpochRef.current += 1;
  }
  const paintedPreviewRef = useRef(null);
  const settledPreviewRef = useRef(null);
  const commitTokenRef = useRef(0);
  const suppressClickRef = useRef(null);
  const rowsRef = useRef([]);
  const rowElementsRef = useRef(new Map());
  // Only the active real rows own this visual offset. No source clone or model mutation.
  const sourceFollowRef = useRef(null);
  const rowRefCallbacksRef = useRef(new Map());
  const rowLayoutSnapshotRef = useRef({ scrollTop: 0, rows: [], signature: null });
  const pendingLayoutFirstRef = useRef(null);
  const rowLayoutAnimationsRef = useRef(new Map());
  const rowLayoutAnimationBatchRef = useRef(null);
  const rowLayoutLastChangeAtRef = useRef(-Infinity);
  const pointerMoveFrameRef = useRef({ frameId: 0, latest: null });
  // Electron/CDP and a few macOS event paths can deliver a real Meta keydown
  // while subsequent pointermove.metaKey is false. The keyboard edge is the
  // authoritative held-modifier state; blur/keyup clears it.
  const metaKeyHeldRef = useRef(false);
  const lastBoundaryMeasurementRef = useRef(null);
  const pointerTraceRef = useRef({ received: 0, processed: 0, lastReceived: null, lastProcessed: null });

  controlledOutlineRef.current = controlledOutline;

  const callbacksRef = useRef({
    onCommit,
    onExternalCommit,
    onExpansionRequest,
    onToggle,
    onLog,
    onDiagnostic,
    canHorizontalMove,
    canUseVerticalSlot,
    resolveExternalTarget,
    getDragSource,
    validateDragSource,
  });
  callbacksRef.current = {
    onCommit,
    onExternalCommit,
    onExpansionRequest,
    onToggle,
    onLog,
    onDiagnostic,
    canHorizontalMove,
    canUseVerticalSlot,
    resolveExternalTarget,
    getDragSource,
    validateDragSource,
  };

  const configRef = useRef({});
  configRef.current = {
    disabled,
    scopeKey,
    hierarchyModifier,
    pointerPublication: pointerPublication === 'semantic' ? 'semantic' : 'frame',
    sourceFollow: sourceFollow === 'y' ? 'y' : null,
    createSessionId,
    pointerThreshold: Math.max(0, Number(pointerThreshold) || 0),
    rowHeight: rowHeight == null ? null : Math.max(1, Number(rowHeight) || ROW_HEIGHT),
    horizontalThreshold: Math.max(1, Number(horizontalThreshold) || HORIZONTAL_THRESHOLD),
    horizontalPreviewStart: Math.max(0, Number(horizontalPreviewStart) || 0),
    horizontalYTolerance: Math.max(0, Number(horizontalYTolerance) || 0),
    verticalRebaseDistance: Math.max(0, Number(verticalRebaseDistance) || 0),
    edgeZoneSize: Math.max(1, Number(edgeZoneSize) || EDGE_ZONE_SIZE),
    edgeScrollStep: Math.max(1, Number(edgeScrollStep) || MAX_SCROLL_STEP),
    edgeActivationDistance: Math.max(0, Number(edgeActivationDistance) || 0),
    folderDwellInterval: Math.max(1, Number(folderDwellInterval) || COLLAPSIBLE_DWELL_INTERVAL),
    ignoreSelector,
    outsidePointerPolicy: normalizeOutsidePointerPolicy(outsidePointerPolicy),
    layoutAnimation: normalizeLayoutAnimation(layoutAnimation),
  };

  const [view, setView] = useState(() => ({
    previewOutline: controlledOutline,
    dragState: null,
    scrollLease: null,
    revision: 0,
  }));

  const emitDiagnostic = useCallback((type, detail = {}, drag = dragRef.current) => {
    const callback=callbacksRef.current.onDiagnostic;
    if(typeof callback!=='function')return;
    try { callback(type,{gestureId:drag?.sourceContext?.gestureId ?? drag?.sessionId,
      sessionId:drag?.sessionId,sourceId:drag?.sourceId,pointerId:drag?.pointerId,
      ownerKey:drag?.externalOwnerKey,ownerEpoch:drag?.ownerEpoch,workflowId:configRef.current.scopeKey,
      revision:drag?.renderRevision,eventAbs:drag?.diagnosticEventAbs,
      x:drag?.pointerX,y:drag?.pointerY,grabY:drag?.grabOffsetY,
      boundary:drag?.boundary,depth:drag?.resolvedDepth,meta:drag?.hierarchyMode===true,
      ...detail}); } catch { /* Diagnostics cannot change gesture acceptance. */ }
  }, []);

  const emitLog = useCallback((type, detail = {}, drag = dragRef.current) => {
    emitDiagnostic(type,{reason:detail.reason},drag);
    const callback = callbacksRef.current.onLog;
    if (typeof callback !== 'function') return;
    try {
      callback({
        type,
        detail,
        sessionId: drag?.sessionId ?? null,
        sourceId: drag?.sourceId ?? null,
        // Reuse the resolver's measurements: diagnostics must not force another
        // layout or replace the last painted destination at release.
        pointer: drag ? { x: drag.pointerX, y: drag.pointerY, navigationMode: drag.navigationMode } : null,
        slot: drag?.slot ?? null,
        measurement: lastBoundaryMeasurementRef.current,
        input: { ...pointerTraceRef.current },
        timestamp: Date.now(),
      });
    } catch {
      // Observability must not change pointer semantics.
    }
  }, [emitDiagnostic]);

  const followsSourceY = useCallback((drag) => configRef.current.sourceFollow === 'y'
    && drag?.phase === 'dragging' && !drag.externalReleasePending
    && drag.ownerEpoch === ownerEpochRef.current, []);

  const restoreSourceRow = useCallback((entry) => {
    const style = entry.element.style;
    // Do not undo a later binding/host write when a row leaves this owner.
    if (style.getPropertyValue('--outline-dnd-source-y') !== entry.written) return;
    if (entry.previous) style.setProperty('--outline-dnd-source-y', entry.previous, entry.priority);
    else style.removeProperty('--outline-dnd-source-y');
  }, []);

  const clearSourceFollow = useCallback(() => {
    const state = sourceFollowRef.current;
    sourceFollowRef.current = null;
    if (state) for (const entry of state.rows.values()) restoreSourceRow(entry);
  }, [restoreSourceRow]);

  const layoutRect = useCallback((element) => {
    const rect = snapRect(element, { compensateTransform: true });
    const entry = sourceFollowRef.current?.rows.get(element.dataset.outlineDndKey);
    // snapRect owns WAAPI transform compensation. Individual translate is our
    // separate Y channel; subtract its known value without another style read.
    const y = entry?.element === element
      && element.style.getPropertyValue('--outline-dnd-source-y') === entry.written ? entry.y : 0;
    return y ? { ...rect, top: rect.top - y, bottom: rect.bottom - y, midY: rect.midY - y } : rect;
  }, []);

  const writeSourceFollow = useCallback((drag, measuredRows) => {
    if (!followsSourceY(drag) || !followsSourceY(dragRef.current)
      || dragRef.current.sessionId !== drag.sessionId) return;
    let state = sourceFollowRef.current;
    if (state && (state.sessionId !== drag.sessionId || state.ownerEpoch !== drag.ownerEpoch)) {
      clearSourceFollow(); state = null;
    }
    if (!state) sourceFollowRef.current = state = {
      sessionId: drag.sessionId, ownerEpoch: drag.ownerEpoch, rows: new Map(), dirty: true,
    };
    if (measuredRows) {
      const sourceIds = new Set(drag.sourceIds), nextRows = new Map();
      let offset = 0;
      for (let index = 0; index < measuredRows.length; index += 1) {
        const row = measuredRows[index];
        if (!sourceIds.has(row.id)) continue;
        const key = domNodeKey(row.id), element = rowElementsRef.current.get(key);
        if (!element || !Number.isFinite(row.top)) continue;
        let entry = state.rows.get(key);
        if (entry?.element !== element) {
          if (entry) restoreSourceRow(entry);
          entry = { element, y: 0, written: null,
            previous: element.style.getPropertyValue('--outline-dnd-source-y'),
            priority: element.style.getPropertyPriority('--outline-dnd-source-y') };
        }
        entry.top = row.top; entry.offset = offset;
        nextRows.set(key, entry);
        // Same compact-forest footprint as forestAnchorOffset, including the
        // real row gap, without the gaps occupied by unselected roots.
        offset += (measuredRows[index + 1]?.top ?? row.bottom) - row.top;
      }
      for (const [key, entry] of state.rows) if (!nextRows.has(key)) restoreSourceRow(entry);
      state.rows = nextRows;
      state.outline = previewOutlineRef.current;
      state.dirty = false;
    }
    const anchor = state.rows.get(domNodeKey(drag.sourceId));
    if (!anchor) return;
    const top = drag.pointerY - drag.grabOffsetY;
    let writes = 0;
    for (const [key, entry] of state.rows) {
      if (rowElementsRef.current.get(key) !== entry.element || !entry.element.isConnected) continue;
      const y = top - anchor.offset + entry.offset - entry.top;
      if (!Number.isFinite(y)) continue;
      const written = `${y}px`;
      if (entry.written === written) continue;
      entry.element.style.setProperty('--outline-dnd-source-y', written);
      entry.y = y; entry.written = written; writes += 1;
    }
    if (writes) emitDiagnostic('authored', { axis: 'y', top, intendedTop: top - anchor.offset,
      forestOffset: anchor.offset, presentation: 'in-tree-source-y-style-not-pixels' }, drag);
  }, [clearSourceFollow, emitDiagnostic, followsSourceY, restoreSourceRow]);

  const refreshSourceFollow = useCallback((drag, rects) => {
    if (!followsSourceY(drag)) { clearSourceFollow(); return; }
    if (!sourceFollowRef.current) return; // First move uses measureBoundary's existing snapshot.
    const sourceIds = new Set(drag.sourceIds), needed = new Set();
    const visible = rowsRef.current;
    for (let index = 0; index < visible.length; index += 1) if (sourceIds.has(visible[index].id)) {
      needed.add(visible[index].id);
      if (visible[index + 1]) needed.add(visible[index + 1].id);
    }
    // A real layout/scroll/rebind needs only source rows and their gap anchors.
    // Pointer-only React publications never enter this measurement path.
    const measured = visible.flatMap(row => {
      if (!needed.has(row.id)) return [];
      const key = domNodeKey(row.id), element = rowElementsRef.current.get(key);
      const rect = rects?.get(key) || (element ? layoutRect(element) : null);
      return rect ? [{ id: row.id, top: rect.top, bottom: rect.bottom }] : [];
    });
    writeSourceFollow(drag, measured);
  }, [clearSourceFollow, followsSourceY, layoutRect, writeSourceFollow]);

  const clearPendingPointerMove = useCallback(() => {
    const pending = pointerMoveFrameRef.current;
    if (pending.frameId) cancelAnimationFrame(pending.frameId);
    pending.frameId = 0;
    pending.latest = null;
  }, []);

  const publish = useCallback((nextDrag, nextOutline, nextLease, pointerReadPhase) => {
    const resolvedOutline = nextOutline === undefined
      ? previewOutlineRef.current
      : nextOutline;
    const resolvedLease = nextLease === undefined
      ? scrollLeaseRef.current
      : nextLease;
    const previousOutline = previewOutlineRef.current;
    if (!followsSourceY(nextDrag)) clearSourceFollow();
    if (configRef.current.pointerPublication === 'semantic' && pointerReadPhase
      && canRetainPointerPublication({ current: dragRef.current, next: nextDrag,
        painted: paintedPreviewRef.current, outline: resolvedOutline, previousOutline,
        lease: resolvedLease, previousLease: scrollLeaseRef.current,
        controlledOutline: controlledOutlineRef.current, revision: revisionRef.current,
        ownerEpoch: ownerEpochRef.current, validatedImmutableOutline: immutableOutlineRef.current,
        pendingLayout: pendingLayoutFirstRef.current, inside: pointerReadPhase.inside })) {
      const stored = { ...nextDrag, renderRevision: dragRef.current.renderRevision };
      dragRef.current = stored;
      // Keep the acknowledged receipt, including its coordinates, unchanged.
      emitDiagnostic('published',{presentation:'semantic-state-retained'},stored);
      return stored;
    }
    assertValidOutline(resolvedOutline);
    immutableOutlineRef.current = configRef.current.pointerPublication === 'semantic'
      && freezeOutlineData(resolvedOutline) ? resolvedOutline : null;
    let capturedFirst = null;
    if (
      nextDrag?.phase === 'dragging'
      && (nextDrag.layoutChangeAxis === 'vertical' || nextDrag.layoutChangeAxis === 'horizontal')
      && resolvedOutline !== previousOutline
    ) {
      const scroller = scrollerRef.current;
      const renderedSnapshot = rowLayoutSnapshotRef.current;
      if (scroller && renderedSnapshot.signature != null) {
        const nextRows = flattenVisible(resolvedOutline);
        const changedKeys = changedOutlineLayoutKeys(
          renderedSnapshot.rows || [],
          nextRows,
          (row) => domNodeKey(row.id),
        );
        const nextKeys = new Set(nextRows.map((row) => domNodeKey(row.id)));
        const changedVisibleKeys = new Set(
          [...changedKeys].filter((key) => nextKeys.has(key)),
        );

        if (changedKeys.size > 0) {
          const animationConfig = configRef.current.layoutAnimation;
          const activeAnimations = rowLayoutAnimationsRef.current;
          let preservedAnimations = 0;
          for (const key of activeAnimations.keys()) {
            if (nextKeys.has(key) && !changedKeys.has(key)) preservedAnimations += 1;
          }
          const projectedActiveRows = preservedAnimations + changedVisibleKeys.size;
          const capturedAt = now();
          const elapsedSinceLayoutChange = capturedAt - rowLayoutLastChangeAtRef.current;
          const reducedMotion = typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
          const supportsAnimation = typeof Element !== 'undefined'
            && typeof Element.prototype.animate === 'function';

          let skipReason = null;
          if (!animationConfig.enabled) skipReason = 'disabled';
          else if (animationConfig.duration <= 0) skipReason = 'zero-duration';
          else if (nextDrag.navigationMode) skipReason = 'navigation';
          else if (!supportsAnimation) skipReason = 'unsupported';
          else if (!allowsLayoutAnimationForMotionPreference(animationConfig, reducedMotion)) {
            skipReason = 'reduced-motion';
          } else {
            skipReason = layoutAnimationBudgetReason({
              animationConfig,
              origin: nextDrag.edgeOrigin,
              sourceRows: nextDrag.sourceIds?.length ?? 1,
              changedRows: changedVisibleKeys.size,
              projectedActiveRows,
              elapsedSinceLayoutChange,
            });
          }

          const rects = new Map();
          if (!skipReason) {
            for (const key of changedVisibleKeys) {
              const element = rowElementsRef.current.get(key);
              if (element) rects.set(key, element.getBoundingClientRect());
            }
            if (rects.size === 0) skipReason = 'missing-first-rects';
          }

          capturedFirst = {
            scrollTop: scroller.scrollTop,
            rects,
            rows: renderedSnapshot.rows || [],
            signature: renderedSnapshot.signature,
            changedKeys,
            changedVisibleKeys,
            sourceRows: nextDrag.sourceIds?.length ?? 1,
            projectedActiveRows,
            elapsedSinceLayoutChange,
            origin: nextDrag.edgeOrigin ?? null,
            skipReason,
            capturedAt,
            outline: resolvedOutline,
            sessionId: nextDrag.sessionId,
          };
          rowLayoutLastChangeAtRef.current = capturedAt;
        }
      }
    }

    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    const storedDrag = nextDrag
      ? { ...nextDrag, renderRevision: revision }
      : null;

    dragRef.current = storedDrag;
    previewOutlineRef.current = resolvedOutline;
    scrollLeaseRef.current = resolvedLease;
    const pendingFirst = capturedFirst || pendingLayoutFirstRef.current;
    if (
      pendingFirst
      && storedDrag?.sessionId === pendingFirst.sessionId
      && resolvedOutline === pendingFirst.outline
    ) {
      pendingLayoutFirstRef.current = { ...pendingFirst, revision };
    } else {
      pendingLayoutFirstRef.current = null;
    }
    setView({
      previewOutline: resolvedOutline,
      dragState: publicDragState(storedDrag, revision),
      scrollLease: resolvedLease,
      revision,
    });
    if(storedDrag?.phase==='dragging')emitDiagnostic('published',{presentation:'semantic-outline-state'},storedDrag);
    return storedDrag;
  }, [clearSourceFollow, emitDiagnostic, followsSourceY]);

  const measureBoundary = useCallback((drag, clientY) => {
    const scroller = scrollerRef.current;
    if (!scroller) return { boundary: drag.boundary, scroller: null, rect: null, prepared: drag.prepared };
    const rect = scroller.getBoundingClientRect();
    const baseVisibleCount = flattenVisible(drag.prepared.baseTree).length;
    const rectById = new Map();
    const readRect = (id) => {
      const key = domNodeKey(id), element = rowElementsRef.current.get(key) || null;
      const cached = rectById.get(key);
      if (cached && cached.element === element) return cached.rect;
      const rowRect = element ? layoutRect(element) : null;
      rectById.set(key, { element, rect: rowRect });
      return rowRect;
    };
    // Preserve the exact boundary population; folder-only refs are not added.
    const measuredRows = rowsRef.current.flatMap((row) => {
      const rowRect = readRect(row.id);
      return rowRect ? [{ id: row.id, top: rowRect.top, bottom: rowRect.bottom }] : [];
    });
    const result = (boundary) => {
      const measured=lastBoundaryMeasurementRef.current;
      emitDiagnostic('geometry',{sourceLayoutTop:rectById.get(domNodeKey(drag.sourceId))?.rect?.top,
        intendedTop:measured?.sourceTop,forestOffset:measured?.forestOffset,
        previousBoundaryTop:measured?.previousBoundaryTop,nextBoundaryTop:measured?.nextBoundaryTop,
        boundary,presentation:'compensated-layout-not-pixels'},drag);
      writeSourceFollow(drag, measuredRows);
      return { boundary, scroller, rect, rectById, readRect, measuredRows,
        prepared: drag.prepared, diagnostic: lastBoundaryMeasurementRef.current };
    };
    const forestOffset = drag.sourceRootIds
      ? forestAnchorOffset({ rows: measuredRows, sourceIds: drag.sourceIds, anchorId: drag.sourceId }) : 0;
    const sourceTop = clientY - drag.grabOffsetY - forestOffset;
    const offsets = { clientY, grabOffsetY: drag.grabOffsetY, forestOffset, previousBoundary: drag.pointerBoundary };
    const boundaryTops = detachedBoundaryTops({
      rows: measuredRows,
      sourceIds: drag.sourceIds,
      currentBoundary: drag.boundary,
      allowDisjoint: !!drag.sourceRootIds,
    });
    if (boundaryTops.length === baseVisibleCount + 1) {
      const boundary = boundaryFromGeometry({
        sourceTop,
        boundaryTops,
        fallbackBoundary: drag.pointerBoundary,
      });
      lastBoundaryMeasurementRef.current = {
        mode: 'geometry',
        ...offsets,
        boundary,
        sourceTop,
        currentBoundaryTop: boundaryTops[drag.boundary] ?? null,
        previousBoundaryTop: boundaryTops[drag.boundary - 1] ?? null,
        nextBoundaryTop: boundaryTops[drag.boundary + 1] ?? null,
        measuredRows: measuredRows.length,
        baseVisibleCount,
      };
      return result(boundary);
    }

    if (measuredRows.length > 0) {
      const boundary = drag.pointerBoundary;
      lastBoundaryMeasurementRef.current = {
        mode: 'stale-geometry-hold',
        ...offsets,
        boundary,
        sourceTop,
        measuredRows: measuredRows.length,
        expectedRows: rowsRef.current.length,
        boundaryTops: boundaryTops.length,
        expectedBoundaryTops: baseVisibleCount + 1,
        missingRowIds: rowsRef.current.filter(row => !rowElementsRef.current.has(domNodeKey(row.id))).slice(0, 8).map(row => row.id),
      };
      return result(boundary);
    }

    const boundary = boundaryFromPointer({
      clientY,
      grabOffsetY: drag.grabOffsetY,
      containerTop: rect.top,
      scrollTop: scroller.scrollTop,
      rowHeight: drag.rowHeight,
      visibleCount: baseVisibleCount,
    });
    lastBoundaryMeasurementRef.current = {
      mode: 'uniform-fallback',
      ...offsets,
      boundary,
      sourceTop,
      rowHeight: drag.rowHeight,
      baseVisibleCount,
    };
    return result(boundary);
  }, [layoutRect, writeSourceFollow]);

  const calculateBoundary = useCallback((drag, clientY) => {
    return measureBoundary(drag, clientY).boundary;
  }, [measureBoundary]);

  const measureNaturalScrollMax = useCallback(() => {
    const scroller = scrollerRef.current;
    const spacer = scrollSpacerElementRef.current;
    if (!scroller || !spacer?.isConnected) return null;

    const scrollerRect = scroller.getBoundingClientRect();
    const spacerRect = spacer.getBoundingClientRect();
    const parent = spacer.parentElement;
    const trailingPadding = parent && typeof getComputedStyle === 'function'
      ? Math.max(0, Number.parseFloat(getComputedStyle(parent).paddingBottom) || 0)
      : 0;
    const naturalContentEnd = scroller.scrollTop
      + (spacerRect.top - scrollerRect.top)
      + trailingPadding;
    return naturalContentEnd - scroller.clientHeight;
  }, []);

  const projectVertical = useCallback((drag, clientY, origin, measurement) => {
    const sample = measurement?.scroller === scrollerRef.current && measurement?.prepared === drag.prepared
      ? measurement : measureBoundary(drag, clientY);
    const boundary = sample.boundary;
    const scrollerRect = sample.rect;
    if (usesCommandHierarchy(configRef.current.hierarchyModifier) && scrollerRect
      && drag.pointerX >= scrollerRect.left && drag.pointerX <= scrollerRect.right
      && boundary !== (drag.pointerBoundary ?? drag.boundary)) {
      const protectedIds = [...drag.sourceIds,...(drag.sourceRootIds || [drag.sourceId])
        .flatMap(id => findNodeLocation(previewOutlineRef.current,id)?.ancestors || [])];
      const rows = flattenVisible(drag.prepared.baseTree).map(row => {
        const rect = sample.readRect(row.id);
        return {...row,top:rect?.top,bottom:rect?.bottom};
      });
      if (folderApproachBlocksSlot({from:drag.pointerBoundary ?? drag.boundary,to:boundary,pointerY:clientY,rows,protectedIds}))
        return {drag,outline:previewOutlineRef.current};
    }
    if (boundary === drag.pointerBoundary) {
      return {
        drag: {
          ...drag,
          pointerBoundary: boundary,
          feedback: null,
          blockedDirection: null,
          axisLock: null,
          edgeOrigin: origin,
        },
        outline: previewOutlineRef.current,
        changed: false,
      };
    }

    const projected = projectVerticalMove({
      baseTree: drag.prepared.baseTree,
      sourceNode: drag.prepared.sourceNode,
      sourceNodes: drag.prepared.sourceNodes,
      boundary,
      preferredDepth: drag.preferredDepth,
      previousDepth: drag.resolvedDepth,
      currentParentId: drag.currentParentId,
      canUseSlot: (slot) => {
        const policy = callbacksRef.current.canUseVerticalSlot;
        if (typeof policy !== 'function') return true;
        try {
          const decision = policy({
            sourceId: drag.sourceId,
            sourceNode: drag.prepared.sourceNode,
            sourceRootIds: drag.sourceRootIds,
            sourceNodes: drag.prepared.sourceNodes,
            sourceContext: drag.sourceContext,
            baseOutline: drag.prepared.baseTree,
            slot,
          });
          return decision !== false && decision?.ok !== false;
        } catch (error) {
          emitLog('vertical-slot-policy-error', { slot, error }, drag);
          return false;
        }
      },
    });
    assertValidOutline(projected.tree);
    if (semanticVerticalSlotUnchanged(projected, drag)) {
      return {
        drag: {
          ...drag,
          pointerBoundary: boundary,
          feedback: null,
          blockedDirection: null,
          axisLock: null,
          edgeOrigin: origin,
        },
        outline: previewOutlineRef.current,
        changed: false,
      };
    }
    emitLog(origin === 'scroll' ? 'scroll' : 'vertical', {
      fromBoundary: drag.boundary,
      toBoundary: projected.boundary,
      fromDepth: drag.resolvedDepth,
      toDepth: projected.resolvedDepth,
      origin,
      measurement: lastBoundaryMeasurementRef.current,
    }, drag);
    return {
      outline: projected.tree,
      changed: true,
      drag: {
        ...drag,
        boundary: projected.boundary,
        pointerBoundary: boundary,
        slot: projected.slot,
        resolvedDepth: projected.resolvedDepth,
        currentParentId: projected.slot.parentId,
        feedback: null,
        blockedDirection: null,
        axisLock: null,
        edgeOrigin: origin,
        layoutChangeAxis: 'vertical',
      },
    };
  }, [measureBoundary, emitLog]);

  const rebaseAfterHorizontalMove = useCallback((drag, result, clientX, clientY) => {
    const scroller = scrollerRef.current;
    const beforeElement = sourceElement(scroller, drag.sourceId);
    const sourceTopBefore = beforeElement
      ? (followsSourceY(drag) ? layoutRect(beforeElement) : beforeElement.getBoundingClientRect()).top : null;
    const scrollTopBefore = scroller?.scrollTop ?? 0;

    let paintedDrag;
    flushSync(() => {
      paintedDrag = publish({
        ...drag,
        feedback: null,
        blockedDirection: null,
        axisLock: null,
        layoutChangeAxis: 'horizontal',
      }, result.tree, null);
    });

    const movedElement = sourceElement(scroller, drag.sourceId);
    const sourceTopAfterMutation = movedElement
      ? (followsSourceY(drag) ? layoutRect(movedElement) : movedElement.getBoundingClientRect()).top : null;
    if (scroller && sourceTopBefore != null && sourceTopAfterMutation != null) {
      const targetScrollTop = Math.max(
        0,
        scrollTopBefore + sourceTopAfterMutation - sourceTopBefore,
      );
      const physicalMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const measuredNaturalMax = measureNaturalScrollMax();
      const nextReserve = reserveForScrollTarget({
        currentReserve: paintedDrag.scrollReserve,
        physicalMax,
        naturalMax: measuredNaturalMax ?? undefined,
        targetScrollTop,
      });
      if (nextReserve > paintedDrag.scrollReserve) {
        const previousReserve = paintedDrag.scrollReserve;
        flushSync(() => {
          paintedDrag = publish({
            ...paintedDrag,
            scrollReserve: nextReserve,
          }, result.tree, null);
        });
        emitLog('scroll-reserve', {
          reason: 'horizontal-anchor',
          previousReserve,
          nextReserve,
          added: nextReserve - previousReserve,
          targetScrollTop,
        }, drag);
      }
      scroller.scrollTop = targetScrollTop;
      if (scroller.scrollTop + 0.5 < targetScrollTop) {
        const correction = Math.ceil(targetScrollTop - scroller.scrollTop);
        const previousReserve = paintedDrag.scrollReserve;
        flushSync(() => {
          paintedDrag = publish({
            ...paintedDrag,
            scrollReserve: previousReserve + correction,
          }, result.tree, null);
        });
        scroller.scrollTop = targetScrollTop;
        emitLog('scroll-reserve', {
          reason: 'horizontal-anchor-correction',
          previousReserve,
          nextReserve: paintedDrag.scrollReserve,
          added: correction,
          targetScrollTop,
          actualScrollTop: scroller.scrollTop,
        }, drag);
      }
    }

    const anchoredElement = sourceElement(scroller, drag.sourceId);
    const anchoredSourceTop = anchoredElement
      ? (followsSourceY(drag) ? layoutRect(anchoredElement) : anchoredElement.getBoundingClientRect()).top : sourceTopBefore;
    const scrollCompensation = (scroller?.scrollTop ?? 0) - scrollTopBefore;
    const prepared = prepareDrag(result.tree, drag.sourceId, { sourceRootIds: drag.sourceRootIds });
    const rebased = {
      ...paintedDrag,
      prepared,
      sourceNode: prepared.sourceNode,
      boundary: prepared.slot.boundary,
      slot: prepared.slot,
      preferredDepth: prepared.preferredDepth,
      resolvedDepth: prepared.preferredDepth,
      currentParentId: prepared.sourceLocation.parentId,
      grabOffsetY: followsSourceY(drag) ? drag.grabOffsetY : sourceTopBefore != null
        && anchoredSourceTop != null
        && Math.abs(anchoredSourceTop - sourceTopBefore) < 1
          ? drag.grabOffsetY
          : anchoredSourceTop == null
            ? drag.grabOffsetY
            : clientY - anchoredSourceTop,
      horizontalBaseX: clientX,
      horizontalBaseY: clientY,
      feedback: null,
      blockedDirection: null,
      axisLock: null,
      edge: null,
      scrollAnchorCeiling: Math.max(
        drag.scrollAnchorCeiling ?? 0,
        (scroller?.scrollTop ?? 0) > drag.naturalScrollMax
          ? scroller?.scrollTop ?? 0
          : 0,
      ),
      scrollCeiling: Math.max(drag.naturalScrollMax, scroller?.scrollTop ?? 0),
      suspendEdgeFrame: true,
      lastAnchor: sourceTopBefore == null || anchoredSourceTop == null
        ? null
        : {
            topBefore: sourceTopBefore,
            topAfter: anchoredSourceTop,
            scrollCompensation,
          },
    };
    rebased.pointerBoundary = calculateBoundary(rebased, clientY);
    emitLog('horizontal', {
      direction: result.reason === 'outdent' ? 'left' : 'right',
      reason: result.reason,
      fromDepth: drag.resolvedDepth,
      toDepth: prepared.preferredDepth,
      scrollCompensation,
    }, drag);
    return publish(rebased, result.tree, null);
  }, [calculateBoundary, emitLog, followsSourceY, layoutRect, measureNaturalScrollMax, publish]);

  const expansionPromises = useCallback((drag) => (
    drag?.expansionPromises ? [...drag.expansionPromises.values()] : []
  ), []);

  const restoreTemporaryExpansions = useCallback((drag) => {
    if (!drag?.expansionBaseline?.size) return;
    const callbacks = callbacksRef.current;
    const callback = expansionCallback(callbacks, 'drag-cancel');
    if (typeof callback !== 'function') return;

    const restore = () => {
      for (const [nodeId, expanded] of drag.expansionBaseline) {
        try {
          Promise.resolve(callback({
            nodeId,
            expanded,
            reason: 'drag-cancel',
          })).catch((error) => emitLog('expansion-error', {
            nodeId,
            reason: 'drag-cancel',
            error,
          }, drag));
        } catch (error) {
          emitLog('expansion-error', { nodeId, reason: 'drag-cancel', error }, drag);
        }
      }
    };

    const pending = expansionPromises(drag);
    if (pending.length === 0) restore();
    else Promise.allSettled(pending).then(restore);
  }, [emitLog, expansionPromises]);

  const cancel = useCallback((reason = 'programmatic') => {
    const drag = dragRef.current;
    if (!drag) return false;
    clearPendingPointerMove();
    commitTokenRef.current += 1;
    releasePointerCapture(drag);
    paintedPreviewRef.current = null;
    settledPreviewRef.current = null;

    if (drag.phase === 'pending') {
      publish(null, previewOutlineRef.current, scrollLeaseRef.current);
      emitLog('pending-cancel', { reason }, drag);
      return true;
    }

    if (drag.phase === 'committing' && drag.sourceRootIds) {
      // A released operation owns only its preview. Rejection/supersession
      // must expose current host data and preserve the user's newer scroll,
      // never restore a pickup outline after navigation or another writer.
      publish(null, controlledOutlineRef.current, scrollLeaseRef.current);
      emitLog('cancel', { reason }, drag);
      return true;
    }

    restoreTemporaryExpansions(drag);
    suppressClickRef.current = {
      sourceId: drag.sourceId,
      expiresAt: now() + 500,
    };
    flushSync(() => {
      publish(null, drag.originalOutline, drag.originalScrollLease);
    });
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = drag.originalScrollTop;
    emitLog('cancel', { reason }, drag);
    if(drag.externalReleaseOwner!=='bridge')emitDiagnostic('physical-end',{reason:'cancel:'+reason},drag);
    return true;
  }, [clearPendingPointerMove, emitLog, publish, restoreTemporaryExpansions]);

  const calculateCommitLease = useCallback((drag) => {
    const scroller = scrollerRef.current;
    if (!scroller) return drag.originalScrollLease ?? null;
    const physicalMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const measuredNaturalMax = measureNaturalScrollMax();
    const naturalMax = measuredNaturalMax ?? (physicalMax - drag.scrollReserve);
    return leaseForScrollPosition({ naturalMax, scrollTop: scroller.scrollTop });
  }, [measureNaturalScrollMax]);

  const beginCommit = useCallback((reason = 'pointerup') => {
    const pending = pointerMoveFrameRef.current, rendered = paintedPreviewRef.current;
    emitLog('release-preview', { reason, queued: pending.latest, framePending: !!pending.frameId,
      painted: rendered ? { revision: rendered.revision, x: rendered.drag.pointerX, y: rendered.drag.pointerY, slot: rendered.drag.slot } : null });
    clearPendingPointerMove();
    const current = dragRef.current;
    const painted = paintedPreviewRef.current;
    if (current && callbacksRef.current.validateDragSource?.(publicDragState(current, revisionRef.current)) === false) {
      cancel('source-admission-changed');
      return;
    }
    if (
      !current
      || current.phase !== 'dragging'
      || !painted
      || painted.sessionId !== current.sessionId
      || painted.ownerEpoch !== current.ownerEpoch
      || current.ownerEpoch !== ownerEpochRef.current
    ) {
      cancel('release-before-preview-paint');
      return;
    }

    const token = commitTokenRef.current + 1;
    commitTokenRef.current = token;
    const commitControlledOutline = controlledOutlineRef.current;
    const commitDrag = {
      ...painted.drag,
      phase: 'committing',
      feedback: null,
      edge: null,
      navigationDwell: null,
      externalReleasePending: false,
      commitControlledOutline,
    };
    releasePointerCapture(commitDrag);
    suppressClickRef.current = {
      sourceId: commitDrag.sourceId,
      expiresAt: now() + 500,
    };
    flushSync(() => {
      publish(commitDrag, painted.outline, null);
    });

    const payload = {
      sourceId: commitDrag.sourceId,
      sourceIds: commitDrag.sourceIds,
      sourceNode: commitDrag.prepared.sourceNode,
      sourceRootIds: commitDrag.sourceRootIds,
      sourceNodes: commitDrag.prepared.sourceNodes,
      sourceContext: commitDrag.sourceContext,
      ...(commitDrag.sourceRootIds ? {isCurrent:()=>commitTokenRef.current===token
        && dragRef.current?.sessionId===commitDrag.sessionId && dragRef.current?.phase==='committing'} : {}),
      originalOutline: commitDrag.originalOutline,
      previewOutline: painted.outline,
      sessionId: commitDrag.sessionId,
      reason,
      externalTarget: commitDrag.externalTarget ?? null,
    };

    let callbackResult;
    try {
      const callback = commitDrag.externalTarget != null
        ? callbacksRef.current.onExternalCommit
        : callbacksRef.current.onCommit;
      callbackResult = typeof callback === 'function'
        ? callback(payload)
        : commitDrag.externalTarget == null ? undefined : false;
    } catch (error) {
      emitLog('commit-error', { reason, error }, commitDrag);
      cancel('commit-error');
      return;
    }

    Promise.resolve(callbackResult).then((result) => {
      const active = dragRef.current;
      if (
        commitTokenRef.current !== token
        || active?.sessionId !== commitDrag.sessionId
        || active.phase !== 'committing'
      ) return;

      if (!isAcceptedCallbackResult(result)) {
        emitLog('commit-rejected', { reason }, commitDrag);
        cancel('commit-rejected');
        return;
      }

      const nextLease = calculateCommitLease(commitDrag);
      const latestControlledOutline = controlledOutlineRef.current;
      const hostAlreadyUpdated = latestControlledOutline !== commitControlledOutline;
      settledPreviewRef.current = hostAlreadyUpdated
        ? null
        : { controlledOutline: commitControlledOutline };
      paintedPreviewRef.current = null;
      flushSync(() => {
        publish(
          null,
          hostAlreadyUpdated ? latestControlledOutline : painted.outline,
          nextLease,
        );
      });

      const scroller = scrollerRef.current;
      if (scroller) {
        const physicalMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = nextLease?.ceiling ?? Math.min(scroller.scrollTop, physicalMax);
      }
      emitLog('scroll-lease', {
        reason: 'commit',
        reserve: commitDrag.scrollReserve,
        leaseHeight: nextLease?.height ?? 0,
        naturalMax: nextLease?.naturalMax ?? null,
        ceiling: nextLease?.ceiling ?? null,
        actualScrollTop: scroller?.scrollTop ?? null,
      }, commitDrag);
      emitLog('commit', {
        reason,
        externalTarget: commitDrag.externalTarget ?? null,
      }, commitDrag);
    }).catch((error) => {
      const active = dragRef.current;
      if (commitTokenRef.current !== token || active?.sessionId !== commitDrag.sessionId) return;
      emitLog('commit-error', { reason, error }, commitDrag);
      cancel('commit-error');
    });
  }, [calculateCommitLease, cancel, clearPendingPointerMove, emitLog, publish]);

  // A host can hand an already-running pointer gesture to the outline (for
  // example a terminal pane tab entering the project sidebar). The original
  // pointerdown happened outside our rows, so normal pointer capture cannot
  // start this session. Commit is therefore exposed as a narrow host signal;
  // it still obeys the same "painted preview before mutation" invariant.
  const commitExternalDrag = useCallback((reason = 'external-pointerup', finalInput) => {
    const current = dragRef.current;
    if (!current?.externalOwnerKey || current.phase !== 'dragging' || current.ownerEpoch !== ownerEpochRef.current) return false;
    if (finalInput && (finalInput.ownerKey !== current.externalOwnerKey || finalInput.pointerId !== current.pointerId)) return false;
    const sessionId = current.sessionId;
    const candidateRevision = current.renderRevision, candidateOutline = previewOutlineRef.current;
    const cancelToken = commitTokenRef.current, ownerEpoch = current.ownerEpoch;
    const commitWhenPainted = () => {
      const latest = dragRef.current;
      if (!latest || latest.sessionId !== sessionId || latest.phase !== 'dragging'
        || latest.ownerEpoch !== ownerEpoch || ownerEpochRef.current !== ownerEpoch
        || commitTokenRef.current !== cancelToken) return;
      const receipt = paintedPreviewRef.current;
      if (latest.externalReleasePending && (!receipt || receipt.revision !== candidateRevision
        || receipt.outline !== candidateOutline || receipt.ownerEpoch !== ownerEpoch)) {
        cancel('release-candidate-not-acknowledged');return;
      }
      beginCommit(reason);
    };
    const painted = paintedPreviewRef.current;
    if (painted?.sessionId === sessionId && painted.ownerEpoch === ownerEpoch) commitWhenPainted();
    else {
      clearPendingPointerMove();
      clearSourceFollow();
      // Latch the submitted candidate, not another publication with newer
      // coordinates. Released gestures no longer generate movement/dwell slots.
      dragRef.current = { ...current, externalReleasePending: Object.freeze({sessionId,
        gestureId:current.sourceContext?.gestureId ?? null,ownerKey:current.externalOwnerKey,ownerEpoch,
        pointerId:current.pointerId,candidateRevision,cancelToken,
        releasePoint:finalInput?.releasePoint ? Object.freeze({...finalInput.releasePoint}):null}) };
      requestAnimationFrame(commitWhenPainted);
    }
    return true;
  }, [beginCommit, cancel, clearPendingPointerMove, clearSourceFollow]);

  const requestExpansion = useCallback((nodeId, expanded, reason = 'pointer-toggle') => {
    const targetId = nodeId;
    const desired = !!expanded;
    const currentDrag = dragRef.current;
    const previousOutline = previewOutlineRef.current;
    const previousNode = findOutlineNode(previousOutline, targetId);
    if (!previousNode || previousNode.collapsible !== true) return Promise.resolve(false);

    const previousExpanded = previousNode.expanded !== false;
    if (previousExpanded === desired) return Promise.resolve(true);
    const patch = setOutlineExpanded(previousOutline, targetId, desired);
    if (!patch.changed) return Promise.resolve(false);

    let requestDrag = currentDrag;
    if (currentDrag && currentDrag.phase !== 'pending') {
      const expansionBaseline = new Map(currentDrag.expansionBaseline);
      if (!expansionBaseline.has(targetId)) {
        const baselineNode = findOutlineNode(currentDrag.originalOutline, targetId);
        expansionBaseline.set(targetId, baselineNode?.expanded !== false);
      }
      const expansionOverrides = new Map(currentDrag.expansionOverrides);
      expansionOverrides.set(targetId, desired);
      const pendingExpansionIds = new Set(currentDrag.pendingExpansionIds);
      pendingExpansionIds.add(targetId);
      requestDrag = {
        ...currentDrag,
        expansionBaseline,
        expansionOverrides,
        pendingExpansionIds,
        layoutChangeAxis: 'navigation',
      };
    }
    publish(requestDrag, patch.outline, scrollLeaseRef.current);

    const callbacks = callbacksRef.current;
    const callback = expansionCallback(callbacks, reason);
    const payload = { nodeId: targetId, expanded: desired, reason };
    let callbackResult;
    try {
      callbackResult = typeof callback === 'function' ? callback(payload) : undefined;
    } catch (error) {
      callbackResult = Promise.reject(error);
    }

    const request = Promise.resolve(callbackResult).then((result) => {
      const active = dragRef.current;
      const sameSession = requestDrag?.sessionId
        ? active?.sessionId === requestDrag.sessionId
        : !active;
      if (!sameSession) return isAcceptedCallbackResult(result);

      if (!isAcceptedCallbackResult(result)) {
        const rollback = setOutlineExpanded(previewOutlineRef.current, targetId, previousExpanded);
        if (rollback.changed) {
          if (active) {
            const overrides = new Map(active.expansionOverrides);
            overrides.set(targetId, previousExpanded);
            const pendingIds = new Set(active.pendingExpansionIds);
            pendingIds.delete(targetId);
            publish({
              ...active,
              expansionOverrides: overrides,
              pendingExpansionIds: pendingIds,
            }, rollback.outline, scrollLeaseRef.current);
          } else {
            publish(null, rollback.outline, scrollLeaseRef.current);
          }
        }
        emitLog('expansion-rejected', payload, requestDrag);
        return false;
      }

      if (active) {
        const pendingIds = new Set(active.pendingExpansionIds);
        pendingIds.delete(targetId);
        publish({ ...active, pendingExpansionIds: pendingIds }, undefined, undefined);
      }
      emitLog('expansion', payload, requestDrag);
      return true;
    }).catch((error) => {
      const active = dragRef.current;
      const sameSession = requestDrag?.sessionId
        ? active?.sessionId === requestDrag.sessionId
        : !active;
      if (sameSession) {
        const rollback = setOutlineExpanded(previewOutlineRef.current, targetId, previousExpanded);
        if (rollback.changed) {
          if (active) {
            const pendingIds = new Set(active.pendingExpansionIds);
            pendingIds.delete(targetId);
            const overrides = new Map(active.expansionOverrides);
            overrides.set(targetId, previousExpanded);
            publish({
              ...active,
              pendingExpansionIds: pendingIds,
              expansionOverrides: overrides,
            }, rollback.outline, scrollLeaseRef.current);
          } else {
            publish(null, rollback.outline, scrollLeaseRef.current);
          }
        }
      }
      emitLog('expansion-error', { ...payload, error }, requestDrag);
      return false;
    });

    if (requestDrag?.phase !== 'pending') {
      const active = dragRef.current;
      if (shouldTrackExpansionPromise(requestDrag, active)) {
        const promises = new Map(active.expansionPromises);
        promises.set(targetId, request);
        publish({ ...active, expansionPromises: promises }, undefined, undefined);
        request.finally(() => {
          const latest = dragRef.current;
          if (latest?.sessionId !== requestDrag.sessionId) return;
          const nextPromises = new Map(latest.expansionPromises);
          nextPromises.delete(targetId);
          publish({ ...latest, expansionPromises: nextPromises }, undefined, undefined);
        });
      }
    }
    return request;
  }, [emitLog, publish]);

  const resolveNavigationTarget = useCallback((drag) => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof document === 'undefined') return null;
    const element = document.elementFromPoint(drag.pointerX, drag.pointerY);
    const rowElement = element?.closest?.('[data-outline-dnd-row]');
    if (!rowElement || !scroller.contains(rowElement)) return null;

    const targetKey = rowElement.dataset.outlineDndKey;
    const targetRow = flattenVisible(previewOutlineRef.current)
      .find((row) => domNodeKey(row.id) === targetKey);
    if (!targetRow?.collapsible || !targetRow.hasChildren) return null;
    const targetId = targetRow.id;

    const sourceLocation = findNodeLocation(previewOutlineRef.current, drag.sourceId);
    const protectedIds = new Set([
      ...(sourceLocation?.ancestors || []),
      ...drag.sourceIds,
      ...(drag.sourceRootIds || []).flatMap(id => findNodeLocation(previewOutlineRef.current, id)?.ancestors || []),
    ]);
    return {
      targetId,
      blocked: protectedIds.has(targetId),
      pending: drag.pendingExpansionIds.has(targetId),
    };
  }, []);

  const enterNavigationMode = useCallback((inputDrag = dragRef.current) => {
    if (!inputDrag || inputDrag.phase !== 'dragging' || inputDrag.navigationMode) {
      return inputDrag;
    }
    const rect = scrollerRef.current?.getBoundingClientRect();
    const next = {
      ...inputDrag,
      navigationMode: true,
      navigationDwell: null,
      feedback: null,
      blockedDirection: null,
      axisLock: null,
      edge: null,
      edgeGesture: createEdgeGesture({
        clientY: inputDrag.pointerY,
        top: rect?.top ?? 0,
        bottom: rect?.bottom ?? 0,
        zoneSize: inputDrag.edgeZoneSize,
      }),
      horizontalBaseX: inputDrag.pointerX,
      horizontalBaseY: inputDrag.pointerY,
      layoutChangeAxis: 'navigation',
    };
    emitLog('navigation-start', {}, inputDrag);
    return publish(next, undefined, undefined);
  }, [emitLog, publish]);

  const exitNavigationMode = useCallback((inputDrag = dragRef.current) => {
    if (!inputDrag?.navigationMode || inputDrag.phase !== 'dragging') return inputDrag;
    const prepared = prepareDrag(previewOutlineRef.current, inputDrag.sourceId, { sourceRootIds: inputDrag.sourceRootIds });
    const rect = scrollerRef.current?.getBoundingClientRect();
    let next = {
      ...inputDrag,
      prepared,
      sourceNode: prepared.sourceNode,
      boundary: prepared.slot.boundary,
      pointerBoundary: null,
      slot: prepared.slot,
      resolvedDepth: prepared.preferredDepth,
      currentParentId: prepared.sourceLocation.parentId,
      navigationMode: false,
      navigationDwell: null,
      feedback: null,
      blockedDirection: null,
      axisLock: null,
      edge: null,
      edgeGesture: createEdgeGesture({
        clientY: inputDrag.pointerY,
        top: rect?.top ?? 0,
        bottom: rect?.bottom ?? 0,
        zoneSize: inputDrag.edgeZoneSize,
      }),
      horizontalBaseX: inputDrag.pointerX,
      horizontalBaseY: inputDrag.pointerY,
    };

    const inside = isPointInsideRect(inputDrag.pointerX, inputDrag.pointerY, rect);
    let nextOutline = previewOutlineRef.current;
    if (inside) {
      const projection = projectVertical(next, inputDrag.pointerY, 'navigation-release');
      next = projection.drag;
      nextOutline = projection.outline;
      next.horizontalBaseX = inputDrag.pointerX;
      next.horizontalBaseY = inputDrag.pointerY;
    }
    emitLog('navigation-end', { resolvedUnderPointer: inside }, inputDrag);
    return publish(next, nextOutline, undefined);
  }, [emitLog, projectVertical, publish]);

  const processActivePointerMove = useCallback((inputDrag, event) => {
    if (inputDrag.externalReleasePending || inputDrag.ownerEpoch !== ownerEpochRef.current
      || dragRef.current?.sessionId !== inputDrag.sessionId || dragRef.current?.phase !== 'dragging'
      || dragRef.current.externalReleasePending) return;
    pointerTraceRef.current.processed += 1;
    emitDiagnostic('processed',{eventAbs:Number.isFinite(event.timeStamp)?performance.timeOrigin+event.timeStamp:null,
      x:event.clientX,y:event.clientY,received:pointerTraceRef.current.received,
      processed:pointerTraceRef.current.processed,queuedOverwrites:pointerTraceRef.current.queuedOverwrites || 0},inputDrag);
    pointerTraceRef.current.lastProcessed = { x: event.clientX, y: event.clientY, metaKey: !!event.metaKey,
      heldMeta: metaKeyHeldRef.current, navigationMode: inputDrag.navigationMode,
      dx: event.clientX - inputDrag.horizontalBaseX, dy: event.clientY - inputDrag.horizontalBaseY };
    let current = inputDrag;
    const metaKey = !!(event.metaKey || metaKeyHeldRef.current);
    if (usesCommandHierarchy(configRef.current.hierarchyModifier) && current.hierarchyMode !== metaKey) {
      // The key can arrive before the queued pointer frame. Its physical
      // position is the new X origin, never the last painted position.
      current = rebaseHierarchyModifier({...current,pointerX:event.clientX,pointerY:event.clientY}, metaKey, configRef.current.hierarchyModifier);
    }
    const navigationMode = commandNavigationMode(configRef.current.hierarchyModifier,metaKey);
    if (navigationMode && !current.navigationMode) {
      current = enterNavigationMode(current);
    } else if (!navigationMode && current.navigationMode) {
      current = exitNavigationMode(current);
    }
    if (!current || current.phase !== 'dragging') return;

    let next = {
      ...current,
      pointerX: event.clientX,
      pointerY: event.clientY,
      diagnosticEventAbs: Number.isFinite(event.timeStamp)
        ? performance.timeOrigin + event.timeStamp : current.diagnosticEventAbs,
    };
    const treeRect = scrollerRef.current?.getBoundingClientRect();
    if (treeRect) {
      next.edgeGesture = updateEdgeGesture(current.edgeGesture, {
        clientY: event.clientY,
        top: treeRect.top,
        bottom: treeRect.bottom,
        zoneSize: current.edgeZoneSize,
        activationDistance: current.edgeActivationDistance,
      });
    }

    let externalTarget = null;
    const externalResolver = callbacksRef.current.resolveExternalTarget;
    if (typeof externalResolver === 'function') {
      try {
        externalTarget = resolvePointerExternalTarget({
          drag: current,
          event,
          previewOutline: previewOutlineRef.current,
          resolveExternalTarget: externalResolver,
        });
      } catch (error) {
        emitLog('external-target-error', { error }, current);
      }
    }
    if (externalTarget != null) {
      writeSourceFollow(next);
      const externalTargetKey = typeof externalTarget === 'object'
        ? String(externalTarget.id ?? externalTarget.zone ?? JSON.stringify(externalTarget))
        : String(externalTarget);
      next.externalTarget = externalTarget;
      next.externalTargetKey = externalTargetKey;
      next.navigationDwell = null;
      next.feedback = null;
      next.blockedDirection = null;
      next.axisLock = null;
      next.edge = null;
      next.edgeGesture = {
        ...next.edgeGesture,
        zone: null,
        active: false,
        anchorY: event.clientY,
      };
      next.horizontalBaseX = event.clientX;
      next.horizontalBaseY = event.clientY;
      next.layoutChangeAxis = 'external';
      if (current.externalTargetKey !== externalTargetKey) {
        emitLog('external-target', { target: externalTarget }, current);
      }
      publish(next, externalTarget.previewOutline, undefined);
      return;
    }
    if (current.externalTarget != null) {
      emitLog('external-target-leave', { target: current.externalTarget }, current);
      next.externalTarget = null;
      next.externalTargetKey = null;
      next.layoutChangeAxis = null;
    }

    if (current.navigationMode) {
      writeSourceFollow(next);
      next.feedback = null;
      next.blockedDirection = null;
      next.axisLock = null;
      next.horizontalBaseX = event.clientX;
      next.horizontalBaseY = event.clientY;
      publish(next, undefined, undefined);
      return;
    }

    const hoverTarget = usesCommandHierarchy(configRef.current.hierarchyModifier)
      ? resolveNavigationTarget(next) : null;
    // Hold the actual header from its first hit, including its near edge.
    // A partial interior band lets slow Y steps swap it away before dwell.
    // Moving past the header resumes the ordinary before/after slot resolver.
    const folderHoverTargetId = hoverTarget && !hoverTarget.blocked ? hoverTarget.targetId : null;
    if (folderHoverTargetId != null && current.folderHoverTargetId !== folderHoverTargetId) {
      current = {...current,horizontalBaseX:event.clientX,horizontalBaseY:event.clientY,axisLock:null};
      next = {...next,horizontalBaseX:event.clientX,horizontalBaseY:event.clientY,axisLock:null};
    }
    next.folderHoverTargetId = folderHoverTargetId;
    const measurement = measureBoundary(next, event.clientY);
    const boundary = measurement.boundary;
    const verticalDistance = Math.abs(event.clientY - current.horizontalBaseY);
    const isVerticalMove = boundary !== current.pointerBoundary
      || verticalDistance >= current.verticalRebaseDistance;
    if (isVerticalMove && folderHoverTargetId == null) {
      const projection = projectVertical(next, event.clientY, 'pointer', measurement);
      projection.drag.horizontalBaseX = event.clientX;
      projection.drag.horizontalBaseY = event.clientY;
      publish(projection.drag, projection.outline, undefined);
      return;
    }

    if (usesCommandHierarchy(configRef.current.hierarchyModifier) && !metaKey) {
      // Plain motion still owns Y and external targets, but accumulated X is
      // not a deferred hierarchy command when the modifier is pressed later.
      publish({...next,feedback:null,blockedDirection:null,axisLock:null,
        horizontalBaseX:event.clientX,horizontalBaseY:event.clientY},undefined,undefined,{
          inside: measurement.diagnostic?.mode === 'geometry' && measurement.rect
            && event.clientX >= measurement.rect.left && event.clientX <= measurement.rect.right
            && event.clientY >= measurement.rect.top && event.clientY <= measurement.rect.bottom,
        });
      return;
    }

    const isInsideTreeWidth = treeRect
      && event.clientX >= treeRect.left
      && event.clientX <= treeRect.right;
    const canContinueInHorizontalCorridor = !isInsideTreeWidth
      && isPointInsideGestureRegion(
        event.clientX,
        event.clientY,
        treeRect,
        configRef.current.outsidePointerPolicy,
      );
    if (!isInsideTreeWidth && !canContinueInHorizontalCorridor) {
      next.feedback = null;
      next.blockedDirection = null;
      next.axisLock = null;
      next.horizontalBaseX = event.clientX;
      next.horizontalBaseY = event.clientY;
      publish(next, undefined, undefined);
      return;
    }

    const horizontalDistance = Math.abs(event.clientX - current.horizontalBaseX);
    const canUseHorizontalAxis = current.axisLock === 'horizontal'
      || (
        horizontalDistance >= current.horizontalPreviewStart
        && verticalDistance <= current.horizontalYTolerance
      );
    if (!canUseHorizontalAxis) {
      next.feedback = null;
      next.blockedDirection = null;
      next.axisLock = null;
      publish(next, undefined, undefined);
      return;
    }
    next.axisLock = 'horizontal';

    const intent = horizontalIntent({
      clientX: event.clientX,
      baseX: current.horizontalBaseX,
      threshold: current.horizontalThreshold,
      previewStart: current.horizontalPreviewStart,
    });
    if (!intent.direction) {
      next.feedback = null;
      next.blockedDirection = null;
      publish(next, undefined, undefined);
      return;
    }

    const horizontalSourceId = current.sourceRootIds?.[0] ?? current.sourceId;
    const result = current.sourceRootIds?.length > 1
      ? { ok: false, reason: 'multi-selection', tree: previewOutlineRef.current }
      : intent.direction === 'right'
        ? indentNode(previewOutlineRef.current, horizontalSourceId)
        : outdentNode(previewOutlineRef.current, horizontalSourceId);
    let policy = { ok: true, reason: null };
    if (result.ok && typeof callbacksRef.current.canHorizontalMove === 'function') {
      try {
        policy = resolveHorizontalMovePolicy(callbacksRef.current.canHorizontalMove({
          direction: intent.direction,
          sourceId: current.sourceId,
          sourceNode: current.prepared.sourceNodes?.[0] ?? current.sourceNode,
          sourceRootIds: current.sourceRootIds,
          sourceContext: current.sourceContext,
          currentOutline: previewOutlineRef.current,
          proposedOutline: result.tree,
          result,
        }));
      } catch (error) {
        policy = { ok: false, reason: 'host-policy-error' };
        emitLog('horizontal-policy-error', {
          direction: intent.direction,
          error,
        }, current);
      }
    }
    const blocked = !result.ok || !policy.ok;
    const blockedReason = result.ok ? policy.reason : result.reason;
    next.feedback = {
      direction: intent.direction,
      progress: intent.progress,
      blocked,
      reason: blocked ? blockedReason : null,
    };
    if (blocked) {
      if (current.blockedDirection !== intent.direction) {
        emitLog('horizontal-blocked', {
          direction: intent.direction,
          reason: blockedReason,
        }, current);
      }
      next.blockedDirection = intent.direction;
      publish(next, undefined, undefined);
      return;
    }
    next.blockedDirection = null;
    if (!intent.crossed) {
      publish(next, undefined, undefined);
      return;
    }

    rebaseAfterHorizontalMove(next, result, event.clientX, event.clientY);
  }, [
    measureBoundary,
    emitLog,
    enterNavigationMode,
    exitNavigationMode,
    projectVertical,
    publish,
    rebaseAfterHorizontalMove,
    resolveNavigationTarget,
    writeSourceFollow,
  ]);

  const scheduleActivePointerMove = useCallback((event) => {
    const pending = pointerMoveFrameRef.current;
    pointerTraceRef.current.queuedOverwrites=Math.min(0xffffffff,(pointerTraceRef.current.queuedOverwrites || 0)+Number(!!pending.latest));
    pending.latest = {
      pointerId: event.pointerId,
      timeStamp: event.timeStamp,
      clientX: event.clientX,
      clientY: event.clientY,
      metaKey: !!(event.metaKey || metaKeyHeldRef.current),
    };
    if (pending.frameId) return;

    const sessionId = dragRef.current?.sessionId, ownerEpoch = ownerEpochRef.current;
    const frameId = requestAnimationFrame(() => {
      if (pending.frameId !== frameId || ownerEpochRef.current !== ownerEpoch
        || dragRef.current?.sessionId !== sessionId) return;
      pending.frameId = 0;
      const latest = pending.latest;
      pending.latest = null;
      const current = dragRef.current;
      if (
        !latest
        || !current
        || current.phase !== 'dragging'
        || current.pointerId !== latest.pointerId
      ) return;
      processActivePointerMove(current, latest);
    });
    pending.frameId = frameId;
  }, [processActivePointerMove]);

  const activatePendingDrag = useCallback((pending, event) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      cancel('missing-scroller');
      return null;
    }

    const pickupOutline = previewOutlineRef.current;
    const rowRect = pending.captureElement?.getBoundingClientRect();
    const grabOffsetY = pending.startY - (rowRect?.top ?? pending.rowTop);
    const descriptor = pending.externalSource || callbacksRef.current.getDragSource?.({
      outline: pickupOutline, sourceId: pending.sourceId, sessionId: pending.sessionId,
      pointerId:pending.pointerId,clientX:event.clientX,clientY:event.clientY,metaKey:!!event.metaKey,grabOffsetY,
    });
    if (descriptor === false) { cancel('source-admission-rejected'); return null; }
    const prepared = prepareDrag(pickupOutline, pending.sourceId, { sourceRootIds: descriptor?.rootIds });
    const sourceIds = prepared.sourceIds || getSubtreeIds(prepared.sourceNode);
    const originalOutline = pending.rollbackOutline || pickupOutline;
    const scrollerRect = scroller.getBoundingClientRect();
    const originalLease = scrollLeaseRef.current;
    const naturalScrollMax = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight - (originalLease?.height ?? 0),
    );
    const measuredRowHeight = configRef.current.rowHeight
      ?? rowRect?.height
      ?? pending.rowHeight
      ?? ROW_HEIGHT;
    const heldMeta = !!(event.metaKey || pending.metaKey || metaKeyHeldRef.current);
    const navigationMode = !usesCommandHierarchy(configRef.current.hierarchyModifier) && heldMeta;
    const next = {
      ...pending,
      phase: 'dragging',
      ownerEpoch: ownerEpochRef.current,
      sourceIds,
      sourceRootIds: prepared.sourceRootIds,
      sourceContext: descriptor?.context,
      externalOwnerKey:pending.externalOwnerKey || descriptor?.releaseOwnerKey,
      externalReleaseOwner:pending.externalReleaseOwner || (descriptor?.releaseOwnerKey ? 'bridge':undefined),
      sourceNode: prepared.sourceNode,
      originalOutline,
      originalScrollTop: scroller.scrollTop,
      originalScrollLease: originalLease,
      controlledOutlineAtStart: controlledOutlineRef.current,
      lastControlledOutline: controlledOutlineRef.current,
      scrollReserve: originalLease?.height ?? 0,
      naturalScrollMax,
      scrollCeiling: Math.max(naturalScrollMax, scroller.scrollTop),
      prepared,
      boundary: prepared.slot.boundary,
      pointerBoundary: prepared.slot.boundary,
      slot: prepared.slot,
      preferredDepth: prepared.preferredDepth,
      resolvedDepth: prepared.preferredDepth,
      currentParentId: prepared.sourceLocation.parentId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      grabOffsetY,
      rowHeight: measuredRowHeight,
      horizontalBaseX: pending.startX,
      horizontalBaseY: pending.startY,
      horizontalThreshold: configRef.current.horizontalThreshold,
      horizontalPreviewStart: configRef.current.horizontalPreviewStart,
      horizontalYTolerance: configRef.current.horizontalYTolerance,
      verticalRebaseDistance: configRef.current.verticalRebaseDistance,
      edgeZoneSize: configRef.current.edgeZoneSize,
      edgeScrollStep: configRef.current.edgeScrollStep,
      edgeActivationDistance: configRef.current.edgeActivationDistance,
      folderDwellInterval: configRef.current.folderDwellInterval,
      feedback: null,
      blockedDirection: null,
      axisLock: null,
      edge: null,
      edgeGesture: createEdgeGesture({
        clientY: pending.startY,
        top: scrollerRect.top,
        bottom: scrollerRect.bottom,
        zoneSize: configRef.current.edgeZoneSize,
      }),
      suspendEdgeFrame: false,
      lastAnchor: null,
      navigationMode,
      hierarchyMode: usesCommandHierarchy(configRef.current.hierarchyModifier) && heldMeta,
      navigationDwell: null,
      scrollAnchorCeiling: scroller.scrollTop > naturalScrollMax
        ? scroller.scrollTop
        : 0,
      expansionBaseline: new Map(),
      expansionOverrides: new Map(),
      pendingExpansionIds: new Set(),
      expansionPromises: new Map(),
      layoutChangeAxis: null,
      externalTarget: null,
      externalTargetKey: null,
    };

    event.preventDefault();
    acquirePointerCapture(next);
    emitDiagnostic('capture-attempt',{},next);
    lastBoundaryMeasurementRef.current = null;
    pointerTraceRef.current = { received: 1, processed: 0,
      lastReceived: { x: event.clientX, y: event.clientY, pointerId: event.pointerId, metaKey: !!event.metaKey }, lastProcessed: null };
    settledPreviewRef.current = null;
    let active;
    flushSync(() => {
      active = publish(next, pickupOutline, null);
    });
    emitLog('start', {
      boundary: active.boundary,
      depth: active.preferredDepth,
      navigationMode,
      scrollReserve: active.scrollReserve,
      naturalScrollMax: active.naturalScrollMax,
    }, active);
    return active;
  }, [cancel, emitLog, publish]);

  const handlePointerDown = useCallback((event, sourceId) => {
    const config = configRef.current;
    if (config.disabled || event.button !== 0) return;
    if (
      config.ignoreSelector
      && event.target !== event.currentTarget
      && event.target?.closest?.(config.ignoreSelector)
    ) return;
    if (dragRef.current?.phase === 'committing' && dragRef.current.sourceRootIds) cancel('new-pointer');
    if (dragRef.current) return;

    const location = findNodeLocation(previewOutlineRef.current, sourceId);
    if (!location) return;
    const rowRect = event.currentTarget.getBoundingClientRect();
    const sessionId = String(config.createSessionId());
    const pending = {
      phase: 'pending',
      sessionId,
      sourceId,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      diagnosticEventAbs:performance.timeOrigin+event.timeStamp,
      rowTop: rowRect.top,
      captureElement: event.currentTarget,
      metaKey: !!event.metaKey,
    };

    publish(pending, undefined, undefined);
    emitLog('pending', {}, pending);
    emitDiagnostic('pickup-rect',{left:rowRect.left,top:rowRect.top,width:rowRect.width,height:rowRect.height},pending);
  }, [cancel, emitLog, publish]);



  useEffect(() => {
    assertValidOutline(controlledOutline);
    const current = dragRef.current;
    if (current?.externalReleasePending) {
      if (callbacksRef.current.validateDragSource?.(publicDragState(current, revisionRef.current)) === false)
        cancel('source-admission-changed');
      return;
    }
    if (!current) {
      const settled = settledPreviewRef.current;
      if (settled?.controlledOutline === controlledOutline) return;
      settledPreviewRef.current = null;
      if (previewOutlineRef.current !== controlledOutline) {
        publish(null, controlledOutline, undefined);
      }
      return;
    }

    if (current.phase === 'pending') {
      if (previewOutlineRef.current !== controlledOutline) {
        publish({ ...current }, controlledOutline, undefined);
      }
      return;
    }
    if (current.phase !== 'dragging' || current.lastControlledOutline === controlledOutline) return;

    const controlledSource = findOutlineNode(controlledOutline, current.sourceId);
    // A host navigation can replace the whole outline owner while preserving
    // the same pointer gesture (project A sidebar → project B sidebar). Merging
    // would retain every row from A and append every row from B. The projected
    // source explicitly marks this ownership boundary, so B becomes the new
    // baseline and the source node is the only bridge between the two worlds.
    const replacesOwner = controlledSource?.externalDragReplacement === true;
    const merged = replacesOwner
      ? controlledOutline
      : mergeControlledOutline(
          previewOutlineRef.current,
          controlledOutline,
          current.expansionOverrides,
        );
    assertValidOutline(merged);
    if (callbacksRef.current.validateDragSource?.(publicDragState(current, revisionRef.current)) === false) {
      cancel('source-admission-changed');
      return;
    }
    const prepared = prepareDrag(merged, current.sourceId, { sourceRootIds: current.sourceRootIds });
    if (current.sourceRootIds && (prepared.sourceIds.length !== current.sourceIds.length
      || prepared.sourceIds.some(id => !current.sourceIds.includes(id)))) {
      cancel('source-forest-changed');
      return;
    }
    const next = {
      ...current,
      lastControlledOutline: controlledOutline,
      prepared,
      sourceNode: prepared.sourceNode,
      sourceIds: prepared.sourceIds || getSubtreeIds(prepared.sourceNode),
      ...(replacesOwner ? {
        originalOutline: controlledOutline,
        controlledOutlineAtStart: controlledOutline,
        expansionBaseline: new Map(),
        expansionOverrides: new Map(),
        pendingExpansionIds: new Set(),
        expansionPromises: new Map(),
      } : {}),
      boundary: prepared.slot.boundary,
      slot: prepared.slot,
      resolvedDepth: prepared.sourceLocation.depth,
      currentParentId: prepared.sourceLocation.parentId,
      layoutChangeAxis: 'external',
    };
    publish(next, merged, undefined);
  }, [controlledOutline, publish, cancel]);

  const previousScopeRef = useRef(scopeKey);
  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return;
    previousScopeRef.current = scopeKey;
    cancel('host-scope-changed');
    publish(null, controlledOutlineRef.current, null);
  }, [scopeKey, cancel, publish]);

  // Adopt a drag that began in another host without faking a pointerdown on a
  // sidebar row. The host temporarily projects the source node into `outline`;
  // from this point onward the regular pointer, Cmd-navigation, autoscroll,
  // FLIP preview and commit paths are used unchanged.
  useEffect(() => {
    const requested = externalDrag && externalDrag.active !== false ? externalDrag : null;
    // activatePendingDrag/cancel use flushSync to preserve the pointer contract.
    // Run them after the current React lifecycle; calling flushSync directly
    // from this effect produces a warning and can leave the adopted drag stuck.
    let cancelled = false;
    const ownerEpoch = ownerEpochRef.current;
    const frame = requestAnimationFrame(() => {
      if (cancelled || ownerEpochRef.current !== ownerEpoch) return;
      const current = dragRef.current;
      if (!requested) {
        if (
          current?.externalOwnerKey
          && current.phase !== 'committing'
          && !current.externalReleasePending
        ) cancel('external-drag-left-host');
        return;
      }

      const ownerKey = String(requested.ownerKey || '');
      const sourceId = requested.sourceId;
      if (!ownerKey || sourceId == null) return;
      let input=requested;
      if(typeof requested.readCurrentInput === 'function') {
        try { input=requested.readCurrentInput(); } catch { input=null; }
        if(!input?.active || input.ownerKey!==ownerKey || input.gestureId!==requested.gestureId
          || input.pointerId!==requested.pointerId) {
          if(current?.externalOwnerKey===ownerKey && !current.externalReleasePending)cancel('external-input-ended');
          return;
        }
      }
      const clientX = Number(input.clientX) || 0;
      const clientY = Number(input.clientY) || 0;
      const pointerId = Number.isFinite(Number(input.pointerId))
        ? Number(input.pointerId)
        : 1;
      const event = {
        pointerId,
        clientX,
        clientY,
        metaKey: input.metaKey === true,
        preventDefault() {},
      };

      if (current) {
        if (current.externalOwnerKey === ownerKey) {
          if (usesCommandHierarchy(configRef.current.hierarchyModifier)) {
            if (current.phase === 'dragging' && !current.externalReleasePending && current.hierarchyMode !== (input.metaKey === true))
              processActivePointerMove(current,{...event,clientX:current.pointerX,clientY:current.pointerY});
            return;
          }
          if (current.phase !== 'dragging' || current.externalReleasePending || current.navigationMode === (input.metaKey === true)) return;
          const changed = input.metaKey === true
            ? enterNavigationMode(current)
            : exitNavigationMode(current);
          if (changed) processActivePointerMove(changed, event);
          return;
        }
        const releasedForest = current.phase === 'committing' && current.sourceRootIds;
        if (!releasedForest && (!current.externalOwnerKey || current.phase === 'committing')) return;
        cancel('external-drag-owner-change');
      }

      const outlineNow = previewOutlineRef.current;
      if (!findNodeLocation(outlineNow, sourceId)) return;
      // Wait until the projected source row has participated in one render. Its
      // geometry is needed by the shared boundary resolver, even though pointer
      // capture itself remains owned by the original host.
      const sourceRow=sourceElement(scrollerRef.current, sourceId);
      if (!sourceRow) return;

      const rowHeight = configRef.current.rowHeight || sourceRow.getBoundingClientRect().height || ROW_HEIGHT;
      const pending = {
        phase: 'pending',
        sessionId: String(configRef.current.createSessionId()),
        sourceId,
        pointerId,
        pointerType: requested.pointerType || 'mouse',
        startX: clientX,
        startY: clientY,
        pointerX: clientX,
        pointerY: clientY,
        // Keep a sidebar-origin grab across hosts. Pane-origin adoption retains
        // its existing centre-grab feedback; never capture a foreign element.
        rowTop: clientY - (Number.isFinite(requested.grabOffsetY) ? requested.grabOffsetY : rowHeight / 2),
        rowHeight,
        captureElement: null,
        metaKey: input.metaKey === true,
        externalOwnerKey: ownerKey,
        externalReleaseOwner:requested.releaseOwner,
        externalSource: requested.sourceRootIds ? { rootIds: requested.sourceRootIds, context: requested.sourceContext } : undefined,
        rollbackOutline: requested.rollbackOutline,
      };
      const active = activatePendingDrag(pending, event);
      if (!active) return;
      processActivePointerMove(active, event);
      emitLog('external-adopt', { ownerKey }, active);
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [
    activatePendingDrag,
    cancel,
    emitLog,
    enterNavigationMode,
    externalDrag,
    exitNavigationMode,
    processActivePointerMove,
    view.revision,
  ]);

  useEffect(() => {
    const handlePointerMove = (event) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;

      if (current.phase === 'pending') {
        const nextPending = {
          ...current,
          pointerX: event.clientX,
          pointerY: event.clientY,
          metaKey: !!event.metaKey,
        };
        const distance = Math.hypot(
          event.clientX - current.startX,
          event.clientY - current.startY,
        );
        if (distance < configRef.current.pointerThreshold) {
          publish(nextPending, undefined, undefined);
          return;
        }

        emitDiagnostic('threshold',{eventAbs:performance.timeOrigin+event.timeStamp,x:event.clientX,y:event.clientY},nextPending);
        const active = activatePendingDrag(nextPending, event);
        if (active) processActivePointerMove(active, event);
        return;
      }

      if (current.phase !== 'dragging') return;
      pointerTraceRef.current.received += 1;
      pointerTraceRef.current.lastReceived = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, metaKey: !!event.metaKey };
      event.preventDefault();
      scheduleActivePointerMove(event);
    };

    const handlePointerUp = (event) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      clearPendingPointerMove();
      if (current.phase === 'pending') {
        releasePointerCapture(current);
        publish(null, undefined, undefined);
        emitLog('click-release', {}, current);
        return;
      }
      if (current.phase !== 'dragging') return;
      if (current.externalReleaseOwner === 'bridge') return; // Explicit transport-owned release; legacy hosts retain their default.
      const rect = scrollerRef.current?.getBoundingClientRect();
      if (
        current.externalTarget == null
        && !isPointInsideGestureRegion(
          event.clientX,
          event.clientY,
          rect,
          configRef.current.outsidePointerPolicy,
        )
      ) {
        cancel('pointerup-outside');
        return;
      }
      beginCommit('pointerup');
      emitDiagnostic('physical-end',{reason:'release'},current);
    };

    const handlePointerCancel = (event) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      cancel('pointercancel');
    };

    const handleKeyDown = (event) => {
      const current = dragRef.current;
      if (!current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel('escape');
        return;
      }
      if (event.key !== 'Meta' || event.repeat) return;
      metaKeyHeldRef.current = true;
      const pendingPoint = pointerMoveFrameRef.current.latest;
      clearPendingPointerMove();
      if (current.phase === 'pending') {
        publish({ ...current, metaKey: true }, undefined, undefined);
        return;
      }
      if (current.phase === 'dragging') {
        event.preventDefault();
        if (usesCommandHierarchy(configRef.current.hierarchyModifier)) {
          processActivePointerMove(current,{pointerId:current.pointerId,clientX:pendingPoint?.clientX ?? current.pointerX,clientY:pendingPoint?.clientY ?? current.pointerY,metaKey:true});
          return;
        }
        const entered = enterNavigationMode(current);
        if (entered) {
          processActivePointerMove(entered, {
            pointerId: entered.pointerId,
            clientX: entered.pointerX,
            clientY: entered.pointerY,
            metaKey: true,
          });
        }
      }
    };

    const handleKeyUp = (event) => {
      if (event.key !== 'Meta') return;
      metaKeyHeldRef.current = false;
      const pendingPoint = pointerMoveFrameRef.current.latest;
      clearPendingPointerMove();
      const current = dragRef.current;
      if (current?.phase === 'pending') {
        publish({ ...current, metaKey: false }, undefined, undefined);
      } else if (current?.phase === 'dragging' && usesCommandHierarchy(configRef.current.hierarchyModifier)) {
        event.preventDefault();
        processActivePointerMove(current,{pointerId:current.pointerId,clientX:pendingPoint?.clientX ?? current.pointerX,clientY:pendingPoint?.clientY ?? current.pointerY,metaKey:false});
      } else if (current?.phase === 'dragging' && current.navigationMode) {
        event.preventDefault();
        const exited = exitNavigationMode(current);
        if (exited) {
          processActivePointerMove(exited, {
            pointerId: exited.pointerId,
            clientX: exited.pointerX,
            clientY: exited.pointerY,
            metaKey: false,
          });
        }
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    const handleWindowBlur = () => {
      metaKeyHeldRef.current = false;
      if (dragRef.current?.sourceRootIds) cancel('blur');
    };
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      metaKeyHeldRef.current = false;
      clearPendingPointerMove();
    };
  }, [
    activatePendingDrag,
    beginCommit,
    cancel,
    clearPendingPointerMove,
    emitLog,
    enterNavigationMode,
    exitNavigationMode,
    processActivePointerMove,
    publish,
    scheduleActivePointerMove,
  ]);

  useEffect(() => {
    if (view.dragState?.phase !== 'dragging') return undefined;
    let frameId = 0, cancelled = false;
    const sessionId = view.dragState.sessionId, ownerEpoch = ownerEpochRef.current;

    const tick = (timestamp) => {
      let current = dragRef.current;
      if (cancelled || current?.sessionId !== sessionId || current?.ownerEpoch !== ownerEpoch
        || ownerEpochRef.current !== ownerEpoch) return;
      const scroller = scrollerRef.current;
      if (!current || current.phase !== 'dragging' || current.externalReleasePending || !scroller) return;
      // A host target owns dwell/navigation outside this outline. Its pointer
      // handler has already stopped edge scroll. Reading geometry and
      // publishing an identical null folder dwell here woke the entire host
      // every frame while the pointer was held still over a workflow/project.
      if (current.externalTarget != null) {
        frameId = requestAnimationFrame(tick);
        return;
      }
      const rect = scroller.getBoundingClientRect();

      if (current.suspendEdgeFrame) {
        publish({ ...current, edge: null, suspendEdgeFrame: false }, undefined, undefined);
        frameId = requestAnimationFrame(tick);
        return;
      }

      const physicalMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const naturalScrollMax = Math.max(0, physicalMax - current.scrollReserve);
      const scrollCeiling = Math.max(naturalScrollMax, current.scrollAnchorCeiling ?? 0);
      if (
        current.naturalScrollMax !== naturalScrollMax
        || current.scrollCeiling !== scrollCeiling
      ) {
        current = { ...current, naturalScrollMax, scrollCeiling };
      }
      if (scroller.scrollTop > scrollCeiling) scroller.scrollTop = scrollCeiling;

      const insideWidth = current.pointerX >= rect.left && current.pointerX <= rect.right;
      const requestedVelocity = edgeScrollVelocity({
        clientY: current.pointerY,
        top: rect.top,
        bottom: rect.bottom,
        zoneSize: current.edgeZoneSize,
        maxStep: current.edgeScrollStep,
      });
      const gestureMatches = current.edgeGesture?.active && (
        (current.edgeGesture.zone === 'top' && requestedVelocity < 0)
        || (current.edgeGesture.zone === 'bottom' && requestedVelocity > 0)
      );
      const velocity = insideWidth && gestureMatches ? requestedVelocity : 0;
      const previousScrollTop = scroller.scrollTop;
      const maxScrollTop = Math.min(physicalMax, scrollCeiling);
      const canScroll = velocity < 0
        ? previousScrollTop > 0
        : velocity > 0
          ? previousScrollTop < maxScrollTop
          : false;
      const edge = canScroll ? (velocity < 0 ? 'top' : 'bottom') : null;
      if (canScroll) scroller.scrollTop += velocity;
      const didScroll = scroller.scrollTop !== previousScrollTop;

      let next = dragRef.current;
      let nextOutline = previewOutlineRef.current;
      if (!next || next.phase !== 'dragging') return;
      if (
        next.naturalScrollMax !== naturalScrollMax
        || next.scrollCeiling !== scrollCeiling
      ) {
        next = { ...next, naturalScrollMax, scrollCeiling };
      }
      if (next.edge !== edge || didScroll) {
        next = { ...next, edge };
        const hoverTarget = usesCommandHierarchy(configRef.current.hierarchyModifier) ? resolveNavigationTarget(next) : null;
        if (didScroll && !next.navigationMode && (!hoverTarget || hoverTarget.blocked)) {
          const projection = projectVertical(next, next.pointerY, 'scroll');
          next = projection.drag;
          nextOutline = projection.outline;
          next.horizontalBaseX = next.pointerX;
          next.horizontalBaseY = next.pointerY;
        } else if (didScroll) refreshSourceFollow(next);
      }

      let toggle = null;
      if (usesFolderHover(configRef.current.hierarchyModifier, next)) {
        const target = resolveNavigationTarget(next);
        const dwellResult = advanceFolderDwell(next.navigationDwell, {
          targetId: target?.targetId ?? null,
          blocked: target?.blocked ?? false,
          pending: target?.pending ?? false,
          now: timestamp,
          interval: next.folderDwellInterval,
        });
        if (next.navigationDwell !== dwellResult.dwell) {
          next = { ...next, navigationDwell: dwellResult.dwell };
        }
        if (dwellResult.shouldToggle && target && !target.blocked && !target.pending) {
          const targetNode = findOutlineNode(nextOutline, target.targetId);
          if (
            targetNode?.collapsible === true
            && (targetNode.hasChildren === true || targetNode.children?.length)
          ) {
            toggle = {
              nodeId: target.targetId,
              expanded: targetNode.expanded === false,
            };
          }
        }
      }

      if (next !== dragRef.current || nextOutline !== previewOutlineRef.current) {
        publish(next, nextOutline, undefined);
      }
      if (toggle) requestExpansion(toggle.nodeId, toggle.expanded,
        usesCommandHierarchy(configRef.current.hierarchyModifier) ? 'hover-dwell' : 'cmd-dwell');
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(frameId); };
  }, [
    projectVertical,
    publish,
    refreshSourceFollow,
    requestExpansion,
    resolveNavigationTarget,
    view.dragState?.phase,
    view.dragState?.sessionId,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;

    const handleScroll = () => {
      if (followsSourceY(dragRef.current)) refreshSourceFollow(dragRef.current);
      const lease = scrollLeaseRef.current;
      if (!lease || dragRef.current) return;
      const nextLease = leaseForScrollPosition({
        naturalMax: lease.naturalMax,
        scrollTop: scroller.scrollTop,
        ceiling: lease.ceiling,
      });
      if (nextLease && Math.abs(nextLease.height - lease.height) < 0.5) {
        if (scroller.scrollTop > nextLease.ceiling) scroller.scrollTop = nextLease.ceiling;
        return;
      }
      flushSync(() => publish(null, undefined, nextLease));
      if (nextLease) scroller.scrollTop = Math.min(scroller.scrollTop, nextLease.ceiling);
      emitLog('scroll-lease', {
        reason: nextLease ? 'user-scroll' : 'released',
        previousHeight: lease.height,
        leaseHeight: nextLease?.height ?? 0,
        naturalMax: lease.naturalMax,
        ceiling: nextLease?.ceiling ?? null,
        actualScrollTop: scroller.scrollTop,
      });
    };

    const clearLease = () => {
      if (!scrollLeaseRef.current || dragRef.current) return;
      publish(null, undefined, null);
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(scroller.scrollTop, max);
    };

    scroller.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', clearLease);
    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', clearLease);
    };
  }, [emitLog, followsSourceY, publish, refreshSourceFollow]);

  const rows = useMemo(() => {
    assertValidOutline(view.previewOutline);
    return flattenVisible(view.previewOutline);
  }, [view.previewOutline]);
  rowsRef.current = rows;

  const sourceIdSet = useMemo(
    () => new Set(view.dragState?.sourceIds || []),
    [view.dragState?.sourceIds],
  );
  const visibleSourceIds = useMemo(
    () => rows.filter((row) => sourceIdSet.has(row.id)).map((row) => row.id),
    [rows, sourceIdSet],
  );
  const navigationProtectedIds = useMemo(() => {
    if (!view.dragState?.sourceId) return new Set();
    const location = findNodeLocation(view.previewOutline, view.dragState.sourceId);
    return new Set([
      ...(location?.ancestors || []),
      ...(view.dragState.sourceIds || []),
      ...(view.dragState.sourceRootIds || []).flatMap(id => findNodeLocation(view.previewOutline, id)?.ancestors || []),
    ]);
  }, [view.dragState?.sourceId, view.dragState?.sourceIds, view.previewOutline]);

  const rowLayoutSignature = useMemo(
    () => JSON.stringify(rows.map((row) => [domNodeKey(row.id), row.depth])),
    [rows],
  );

  const rowRefFor = useCallback((rowId) => {
    const key = domNodeKey(rowId);
    const epoch = ownerEpochRef.current;
    let binding = rowRefCallbacksRef.current.get(key);
    if (!binding || binding.epoch !== epoch) {
      let bound = null;
      const callback = (element) => {
        if (ownerEpochRef.current !== epoch) return;
        const state = sourceFollowRef.current, entry = state?.rows.get(key);
        if (entry?.element === bound && bound !== element) {
          restoreSourceRow(entry); state.rows.delete(key);
        }
        if (element) rowElementsRef.current.set(key, element);
        else if (rowElementsRef.current.get(key) === bound) rowElementsRef.current.delete(key);
        bound = element;
        if (state) state.dirty = true;
      };
      binding = { epoch, callback };
      rowRefCallbacksRef.current.set(key, binding);
    }
    return binding.callback;
  }, [restoreSourceRow]);

  useLayoutEffect(() => {
    const frameStartedAt = now();
    const scroller = scrollerRef.current;
    const animationConfig = configRef.current.layoutAnimation;
    if (!scroller) return undefined;

    const pendingFirst = pendingLayoutFirstRef.current;
    const hasPendingLayout = pendingFirst?.revision === view.revision
      && pendingFirst.outline === view.previewOutline;
    const hasCapturedFirst = hasPendingLayout && pendingFirst.rects?.size > 0;
    const previousSnapshot = hasPendingLayout
      ? pendingFirst
      : rowLayoutSnapshotRef.current;
    if (pendingFirst && pendingFirst.revision <= view.revision) {
      pendingLayoutFirstRef.current = null;
    }

    const activeAnimations = rowLayoutAnimationsRef.current;
    const follow = sourceFollowRef.current;
    const sourceKeys = followsSourceY(dragRef.current)
      ? new Set((dragRef.current.sourceIds || []).map(domNodeKey)) : new Set();
    const finishSourceFollow = (rects) => {
      if (!followsSourceY(dragRef.current)) clearSourceFollow();
      else if (follow && (follow.dirty || follow.outline !== view.previewOutline))
        refreshSourceFollow(dragRef.current, rects);
    };
    const animationFor = (entry) => entry?.animation || entry;
    const cancelAnimationKeys = (keys) => {
      const currentTimes = [];
      let count = 0;
      for (const key of new Set(keys)) {
        const entry = activeAnimations.get(key);
        if (!entry) continue;
        const animation = animationFor(entry);
        const currentTime = Number(animation?.currentTime);
        if (Number.isFinite(currentTime)) currentTimes.push(currentTime);
        if (animation) {
          animation.onfinish = null;
          animation.cancel();
        }
        activeAnimations.delete(key);
        count += 1;
      }
      return { count, currentTimes };
    };
    const cancelActiveAnimations = (reason) => {
      if (activeAnimations.size === 0) return 0;
      const batch = rowLayoutAnimationBatchRef.current;
      const result = cancelAnimationKeys(activeAnimations.keys());
      if (batch) batch.closed = true;
      rowLayoutAnimationBatchRef.current = null;
      emitLog('layout-animation-cancel', {
        reason,
        rows: result.count,
        batchRevision: batch?.revision ?? null,
        elapsedMs: batch ? now() - batch.startedAt : null,
        maxCurrentTime: result.currentTimes.length
          ? Math.max(...result.currentTimes)
          : null,
      });
      return result.count;
    };
    const renderedRows = rows.map((row) => ({ id: row.id, depth: row.depth }));
    const layoutChanged = previousSnapshot.signature != null
      && previousSnapshot.signature !== rowLayoutSignature;
    const modeCancelReason = layoutAnimationCancelReason({
      dragging: view.dragState?.phase === 'dragging',
      navigationMode: view.dragState?.navigationMode === true,
      layoutChangeAxis: view.dragState?.layoutChangeAxis ?? null,
    });

    // The real source owns continuous Y. Its existing semantic X animation
    // remains independent; neighbouring rows keep their ordinary FLIP budget.
    cancelAnimationKeys([...sourceKeys].filter(key => activeAnimations.has(key)
      && activeAnimations.get(key).axis !== 'horizontal'));

    if (!layoutChanged) {
      if (modeCancelReason) cancelActiveAnimations(modeCancelReason);
      if (view.dragState?.phase !== 'dragging') {
        rowLayoutLastChangeAtRef.current = -Infinity;
      }
      // Pointer-only / owner-switch revisions update the semantic snapshot
      // without consulting layout. `scrollTop` is a geometry read: after a
      // large React commit it forced Blink to update the whole sidebar style
      // tree even though no row moved (21-24ms per read on the small workflow
      // fixture). A real layout change reads the current value below, at the
      // same boundary where FLIP already needs geometry.
      rowLayoutSnapshotRef.current = {
        scrollTop: previousSnapshot.scrollTop ?? 0,
        rows: renderedRows,
        signature: rowLayoutSignature,
      };
      finishSourceFollow();
      return undefined;
    }

    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const motionPreferenceAllowsAnimation = allowsLayoutAnimationForMotionPreference(
      animationConfig,
      reducedMotion,
    );
    const supportsAnimation = typeof Element !== 'undefined'
      && typeof Element.prototype.animate === 'function';
    const fallbackChangedKeys = changedOutlineLayoutKeys(
      previousSnapshot.rows || [],
      renderedRows,
      (row) => domNodeKey(row.id),
    );
    const changedKeys = hasPendingLayout && pendingFirst.changedKeys
      ? pendingFirst.changedKeys
      : fallbackChangedKeys;
    const visibleKeys = new Set(renderedRows.map((row) => domNodeKey(row.id)));
    const changedVisibleKeys = hasPendingLayout && pendingFirst.changedVisibleKeys
      ? pendingFirst.changedVisibleKeys
      : new Set([...changedKeys].filter((key) => visibleKeys.has(key)));

    let skippedReason = hasPendingLayout ? pendingFirst.skipReason : null;
    if (!skippedReason && !animationConfig.enabled) skippedReason = 'disabled';
    else if (!skippedReason && animationConfig.duration <= 0) skippedReason = 'zero-duration';
    else if (!skippedReason && modeCancelReason) skippedReason = modeCancelReason;
    else if (!skippedReason && !motionPreferenceAllowsAnimation) skippedReason = 'reduced-motion';
    else if (!skippedReason && !supportsAnimation) skippedReason = 'unsupported';
    else if (!skippedReason && !hasCapturedFirst) skippedReason = 'missing-first-rects';

    if (skippedReason) {
      const canceledAnimations = cancelActiveAnimations(skippedReason);
      if (view.dragState?.phase === 'dragging') {
        emitLog('layout-animation', {
          axis: view.dragState?.layoutChangeAxis ?? null,
          origin: pendingFirst?.origin ?? view.dragState?.edgeOrigin ?? null,
          revision: view.revision,
          changedRows: changedVisibleKeys.size,
          sourceRows: pendingFirst?.sourceRows ?? view.dragState?.sourceIds?.length ?? 1,
          projectedActiveRows: pendingFirst?.projectedActiveRows ?? null,
          preservedAnimations: 0,
          retargetedAnimations: 0,
          createdAnimations: 0,
          activeAnimations: 0,
          canceledAnimations,
          animatedRows: 0,
          maxDeltaY: 0,
          skippedReason,
          elapsedSinceLayoutChange: pendingFirst?.elapsedSinceLayoutChange ?? null,
          frameCostMs: now() - frameStartedAt,
          enabled: animationConfig.enabled,
          reducedMotion: !!reducedMotion,
          respectReducedMotion: animationConfig.respectReducedMotion,
          motionSuppressed: !motionPreferenceAllowsAnimation,
        });
      }
      // A host/project replacement changes row identity but has no captured
      // FIRST rectangles, so no FLIP can run. Keep the semantic snapshot and
      // skip `scrollTop`: reading it here forced the freshly replaced sidebar
      // style tree even though this branch immediately exits.
      rowLayoutSnapshotRef.current = {
        scrollTop: previousSnapshot.scrollTop ?? 0,
        rows: renderedRows,
        signature: rowLayoutSignature,
      };
      if (view.dragState?.phase !== 'dragging') {
        rowLayoutLastChangeAtRef.current = -Infinity;
      }
      finishSourceFollow();
      return undefined;
    }

    const nextSnapshot = {
      scrollTop: scroller.scrollTop,
      rows: renderedRows,
      signature: rowLayoutSignature,
    };

    const removedAnimationKeys = [...activeAnimations.keys()]
      .filter((key) => !visibleKeys.has(key));
    cancelAnimationKeys(removedAnimationKeys);
    const retargetAnimationKeys = [...changedVisibleKeys]
      .filter((key) => activeAnimations.has(key));
    const retargetedAnimations = cancelAnimationKeys(retargetAnimationKeys).count;
    const preservedAnimations = activeAnimations.size;

    const afterRects = new Map();
    for (const key of changedVisibleKeys) {
      const element = rowElementsRef.current.get(key);
      if (element) afterRects.set(key, layoutRect(element));
    }

    const layoutChangeAxis = view.dragState?.layoutChangeAxis ?? null;
    let createdAnimations = 0;
    let maxDeltaX = 0;
    let maxDeltaY = 0;
    for (const [key, after] of afterRects) {
      const before = pendingFirst.rects.get(key);
      const element = rowElementsRef.current.get(key);
      if (!before || !element) continue;
      const delta = layoutFlipDelta({
        beforeLeft: before.left,
        beforeTop: before.top,
        afterLeft: after.left,
        afterTop: after.top,
        beforeScrollTop: pendingFirst.scrollTop,
        afterScrollTop: nextSnapshot.scrollTop,
      });
      const ownedDelta = axisOwnedLayoutDelta(layoutChangeAxis, delta);
      const deltaX = ownedDelta.x;
      const deltaY = sourceKeys.has(key) ? 0 : ownedDelta.y;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      createdAnimations += 1;
      maxDeltaX = Math.max(maxDeltaX, Math.abs(deltaX));
      maxDeltaY = Math.max(maxDeltaY, Math.abs(deltaY));

      const animation = element.animate([
        { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ], {
        duration: animationConfig.duration,
        easing: animationConfig.easing,
        fill: 'both',
      });
      activeAnimations.set(key, { animation, revision: view.revision, axis: layoutChangeAxis });
      animation.onfinish = () => {
        const entry = activeAnimations.get(key);
        if (animationFor(entry) !== animation) return;
        activeAnimations.delete(key);
        animation.onfinish = null;
        animation.cancel();
        if (activeAnimations.size > 0) return;

        const batch = rowLayoutAnimationBatchRef.current;
        if (!batch || batch.closed) return;
        batch.closed = true;
        rowLayoutAnimationBatchRef.current = null;
        emitLog('layout-animation-finish', {
          revision: batch.revision,
          rows: batch.createdAnimations,
          retargetedRows: batch.retargetedAnimations,
          peakRows: batch.peakRows,
          elapsedMs: now() - batch.startedAt,
        });
      };
    }

    if (activeAnimations.size > 0) {
      let batch = rowLayoutAnimationBatchRef.current;
      if (
        !batch
        || batch.closed
        || !Number.isFinite(batch.createdAnimations)
        || !Number.isFinite(batch.retargetedAnimations)
        || !Number.isFinite(batch.peakRows)
      ) {
        batch = {
          revision: view.revision,
          startedAt: now(),
          createdAnimations: 0,
          retargetedAnimations: 0,
          peakRows: 0,
          closed: false,
        };
        rowLayoutAnimationBatchRef.current = batch;
      }
      batch.revision = view.revision;
      batch.createdAnimations += createdAnimations;
      batch.retargetedAnimations += retargetedAnimations;
      batch.peakRows = Math.max(batch.peakRows, activeAnimations.size);
    } else {
      const batch = rowLayoutAnimationBatchRef.current;
      if (batch && !batch.closed) batch.closed = true;
      rowLayoutAnimationBatchRef.current = null;
    }

    if (view.dragState?.phase === 'dragging') {
      emitLog('layout-animation', {
        axis: layoutChangeAxis,
        origin: pendingFirst.origin ?? view.dragState?.edgeOrigin ?? null,
        retargeted: retargetedAnimations > 0,
        revision: view.revision,
        changedRows: changedVisibleKeys.size,
        sourceRows: pendingFirst.sourceRows ?? view.dragState?.sourceIds?.length ?? 1,
        projectedActiveRows: pendingFirst.projectedActiveRows ?? null,
        preservedAnimations,
        retargetedAnimations,
        createdAnimations,
        activeAnimations: activeAnimations.size,
        animatedRows: createdAnimations,
        maxDeltaX,
        maxDeltaY,
        skippedReason: null,
        elapsedSinceLayoutChange: pendingFirst.elapsedSinceLayoutChange ?? null,
        frameCostMs: now() - frameStartedAt,
        enabled: animationConfig.enabled,
        reducedMotion: !!reducedMotion,
        respectReducedMotion: animationConfig.respectReducedMotion,
        motionSuppressed: !motionPreferenceAllowsAnimation,
      });
    }

    rowLayoutSnapshotRef.current = nextSnapshot;
    finishSourceFollow(afterRects);
    return undefined;
  }, [
    clearSourceFollow,
    emitLog,
    followsSourceY,
    layoutRect,
    refreshSourceFollow,
    rowLayoutSignature,
    rows,
    view.dragState?.layoutChangeAxis,
    view.dragState?.navigationMode,
    view.dragState?.phase,
    view.revision,
  ]);

  // Ref replacement can occur in a host commit with identical row IDs/view
  // revision. Run the cheap binding check on that commit too, before paint.
  useLayoutEffect(() => {
    if (!followsSourceY(dragRef.current)) clearSourceFollow();
    else if (sourceFollowRef.current?.dirty) refreshSourceFollow(dragRef.current);
  });

  // Acknowledges this React commit after FLIP/source-style writes, not compositor pixels.
  useLayoutEffect(() => {
    const current = dragRef.current;
    if (
      current?.phase === 'dragging'
      && current.renderRevision === view.revision
      && view.dragState?.sessionId === current.sessionId
    ) {
      paintedPreviewRef.current = {
        sessionId: current.sessionId,
        revision: view.revision,
        ownerEpoch: current.ownerEpoch,
        outline: view.previewOutline,
        drag: current,
      };
      emitDiagnostic('layout-receipt',{presentation:'semantic-outline-row'},current);
    }
  }, [view]);

  useEffect(() => () => {
    clearSourceFollow();
    if(dragRef.current?.sourceRootIds) {
      commitTokenRef.current+=1;
      releasePointerCapture(dragRef.current);
      dragRef.current=null;
      clearPendingPointerMove();
    }
    const batch = rowLayoutAnimationBatchRef.current;
    if (batch) batch.closed = true;
    rowLayoutAnimationBatchRef.current = null;
    for (const entry of rowLayoutAnimationsRef.current.values()) {
      const animation = entry?.animation || entry;
      if (animation) {
        animation.onfinish = null;
        animation.cancel();
      }
    }
    rowLayoutAnimationsRef.current.clear();
    rowElementsRef.current.clear();
    rowRefCallbacksRef.current.clear();
  }, []);

  const suppressOrToggleClick = useCallback((event, row) => {
    const suppression = suppressClickRef.current;
    if (suppression && suppression.expiresAt >= now() && event.detail !== 0) {
      suppressClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (suppression) suppressClickRef.current = null;

    const insideIgnoredControl = event.target !== event.currentTarget
      && !!event.target?.closest?.(configRef.current.ignoreSelector);
    if (!shouldToggleFolderRowClick({
      collapsible: row?.collapsible,
      hasChildren: row?.hasChildren,
      defaultPrevented: event.defaultPrevented,
      insideIgnoredControl,
    })) return;

    const desired = nextFolderRowExpansion(previewOutlineRef.current, row.id);
    if (desired != null) requestExpansion(row.id, desired, 'pointer-toggle');
  }, [requestExpansion]);

  const getRowProps = useCallback((rowOrId) => {
    const row = rowOrId && typeof rowOrId === 'object'
      ? rowOrId
      : rowsRef.current.find((candidate) => candidate.id === rowOrId);
    if (!row?.id) throw new TypeError('getRowProps requires a visible row or row id');

    const sourceStartId = visibleSourceIds[0] ?? null;
    const sourceEndId = visibleSourceIds.at(-1) ?? null;
    const isSource = sourceIdSet.has(row.id);
    const isSourceStart = row.id === sourceStartId;
    const isSourceEnd = row.id === sourceEndId;
    const dwell = view.dragState?.navigationDwell;
    const isNavigationTarget = dwell?.targetId === row.id;
    const feedback = isSourceStart ? view.dragState?.feedback : null;

    return {
      ref: rowRefFor(row.id),
      // Host row style must merge this object (e.g. its semantic marginLeft).
      style: isSource && followsSourceY(dragRef.current)
        ? { translate: '0 var(--outline-dnd-source-y, 0px)', pointerEvents: 'none', zIndex: 1 } : undefined,
      draggable: false,
      'data-outline-dnd-row': 'true',
      'data-outline-hierarchy-modifier': usesCommandHierarchy(configRef.current.hierarchyModifier) ? 'meta' : undefined,
      'data-outline-dnd-key': domNodeKey(row.id),
      'data-node-id': String(row.id),
      'data-parent-id': row.parentId ?? 'root',
      'data-depth': row.depth,
      'data-outline-dnd-source': isSource ? 'true' : undefined,
      'data-outline-dnd-source-start': isSourceStart ? 'true' : undefined,
      'data-outline-dnd-source-end': isSourceEnd ? 'true' : undefined,
      'data-outline-dnd-navigation-mode': view.dragState?.navigationMode ? 'true' : undefined,
      'data-outline-dnd-navigation-protected': navigationProtectedIds.has(row.id) ? 'true' : undefined,
      'data-outline-dnd-navigation-target': isNavigationTarget ? 'true' : undefined,
      'data-outline-dnd-navigation-pending': isNavigationTarget && dwell?.pending ? 'true' : undefined,
      'data-outline-dnd-feedback': feedback?.direction,
      'data-outline-dnd-feedback-blocked': feedback?.blocked ? 'true' : undefined,
      'aria-grabbed': isSource ? true : undefined,
      // Suppress only the click produced by the completed drag. A new press
      // (including on an ignored metadata control) owns a new user action.
      onPointerDownCapture: () => { suppressClickRef.current = null; },
      onPointerDown: (event) => handlePointerDown(event, row.id),
      onDragStart: (event) => event.preventDefault(),
      onClickCapture: (event) => suppressOrToggleClick(event, row),
    };
  }, [
    followsSourceY,
    handlePointerDown,
    navigationProtectedIds,
    rowRefFor,
    sourceIdSet,
    suppressOrToggleClick,
    view.dragState?.feedback,
    view.dragState?.navigationDwell,
    view.dragState?.navigationMode,
    visibleSourceIds,
  ]);

  const scrollReserve = view.dragState && view.dragState.phase !== 'pending'
    ? view.dragState.scrollReserve
    : 0;
  const spacerHeight = scrollReserve || view.scrollLease?.height || 0;
  const scrollSpacerProps = useMemo(() => ({
    ref: (element) => {
      scrollSpacerElementRef.current = element;
    },
    'aria-hidden': true,
    'data-outline-dnd-scroll-space': scrollReserve
      ? 'reserve'
      : view.scrollLease
        ? 'lease'
        : undefined,
    style: {
      height: `${spacerHeight}px`,
      minHeight: `${spacerHeight}px`,
      flex: '0 0 auto',
      pointerEvents: 'none',
    },
  }), [scrollReserve, spacerHeight, view.scrollLease]);

  const getDragSnapshot = useCallback(() => {
    const current=dragRef.current,painted=paintedPreviewRef.current;
    return Object.freeze({ownerEpoch:ownerEpochRef.current,
      current:readonlyDragSnapshot(current,current ? publicDragState(current,revisionRef.current):null),
      painted:painted ? Object.freeze({sessionId:painted.sessionId,ownerEpoch:painted.ownerEpoch,
        ownerKey:painted.drag.externalOwnerKey ?? null,pointerId:painted.drag.pointerId,
        gestureId:painted.drag.sourceContext?.gestureId ?? null,revision:painted.revision,
        drag:readonlyDragSnapshot(painted.drag,publicDragState(painted.drag,painted.revision))}):null});
  }, []);

  return {
    previewOutline: view.previewOutline,
    rows,
    dragState: view.dragState,
    scrollerRef,
    getRowProps,
    requestExpansion,
    scrollReserve,
    scrollLease: view.scrollLease,
    scrollSpacerProps,
    cancel,
    commitExternalDrag,
    getDragSnapshot,
  };
}
