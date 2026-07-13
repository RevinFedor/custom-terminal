import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { normalizeSelectedVisualRootIds, snapRect } from '@noted/structured-dnd';
import { flattenTree } from './treeUtils';
import FileIcon from './FileIcon';
import FileRow from './FileRow';
import ScrollHints from './ScrollHints';
import {
  ROOT_PARENT,
  applySidebarLayout,
  normalizeSidebarLayout,
  pathParentKey,
  sameSidebarLayout,
} from './sidebarLayout';

const EDGE_THRESHOLD_PX = 5;
const SCROLL_HINT_THRESHOLD_PX = 120;
const DRAG_AUTOSCROLL_MAX_STEP_PX = 8;
const DRAG_AUTOSCROLL_MIN_INTERVAL_MS = 16;
const DRAG_END_FALLBACK_DELAY_MS = 180;
const POST_DROP_REVEAL_DURATION_MS = 110;
const POST_DROP_REVEAL_MARGIN_PX = 24;
const POST_DROP_REVEAL_FOLDER_PEEK_ROWS = 3;
const DRAG_FOLDER_AUTO_EXPAND_MS = 500;
const DRAG_MOVE_Y_BUCKET_PX = 8;
const DRAG_MOVE_SCROLL_BUCKET_PX = 8;
const DRAG_VISUAL_ATTACH_THRESHOLD_PX = 32;
const DRAG_VISUAL_DETACH_THRESHOLD_PX = 32;
const DRAG_HORIZONTAL_REPEAT_THRESHOLD_PX = 56;
const MAX_VISUAL_HIERARCHY_DEPTH = 4;
const FLIP_MIN_TRANSLATE_LIMIT_PX = 240;
const DND_LOG_PREFIX = '[SidebarDnd]';
const SCROLL_LOG_PREFIX = '[SidebarScroll]';

const rowKey = (id) => `file:${id}`;

const shortPath = (path) => {
  if (!path) return '-';
  const parts = String(path).split('/');
  return parts.slice(-2).join('/');
};

const cloneLayout = (layout) => ({
  orderByParent: { ...(layout?.orderByParent || {}) },
  visualParentByPath: { ...(layout?.visualParentByPath || {}) },
});

const summarizeLayout = (layout) => {
  const normalized = normalizeSidebarLayout(layout);
  return `orderParents=${Object.keys(normalized.orderByParent).length}` +
    ` visualParents=${Object.keys(normalized.visualParentByPath).length}`;
};

const sameOrder = (a = [], b = []) => a.length === b.length && a.every((value, index) => value === b[index]);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const isHorizontalVisualAction = (detail) => /^(attach|detach|outdent)-visual-parent$/.test(detail || '');
const isVisualParentAction = (detail) => /^(attach|detach|outdent)-visual-parent$|^move-visual-child(-root)?$/.test(detail || '');

const readRowLayoutRect = (element, compensateFlip = false) => {
  const rect = snapRect(element, { compensateTransform: compensateFlip });
  return {
    top: rect.top,
    bottom: rect.bottom,
    mid: rect.midY,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    translateX: rect.translateX,
    translateY: rect.translateY,
  };
};

const waitForTwoAnimationFrames = () => new Promise(resolve => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

const formatIdList = (ids, limit = 8) => {
  if (!ids || ids.length === 0) return '-';
  const list = Array.from(ids);
  const visible = list.slice(0, limit).map(shortPath).join(',');
  return list.length > limit ? `${visible},+${list.length - limit}` : visible;
};

const formatRect = (rect) => {
  if (!rect) return '-';
  return `${Math.round(rect.top)}..${Math.round(rect.bottom)} mid=${Math.round(rect.mid ?? ((rect.top + rect.bottom) / 2))}`;
};

const formatActionLog = (action) => {
  if (!action) return 'action=none';
  const sourceIds = Array.isArray(action.sourceIds)
    ? action.sourceIds.map(shortPath).join(',')
    : '-';
  const sourceParents = Array.isArray(action.sourceParentKeys)
    ? action.sourceParentKeys.map(shortPath).join(',')
    : '-';
  const base =
    `mode=${action.mode || '-'} detail=${action.detail}` +
    ` kind=${action.kind || '-'}` +
    ` sourceKind=${action.sourceKind || '-'}` +
    ` targetKind=${action.targetKind || '-'}` +
    ` targetSource=${action.targetSource || '-'}` +
    ` targetScrollDelta=${action.targetScrollDelta == null ? '-' : Math.round(action.targetScrollDelta)}` +
    ` target=${action.targetName || shortPath(action.targetId)}` +
    ` visualParent=${shortPath(action.visualParentId)}` +
    ` attachParent=${shortPath(action.visualAttachParentId)}` +
    ` blockHint=${formatIdList(action.verticalBlockHintIds)}` +
    ` blockReason=${action.verticalBlockHintReason || '-'}` +
    ` blockRoot=${shortPath(action.verticalBlockHintRootId)}` +
    ` verticalLimit=${action.verticalLimitDirection || '-'}` +
    ` limitReason=${action.verticalLimitReason || '-'}` +
    ` limitPreserve=${action.verticalLimitPreservePreview == null ? '-' : (action.verticalLimitPreservePreview ? 1 : 0)}` +
    ` blockBoundary=${action.verticalBlockBoundaryDirection || '-'}` +
    ` blockCrossed=${action.verticalBlockBoundaryCrossed == null ? '-' : (action.verticalBlockBoundaryCrossed ? 1 : 0)}` +
    ` boundarySide=${action.verticalBlockBoundarySide || '-'}` +
    ` boundaryThreshold=${action.verticalBlockBoundaryThresholdY == null ? '-' : Math.round(action.verticalBlockBoundaryThresholdY)}` +
    ` activeBoundary=${action.verticalActiveBoundary == null ? '-' : (action.verticalActiveBoundary ? 1 : 0)}` +
    ` boundaryPhase=${action.verticalBlockBoundaryPhase || '-'}` +
    ` visualDepth=${action.sourceVisualDepth == null ? '-' : action.sourceVisualDepth}` +
    ` targetVisualDepth=${action.targetVisualDepth == null ? '-' : action.targetVisualDepth}` +
    ` sourceVisualParent=${shortPath(action.sourceVisualParentId)}` +
    ` targetVisualParent=${shortPath(action.targetVisualParentId)}` +
    ` verticalParent=${shortPath(action.verticalParentCandidateId)}` +
    ` verticalParentReason=${action.verticalParentCandidateReason || '-'}` +
    ` visualRepair=${formatIdList(action.visualParentRepairIds)}` +
    ` repairReason=${action.visualParentRepairReason || '-'}` +
    ` canLeft=${action.visualCanLeft == null ? '-' : (action.visualCanLeft ? 1 : 0)}` +
    ` canRight=${action.visualCanRight == null ? '-' : (action.visualCanRight ? 1 : 0)}` +
    ` repeat=${action.visualRepeatPendingDirection || '-'}` +
    ` threshold=${action.visualIntentThresholdPx || '-'}` +
    ` blocked=${action.visualBlockedDirection || '-'}` +
    ` parent=${shortPath(action.targetParentKey)}` +
    ` hoverParent=${shortPath(action.hoveredParentKey)}` +
    ` sourceParent=${shortPath(action.sourceParentKey)}` +
    ` sourceParents=${sourceParents}` +
    ` edge=${action.edge}` +
    ` rawX=${action.rawX == null ? '-' : action.rawX}` +
    ` baseX=${action.horizontalBaseX == null ? '-' : action.horizontalBaseX}` +
    ` deltaX=${action.deltaX == null ? '-' : action.deltaX}` +
    ` rawY=${action.rawY}` +
    ` effectiveY=${action.effectiveY}` +
    ` sourceIds=${sourceIds}` +
    ` canVirtual=${action.canVirtualLayout ? 1 : 0}` +
    ` orderChanged=${action.orderChanged == null ? '-' : (action.orderChanged ? 1 : 0)}` +
    ` boundaryClamp=${action.boundaryClamp ? 1 : 0}` +
    ` insertIndex=${action.insertIndex == null ? '-' : action.insertIndex}`;
  if (action.kind === 'layout') {
    return `${base} layout=${summarizeLayout(action.layout)}`;
  }
  return `${base} dest=${shortPath(action.destinationFolder)}`;
};

const previewActionKey = (action) => {
  if (!action) return '';
  if (action.kind === 'layout') {
    return JSON.stringify({
      kind: action.kind,
      mode: action.mode,
      detail: action.detail,
      parent: action.targetParentKey,
      layout: normalizeSidebarLayout(action.layout),
    });
  }
  return JSON.stringify({
    kind: action.kind,
    mode: action.mode,
    detail: action.detail,
    destinationFolder: action.destinationFolder,
    overFolderId: action.overFolderId,
    isRoot: !!action.isRoot,
  });
};

const formatMoveResults = (results) => {
  if (!Array.isArray(results)) return '-';
  return results.map(r => {
    const status = r.success
      ? 'ok'
      : (r.skipped ? `skip:${r.reason || 'unknown'}` : `fail:${r.reason || 'unknown'}`);
    return `${shortPath(r.sourcePath)}:${status}`;
  }).join(',');
};

const successfulMoveTargets = (results) => (
  Array.isArray(results)
    ? results.filter(r => r?.success && !r?.skipped && r?.newPath).map(r => r.newPath)
    : []
);

const PragmaticFileTree = ({
  treeData, // Raw recursive tree data
  folderPath, // Root path
  onFileSelect,
  activeFilePath,
  customIcons,
  iconTheme,
  settings,
  onContextMenu,
  onRename, // Callback to notify parent of moves if needed
  onExternalFilesDrop, // Finder/native file drops: copy dropped paths into target dir
  onToggle, // Prop from parent to load children (legacy/data loading)
  onExpandChange, // Sync expanded state with parent
  initialExpanded = {},
  editingId,
  onCommitRename,
  onCancelRename,
  onStartRename,
  sidebarFocused,
  focusedId,
  multiSelected = new Set(),
  indexedFolders = new Set(),
  indexPresets = {},
  onChangeIndexPresets,
  sortMode = 'name-asc',
  onRevealLink,
  onRemoveLink,
  projects = [],
  sidebarLayout,
  onApplySidebarLayout,
  onMoveItems,
  fileApi = typeof window !== 'undefined' ? window.electronAPI : null,
  IndexButtonComponent = null,
  onOpenProjectFile,
  // Scroll persistence: parent owns the per-directory scrollTop map (survives
  // this component's unmount/remount on dir-switch). We report scroll up via
  // onScrollChange and restore from initialScrollTop on (re)mount.
  initialScrollTop = 0,
  onScrollChange
}) => {
  const [expandedIds, setExpandedIds] = useState(initialExpanded);
  const containerRef = useRef(null);
  // Guards the active-file auto-reveal so it doesn't fight scroll-restore.
  // The reveal effect's FIRST run is the mount commit (which is exactly a
  // dir-switch remount) — there we honor the restored scroll and skip reveal.
  // Subsequent activeFilePath changes (user opens a file in the same dir) reveal
  // normally. A ref (not the restore useLayoutEffect's flag) is required because
  // useLayoutEffect runs BEFORE useEffect on the same commit, so any flag it set
  // would already be "done" by the time the reveal effect first runs.
  const revealArmedRef = useRef(false);
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;
  const [isRootOver, setIsRootOver] = useState(false);
  const [overFolderId, setOverFolderId] = useState(null);
  const [isDraggingGlobal, setIsDraggingGlobal] = useState(false);
  const [suppressTreeDropTargets, setSuppressTreeDropTargets] = useState(false);
  const [dragPreviewLayout, setDragPreviewLayout] = useState(null);
  const [dragPinnedSource, setDragPinnedSource] = useState(null);
  const [dragHorizontalIntent, setDragHorizontalIntent] = useState(null);
  const [dragVerticalBlockHint, setDragVerticalBlockHint] = useState(null);
  const [dragVerticalLimitHint, setDragVerticalLimitHint] = useState(null);
  const [dragSourceBlock, setDragSourceBlock] = useState(null);
  const [dragFolderModeActive, setDragFolderModeActive] = useState(false);
  const [dragFolderSpringState, setDragFolderSpringState] = useState(null);
  const [scrollHintEdge, setScrollHintEdge] = useState(null);
  const [dropConfirmedIds, setDropConfirmedIds] = useState(() => new Set());
  const dragPreviewLayoutRef = useRef(null);
  const visibleNodesRef = useRef([]);
  const expandedIdsRef = useRef(expandedIds);
  const dragGeometryRef = useRef(null);
  const dragAnchorRef = useRef(null);
  const dragSourceDataRef = useRef(null);
  const dragLastModifiersRef = useRef({ metaKey: false });
  const dragPreviewKeyRef = useRef('');
  const dragSessionRef = useRef(null);
  const dragSessionSeqRef = useRef(0);
  const dragMoveLogKeyRef = useRef('');
  const dragRejectLogKeyRef = useRef('');
  const dragScrollLogKeyRef = useRef('');
  const dragAutoscrollLogKeyRef = useRef('');
  const dragWheelLogKeyRef = useRef('');
  const dragWheelSkipLogKeyRef = useRef('');
  const dragAutoscrollFrameRef = useRef(null);
  const dragAutoscrollLastStepAtRef = useRef(0);
  const dragGeometryRefreshSeqRef = useRef(0);
  const dragGeometryRefreshAppliedSeqRef = useRef(0);
  const dragGeometryRefreshReasonRef = useRef(null);
  const dragLastResolvedActionRef = useRef(null);
  const dragLastBoundaryPreviewRef = useRef(null);
  const dragLastLayoutPreviewRef = useRef(null);
  const dragLastVisualParentPreviewRef = useRef(null);
  const dragLastResolveSnapshotRef = useRef(null);
  const dragPhysicalEndRef = useRef(null);
  const dragPhysicalEndLogKeyRef = useRef('');
  const dragNativeEventLogKeyRef = useRef('');
  const dragNativeEventLastAtRef = useRef(0);
  const dragVisualAuditLogKeyRef = useRef('');
  const dragHorizontalAuditLogKeyRef = useRef('');
  const dragHorizontalIntentLogKeyRef = useRef('');
  const dragVerticalBlockHintLogKeyRef = useRef('');
  const dragVerticalLimitHintLogKeyRef = useRef('');
  const dragFolderModeActiveRef = useRef(false);
  const dragDropStartedRef = useRef(false);
  const dragEarlyCommitRef = useRef(null);
  const lastDragClientXRef = useRef(null);
  const lastDragClientYRef = useRef(null);
  const isDraggingGlobalRef = useRef(false);
  const scrollHintLogKeyRef = useRef('');
  const rowSignatureRef = useRef('');
  const rowRectsRef = useRef(new Map());
  const rowRectsScrollTopRef = useRef(0);
  const rowAnimationsRef = useRef(new Map());
  const globalAutoExpandRef = useRef(null);
  const dragPinnedSourceKeyRef = useRef('');

  // Update expandedIds if initialExpanded changes (e.g. on full refresh)
  useEffect(() => {
      if (initialExpanded && Object.keys(initialExpanded).length > 0) {
          setExpandedIds(prev => ({ ...prev, ...initialExpanded }));
      }
  }, [initialExpanded]);

  useEffect(() => {
    expandedIdsRef.current = expandedIds;
  }, [expandedIds]);

  useEffect(() => {
    isDraggingGlobalRef.current = isDraggingGlobal;
  }, [isDraggingGlobal]);

  // The element that actually scrolls is the PARENT `.file-tree` (overflow-y:auto
  // in main.css), NOT this component's root `.file-tree-container` (overflow:
  // visible — it grows to fit its content, scrollTop is permanently 0). Resolve
  // the real scroller from our own node. Verified on live DOM: containerRef
  // .closest('.file-tree') === the overflow scroller.
  const getScroller = () => containerRef.current?.closest('.file-tree') || null

  const getVisibleScrollerRect = (scroller) => {
    const rect = scroller.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || rect.bottom;
    const top = Math.max(0, rect.top);
    const bottom = Math.min(viewportHeight, rect.bottom);
    return {
      top,
      bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: Math.max(0, bottom - top),
      rawTop: rect.top,
      rawBottom: rect.bottom,
    };
  };

  const isPointInsideDragSurface = useCallback((clientX, clientY) => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    const scroller = containerRef.current?.closest('.file-tree');
    if (!scroller) return false;
    const rect = getVisibleScrollerRect(scroller);
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }, []);

  const currentDragSessionId = useCallback(() => dragSessionRef.current?.id || '-', []);

  const setPreviewLayout = useCallback((layout) => {
    dragPreviewLayoutRef.current = layout;
    if (dragSessionRef.current) dragSessionRef.current.previewLayout = layout;
    setDragPreviewLayout(layout);
  }, []);

  const markDropConfirmed = useCallback((ids, sessionId, reason = 'drop') => {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))];
    if (list.length === 0) return;
    console.log(
      DND_LOG_PREFIX,
      `session=${sessionId || currentDragSessionId()} drop-confirm show` +
      ` reason=${reason} ids=${formatIdList(list)} wall=${Date.now()}`
    );
    setDropConfirmedIds(new Set(list));
  }, [currentDragSessionId]);

  const clearDropConfirmed = useCallback((reason = 'clear') => {
    setDropConfirmedIds(prev => {
      if (!prev || prev.size === 0) return prev;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} drop-confirm hide` +
        ` reason=${reason} ids=${formatIdList([...prev])} wall=${Date.now()}`
      );
      return new Set();
    });
  }, [currentDragSessionId]);

  const setDragFolderMode = useCallback((active, reason = 'drag') => {
    const next = !!active;
    if (dragFolderModeActiveRef.current === next) return;
    dragFolderModeActiveRef.current = next;
    setDragFolderModeActive(next);
    console.log(
      DND_LOG_PREFIX,
      `session=${currentDragSessionId()} folder-mode ${next ? 'on' : 'off'}` +
      ` reason=${reason} wall=${Date.now()}`
    );
  }, [currentDragSessionId]);

  useEffect(() => {
    if (!sidebarFocused) clearDropConfirmed('sidebar-blur');
  }, [sidebarFocused, clearDropConfirmed]);

  const commitPendingPreviewLayoutForMove = useCallback((sessionId, reason = 'cmd-move') => {
    const pending = dragPreviewLayoutRef.current;
    if (!pending || !onApplySidebarLayout) return false;
    const changed = !sameSidebarLayout(sidebarLayout, pending);
    console.log(
      DND_LOG_PREFIX,
      `session=${sessionId || currentDragSessionId()} pending-preview-layout` +
      ` reason=${reason} changed=${changed ? 1 : 0}` +
      ` ${summarizeLayout(pending)} wall=${Date.now()}`
    );
    if (changed) {
      flushSync(() => {
        onApplySidebarLayout(pending, {
          activateManualOrder: true,
          reason: 'dnd-preview-before-cmd-move',
        });
      });
    }
    return changed;
  }, [currentDragSessionId, onApplySidebarLayout, sidebarLayout]);

  const getScrollSnapshot = useCallback(() => {
    const scroller = getScroller();
    if (!scroller) {
      return {
        hasScroller: 0,
        scrollTop: 0,
        clientHeight: 0,
        scrollHeight: 0,
        canUp: false,
        canDown: false,
        rectTop: 0,
        rectBottom: 0,
      };
    }
    const rect = getVisibleScrollerRect(scroller);
    return {
      hasScroller: 1,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      canUp: scroller.scrollTop > 1,
      canDown: scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1,
      rectTop: rect.top,
      rectBottom: rect.bottom,
    };
  }, [currentDragSessionId]);

  const formatScrollSnapshot = useCallback((scroll) => (
    `scrollTop=${Math.round(scroll.scrollTop)}` +
    ` clientH=${Math.round(scroll.clientHeight)}` +
    ` scrollH=${Math.round(scroll.scrollHeight)}` +
    ` canUp=${scroll.canUp ? 1 : 0}` +
    ` canDown=${scroll.canDown ? 1 : 0}` +
    ` scroller=${scroll.hasScroller ? 1 : 0}`
  ), []);

  const logResolveReject = useCallback((reason, details = '') => {
    const key = `${currentDragSessionId()}:${reason}:${details}`;
    if (key === dragRejectLogKeyRef.current) return;
    dragRejectLogKeyRef.current = key;
    console.log(
      DND_LOG_PREFIX,
      `session=${currentDragSessionId()} reject reason=${reason}${details ? ` ${details}` : ''}`
    );
  }, [currentDragSessionId]);

  const sourceRectDiagnostics = useCallback((sourceId) => {
    const root = containerRef.current;
    const geometry = dragGeometryRef.current;
    const session = dragSessionRef.current;
    const snapshotRow = geometry?.sourceRow || geometry?.rows?.find(row => row.id === sourceId) || null;
    const row = root
      ? Array.from(root.querySelectorAll('.arborist-node[data-node-id]')).find(el => el.dataset.nodeId === sourceId)
      : null;
    const live = row?.getBoundingClientRect?.() || null;
    const layoutRect = row
      ? readRowLayoutRect(row, rowAnimationsRef.current.has(rowKey(sourceId)))
      : null;
    const scroll = getScrollSnapshot();
    const snapshotScrollTop = Number.isFinite(geometry?.scrollTop)
      ? geometry.scrollTop
      : (session?.startScrollTop || 0);
    const scrollDelta = scroll.scrollTop - snapshotScrollTop;
    const expectedTop = snapshotRow && live ? snapshotRow.rect.top - scrollDelta : null;
    const drift = live && expectedTop != null ? live.top - expectedTop : null;
    const layoutDrift = layoutRect && expectedTop != null ? layoutRect.top - expectedTop : null;
    return (
      `sourceSnap=${formatRect(snapshotRow?.rect)}` +
      ` sourceLive=${live ? `${Math.round(live.top)}..${Math.round(live.bottom)}` : '-'}` +
      ` sourceLayout=${layoutRect ? `${Math.round(layoutRect.top)}..${Math.round(layoutRect.bottom)}` : '-'}` +
      ` sourceFlipY=${layoutRect ? Math.round(layoutRect.translateY) : '-'}` +
      ` sourceExpectedTop=${expectedTop == null ? '-' : Math.round(expectedTop)}` +
      ` sourceDrift=${drift == null ? '-' : Math.round(drift)}` +
      ` sourceLayoutDrift=${layoutDrift == null ? '-' : Math.round(layoutDrift)}` +
      ` scrollDelta=${Math.round(scrollDelta)}`
    );
  }, [getScrollSnapshot]);

  const updatePinnedDragSource = useCallback((sourceId, reason = 'drag') => {
    const root = containerRef.current;
    const scroller = getScroller();
    const hide = (hideReason) => {
      if (dragPinnedSourceKeyRef.current === '-') return;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} source-pin hide reason=${hideReason || reason}`
      );
      dragPinnedSourceKeyRef.current = '-';
      setDragPinnedSource(null);
    };

    if (!isDraggingGlobalRef.current || !sourceId || !root || !scroller) {
      hide(reason);
      return;
    }

    const sourceNode = visibleNodesRef.current.find(node => node.id === sourceId);
    const sourceRow = Array.from(root.querySelectorAll('.arborist-node[data-node-id]'))
      .find(row => row.dataset.nodeId === sourceId);
    if (!sourceNode || !sourceRow) {
      hide('missing-source-row');
      return;
    }

    const rowRect = sourceRow.getBoundingClientRect();
    const scrollRect = getVisibleScrollerRect(scroller);
    const isAboveViewport = rowRect.bottom < scrollRect.top + 2;
    const nextKey = isAboveViewport ? `top:${sourceId}` : '-';

    if (nextKey === dragPinnedSourceKeyRef.current) return;
    dragPinnedSourceKeyRef.current = nextKey;

    if (!isAboveViewport) {
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} source-pin hide reason=${reason}` +
        ` row=${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)}` +
        ` scroller=${Math.round(scrollRect.top)}..${Math.round(scrollRect.bottom)}`
      );
      setDragPinnedSource(null);
      return;
    }

    console.log(
      DND_LOG_PREFIX,
      `session=${currentDragSessionId()} source-pin show edge=top reason=${reason}` +
      ` source=${shortPath(sourceId)}` +
      ` row=${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)}` +
      ` scroller=${Math.round(scrollRect.top)}..${Math.round(scrollRect.bottom)}`
    );
    setDragPinnedSource({
      id: sourceId,
      name: sourceNode.name || shortPath(sourceId),
      isDirectory: !!sourceNode.isDirectory,
    });
  }, [currentDragSessionId]);

  const updateScrollHintEdge = useCallback((clientY, reason = 'drag') => {
    const scroller = getScroller();
    if (!scroller) {
      setScrollHintEdge(null);
      return;
    }
    const rect = getVisibleScrollerRect(scroller);
    const canUp = scroller.scrollTop > 1;
    const canDown = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    const nearTop = clientY >= rect.top && clientY <= rect.top + SCROLL_HINT_THRESHOLD_PX;
    const nearBottom = clientY <= rect.bottom && clientY >= rect.bottom - SCROLL_HINT_THRESHOLD_PX;
    const nextEdge = nearTop && canUp
      ? 'top'
      : (nearBottom && canDown ? 'bottom' : null);
    const nextKey = `${nextEdge || '-'}:${canUp ? 1 : 0}:${canDown ? 1 : 0}:${Math.round(scroller.scrollTop)}`;
    if (nextKey !== scrollHintLogKeyRef.current) {
      console.log(
        SCROLL_LOG_PREFIX,
        `session=${currentDragSessionId()} hint edge=${nextEdge || '-'} reason=${reason}` +
        ` y=${Math.round(clientY)} top=${Math.round(scroller.scrollTop)}` +
        ` canUp=${canUp ? 1 : 0} canDown=${canDown ? 1 : 0}` +
        ` clientH=${scroller.clientHeight} scrollH=${scroller.scrollHeight}`
      );
      scrollHintLogKeyRef.current = nextKey;
    }
    setScrollHintEdge(nextEdge);
  }, [currentDragSessionId]);

  const resetScrollHintEdge = useCallback((reason = 'reset') => {
    if (scrollHintLogKeyRef.current !== '-') {
      console.log(SCROLL_LOG_PREFIX, `session=${currentDragSessionId()} hint edge=- reason=${reason}`);
      scrollHintLogKeyRef.current = '-';
    }
    setScrollHintEdge(null);
  }, [currentDragSessionId]);

  const schedulePostDropReveal = useCallback((sourceId, sessionId, reason = 'drop-layout') => {
    if (!sourceId) return;

    const runReveal = () => {
      const scroller = getScroller();
      const row = containerRef.current
        ? Array.from(containerRef.current.querySelectorAll('.arborist-node[data-node-id]'))
            .find(el => el.dataset.nodeId === sourceId)
        : null;
      if (!scroller || !row) {
        console.log(
          SCROLL_LOG_PREFIX,
          `session=${sessionId || currentDragSessionId()} post-drop-reveal miss` +
          ` reason=${reason} source=${shortPath(sourceId)}` +
          ` hasScroller=${scroller ? 1 : 0} hasRow=${row ? 1 : 0}`
        );
        return;
      }

      const rect = getVisibleScrollerRect(scroller);
      const rowRect = row.getBoundingClientRect();
      const margin = POST_DROP_REVEAL_MARGIN_PX;
      const sourceNode = visibleNodesRef.current.find(node => node.id === sourceId);
      const isExpandedFolder = !!sourceNode?.isDirectory && !!expandedIdsRef.current[sourceId];
      const descendantRows = isExpandedFolder && containerRef.current
        ? Array.from(containerRef.current.querySelectorAll('.arborist-node[data-node-id]'))
            .filter(el => el.dataset.nodeId?.startsWith(`${sourceId}/`))
        : [];
      const peekRows = descendantRows.slice(0, POST_DROP_REVEAL_FOLDER_PEEK_ROWS);
      const peekBottom = peekRows.length > 0
        ? peekRows[peekRows.length - 1].getBoundingClientRect().bottom
        : rowRect.bottom;
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      let targetTop = scroller.scrollTop;
      let edge = 'inside';

      const isFullyVisible = rowRect.top >= rect.top + margin && peekBottom <= rect.bottom - margin;
      if (isFullyVisible) {
        console.log(
          SCROLL_LOG_PREFIX,
          `session=${sessionId || currentDragSessionId()} post-drop-reveal skip` +
          ` reason=${reason} edge=inside-visible source=${shortPath(sourceId)}` +
          ` top=${Math.round(scroller.scrollTop)} row=${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)}` +
          ` scroller=${Math.round(rect.top)}..${Math.round(rect.bottom)}` +
          ` margin=${margin} expanded=${isExpandedFolder ? 1 : 0}` +
          ` peekRows=${peekRows.length} peekBottom=${Math.round(peekBottom)}`
        );
        return;
      }

      if (peekBottom > rect.bottom - margin) {
        targetTop += peekBottom - (rect.bottom - margin);
        edge = 'below';
      } else if (rowRect.top < rect.top + margin) {
        targetTop -= (rect.top + margin) - rowRect.top;
        edge = 'above';
      }

      targetTop = Math.max(0, Math.min(maxScrollTop, targetTop));
      const before = scroller.scrollTop;
      if (Math.abs(targetTop - before) < 1) {
        console.log(
          SCROLL_LOG_PREFIX,
          `session=${sessionId || currentDragSessionId()} post-drop-reveal skip` +
          ` reason=${reason} edge=${edge} source=${shortPath(sourceId)}` +
          ` top=${Math.round(before)} row=${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)}` +
          ` scroller=${Math.round(rect.top)}..${Math.round(rect.bottom)}` +
          ` margin=${margin} expanded=${isExpandedFolder ? 1 : 0}` +
          ` peekRows=${peekRows.length} peekBottom=${Math.round(peekBottom)}`
        );
        return;
      }

      const startedAt = performance.now();
      console.log(
        SCROLL_LOG_PREFIX,
        `session=${sessionId || currentDragSessionId()} post-drop-reveal start` +
        ` reason=${reason} edge=${edge} source=${shortPath(sourceId)}` +
        ` before=${Math.round(before)} target=${Math.round(targetTop)}` +
        ` row=${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)}` +
        ` scroller=${Math.round(rect.top)}..${Math.round(rect.bottom)}` +
        ` margin=${margin} expanded=${isExpandedFolder ? 1 : 0}` +
        ` peekRows=${peekRows.length} peekBottom=${Math.round(peekBottom)}` +
        ` duration=${POST_DROP_REVEAL_DURATION_MS}ms`
      );

      const step = (now) => {
        const progress = Math.min(1, (now - startedAt) / POST_DROP_REVEAL_DURATION_MS);
        const eased = 1 - Math.pow(1 - progress, 3);
        scroller.scrollTop = before + (targetTop - before) * eased;
        if (progress < 1) {
          requestAnimationFrame(step);
          return;
        }

        scroller.scrollTop = targetTop;
        const doneRowRect = row.getBoundingClientRect();
        console.log(
          SCROLL_LOG_PREFIX,
          `session=${sessionId || currentDragSessionId()} post-drop-reveal done` +
          ` reason=${reason} source=${shortPath(sourceId)}` +
          ` before=${Math.round(before)} after=${Math.round(scroller.scrollTop)}` +
          ` target=${Math.round(targetTop)}` +
          ` elapsed=${Math.round(performance.now() - startedAt)}ms` +
          ` row=${Math.round(doneRowRect.top)}..${Math.round(doneRowRect.bottom)}` +
          ` expanded=${isExpandedFolder ? 1 : 0} peekRows=${peekRows.length}`
        );
      };

      requestAnimationFrame(step);
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(runReveal);
    });
  }, [currentDragSessionId]);

  // Restore saved scroll BEFORE paint (useLayoutEffect) so the user never sees
  // a flash at scrollTop 0 followed by a jump. Runs once per mount — a mount
  // corresponds to one directory (App keys this subtree by folderPath, so a
  // dir-switch recreates it). The rows are already in the DOM here because
  // visibleNodes is computed synchronously from props during render.
  useLayoutEffect(() => {
    const el = getScroller()
    if (el && initialScrollTop > 0) {
      const before = el.scrollTop
      el.scrollTop = initialScrollTop // browser auto-clamps to scrollable range
      console.log(
        SCROLL_LOG_PREFIX,
        `restore folder=${shortPath(folderPath)} initial=${Math.round(initialScrollTop)}` +
        ` before=${Math.round(before)} after=${Math.round(el.scrollTop)}` +
        ` clientH=${el.clientHeight} scrollH=${el.scrollHeight}`
      )
    } else {
      console.log(
        SCROLL_LOG_PREFIX,
        `restore-skip folder=${shortPath(folderPath)} initial=${Math.round(initialScrollTop || 0)}` +
        ` hasScroller=${el ? 1 : 0}`
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track scroll and report up to parent (which persists per-directory).
  useEffect(() => {
    const el = getScroller()
    if (!el) return
    console.log(
      SCROLL_LOG_PREFIX,
      `listener-attach folder=${shortPath(folderPath)}` +
      ` top=${Math.round(el.scrollTop)} clientH=${el.clientHeight} scrollH=${el.scrollHeight}`
    )
    let lastLoggedTop = el.scrollTop
    const onScroll = () => {
      const nextTop = el.scrollTop
      onScrollChangeRef.current?.(nextTop)
      if (isDraggingGlobalRef.current && lastDragClientYRef.current != null) {
        updateScrollHintEdge(lastDragClientYRef.current, 'scroll')
      }
      const delta = nextTop - lastLoggedTop
      if (isDraggingGlobalRef.current && lastDragClientYRef.current != null) {
        const rect = getVisibleScrollerRect(el)
        const pointerY = lastDragClientYRef.current
        const canUp = nextTop > 1
        const canDown = nextTop + el.clientHeight < el.scrollHeight - 1
        const nearTop = pointerY >= rect.top && pointerY <= rect.top + SCROLL_HINT_THRESHOLD_PX
        const nearBottom = pointerY <= rect.bottom && pointerY >= rect.bottom - SCROLL_HINT_THRESHOLD_PX
        const session = dragSessionRef.current
        const scrollKey =
          `${session?.id || '-'}:${Math.round(nextTop / DRAG_MOVE_SCROLL_BUCKET_PX)}` +
          `:${Math.round(pointerY / DRAG_MOVE_Y_BUCKET_PX)}:${canUp ? 1 : 0}:${canDown ? 1 : 0}`
        if (scrollKey !== dragScrollLogKeyRef.current) {
          dragScrollLogKeyRef.current = scrollKey
          console.log(
            DND_LOG_PREFIX,
            `session=${session?.id || '-'} scroll-during-drag` +
            ` top=${Math.round(nextTop)} delta=${Math.round(nextTop - (session?.lastScrollTop ?? nextTop))}` +
            ` pointerY=${Math.round(pointerY)}` +
            ` nearTop=${nearTop ? 1 : 0} nearBottom=${nearBottom ? 1 : 0}` +
            ` canUp=${canUp ? 1 : 0} canDown=${canDown ? 1 : 0}` +
            ` clientH=${el.clientHeight} scrollH=${el.scrollHeight}` +
            ` ${session?.sourceId ? sourceRectDiagnostics(session.sourceId) : ''}`
          )
        }
        if (session) session.lastScrollTop = nextTop
        if (session?.sourceId) updatePinnedDragSource(session.sourceId, 'scroll')
      }
      if (Math.abs(delta) >= 16) {
        console.log(
          SCROLL_LOG_PREFIX,
          `event folder=${shortPath(folderPath)}` +
          ` top=${Math.round(nextTop)} delta=${Math.round(delta)}` +
          ` clientH=${el.clientHeight} scrollH=${el.scrollHeight}`
        )
        lastLoggedTop = nextTop
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      console.log(
        SCROLL_LOG_PREFIX,
        `listener-detach folder=${shortPath(folderPath)} top=${Math.round(el.scrollTop)}`
      )
      el.removeEventListener('scroll', onScroll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll active file into view after reveal. The first invocation per mount is
  // the dir-switch remount — skip it so the restored scroll (above) wins. Only
  // later activeFilePath changes (user opens a file within the current dir) get
  // a controlled reveal. setTimeout(0) waits for the .selected row to commit to
  // the DOM (allowed per project rules: zero-delay, not a magic timeout).
  useEffect(() => {
    // Arm on the first run (mount) regardless of whether a file is active, so a
    // dir that mounts with no active file still reveals the user's first open.
    if (!revealArmedRef.current) {
      revealArmedRef.current = true
      console.log(
        SCROLL_LOG_PREFIX,
        `reveal-skip-mount folder=${shortPath(folderPath)} active=${shortPath(activeFilePath)}`
      )
      return
    }
    if (!activeFilePath) return
    console.log(
      SCROLL_LOG_PREFIX,
      `reveal-schedule folder=${shortPath(folderPath)} active=${shortPath(activeFilePath)}`
    )
    const id = setTimeout(() => {
      const container = containerRef.current
      if (!container) return
      // Rows render as .arborist-node (selected row = .arborist-node.selected),
      // NOT .file-row — verified on live DOM.
      const activeRow = container.querySelector('.arborist-node.selected')
      if (activeRow) {
        const scroller = getScroller()
        const before = scroller?.scrollTop || 0
        if (!scroller) return
        const rect = getVisibleScrollerRect(scroller)
        const rowRect = activeRow.getBoundingClientRect()
        const margin = 24
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        let targetTop = before
        let edge = 'inside'
        if (rowRect.bottom > rect.bottom - margin) {
          targetTop += rowRect.bottom - (rect.bottom - margin)
          edge = 'below'
        } else if (rowRect.top < rect.top + margin) {
          targetTop -= (rect.top + margin) - rowRect.top
          edge = 'above'
        }
        targetTop = Math.max(0, Math.min(maxScrollTop, targetTop))
        if (Math.abs(targetTop - before) < 1) {
          console.log(
            SCROLL_LOG_PREFIX,
            `reveal-skip folder=${shortPath(folderPath)} active=${shortPath(activeFilePath)}` +
            ` edge=${edge} top=${Math.round(before)}` +
            ` row=${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)}`
          )
          return
        }
        const startedAt = performance.now()
        console.log(
          SCROLL_LOG_PREFIX,
          `reveal-run folder=${shortPath(folderPath)} active=${shortPath(activeFilePath)}` +
          ` edge=${edge} before=${Math.round(before)} target=${Math.round(targetTop)}` +
          ` row=${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)}` +
          ` duration=${POST_DROP_REVEAL_DURATION_MS}ms`
        )
        const step = (now) => {
          const progress = Math.min(1, (now - startedAt) / POST_DROP_REVEAL_DURATION_MS)
          const eased = 1 - Math.pow(1 - progress, 3)
          scroller.scrollTop = before + (targetTop - before) * eased
          if (progress < 1) {
            requestAnimationFrame(step)
            return
          }
          scroller.scrollTop = targetTop
          console.log(
            SCROLL_LOG_PREFIX,
            `reveal-done folder=${shortPath(folderPath)} active=${shortPath(activeFilePath)}` +
            ` before=${Math.round(before)} after=${Math.round(scroller.scrollTop)}` +
            ` elapsed=${Math.round(performance.now() - startedAt)}ms`
          )
        }
        requestAnimationFrame(step)
      } else {
        console.log(
          SCROLL_LOG_PREFIX,
          `reveal-miss folder=${shortPath(folderPath)} active=${shortPath(activeFilePath)}`
        )
      }
    }, 0)
    return () => clearTimeout(id)
  }, [activeFilePath]);

  // Toggle Folder
  const handleToggle = (id) => {
    setExpandedIds(prev => {
      const newState = {
        ...prev,
        [id]: !prev[id]
      };
      if (onExpandChange) onExpandChange(newState);
      return newState;
    });
    if (onToggle) onToggle(id);
  };

  const cancelGlobalAutoExpand = useCallback((reason = 'unknown') => {
    const current = globalAutoExpandRef.current;
    if (current) {
      current.cancelled = true;
      if (current.timer) clearTimeout(current.timer);
      console.log(DND_LOG_PREFIX, `autoexpand cancel folder=${shortPath(current.folderId)} reason=${reason}`);
    }
    globalAutoExpandRef.current = null;
    if (reason !== 'unmount') setDragFolderSpringState(null);
  }, []);

  const logDragVisualDomState = useCallback((reason, phase) => {
    const root = containerRef.current;
    const tree = root;
    const count = (selector) => root?.querySelectorAll(selector).length || 0;
    const ids = (selector, limit = 4) => root
      ? Array.from(root.querySelectorAll(selector))
          .slice(0, limit)
          .map(row => shortPath(row.dataset.nodeId || row.textContent || '-'))
          .join(',')
      : '-';
    const key = [
      reason,
      phase,
      count('.is-dragging'),
      count('.drop-target'),
      count('.inside-drop-target'),
      count('.drop-before'),
      count('.drop-after'),
      tree?.classList?.contains('is-dragging-global') ? 1 : 0,
    ].join(':');
    if (key === dragVisualAuditLogKeyRef.current) return;
    dragVisualAuditLogKeyRef.current = key;
    console.log(
      DND_LOG_PREFIX,
      `session=${currentDragSessionId()} visual-state reason=${reason} phase=${phase}` +
      ` globalClass=${tree?.classList?.contains('is-dragging-global') ? 1 : 0}` +
      ` isDragging=${count('.is-dragging')}` +
      ` dropTarget=${count('.drop-target')}` +
      ` inside=${count('.inside-drop-target')}` +
      ` before=${count('.drop-before')}` +
      ` after=${count('.drop-after')}` +
      ` dragIds=${ids('.is-dragging')}` +
      ` targetIds=${ids('.drop-target')}`
    );
  }, [currentDragSessionId]);

  const scheduleDragVisualAudit = useCallback((reason) => {
    logDragVisualDomState(reason, 'cleanup-call');
    requestAnimationFrame(() => {
      logDragVisualDomState(reason, 'raf1');
      requestAnimationFrame(() => logDragVisualDomState(reason, 'raf2'));
    });
    window.setTimeout(() => logDragVisualDomState(reason, 't120'), 120);
  }, [logDragVisualDomState]);

  const logHorizontalPreviewFrame = useCallback((action, phase) => {
    const sourceId = action?.sourceIds?.[0];
    if (!sourceId) return;
    const root = containerRef.current;
    const row = root?.querySelector(`.arborist-node[data-node-id="${CSS.escape(sourceId)}"]`);
    if (!row) {
      const key = `${phase}:${sourceId}:missing`;
      if (key === dragHorizontalAuditLogKeyRef.current) return;
      dragHorizontalAuditLogKeyRef.current = key;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} horizontal-preview phase=${phase}` +
        ` detail=${action.detail} source=${shortPath(sourceId)} row=missing`
      );
      return;
    }

    const style = window.getComputedStyle(row);
    const rect = row.getBoundingClientRect();
    const continuationDepths = Array.from(row.querySelectorAll('[data-visual-continuation-depth]'))
      .map(el => el.getAttribute('data-visual-continuation-depth'))
      .join(',') || '-';
    const key = [
      phase,
      action.detail,
      sourceId,
      style.paddingLeft,
      style.transform,
      row.dataset.visualDepth || '0',
      row.dataset.visualParentId || '-',
      row.dataset.horizontalIntentDirection || '-',
      row.dataset.horizontalIntentProgress || '0',
      continuationDepths,
    ].join(':');
    if (key === dragHorizontalAuditLogKeyRef.current) return;
    dragHorizontalAuditLogKeyRef.current = key;
    console.log(
      DND_LOG_PREFIX,
      `session=${currentDragSessionId()} horizontal-preview phase=${phase}` +
      ` detail=${action.detail}` +
      ` source=${shortPath(sourceId)}` +
      ` deltaX=${action.deltaX == null ? '-' : action.deltaX}` +
      ` visualParent=${shortPath(action.visualParentId)}` +
      ` prevVisualParent=${shortPath(action.previousVisualParentId)}` +
      ` rowDepth=${row.dataset.visualDepth || 0}` +
      ` rowVisualParent=${shortPath(row.dataset.visualParentId)}` +
      ` intent=${row.dataset.horizontalIntentDirection || '-'}:${row.dataset.horizontalIntentProgress || 0}` +
      ` paddingLeft=${style.paddingLeft}` +
      ` transform=${style.transform}` +
      ` transition=${style.transitionProperty}/${style.transitionDuration}` +
      ` rectLeft=${Math.round(rect.left)}` +
      ` continuations=${continuationDepths}`
    );
  }, [currentDragSessionId]);

  const scheduleHorizontalPreviewAudit = useCallback((action) => {
    if (!action?.detail || !/(attach|detach|outdent|visual-child)/.test(action.detail)) return;
    logHorizontalPreviewFrame(action, 'sync');
    requestAnimationFrame(() => {
      logHorizontalPreviewFrame(action, 'raf1');
      requestAnimationFrame(() => logHorizontalPreviewFrame(action, 'raf2'));
    });
    window.setTimeout(() => logHorizontalPreviewFrame(action, 't120'), 120);
  }, [logHorizontalPreviewFrame]);

  const updateHorizontalDragIntent = useCallback((sourceData, action, metaKey) => {
    const sourceId = sourceData?.fileId || action?.sourceIds?.[0] || null;
    const selectedCount = Array.isArray(sourceData?.selectedIds) ? sourceData.selectedIds.length : 1;
    const isSingleOutlineLayout =
      !!sourceId &&
      !metaKey &&
      action?.kind === 'layout' &&
      action?.mode === 'flat-reorder' &&
      ['file', 'dir', 'link'].includes(action?.sourceKind) &&
      selectedCount === 1 &&
      Array.isArray(action.sourceIds) &&
      action.sourceIds.includes(sourceId);
    const horizontalCommitted = !!action?.detail && /(attach|detach|outdent|visual-child)/.test(action.detail);
    const deltaX = Number.isFinite(action?.deltaX) ? action.deltaX : 0;
    let direction = '';
    let progress = 0;
    let phase = 'off';
    let disabled = false;

    if (isSingleOutlineLayout && !horizontalCommitted && Math.abs(deltaX) > 2) {
      direction = deltaX < 0 ? 'left' : 'right';
      const canMoveDirection = direction === 'left'
        ? action?.visualCanLeft !== false
        : action?.visualCanRight !== false;
      disabled = !canMoveDirection || action?.visualBlockedDirection === direction;
      const threshold = direction === 'left'
        ? (action?.visualLeftThresholdPx || action?.visualIntentThresholdPx || DRAG_VISUAL_DETACH_THRESHOLD_PX)
        : (action?.visualRightThresholdPx || action?.visualIntentThresholdPx || DRAG_VISUAL_ATTACH_THRESHOLD_PX);
      progress = Math.min(
        1,
        Math.abs(deltaX) / Math.max(1, threshold)
      );
      phase = 'prethreshold';
    } else if (isSingleOutlineLayout && horizontalCommitted) {
      phase = 'committed';
    }

    const roundedProgress = Number(progress.toFixed(2));
    const roundedDelta = Math.round(deltaX);
    const next = roundedProgress === 0 || !sourceId
      ? null
      : { sourceId, direction, progress: roundedProgress, deltaX: roundedDelta, disabled };
    const key = [
      currentDragSessionId(),
      sourceId || '-',
      action?.detail || 'none',
      phase,
      roundedDelta,
      direction || '-',
      roundedProgress,
      disabled ? 'disabled' : 'enabled',
    ].join(':');

    if (key !== dragHorizontalIntentLogKeyRef.current) {
      dragHorizontalIntentLogKeyRef.current = key;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} horizontal-intent` +
        ` phase=${phase}` +
        ` detail=${action?.detail || 'none'}` +
        ` source=${shortPath(sourceId)}` +
        ` deltaX=${roundedDelta}` +
        ` direction=${direction || '-'}` +
        ` progress=${roundedProgress}` +
        ` disabled=${disabled ? 1 : 0}` +
        ` committed=${horizontalCommitted ? 1 : 0}`
      );
    }

    setDragHorizontalIntent(prev => {
      if (!next && !prev) return prev;
      if (
        next &&
        prev?.sourceId === next.sourceId &&
        prev?.direction === next.direction &&
        prev?.progress === next.progress &&
        prev?.deltaX === next.deltaX &&
        prev?.disabled === next.disabled
      ) return prev;
      return next;
    });
  }, [currentDragSessionId]);

  const updateVerticalBlockHint = useCallback((sourceData, action, metaKey) => {
    const sourceId = sourceData?.fileId || action?.sourceIds?.[0] || null;
    const ids = Array.isArray(action?.verticalBlockHintIds)
      ? action.verticalBlockHintIds.filter(Boolean)
      : [];
    const allowSingle = !!action?.verticalBlockHintAllowSingle;
    const next = !metaKey && sourceId && (ids.length > 1 || (allowSingle && ids.length === 1))
      ? {
          sourceId,
          ids,
          rootId: action.verticalBlockHintRootId || ids[0],
          targetId: action.verticalBlockHintTargetId || action.targetId || null,
        }
      : null;
    const key = [
      currentDragSessionId(),
      sourceId || '-',
      next?.rootId || '-',
      next?.targetId || '-',
      formatIdList(ids),
    ].join(':');

    if (key !== dragVerticalBlockHintLogKeyRef.current) {
      dragVerticalBlockHintLogKeyRef.current = key;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} vertical-block-hint` +
        ` source=${shortPath(sourceId)}` +
        ` root=${shortPath(next?.rootId)}` +
        ` target=${shortPath(next?.targetId)}` +
        ` ids=${formatIdList(ids)}`
      );
    }

    setDragVerticalBlockHint(prev => {
      if (!next && !prev) return prev;
      if (
        next &&
        prev?.sourceId === next.sourceId &&
        prev?.rootId === next.rootId &&
        prev?.targetId === next.targetId &&
        sameOrder(prev.ids, next.ids)
      ) return prev;
      return next;
    });
  }, [currentDragSessionId]);

  const updateVerticalLimitHint = useCallback((sourceData, action, metaKey) => {
    const sourceId = sourceData?.fileId || action?.sourceIds?.[0] || null;
    const direction = action?.verticalLimitDirection || null;
    const next = !metaKey && sourceId && (direction === 'up' || direction === 'down')
      ? {
          sourceId,
          direction,
          targetId: action.verticalLimitTargetId || action.targetId || null,
        }
      : null;
    const key = [
      currentDragSessionId(),
      sourceId || '-',
      next?.direction || '-',
      next?.targetId || '-',
    ].join(':');

    if (key !== dragVerticalLimitHintLogKeyRef.current) {
      dragVerticalLimitHintLogKeyRef.current = key;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} vertical-limit-hint` +
        ` source=${shortPath(sourceId)}` +
        ` direction=${next?.direction || '-'}` +
        ` target=${shortPath(next?.targetId)}`
      );
    }

    setDragVerticalLimitHint(prev => {
      if (!next && !prev) return prev;
      if (
        next &&
        prev?.sourceId === next.sourceId &&
        prev?.direction === next.direction &&
        prev?.targetId === next.targetId
      ) return prev;
      return next;
    });
  }, [currentDragSessionId]);

  const updateDragVisualParentBaseline = useCallback((sourceData, action, reason = 'drag') => {
    if (!action || action.kind !== 'layout' || !isVisualParentAction(action.detail) || !action.visualChanged) return;
    const session = dragSessionRef.current;
    const sourceId = sourceData?.fileId || action.sourceIds?.[0] || null;
    if (!session || !sourceId) return;

    if (!session.visualParentByPath) session.visualParentByPath = {};
    const actionLayoutParents = normalizeSidebarLayout(action.layout).visualParentByPath || {};
    const nextParentId = hasOwn(actionLayoutParents, sourceId)
      ? (actionLayoutParents[sourceId] || null)
      : null;
    const actionParentId = action.visualParentId || null;
    const previousParentId = action.previousVisualParentId || null;
    const actualVisualChanged = previousParentId !== nextParentId;
    const key = [
      sourceId,
      action.detail,
      previousParentId || '-',
      nextParentId || '-',
    ].join(':');
    if (session.visualParentCommitKey === key) return;

    session.visualParentByPath[sourceId] = nextParentId;
    session.activeBlockBoundary = null;
    if (isHorizontalVisualAction(action.detail) && Number.isFinite(action.rawX)) {
      session.horizontalBaseX = action.rawX;
      session.lastHorizontalCommit = {
        sourceId,
        direction: action.detail === 'attach-visual-parent' ? 'right' : 'left',
        rawY: Number.isFinite(action.rawY) ? action.rawY : null,
        effectiveY: Number.isFinite(action.effectiveY) ? action.effectiveY : null,
        insertIndex: Number.isFinite(action.insertIndex) ? action.insertIndex : null,
        targetId: action.targetId || null,
        targetParentKey: action.targetParentKey || null,
      };
      dragHorizontalIntentLogKeyRef.current = '';
    }
    session.visualParentCommitKey = key;

      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} horizontal-baseline` +
        ` reason=${reason}` +
        ` detail=${action.detail}` +
        ` source=${shortPath(sourceId)}` +
        ` prevParent=${shortPath(previousParentId)}` +
        ` actionParent=${shortPath(actionParentId)}` +
        ` nextParent=${shortPath(nextParentId)}` +
        ` actualChanged=${actualVisualChanged ? 1 : 0}` +
        ` clearBoundary=1` +
        ` baseX=${Number.isFinite(session.horizontalBaseX) ? Math.round(session.horizontalBaseX) : '-'}` +
        ` rawX=${action.rawX == null ? '-' : action.rawX}`
      );
  }, [currentDragSessionId]);

  const logPostDropFrameState = useCallback((reason, phase, details = {}) => {
    const root = containerRef.current;
    const rows = root ? Array.from(root.querySelectorAll('.arborist-node[data-node-id]')) : [];
    const rowInfo = (id) => {
      if (!id) return '-';
      const row = rows.find(el => el.dataset.nodeId === id);
      if (!row) return `${shortPath(id)}:missing`;
      const rect = row.getBoundingClientRect();
      const classes = [
        row.classList.contains('is-dragging') ? 'dragging' : '',
        row.classList.contains('drop-target') ? 'target' : '',
        row.classList.contains('inside-drop-target') ? 'inside' : '',
        row.classList.contains('drop-before') ? 'before' : '',
        row.classList.contains('drop-after') ? 'after' : '',
        row.matches(':hover') ? 'hover' : '',
      ].filter(Boolean).join('|') || '-';
      return `${shortPath(id)}:${Math.round(rect.top)}..${Math.round(rect.bottom)}:${classes}`;
    };
    const count = (selector) => root?.querySelectorAll(selector).length || 0;
    const ids = (selector, limit = 4) => root
      ? Array.from(root.querySelectorAll(selector))
          .slice(0, limit)
          .map(row => shortPath(row.dataset.nodeId || row.textContent || '-'))
          .join(',')
      : '-';
    const pointerY = details.pointerY ?? lastDragClientYRef.current;
    const rowAtPointer = pointerY == null
      ? null
      : rows.find(row => {
          const rect = row.getBoundingClientRect();
          return pointerY >= rect.top && pointerY <= rect.bottom;
        });
    const hoveredRows = rows.filter(row => row.matches(':hover')).slice(0, 4);
    const expectedIds = Array.isArray(details.expectedIds) && details.expectedIds.length > 0
      ? details.expectedIds
      : [details.expectedId || details.sourceId].filter(Boolean);
    const expected = expectedIds.map(rowInfo).join(';') || '-';
    const scroll = getScrollSnapshot();
    console.log(
      DND_LOG_PREFIX,
      `session=${details.sessionId || currentDragSessionId()} post-drop-frame` +
      ` reason=${reason} phase=${phase}` +
      ` wall=${Date.now()}` +
      ` source=${rowInfo(details.sourceId)}` +
      ` expected=${expected}` +
      ` pointerY=${pointerY == null ? '-' : Math.round(pointerY)}` +
      ` rowAtPointer=${rowAtPointer ? rowInfo(rowAtPointer.dataset.nodeId) : '-'}` +
      ` hoverIds=${hoveredRows.map(row => shortPath(row.dataset.nodeId)).join(',') || '-'}` +
      ` globalClass=${root?.classList?.contains('is-dragging-global') ? 1 : 0}` +
      ` isDragging=${count('.is-dragging')}` +
      ` dropTarget=${count('.drop-target')}` +
      ` inside=${count('.inside-drop-target')}` +
      ` before=${count('.drop-before')}` +
      ` after=${count('.drop-after')}` +
      ` pin=${root?.querySelector('.sidebar-drag-source-pin') ? 1 : 0}` +
      ` dragIds=${ids('.is-dragging')}` +
      ` targetIds=${ids('.drop-target')}` +
      ` ${formatScrollSnapshot(scroll)}`
    );
  }, [currentDragSessionId, formatScrollSnapshot, getScrollSnapshot]);

  const schedulePostDropFrameAudit = useCallback((reason, details = {}) => {
    logPostDropFrameState(reason, 'sync', details);
    requestAnimationFrame(() => {
      logPostDropFrameState(reason, 'raf1', details);
      requestAnimationFrame(() => logPostDropFrameState(reason, 'raf2', details));
    });
    window.setTimeout(() => logPostDropFrameState(reason, 't50', details), 50);
    window.setTimeout(() => logPostDropFrameState(reason, 't150', details), 150);
  }, [logPostDropFrameState]);

  const finalizeTemporaryDragExpansions = useCallback((session, commitExpansion, reason) => {
    const temporaryIds = session?.temporaryExpandedIds;
    if (!(temporaryIds instanceof Set) || temporaryIds.size === 0) return;
    if (commitExpansion) {
      console.log(
        DND_LOG_PREFIX,
        `session=${session.id || '-'} spring-open commit reason=${reason} folders=${formatIdList([...temporaryIds])}`
      );
      return;
    }

    const baseline = session.expandedBeforeDrag || {};
    setExpandedIds(prev => {
      const next = { ...prev };
      let changed = false;
      for (const folderId of temporaryIds) {
        if (baseline[folderId]) {
          if (!next[folderId]) {
            next[folderId] = true;
            changed = true;
          }
        } else if (Object.prototype.hasOwnProperty.call(next, folderId)) {
          delete next[folderId];
          changed = true;
        }
      }
      if (!changed) return prev;
      expandedIdsRef.current = next;
      onExpandChange?.(next);
      return next;
    });
    console.log(
      DND_LOG_PREFIX,
      `session=${session.id || '-'} spring-open restore reason=${reason} folders=${formatIdList([...temporaryIds])}`
    );
  }, [onExpandChange]);

  const clearDragVisualState = useCallback((reason = 'cleanup', options = {}) => {
    const {
      clearPreview = true,
      clearSession = false,
      commitExpansion = false,
      finalizeExpansion = true,
    } = options;
    const session = dragSessionRef.current;
    const sessionId = currentDragSessionId();

    isDraggingGlobalRef.current = false;
    setIsDraggingGlobal(false);
    setOverFolderId(null);
    setIsRootOver(false);
    lastDragClientXRef.current = null;
    lastDragClientYRef.current = null;
    resetScrollHintEdge(reason);
    cancelGlobalAutoExpand(reason);

    if (dragAutoscrollFrameRef.current) {
      cancelAnimationFrame(dragAutoscrollFrameRef.current);
      dragAutoscrollFrameRef.current = null;
    }
    dragAutoscrollLogKeyRef.current = '';
    dragAutoscrollLastStepAtRef.current = 0;
    dragScrollLogKeyRef.current = '';
    dragWheelLogKeyRef.current = '';
    dragPinnedSourceKeyRef.current = '';
    dragNativeEventLogKeyRef.current = '';
    dragNativeEventLastAtRef.current = 0;
    dragHorizontalIntentLogKeyRef.current = '';
    dragVerticalBlockHintLogKeyRef.current = '';
    dragVerticalLimitHintLogKeyRef.current = '';
    setDragPinnedSource(null);
    setDragHorizontalIntent(null);
    setDragVerticalBlockHint(null);
    setDragVerticalLimitHint(null);
    setDragSourceBlock(null);
    setDragFolderMode(false, reason);

    if (clearPreview) {
      setPreviewLayout(null);
      dragPreviewKeyRef.current = '';
    }

    dragSourceDataRef.current = null;
    dragLastModifiersRef.current = { metaKey: false };
    dragGeometryRef.current = null;
    dragAnchorRef.current = null;
    dragLastResolvedActionRef.current = null;
    dragLastBoundaryPreviewRef.current = null;
    dragLastLayoutPreviewRef.current = null;
    dragLastVisualParentPreviewRef.current = null;
    dragLastResolveSnapshotRef.current = null;
    dragGeometryRefreshAppliedSeqRef.current = dragGeometryRefreshSeqRef.current;
    dragGeometryRefreshReasonRef.current = null;

    if (clearSession) {
      if (finalizeExpansion) finalizeTemporaryDragExpansions(session, commitExpansion, reason);
      dragSessionRef.current = null;
      dragPhysicalEndRef.current = null;
      dragPhysicalEndLogKeyRef.current = '';
      dragNativeEventLogKeyRef.current = '';
      dragNativeEventLastAtRef.current = 0;
      dragDropStartedRef.current = false;
    }

    console.log(
      DND_LOG_PREFIX,
      `session=${sessionId} cleanup reason=${reason}` +
      ` clearPreview=${clearPreview ? 1 : 0}` +
      ` clearSession=${clearSession ? 1 : 0}` +
      ` commitExpansion=${commitExpansion ? 1 : 0}` +
      ` finalizeExpansion=${finalizeExpansion ? 1 : 0}` +
      ` wall=${Date.now()}`
    );
    scheduleDragVisualAudit(reason);
  }, [cancelGlobalAutoExpand, currentDragSessionId, finalizeTemporaryDragExpansions, resetScrollHintEdge, scheduleDragVisualAudit, setDragFolderMode, setPreviewLayout]);

  const requestDragGeometryRefresh = useCallback((reason, folderId) => {
    if (!isDraggingGlobalRef.current) return;
    dragGeometryRefreshSeqRef.current += 1;
    const seq = dragGeometryRefreshSeqRef.current;
    dragGeometryRefreshReasonRef.current = { reason, folderId };
    if (dragSessionRef.current) {
      dragSessionRef.current.geometryRefreshPendingSeq = seq;
    }
    console.log(
      DND_LOG_PREFIX,
      `session=${currentDragSessionId()} geometry-refresh request` +
      ` seq=${seq}` +
      ` reason=${reason}` +
      ` folder=${shortPath(folderId)}` +
      ` previewRev=${dragSessionRef.current?.previewRevision ?? '-'}` +
      ` geometryRev=${dragSessionRef.current?.geometryRevision ?? '-'}`
    );
  }, [currentDragSessionId]);

  const scheduleGlobalAutoExpand = useCallback((folderId) => {
    if (!folderId || expandedIdsRef.current[folderId]) {
      cancelGlobalAutoExpand('not-needed');
      return;
    }
    if (globalAutoExpandRef.current?.folderId === folderId) return;
    cancelGlobalAutoExpand('target-changed');
    const sessionId = dragSessionRef.current?.id || null;
    if (!sessionId) return;
    console.log(DND_LOG_PREFIX, `autoexpand schedule folder=${shortPath(folderId)} delay=${DRAG_FOLDER_AUTO_EXPAND_MS}ms`);
    const entry = {
      folderId,
      sessionId,
      timer: null,
      cancelled: false,
    };
    setDragFolderSpringState({ folderId, phase: 'waiting' });
    entry.timer = setTimeout(async () => {
      if (
        entry.cancelled ||
        globalAutoExpandRef.current !== entry ||
        dragSessionRef.current?.id !== sessionId ||
        !isDraggingGlobalRef.current
      ) return;
      if (expandedIdsRef.current[folderId]) {
        console.log(DND_LOG_PREFIX, `autoexpand skip-expanded folder=${shortPath(folderId)}`);
        globalAutoExpandRef.current = null;
        setDragFolderSpringState(null);
        return;
      }
      setDragFolderSpringState({ folderId, phase: 'loading' });
      console.log(DND_LOG_PREFIX, `autoexpand load folder=${shortPath(folderId)} delay=${DRAG_FOLDER_AUTO_EXPAND_MS}ms`);
      try {
        const loadResult = await Promise.resolve(onToggle?.(folderId));
        if (!loadResult || loadResult.ok !== true) {
          console.log(
            DND_LOG_PREFIX,
            `autoexpand load-rejected folder=${shortPath(folderId)}` +
            ` reason=${loadResult?.reason || 'missing-success-result'}`
          );
          if (globalAutoExpandRef.current === entry) globalAutoExpandRef.current = null;
          if (!entry.cancelled) setDragFolderSpringState(null);
          return;
        }
      } catch (error) {
        console.log(DND_LOG_PREFIX, `autoexpand load-error folder=${shortPath(folderId)} message=${error?.message || String(error)}`);
        if (globalAutoExpandRef.current === entry) globalAutoExpandRef.current = null;
        if (!entry.cancelled) setDragFolderSpringState(null);
        return;
      }
      if (
        entry.cancelled ||
        globalAutoExpandRef.current !== entry ||
        dragSessionRef.current?.id !== sessionId ||
        !isDraggingGlobalRef.current
      ) return;

      dragSessionRef.current.temporaryExpandedIds?.add(folderId);
      setExpandedIds(prev => {
        if (prev[folderId]) return prev;
        const next = { ...prev, [folderId]: true };
        expandedIdsRef.current = next;
        onExpandChange?.(next);
        return next;
      });
      requestDragGeometryRefresh('spring-open-loaded', folderId);
      globalAutoExpandRef.current = null;
      setDragFolderSpringState(null);
      console.log(DND_LOG_PREFIX, `autoexpand opened folder=${shortPath(folderId)} session=${sessionId}`);
    }, DRAG_FOLDER_AUTO_EXPAND_MS);
    globalAutoExpandRef.current = entry;
  }, [cancelGlobalAutoExpand, onExpandChange, onToggle, requestDragGeometryRefresh]);

  useEffect(() => {
    return () => cancelGlobalAutoExpand('unmount');
  }, [cancelGlobalAutoExpand]);

  const displayTreeData = useMemo(() => {
    const activeLayout = dragPreviewLayout || sidebarLayout;
    return applySidebarLayout(treeData, activeLayout, folderPath, sortMode);
  }, [treeData, dragPreviewLayout, sidebarLayout, folderPath, sortMode]);

  // Flatten the tree for rendering
  const visibleNodes = useMemo(() => {
    return flattenTree(displayTreeData, expandedIds);
  }, [displayTreeData, expandedIds]);

  const visualTreeMeta = useMemo(() => {
    const nodeById = new Map(visibleNodes.map(node => [node.id, node]));
    const ancestorCache = new Map();

    const getVisualAncestors = (node) => {
      if (!node?.id) return [];
      if (ancestorCache.has(node.id)) return ancestorCache.get(node.id);
      const parent = node.visualParentId ? nodeById.get(node.visualParentId) : null;
      const ancestors = parent ? [...getVisualAncestors(parent), parent.id] : [];
      ancestorCache.set(node.id, ancestors);
      return ancestors;
    };

    const hasLaterSibling = (node, index) => {
      if (!node?.visualParentId) return false;
      const depth = Math.max(0, node.visualDepth || 0);
      for (let i = index + 1; i < visibleNodes.length; i += 1) {
        const next = visibleNodes[i];
        const nextDepth = Math.max(0, next.visualDepth || 0);
        if (nextDepth < depth) return false;
        if (nextDepth === depth) {
          return next.visualParentId === node.visualParentId;
        }
      }
      return false;
    };

    const hasLaterSiblingForAncestorLine = (node, index, lineDepth) => {
      const ancestors = getVisualAncestors(node);
      const parentAtLine = ancestors[lineDepth - 1];
      const childAtLine = ancestors[lineDepth];
      if (!parentAtLine || !childAtLine) return false;
      for (let i = index + 1; i < visibleNodes.length; i += 1) {
        const next = visibleNodes[i];
        const nextDepth = Math.max(0, next.visualDepth || 0);
        if (nextDepth < lineDepth) return false;
        if (nextDepth === lineDepth && next.visualParentId === parentAtLine && next.id !== childAtLine) {
          return true;
        }
      }
      return false;
    };

    const meta = new Map();
    visibleNodes.forEach((node, index) => {
      const visualDepth = Math.max(0, node.visualDepth || 0);
      const visualParent = node.visualParentId ? nodeById.get(node.visualParentId) : null;
      const continuationDepths = [];
      for (let depth = 1; depth < visualDepth; depth += 1) {
        if (hasLaterSiblingForAncestorLine(node, index, depth)) continuationDepths.push(depth);
      }
      meta.set(node.id, {
        hasLaterVisualSibling: hasLaterSibling(node, index),
        visualContinuationDepths: continuationDepths,
        visualParentLevel: visualParent ? (visualParent.level || 0) : (node.level || 0),
      });
    });
    return meta;
  }, [visibleNodes]);

  const dragSourceBlockMeta = useMemo(() => {
    const ids = new Set(dragSourceBlock?.ids || []);
    const roots = new Set(dragSourceBlock?.rootIds || []);
    const meta = new Map();
    visibleNodes.forEach((node, index) => {
      if (!ids.has(node.id)) return;
      meta.set(node.id, {
        isRoot: roots.has(node.id),
        isFirst: index === 0 || !ids.has(visibleNodes[index - 1]?.id),
        isLast: index === visibleNodes.length - 1 || !ids.has(visibleNodes[index + 1]?.id),
      });
    });
    return meta;
  }, [dragSourceBlock, visibleNodes]);

  useEffect(() => {
    visibleNodesRef.current = visibleNodes;
  }, [visibleNodes]);

  // Lookup map: id → raw recursive node. IndexButton needs the children of a
  // folder, but flattenTree strips them. Built once per treeData change.
  const nodeMap = useMemo(() => {
    const map = new Map()
    const walk = (nodes) => {
      for (const n of nodes) {
        map.set(n.id, n)
        if (n.children) walk(n.children)
      }
    }
    walk(displayTreeData)
    return map
  }, [displayTreeData])

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const scroll = getScrollSnapshot();
    const scroller = getScroller();
    const flipTranslateLimit = Math.max(
      FLIP_MIN_TRANSLATE_LIMIT_PX,
      Math.min(8192, scroller?.scrollHeight || 0)
    );
    const previousScrollTop = rowRectsScrollTopRef.current || 0;
    const flipScrollDelta = scroll.scrollTop - previousScrollTop;
    const rows = Array.from(root.querySelectorAll('.arborist-node[data-node-id]'));
    const interruptedRects = new Map();
    for (const row of rows) {
      const key = rowKey(row.dataset.nodeId);
      const animation = rowAnimationsRef.current.get(key);
      if (!animation) continue;
      const rect = row.getBoundingClientRect();
      interruptedRects.set(key, { top: rect.top, left: rect.left, width: rect.width, height: rect.height });
      animation.cancel();
      rowAnimationsRef.current.delete(key);
    }
    if (isDraggingGlobal && interruptedRects.size > 0) {
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} flip-interrupt rows=${interruptedRects.size}`
      );
    }
    const nextRects = new Map();
    const nextSignature = visibleNodes
      .map(node => [
        node.id,
        node.level ?? 0,
        node.visualDepth ?? 0,
        node.visualParentId || '',
      ].join(':'))
      .join('|');

    for (const row of rows) {
      const key = rowKey(row.dataset.nodeId);
      const rect = row.getBoundingClientRect();
      nextRects.set(key, { top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    }

    if (rowSignatureRef.current === nextSignature) {
      if (isDraggingGlobal) {
        console.log(
          DND_LOG_PREFIX,
          `session=${currentDragSessionId()} flip baseline-refresh rows=${rows.length}`
        );
      }
      rowRectsRef.current = nextRects;
      rowRectsScrollTopRef.current = scroll.scrollTop;
      return;
    }

    if (isDraggingGlobal && !dragPreviewLayout) {
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} flip baseline-refresh reason=non-layout-drag rows=${rows.length}`
      );
      rowRectsRef.current = nextRects;
      rowRectsScrollTopRef.current = scroll.scrollTop;
      rowSignatureRef.current = nextSignature;
      return;
    }

    const flipDeltas = [];
    const skippedFlipDeltas = [];
    for (const row of rows) {
      const key = rowKey(row.dataset.nodeId);
      const prev = rowRectsRef.current.get(key);
      const interrupted = interruptedRects.get(key);
      const next = nextRects.get(key);
      if ((!prev && !interrupted) || !next) continue;
      const basisLeft = interrupted ? interrupted.left : prev.left;
      const basisTop = interrupted ? interrupted.top : (prev.top - flipScrollDelta);
      const dx = basisLeft - next.left;
      const dy = basisTop - next.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      if (Math.abs(dx) > flipTranslateLimit || Math.abs(dy) > flipTranslateLimit) {
        const prior = rowAnimationsRef.current.get(key);
        if (prior) prior.cancel();
        rowAnimationsRef.current.delete(key);
        skippedFlipDeltas.push({
          id: row.dataset.nodeId,
          dx,
          dy,
        });
        continue;
      }
      flipDeltas.push({
        id: row.dataset.nodeId,
        dx,
        dy,
      });

      const prior = rowAnimationsRef.current.get(key);
      if (prior) prior.cancel();
      const animation = row.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        {
          duration: isDraggingGlobal ? 120 : 150,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        }
      );
      rowAnimationsRef.current.set(key, animation);
      animation.onfinish = () => {
        if (rowAnimationsRef.current.get(key) === animation) rowAnimationsRef.current.delete(key);
      };
      animation.oncancel = animation.onfinish;
    }

    if (isDraggingGlobal && flipDeltas.length > 0) {
      const sorted = [...flipDeltas].sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy));
      const maxDy = sorted[0]?.dy || 0;
      const offenders = sorted
        .slice(0, 6)
        .map(item => `${shortPath(item.id)}:${Math.round(item.dy)}`)
        .join(',');
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} flip rows=${flipDeltas.length}` +
        ` maxDy=${Math.round(maxDy)} scrollDelta=${Math.round(flipScrollDelta)} offenders=${offenders}`
      );
    }

    if (isDraggingGlobal && skippedFlipDeltas.length > 0) {
      const sorted = [...skippedFlipDeltas].sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy));
      const maxDy = sorted[0]?.dy || 0;
      const offenders = sorted
        .slice(0, 6)
        .map(item => `${shortPath(item.id)}:${Math.round(item.dy)}`)
        .join(',');
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} flip-skip-large rows=${skippedFlipDeltas.length}` +
        ` maxDy=${Math.round(maxDy)} scrollDelta=${Math.round(flipScrollDelta)}` +
        ` limit=${Math.round(flipTranslateLimit)} offenders=${offenders}`
      );
    }

    rowRectsRef.current = nextRects;
    rowRectsScrollTopRef.current = scroll.scrollTop;
    rowSignatureRef.current = nextSignature;
  }, [visibleNodes, isDraggingGlobal, dragPreviewLayout, currentDragSessionId, getScrollSnapshot]);

  useEffect(() => {
    return () => {
      for (const animation of rowAnimationsRef.current.values()) animation.cancel();
      rowAnimationsRef.current.clear();
      rowRectsRef.current.clear();
      rowRectsScrollTopRef.current = 0;
      rowSignatureRef.current = '';
    };
  }, []);

  useLayoutEffect(() => {
    if (!isDraggingGlobalRef.current || !dragSessionRef.current?.sourceId) return;
    updatePinnedDragSource(dragSessionRef.current.sourceId, 'render');
  }, [visibleNodes, isDraggingGlobal, dragPreviewLayout, updatePinnedDragSource]);

  const captureDragGeometry = useCallback((pointerY = null, sourceId = null) => {
    const root = containerRef.current;
    if (!root) return null;
    const nodesById = new Map(visibleNodesRef.current.map(node => [node.id, node]));
    const rows = Array.from(root.querySelectorAll('.arborist-node[data-node-id]'))
      .map(element => {
        const id = element.dataset.nodeId;
        const node = nodesById.get(id);
        if (!id || !node) return null;
        const rect = readRowLayoutRect(
          element,
          rowAnimationsRef.current.has(rowKey(id))
        );
        return {
          id,
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            mid: rect.mid,
            height: rect.height,
            flipTranslateY: rect.translateY,
          },
          parentKey: pathParentKey(id, folderPath),
          isDirectory: !!node.isDirectory,
          isLink: !!node.isLink,
          visualParentId: node.visualParentId,
        };
      })
      .filter(Boolean);

    const sourceRow = sourceId
      ? (rows.find(row => row.id === sourceId) || null)
      : (pointerY == null ? null : rows.find(row => pointerY >= row.rect.top && pointerY <= row.rect.bottom));
    return { rows, sourceRow };
  }, [folderPath]);

  const collectVisualChildren = useCallback((id, nodesById) => {
    const result = [];
    const addChildren = (parentId) => {
      for (const node of visibleNodesRef.current) {
        if (node.visualParentId !== parentId || result.includes(node.id)) continue;
        result.push(node.id);
        addChildren(node.id);
      }
    };
    if (nodesById.has(id)) addChildren(id);
    return result;
  }, []);

  const normalizeDragSelection = useCallback((sourceData, nodeById, orderedIds) => {
    const rawSelectedIds = Array.isArray(sourceData?.selectedIds) && sourceData.selectedIds.includes(sourceData.fileId)
      ? sourceData.selectedIds.filter(id => nodeById.has(id))
      : [sourceData.fileId];
    const hierarchyItems = orderedIds
      .filter(id => nodeById.has(id))
      .map((id, position) => ({
        id,
        parentId: nodeById.get(id)?.visualParentId || null,
        position,
      }));
    const selectedRootIds = normalizeSelectedVisualRootIds(hierarchyItems, rawSelectedIds, {
      parentKey: 'parentId',
    });
    return {
      rawSelectedIds,
      selectedRootIds: selectedRootIds.length > 0 ? selectedRootIds : [sourceData.fileId],
      isMultiSelection: rawSelectedIds.length > 1,
    };
  }, []);

  const resolveSidebarDrag = useCallback((sourceData, effectiveY, rawY = effectiveY, modifiers = {}) => {
    const initialGeometry = dragGeometryRef.current;
    const scroll = getScrollSnapshot();
    const startScrollTop = dragSessionRef.current?.startScrollTop ?? scroll.scrollTop;
    const geometryScrollTop = Number.isFinite(initialGeometry?.scrollTop)
      ? initialGeometry.scrollTop
      : startScrollTop;
    const targetScrollDelta = scroll.scrollTop - geometryScrollTop;
    let targetSource = initialGeometry?.source || 'snapshot-scroll';
    let geometry = initialGeometry?.rows?.length
      ? {
          ...initialGeometry,
          rows: initialGeometry.rows.map(row => ({
            ...row,
            rect: {
              ...row.rect,
              top: row.rect.top - targetScrollDelta,
              bottom: row.rect.bottom - targetScrollDelta,
              mid: row.rect.mid - targetScrollDelta,
            },
          })),
          sourceRow: initialGeometry.sourceRow
            ? {
                ...initialGeometry.sourceRow,
                rect: {
                  ...initialGeometry.sourceRow.rect,
                  top: initialGeometry.sourceRow.rect.top - targetScrollDelta,
                  bottom: initialGeometry.sourceRow.rect.bottom - targetScrollDelta,
                  mid: initialGeometry.sourceRow.rect.mid - targetScrollDelta,
                },
              }
            : null,
        }
      : null;

    if (!geometry) {
      const liveGeometry = captureDragGeometry();
      geometry = liveGeometry?.rows?.length ? liveGeometry : null;
      targetSource = geometry ? 'live-fallback' : 'none';
    }
    if (!geometry || !sourceData?.fileId || !folderPath) {
      logResolveReject(
        'missing-input',
        `hasGeometry=${geometry ? 1 : 0} targetSource=${targetSource}` +
        ` targetScrollDelta=${Math.round(targetScrollDelta)}` +
        ` source=${shortPath(sourceData?.fileId)}` +
        ` hasFolder=${folderPath ? 1 : 0} rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
      );
      return null;
    }
    const isFolderDropMode = !!modifiers.metaKey;
    const mode = isFolderDropMode ? 'cmd-folder' : 'flat-reorder';
    const rawX = Number.isFinite(modifiers.clientX) ? modifiers.clientX : null;
    const startX = Number.isFinite(dragSessionRef.current?.startX) ? dragSessionRef.current.startX : rawX;
    const horizontalBaseX = Number.isFinite(dragSessionRef.current?.horizontalBaseX)
      ? dragSessionRef.current.horizontalBaseX
      : startX;
    const deltaX = rawX == null || horizontalBaseX == null ? 0 : rawX - horizontalBaseX;

    const rows = geometry.rows;
    const nodeById = new Map(visibleNodesRef.current.map(node => [node.id, node]));
    const sourceNode = nodeById.get(sourceData.fileId);
    if (!sourceNode) {
      logResolveReject(
        'missing-source-node',
        `source=${shortPath(sourceData.fileId)} rows=${rows.length}` +
        ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
      );
      return null;
    }

    const {
      rawSelectedIds,
      selectedRootIds: selectedIds,
      isMultiSelection,
    } = normalizeDragSelection(sourceData, nodeById, rows.map(row => row.id));
    const sourceBlockIds = (() => {
      if (!isMultiSelection) {
        return [sourceData.fileId, ...collectVisualChildren(sourceData.fileId, nodeById)];
      }
      const expanded = new Set();
      selectedIds.forEach(id => {
        if (!nodeById.has(id)) return;
        expanded.add(id);
        collectVisualChildren(id, nodeById).forEach(childId => expanded.add(childId));
      });
      return rows
        .map(row => row.id)
        .filter(id => expanded.has(id));
    })();
    const sourceRenderBlockIds = (() => {
      const fromSession = dragSessionRef.current?.sourceRenderBlockIds;
      if (Array.isArray(fromSession) && fromSession.length > 0) {
        return rows.map(row => row.id).filter(id => fromSession.includes(id));
      }
      return sourceBlockIds;
    })();
    const sourceSet = new Set(sourceBlockIds);
    const sourceRenderSet = new Set(sourceRenderBlockIds);
    let targetRow = rows.find(row => effectiveY >= row.rect.top && effectiveY <= row.rect.bottom) || null;
    if (!targetRow && rows.length > 0) {
      const first = rows[0];
      const last = rows[rows.length - 1];
      if (effectiveY < first.rect.top) {
        targetRow = first;
      } else if (effectiveY > last.rect.bottom) {
        targetRow = { id: '__root_end__', parentKey: ROOT_PARENT, isRootEnd: true, rect: last.rect };
      }
    }
    if (!targetRow) {
      const first = rows[0]?.rect;
      const last = rows[rows.length - 1]?.rect;
      logResolveReject(
        'no-target-row',
        `source=${shortPath(sourceData.fileId)} rows=${rows.length}` +
        ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}` +
        ` targetSource=${targetSource} targetScrollDelta=${Math.round(targetScrollDelta)}` +
        ` first=${formatRect(first)} last=${formatRect(last)}`
      );
      return null;
    }

    const targetNode = nodeById.get(targetRow.id);
    const withinTop = !targetRow.isRootEnd && effectiveY <= targetRow.rect.top + EDGE_THRESHOLD_PX;
    const withinBottom = !targetRow.isRootEnd && effectiveY >= targetRow.rect.bottom - EDGE_THRESHOLD_PX;
    const edge = targetRow.isRootEnd
      ? 'bottom'
      : (!isFolderDropMode
          ? (effectiveY < targetRow.rect.mid ? 'top' : 'bottom')
          : (withinTop ? 'top' : (withinBottom ? 'bottom' : null)));
    const rowParentKey = targetRow.isRootEnd
      ? ROOT_PARENT
      : (targetRow.parentKey || pathParentKey(targetRow.id, folderPath));
    const sourceParentKey = pathParentKey(sourceData.fileId, folderPath);
    const selectedSourceParentKeys = new Set(sourceBlockIds.map(id => pathParentKey(id, folderPath)));

    const destinationForParentKey = (parentKey) => parentKey === ROOT_PARENT ? folderPath : parentKey;
    const canVirtualLayout = sourceBlockIds.every(id => pathParentKey(id, folderPath) === rowParentKey);
    const baseSidebarLayout = normalizeSidebarLayout(sidebarLayout);
    const dragVisualParentOverrides = dragSessionRef.current?.visualParentByPath || {};
    const visualParentByPath = { ...(baseSidebarLayout.visualParentByPath || {}) };
    Object.entries(dragVisualParentOverrides).forEach(([id, parentId]) => {
      if (parentId) {
        visualParentByPath[id] = parentId;
      } else {
        delete visualParentByPath[id];
      }
    });
    const normalizedSidebarLayout = normalizeSidebarLayout({
      ...baseSidebarLayout,
      visualParentByPath,
    });
    const sourceVisualParentId = hasOwn(dragVisualParentOverrides, sourceData.fileId)
      ? dragVisualParentOverrides[sourceData.fileId] || null
      : (
          normalizedSidebarLayout.visualParentByPath?.[sourceData.fileId] ||
          sourceNode.visualParentId ||
          null
        );

    const commonDetail = (detailParentKey = rowParentKey) => ({
      targetId: targetRow.isRootEnd ? 'ROOT_END' : targetRow.id,
      targetName: targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id),
      targetParentKey: detailParentKey,
      hoveredParentKey: rowParentKey,
      sourceParentKey,
      sourceParentKeys: [...selectedSourceParentKeys],
      sourceKind: sourceNode.isDirectory ? 'dir' : (sourceNode.isLink ? 'link' : 'file'),
      targetKind: targetRow.isRootEnd ? 'root-end' : (targetNode?.isDirectory ? 'dir' : (targetNode?.isLink ? 'link' : 'file')),
      targetSource,
      targetScrollDelta,
      canVirtualLayout,
      edge: edge || 'center',
      rawX: rawX == null ? null : Math.round(rawX),
      horizontalBaseX: horizontalBaseX == null ? null : Math.round(horizontalBaseX),
      deltaX: Math.round(deltaX),
      rawY: Math.round(rawY),
      effectiveY: Math.round(effectiveY),
      sourceIds: sourceBlockIds,
      sourceRenderIds: sourceRenderBlockIds,
      mode,
    });

    const buildLayout = (kind, parentKey, nextOrder, meta = {}) => {
      const next = cloneLayout(normalizedSidebarLayout);
      next.orderByParent[parentKey] = nextOrder;
      return {
        kind: 'layout',
        layout: next,
        detail: kind,
        nextOrderSize: nextOrder.length,
        ...meta,
        ...commonDetail(parentKey),
      };
    };

    const rowParentSiblingOrder = rows
      .filter(row => row.parentKey === rowParentKey && !row.isRootEnd)
      .map(row => row.id)
      .filter(id => nodeById.has(id));

    if (
      isFolderDropMode &&
      !targetRow.isRootEnd &&
      selectedIds.some(id => (
        nodeById.get(id)?.isDirectory &&
        (targetRow.id === id || targetRow.id.startsWith(`${id}/`))
      ))
    ) {
      logResolveReject(
        'cmd-folder-self-disabled',
        `source=${shortPath(sourceData.fileId)} target=${shortPath(targetRow.id)}` +
        ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
      );
      return null;
    }

    if (isFolderDropMode && targetNode?.isDirectory) {
      if (targetNode.id === destinationForParentKey(sourceParentKey)) {
        logResolveReject(
          'cmd-current-folder-noop',
          `source=${shortPath(sourceData.fileId)} sourceParent=${shortPath(sourceParentKey)}` +
          ` target=${shortPath(targetNode.id)} rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
        );
        return null;
      }
      const targetIsExpanded = !!expandedIdsRef.current[targetNode.id];
      const targetHasChildren = Array.isArray(targetNode.children) && targetNode.children.length > 0;
      if (!targetIsExpanded || targetHasChildren) {
        return {
          kind: 'move',
          destinationFolder: null,
          isRoot: false,
          overFolderId: targetNode.id,
          detail: 'spring-open-folder',
          springOpenOnly: true,
          ...commonDetail(),
          edge: 'center',
        };
      }
      return {
        kind: 'move',
        destinationFolder: targetNode.id,
        isRoot: false,
        overFolderId: targetNode.id,
        detail: 'move-into-folder',
        ...commonDetail(),
        edge: 'center',
      };
    }

    if (!isFolderDropMode) {
      if (selectedSourceParentKeys.size !== 1) {
        logResolveReject(
          'mixed-parents',
          `source=${shortPath(sourceData.fileId)} parents=${formatIdList([...selectedSourceParentKeys])}` +
          ` target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}` +
          ` hoverParent=${shortPath(rowParentKey)} rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
        );
        return null;
      }

      const sourceParentRows = rows.filter(row => row.parentKey === sourceParentKey && !row.isRootEnd && nodeById.has(row.id));
      const sourceParentOrder = sourceParentRows.map(row => row.id);
      const withoutSource = sourceParentOrder.filter(id => !sourceSet.has(id));
      if (withoutSource.length === 0 && sourceParentOrder.length === 0) {
        logResolveReject(
          'empty-source-parent',
          `source=${shortPath(sourceData.fileId)} sourceParent=${shortPath(sourceParentKey)}` +
          ` target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}`
        );
        return null;
      }

      const boundaryClamp = rowParentKey !== sourceParentKey;
      if (boundaryClamp) {
        logResolveReject(
          'flat-parent-clamp',
          `source=${shortPath(sourceData.fileId)} sourceParent=${shortPath(sourceParentKey)}` +
          ` hoverParent=${shortPath(rowParentKey)} target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}` +
          ` sourceRows=${sourceParentOrder.length} rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
        );
      }

      let insertIndex = withoutSource.length;
      for (const row of sourceParentRows) {
        if (sourceSet.has(row.id)) continue;
        if (effectiveY < row.rect.mid) {
          insertIndex = withoutSource.indexOf(row.id);
          break;
        }
      }
      if (insertIndex < 0) insertIndex = withoutSource.length;

      const nextOrder = [...withoutSource];
      const boundedInsertIndex = Math.max(0, Math.min(insertIndex, nextOrder.length));
      nextOrder.splice(boundedInsertIndex, 0, ...sourceBlockIds);

      const orderChanged = !sameOrder(sourceParentOrder, nextOrder);
      const singleFileDrag = rawSelectedIds.length === 1 && !sourceNode.isDirectory;
      const visualParentForId = (id) => {
        if (hasOwn(dragVisualParentOverrides, id)) return dragVisualParentOverrides[id] || null;
        return (
          normalizedSidebarLayout.visualParentByPath?.[id] ||
          nodeById.get(id)?.visualParentId ||
          null
        );
      };
      const visualDepthForId = (id) => {
        let depth = 0;
        let cursor = visualParentForId(id);
        const seen = new Set([id]);
        while (cursor && !seen.has(cursor) && nodeById.has(cursor)) {
          seen.add(cursor);
          depth += 1;
          cursor = visualParentForId(cursor);
        }
        return depth;
      };
      const sourceVisualDepth = visualDepthForId(sourceData.fileId);
      const folderHorizontalIntentMeta = sourceNode.isDirectory && rawSelectedIds.length === 1
        ? {
            visualCanLeft: false,
            visualCanRight: false,
            sourceVisualDepth,
            visualLeftThresholdPx: DRAG_VISUAL_DETACH_THRESHOLD_PX,
            visualRightThresholdPx: DRAG_VISUAL_ATTACH_THRESHOLD_PX,
            visualIntentThresholdPx: deltaX < 0
              ? DRAG_VISUAL_DETACH_THRESHOLD_PX
              : DRAG_VISUAL_ATTACH_THRESHOLD_PX,
            visualBlockedDirection: deltaX < -2 ? 'left' : (deltaX > 2 ? 'right' : null),
          }
        : {};
      const visualRows = rows.filter(row => !row.isRootEnd && nodeById.has(row.id));
      const visualAncestorAtDepth = (id, targetDepth) => {
        if (!id || targetDepth < 0 || !nodeById.has(id)) return null;
        let cursor = id;
        let depth = visualDepthForId(cursor);
        const seen = new Set();
        while (cursor && depth > targetDepth && !seen.has(cursor)) {
          seen.add(cursor);
          cursor = visualParentForId(cursor);
          depth -= 1;
        }
        return depth === targetDepth ? cursor : null;
      };
      const isVisualDescendantOf = (id, ancestorId) => {
        if (!id || !ancestorId || id === ancestorId) return false;
        let cursor = visualParentForId(id);
        const seen = new Set([id]);
        while (cursor && !seen.has(cursor) && nodeById.has(cursor)) {
          if (cursor === ancestorId) return true;
          seen.add(cursor);
          cursor = visualParentForId(cursor);
        }
        return false;
      };
      const collectVisualBlockIds = (rootId) => {
        if (!rootId || !nodeById.has(rootId)) return [];
        const allNodes = visualRows;
        const rootIndex = allNodes.findIndex(node => node.id === rootId);
        if (rootIndex < 0) return [];
        const ids = [rootId];
        for (let i = rootIndex + 1; i < allNodes.length; i += 1) {
          const id = allNodes[i].id;
          if (!isVisualDescendantOf(id, rootId)) break;
          ids.push(id);
        }
        return ids;
      };
      const collectRenderBlockIds = (rootId) => {
        const rootNode = nodeById.get(rootId);
        if (!rootNode) return [];
        if (rootNode.isDirectory) {
          const prefix = `${rootId}/`;
          return visualRows
            .map(row => row.id)
            .filter(id => id === rootId || id.startsWith(prefix));
        }
        return collectVisualBlockIds(rootId);
      };
      const physicalRootAtSourceParent = (id) => {
        let cursor = id;
        const seen = new Set();
        while (cursor && !seen.has(cursor) && nodeById.has(cursor)) {
          seen.add(cursor);
          if (pathParentKey(cursor, folderPath) === sourceParentKey) return cursor;
          const parentId = pathParentKey(cursor, folderPath);
          if (!parentId || parentId === ROOT_PARENT || parentId === cursor) return null;
          cursor = parentId;
        }
        return null;
      };
      const collectVisualAncestorChainIds = (id) => {
        if (!id || !nodeById.has(id)) return [];
        const ids = [];
        const seen = new Set([id]);
        let cursor = visualParentForId(id);
        while (cursor && !seen.has(cursor) && nodeById.has(cursor)) {
          seen.add(cursor);
          ids.push(cursor);
          cursor = visualParentForId(cursor);
        }
        return ids.reverse();
      };
      const collectVisualPathIds = (id) => {
        if (!id || !nodeById.has(id)) return [];
        return [...collectVisualAncestorChainIds(id), id];
      };
      const sourceVisibleIndices = sourceRenderBlockIds
        .map(id => visualRows.findIndex(node => node.id === id))
        .filter(index => index >= 0);
      const sourceBlockFirstVisibleIndex = sourceVisibleIndices.length
        ? Math.min(...sourceVisibleIndices)
        : -1;
      const sourceBlockLastVisibleIndex = sourceVisibleIndices.length
        ? Math.max(...sourceVisibleIndices)
        : -1;
      const rowById = new Map(visualRows.map(row => [row.id, row]));
      const liveRowRectById = (id) => {
        const root = containerRef.current;
        if (!root || !id) return null;
        const element = Array.from(root.querySelectorAll('.arborist-node[data-node-id]'))
          .find(row => row.dataset.nodeId === id);
        if (!element) return null;
        const rect = readRowLayoutRect(
          element,
          rowAnimationsRef.current.has(rowKey(id))
        );
        return {
          top: rect.top,
          bottom: rect.bottom,
          mid: rect.mid,
          height: rect.height,
        };
      };
      const sourceBlockRects = sourceRenderBlockIds
        .map(id => rowById.get(id)?.rect)
        .filter(rect => rect && Number.isFinite(rect.top) && Number.isFinite(rect.bottom));
      const sourceBlockCurrentTop = sourceBlockRects.length
        ? Math.min(...sourceBlockRects.map(rect => rect.top))
        : null;
      const sourceBlockCurrentBottom = sourceBlockRects.length
        ? Math.max(...sourceBlockRects.map(rect => rect.bottom))
        : null;
      const sourceBlockHeight = sourceBlockRects.reduce((sum, rect) => (
        sum + (Number.isFinite(rect.height) ? rect.height : Math.max(0, rect.bottom - rect.top))
      ), 0) || 28;
      const visibleSourceParentIds = new Set(sourceParentOrder);
      const previewParentOrder = normalizeSidebarLayout(
        dragSessionRef.current?.previewLayout || dragPreviewLayoutRef.current
      )
        .orderByParent?.[sourceParentKey];
      const currentSourceParentOrder = Array.isArray(previewParentOrder)
        ? [
            ...previewParentOrder.filter(id => visibleSourceParentIds.has(id)),
            ...sourceParentOrder.filter(id => !previewParentOrder.includes(id)),
          ]
        : sourceParentOrder;
      const relativeSide = (order, blockIds) => {
        if (!Array.isArray(order) || order.length === 0 || !Array.isArray(blockIds) || blockIds.length === 0) return null;
        const sourceIndices = sourceBlockIds
          .map(id => order.indexOf(id))
          .filter(index => index >= 0);
        const blockIndices = blockIds
          .map(id => order.indexOf(id))
          .filter(index => index >= 0);
        if (sourceIndices.length === 0 || blockIndices.length === 0) return null;
        const sourceFirst = Math.min(...sourceIndices);
        const sourceLast = Math.max(...sourceIndices);
        const blockFirst = Math.min(...blockIndices);
        const blockLast = Math.max(...blockIndices);
        if (sourceLast < blockFirst) return 'before';
        if (sourceFirst > blockLast) return 'after';
        return null;
      };
	      const adjacentSide = (order, blockIds) => {
	        if (!Array.isArray(order) || order.length === 0 || !Array.isArray(blockIds) || blockIds.length === 0) return null;
	        const sourceIndices = sourceBlockIds
	          .map(id => order.indexOf(id))
          .filter(index => index >= 0);
        const blockIndices = blockIds
          .map(id => order.indexOf(id))
          .filter(index => index >= 0);
        if (sourceIndices.length === 0 || blockIndices.length === 0) return null;
        const sourceFirst = Math.min(...sourceIndices);
        const sourceLast = Math.max(...sourceIndices);
        const blockFirst = Math.min(...blockIndices);
        const blockLast = Math.max(...blockIndices);
	        if (sourceLast + 1 === blockFirst) return 'before';
	        if (blockLast + 1 === sourceFirst) return 'after';
	        return null;
	      };
	      const getFolderRenderBlockBoundary = () => {
	        if (isFolderDropMode || !sourceNode.isDirectory || selectedIds.length !== 1) return null;
	        if (sourceBlockCurrentTop == null || sourceBlockCurrentBottom == null) return null;

	        const sourceOrderIds = sourceBlockIds.filter(id => sourceParentOrder.includes(id));
	        if (sourceOrderIds.length === 0) return null;
	        const sourceOrderSet = new Set(sourceOrderIds);
	        const sourceIndices = sourceOrderIds
	          .map(id => sourceParentOrder.indexOf(id))
	          .filter(index => index >= 0)
	          .sort((a, b) => a - b);
	        if (sourceIndices.length !== sourceOrderIds.length) return null;

	        const sourceFirstIndex = sourceIndices[0];
	        const sourceLastIndex = sourceIndices[sourceIndices.length - 1];
	        const sourceIsContiguous = sourceIndices.every((index, offset) => index === sourceFirstIndex + offset);
	        if (!sourceIsContiguous) return null;

	        const sideForRoot = (rootId) => {
	          const rootIndex = sourceParentOrder.indexOf(rootId);
	          if (rootIndex < 0) return null;
	          if (sourceLastIndex < rootIndex) return 'before';
	          if (sourceFirstIndex > rootIndex) return 'after';
	          return null;
	        };
	        const buildHold = (detail = 'reorder-folder-block-hold', limitDirection = null) => (
	          buildLayout(detail, sourceParentKey, sourceParentOrder, {
	            insertIndex: sourceParentOrder.indexOf(sourceData.fileId),
	            orderChanged: false,
	            sourceParentSize: sourceParentOrder.length,
	            folderRenderBlock: true,
	            verticalLimitDirection: limitDirection,
	            verticalLimitReason: limitDirection ? 'folder-boundary' : null,
	            verticalLimitTargetId: limitDirection ? sourceData.fileId : null,
	            ...folderHorizontalIntentMeta,
	          })
	        );

	        if (effectiveY >= sourceBlockCurrentTop && effectiveY <= sourceBlockCurrentBottom) {
	          return buildHold();
	        }

	        let rootId = null;
	        if (targetRow.isRootEnd) {
	          rootId = sourceParentOrder.findLast(id => !sourceOrderSet.has(id)) || null;
	        } else if (targetRow.id) {
	          const physicalRootId = physicalRootAtSourceParent(targetRow.id);
	          if (physicalRootId) {
	            const targetDepth = visualDepthForId(physicalRootId);
	            rootId = targetDepth > 0
	              ? visualAncestorAtDepth(physicalRootId, 0)
	              : physicalRootId;
	          }
	        }

	        if (!rootId || sourceOrderSet.has(rootId)) {
	          const limitDirection = effectiveY < sourceBlockCurrentTop
	            ? 'up'
	            : (effectiveY > sourceBlockCurrentBottom ? 'down' : null);
	          return buildHold(limitDirection ? 'vertical-limit' : 'reorder-folder-block-hold', limitDirection);
	        }

	        const side = sideForRoot(rootId);
	        const targetRenderIds = collectRenderBlockIds(rootId).filter(id => !sourceRenderSet.has(id));
	        const rootRow = rowById.get(rootId);
	        const lastTargetRow = rowById.get(targetRenderIds[targetRenderIds.length - 1]);
	        if (
	          (side !== 'before' && side !== 'after') ||
	          targetRenderIds.length === 0 ||
	          !rootRow?.rect ||
	          !lastTargetRow?.rect
	        ) {
	          return buildHold();
	        }

	        const exitedSource = side === 'before'
	          ? effectiveY > sourceBlockCurrentBottom
	          : effectiveY < sourceBlockCurrentTop;
	        const thresholdY = side === 'before'
	          ? lastTargetRow.rect.mid
	          : rootRow.rect.mid;
	        const crossed = exitedSource && (
	          side === 'before'
	            ? effectiveY >= thresholdY
	            : effectiveY <= thresholdY
	        );
	        const direction = side === 'before' ? 'down' : 'up';
	        const withoutSource = sourceParentOrder.filter(id => !sourceOrderSet.has(id));
	        const targetIndex = withoutSource.indexOf(rootId);
	        const nextOrder = crossed ? [...withoutSource] : [...sourceParentOrder];
	        if (crossed) {
	          const insertIndex = side === 'before' ? targetIndex + 1 : targetIndex;
	          nextOrder.splice(
	            Math.max(0, Math.min(insertIndex, withoutSource.length)),
	            0,
	            ...sourceOrderIds
	          );
	        }

	        return buildLayout('reorder-visual-block-boundary', sourceParentKey, nextOrder, {
	          insertIndex: nextOrder.indexOf(sourceData.fileId),
	          orderChanged: !sameOrder(sourceParentOrder, nextOrder),
	          sourceParentSize: sourceParentOrder.length,
	          folderRenderBlock: true,
	          verticalBlockBoundaryKind: 'physical-folder',
	          verticalBlockBoundaryDirection: direction,
	          verticalBlockBoundaryCrossed: crossed,
	          verticalBlockBoundarySide: crossed
	            ? (direction === 'down' ? 'after' : 'before')
	            : side,
	          verticalBlockBoundaryThresholdY: thresholdY,
	          verticalBlockBoundaryPhase: exitedSource ? 'target' : 'source',
	          verticalBlockBoundaryIds: targetRenderIds,
	          verticalBlockHintAllowSingle: true,
	          verticalBlockHintReason: 'physical-folder-boundary',
	          verticalBlockHintIds: exitedSource ? targetRenderIds : [],
	          verticalBlockHintRootId: rootId,
	          verticalBlockHintTargetId: rootId,
	          verticalBlockSourceHeight: sourceBlockHeight,
	          ...folderHorizontalIntentMeta,
	        });
	      };
	      const folderRenderBlockBoundary = getFolderRenderBlockBoundary();
	      if (folderRenderBlockBoundary) return folderRenderBlockBoundary;
	      const getAdjacentBlockBoundary = () => {
	        if (isFolderDropMode || sourceNode.isDirectory || targetRow.isRootEnd || !targetRow.id) return null;
        const activeBoundary = dragSessionRef.current?.activeBlockBoundary || null;
        const targetIsSourceBlock = sourceSet.has(targetRow.id);
        const activeBoundarySourceMatches =
          activeBoundary?.sourceId === sourceData.fileId &&
          activeBoundary?.sourceParentKey === sourceParentKey &&
          Array.isArray(activeBoundary.ids) &&
          activeBoundary.ids.length > 1 &&
          activeBoundary.ids.every(id => nodeById.has(id)) &&
          (!activeBoundary.rootId || nodeById.has(activeBoundary.rootId));
        const activeBoundaryVisualMatches =
          activeBoundarySourceMatches &&
          activeBoundary.sourceVisualDepth === sourceVisualDepth &&
          (activeBoundary.sourceVisualParentId || null) === (sourceVisualParentId || null);
        const activeBoundaryMatches =
          activeBoundaryVisualMatches &&
          (activeBoundary.ids.includes(targetRow.id) || targetIsSourceBlock);
        const activeBoundarySide =
          activeBoundaryMatches && (activeBoundary.side === 'before' || activeBoundary.side === 'after')
            ? activeBoundary.side
            : null;
        if (activeBoundary && String(targetSource).startsWith('refresh-block-boundary')) {
          logResolveReject(
            'active-boundary-probe',
            `source=${shortPath(sourceData.fileId)}` +
            ` activeSource=${shortPath(activeBoundary.sourceId)}` +
            ` sourceParent=${shortPath(sourceParentKey)}` +
            ` activeParent=${shortPath(activeBoundary.sourceParentKey)}` +
            ` activeSide=${activeBoundary.side || '-'}` +
            ` target=${shortPath(targetRow.id)}` +
            ` targetIsSource=${targetIsSourceBlock ? 1 : 0}` +
            ` targetInIds=${Array.isArray(activeBoundary.ids) && activeBoundary.ids.includes(targetRow.id) ? 1 : 0}` +
            ` sourceOk=${activeBoundarySourceMatches ? 1 : 0}` +
            ` visualOk=${activeBoundaryVisualMatches ? 1 : 0}` +
            ` activeDepth=${activeBoundary.sourceVisualDepth ?? '-'}` +
            ` currentDepth=${sourceVisualDepth}` +
            ` activeVisualParent=${shortPath(activeBoundary.sourceVisualParentId)}` +
            ` currentVisualParent=${shortPath(sourceVisualParentId)}` +
            ` match=${activeBoundaryMatches ? 1 : 0}` +
            ` ids=${formatIdList(activeBoundary.ids)}`
          );
        }
        if (targetIsSourceBlock && !activeBoundaryMatches) return null;
	        const physicalTargetRootId = targetIsSourceBlock
	          ? null
	          : physicalRootAtSourceParent(targetRow.id);
	        const targetProbeId = physicalTargetRootId || targetRow.id;
	        const targetDepth = targetIsSourceBlock
	          ? sourceVisualDepth
	          : visualDepthForId(targetProbeId);
        if (!activeBoundaryMatches && targetDepth < sourceVisualDepth) return null;

        const rootId = activeBoundaryMatches
          ? activeBoundary.rootId
          : (
	              targetDepth === sourceVisualDepth
	                ? targetProbeId
	                : visualAncestorAtDepth(targetProbeId, sourceVisualDepth)
	            );
	        if (!rootId || rootId === sourceData.fileId || sourceSet.has(rootId)) return null;
	        const ids = activeBoundaryMatches
	          ? activeBoundary.ids.filter(id => !sourceSet.has(id) && nodeById.has(id))
	          : collectRenderBlockIds(rootId).filter(id => !sourceSet.has(id));
        if (ids.length <= 1) return null;

        const allNodes = visualRows;
        const rootIndex = allNodes.findIndex(node => node.id === rootId);
        const rootRow = allNodes[rootIndex] || null;
        const blockIndices = ids
          .map(id => allNodes.findIndex(node => node.id === id))
          .filter(index => index >= 0);
        if (!rootRow || rootIndex < 0 || blockIndices.length === 0 || sourceBlockFirstVisibleIndex < 0 || sourceBlockLastVisibleIndex < 0) {
          return null;
        }
        const blockLastIndex = Math.max(...blockIndices);
        const isGeometryAdjacent =
          blockLastIndex === sourceBlockFirstVisibleIndex - 1 ||
          rootIndex === sourceBlockLastVisibleIndex + 1;
        const measuredGeometrySide =
          blockLastIndex === sourceBlockFirstVisibleIndex - 1
            ? 'after'
            : (rootIndex === sourceBlockLastVisibleIndex + 1 ? 'before' : null);

        const geometrySide = relativeSide(sourceParentOrder, ids);
        const previewSide = relativeSide(currentSourceParentOrder, ids);
        const orderAdjacentSide =
          adjacentSide(currentSourceParentOrder, ids) ||
          adjacentSide(sourceParentOrder, ids);
        if (!isGeometryAdjacent && !activeBoundaryMatches && !orderAdjacentSide) return null;
        const currentSide = previewSide || activeBoundarySide || geometrySide || orderAdjacentSide;
        if (activeBoundaryMatches && String(targetSource).startsWith('refresh-block-boundary')) {
          logResolveReject(
            'active-boundary-side',
            `active=${activeBoundarySide || '-'}` +
            ` preview=${previewSide || '-'}` +
            ` geometry=${geometrySide || '-'}` +
            ` current=${currentSide || '-'}` +
            ` source=${shortPath(sourceData.fileId)}` +
            ` root=${shortPath(rootId)}` +
            ` target=${shortPath(targetRow.id)}`
          );
        }
        if (currentSide !== 'before' && currentSide !== 'after') return null;

        const blockLastRow = allNodes[blockLastIndex] || rootRow;
        const rootHeight = Number.isFinite(rootRow.rect?.height) ? rootRow.rect.height : 28;
        const blockLastHeight = Number.isFinite(blockLastRow.rect?.height) ? blockLastRow.rect.height : rootHeight;
        const blockHeight = ids.reduce((sum, id) => {
          const rect = rowById.get(id)?.rect;
          return sum + (Number.isFinite(rect?.height) ? rect.height : 0);
        }, 0) || (
          Number.isFinite(blockLastRow.rect?.bottom) && Number.isFinite(rootRow.rect?.top)
            ? blockLastRow.rect.bottom - rootRow.rect.top
            : rootHeight
        );
        const geometryBlockTop = Number.isFinite(rootRow.rect?.top) ? rootRow.rect.top : null;
        const geometryBlockBottom = Number.isFinite(blockLastRow.rect?.bottom)
          ? blockLastRow.rect.bottom
          : (geometryBlockTop == null ? null : geometryBlockTop + blockHeight);

        // React needs a frame to move the source row after a boundary preview.
        // During that frame the preview order already says "source is before/after
        // the block", while the measured rect still comes from the old side.
        // Use virtual source geometry for that mismatch, otherwise the resolver
        // drops to plain reorder and erases the block hint/animation.
        let effectiveSourceBlockTop = sourceBlockCurrentTop;
        let effectiveSourceBlockBottom = sourceBlockCurrentBottom;
        if (activeBoundaryMatches) {
          if (currentSide === 'before' && geometryBlockTop != null) {
            if (measuredGeometrySide === 'after') {
              effectiveSourceBlockTop = geometryBlockTop;
              effectiveSourceBlockBottom = geometryBlockTop + sourceBlockHeight;
            } else {
              effectiveSourceBlockTop = geometryBlockTop - sourceBlockHeight;
              effectiveSourceBlockBottom = geometryBlockTop;
            }
          } else if (currentSide === 'after' && geometryBlockBottom != null) {
            if (measuredGeometrySide === 'before') {
              effectiveSourceBlockTop = geometryBlockBottom - sourceBlockHeight;
              effectiveSourceBlockBottom = geometryBlockBottom;
            } else {
              effectiveSourceBlockTop = geometryBlockBottom;
              effectiveSourceBlockBottom = geometryBlockBottom + sourceBlockHeight;
            }
          }
          const liveSourceBlockRects = sourceBlockIds
            .map(liveRowRectById)
            .filter(rect => rect && Number.isFinite(rect.top) && Number.isFinite(rect.bottom));
          if (liveSourceBlockRects.length === sourceBlockIds.length) {
            const liveSourceBlockTop = Math.min(...liveSourceBlockRects.map(rect => rect.top));
            const liveSourceBlockBottom = Math.max(...liveSourceBlockRects.map(rect => rect.bottom));
            const liveBlockRects = ids
              .map(liveRowRectById)
              .filter(rect => rect && Number.isFinite(rect.top) && Number.isFinite(rect.bottom));
            const liveBlockTop = liveBlockRects.length === ids.length
              ? Math.min(...liveBlockRects.map(rect => rect.top))
              : null;
            const liveBlockBottom = liveBlockRects.length === ids.length
              ? Math.max(...liveBlockRects.map(rect => rect.bottom))
              : null;
            const sideBlockTop = liveBlockTop ?? geometryBlockTop;
            const sideBlockBottom = liveBlockBottom ?? geometryBlockBottom;
            const liveMatchesActiveSide = currentSide === 'before'
              ? (sideBlockTop == null || liveSourceBlockBottom <= sideBlockTop + 1)
              : (sideBlockBottom == null || liveSourceBlockTop >= sideBlockBottom - 1);
            if (liveMatchesActiveSide) {
              effectiveSourceBlockTop = liveSourceBlockTop;
              effectiveSourceBlockBottom = liveSourceBlockBottom;
            }
          }
        } else if (geometrySide && currentSide !== geometrySide) {
          if (currentSide === 'before' && geometryBlockTop != null) {
            effectiveSourceBlockTop = geometryBlockTop - sourceBlockHeight;
            effectiveSourceBlockBottom = geometryBlockTop;
          } else if (currentSide === 'after' && geometryBlockBottom != null) {
            effectiveSourceBlockTop = geometryBlockBottom;
            effectiveSourceBlockBottom = geometryBlockBottom + sourceBlockHeight;
          }
        }
        const currentRootTop = currentSide === 'before'
          ? effectiveSourceBlockBottom
          : (effectiveSourceBlockTop == null ? null : effectiveSourceBlockTop - blockHeight);
        const currentRootMid = currentRootTop == null ? null : currentRootTop + (rootHeight / 2);
        const currentBlockBottom = currentSide === 'before'
          ? (currentRootTop == null ? null : currentRootTop + blockHeight)
          : effectiveSourceBlockTop;
        const currentBlockLastMid = currentBlockBottom == null
          ? null
          : currentBlockBottom - (blockLastHeight / 2);

        if (currentRootTop == null || currentRootMid == null || currentBlockBottom == null || currentBlockLastMid == null) return null;

        const currentWithoutSource = currentSourceParentOrder.filter(id => !sourceSet.has(id));
        const targetInsideActiveSource =
          activeBoundaryMatches &&
          effectiveSourceBlockTop != null &&
          effectiveSourceBlockBottom != null &&
          effectiveY >= Math.min(effectiveSourceBlockTop, effectiveSourceBlockBottom) &&
          effectiveY <= Math.max(effectiveSourceBlockTop, effectiveSourceBlockBottom);
        const buildBoundary = (direction, insertIndex, crossed, thresholdY) => {
          const boundedIndex = Math.max(0, Math.min(insertIndex, currentWithoutSource.length));
          const nextOrderForBlock = crossed ? [...currentWithoutSource] : [...currentSourceParentOrder];
          if (crossed) nextOrderForBlock.splice(boundedIndex, 0, ...sourceBlockIds);
          const nextSide = crossed
            ? (direction === 'down' ? 'after' : 'before')
            : currentSide;
          return {
            direction,
            side: nextSide,
            nextOrder: nextOrderForBlock,
            insertIndex: crossed ? boundedIndex : currentSourceParentOrder.indexOf(sourceData.fileId),
            orderChanged: !sameOrder(sourceParentOrder, nextOrderForBlock),
            crossed,
            verticalBlockHintReason: 'adjacent-boundary',
            verticalBlockHintIds: ids,
            verticalBlockHintRootId: rootId,
            verticalBlockHintTargetId: targetRow.id,
            verticalBlockSourceHeight: sourceBlockHeight,
            verticalBlockBoundaryThresholdY: Number.isFinite(thresholdY) ? thresholdY : null,
            activeBoundary: activeBoundaryMatches ? 1 : 0,
            phase: activeBoundaryMatches
              ? (targetIsSourceBlock ? 'source' : 'block')
              : 'new',
          };
        };

        if (targetInsideActiveSource) {
          const sourceIndex = currentSourceParentOrder.indexOf(sourceData.fileId);
          const thresholdY = currentSide === 'before' ? currentBlockLastMid : currentRootMid;
          const sourceExitTowardBlock = currentSide === 'before'
            ? effectiveY >= effectiveSourceBlockBottom - EDGE_THRESHOLD_PX
            : effectiveY <= effectiveSourceBlockTop + EDGE_THRESHOLD_PX;
          return {
            direction: currentSide === 'before' ? 'down' : 'up',
            nextOrder: [...currentSourceParentOrder],
            insertIndex: sourceIndex >= 0 ? sourceIndex : sourceParentOrder.indexOf(sourceData.fileId),
            orderChanged: !sameOrder(sourceParentOrder, currentSourceParentOrder),
            crossed: false,
            side: currentSide,
            verticalBlockHintReason: 'adjacent-boundary-source',
            verticalBlockHintIds: sourceExitTowardBlock ? ids : [],
            verticalBlockHintRootId: sourceExitTowardBlock ? rootId : null,
            verticalBlockHintTargetId: sourceExitTowardBlock ? targetRow.id : null,
            verticalBlockSourceHeight: sourceBlockHeight,
            verticalBlockBoundaryThresholdY: Number.isFinite(thresholdY) ? thresholdY : null,
            activeBoundary: 1,
            phase: 'source',
          };
        }

        if (currentSide === 'before' && effectiveY <= effectiveSourceBlockBottom) return null;
        if (currentSide === 'after' && effectiveY >= effectiveSourceBlockTop) return null;

        if (currentSide === 'after') {
          const crossed = effectiveY <= currentRootMid;
          return buildBoundary('up', currentWithoutSource.indexOf(rootId), crossed, currentRootMid);
        }
        if (currentSide === 'before') {
          const nextBlockLastIndex = Math.max(
            ...ids
              .map(id => currentWithoutSource.indexOf(id))
              .filter(index => index >= 0)
          );
          const crossed = effectiveY >= currentBlockLastMid;
          return buildBoundary('down', nextBlockLastIndex + 1, crossed, currentBlockLastMid);
        }
        return null;
	      };
	      const adjacentBlockBoundary = getAdjacentBlockBoundary();
	      const getSplitVisualBlockBoundary = () => {
	        if (isFolderDropMode || !singleFileDrag || targetRow.isRootEnd || !targetRow.id) return null;
	        if (sourceSet.has(targetRow.id)) return null;
	        const targetDepth = visualDepthForId(targetRow.id);
	        if (targetDepth < sourceVisualDepth) return null;
	        const rootId = targetDepth === sourceVisualDepth
	          ? targetRow.id
	          : visualAncestorAtDepth(targetRow.id, sourceVisualDepth);
	        if (!rootId || rootId === sourceData.fileId || sourceSet.has(rootId)) return null;
	        const ids = collectVisualBlockIds(rootId).filter(id => !sourceSet.has(id));
	        if (ids.length <= 1) return null;

	        const sourceIndexInNext = nextOrder.indexOf(sourceData.fileId);
	        const blockIndicesInNext = ids
	          .map(id => nextOrder.indexOf(id))
	          .filter(index => index >= 0);
	        if (sourceIndexInNext < 0 || blockIndicesInNext.length === 0) return null;
	        const blockFirstInNext = Math.min(...blockIndicesInNext);
	        const blockLastInNext = Math.max(...blockIndicesInNext);
	        const splitsBlock =
	          sourceIndexInNext > blockFirstInNext &&
	          sourceIndexInNext <= blockLastInNext;
	        if (!splitsBlock) return null;

	        const currentSide =
	          relativeSide(currentSourceParentOrder, ids) ||
	          relativeSide(sourceParentOrder, ids);
	        if (currentSide !== 'before' && currentSide !== 'after') return null;

	        const rootRow = rowById.get(rootId);
	        const blockRows = ids
	          .map(id => rowById.get(id))
	          .filter(row => row?.rect && Number.isFinite(row.rect.mid));
	        if (!rootRow?.rect || blockRows.length === 0) return null;
	        const blockLastId = ids[ids.length - 1];
	        const blockLastRow = rowById.get(blockLastId) || blockRows[blockRows.length - 1];
	        if (!blockLastRow?.rect || !Number.isFinite(blockLastRow.rect.mid)) return null;

	        const currentWithoutSource = currentSourceParentOrder.filter(id => !sourceSet.has(id));
	        const rootIndex = currentWithoutSource.indexOf(rootId);
	        const nextBlockLastIndex = Math.max(
	          ...ids
	            .map(id => currentWithoutSource.indexOf(id))
	            .filter(index => index >= 0)
	        );
	        if (rootIndex < 0 || nextBlockLastIndex < 0) return null;

	        const thresholdY = currentSide === 'before'
	          ? blockLastRow.rect.mid
	          : rootRow.rect.mid;
	        const crossed = currentSide === 'before'
	          ? effectiveY >= thresholdY
	          : effectiveY <= thresholdY;
	        const direction = currentSide === 'before' ? 'down' : 'up';
	        const boundedIndex = currentSide === 'before'
	          ? nextBlockLastIndex + 1
	          : rootIndex;
	        const nextOrderForBlock = crossed ? [...currentWithoutSource] : [...currentSourceParentOrder];
	        if (crossed) {
	          nextOrderForBlock.splice(Math.max(0, Math.min(boundedIndex, currentWithoutSource.length)), 0, ...sourceBlockIds);
	        }

	        return {
	          direction,
	          side: crossed ? (direction === 'down' ? 'after' : 'before') : currentSide,
	          nextOrder: nextOrderForBlock,
	          insertIndex: crossed ? boundedIndex : currentSourceParentOrder.indexOf(sourceData.fileId),
	          orderChanged: !sameOrder(sourceParentOrder, nextOrderForBlock),
	          crossed,
	          verticalBlockHintReason: 'split-block-guard',
	          verticalBlockHintIds: ids,
	          verticalBlockHintRootId: rootId,
	          verticalBlockHintTargetId: targetRow.id,
	          verticalBlockSourceHeight: sourceBlockHeight,
	          verticalBlockBoundaryThresholdY: thresholdY,
	          activeBoundary: 0,
	          phase: 'split-guard',
	        };
	      };
	      const splitVisualBlockBoundary = adjacentBlockBoundary ? null : getSplitVisualBlockBoundary();
	      const visualBlockBoundary = adjacentBlockBoundary || splitVisualBlockBoundary;
	      const targetVisualDepth = targetRow.isRootEnd || !targetRow.id
	        ? null
	        : visualDepthForId(targetRow.id);
      const targetVisualParentId = targetRow.isRootEnd || !targetRow.id
        ? null
        : visualParentForId(targetRow.id);
      const visualParentForVerticalReorder = () => {
        if (!singleFileDrag || !sourceVisualParentId || targetRow.isRootEnd) {
          return sourceVisualParentId || null;
        }
        const targetId = targetRow.id;
        const target = nodeById.get(targetId);
        if (!target || target.isDirectory || sourceSet.has(targetId)) return sourceVisualParentId || null;

        const targetDepth = visualDepthForId(targetId);
        if (targetDepth === sourceVisualDepth) {
          return visualParentForId(targetId) || null;
        }

        if (targetDepth === sourceVisualDepth - 1) {
          const sourceIndexInNextOrder = nextOrder.indexOf(sourceData.fileId);
          const targetIndexInNextOrder = nextOrder.indexOf(targetId);
          if (sourceIndexInNextOrder >= 0 && targetIndexInNextOrder >= 0 && sourceIndexInNextOrder > targetIndexInNextOrder) {
            return targetId;
          }
          return sourceVisualParentId || null;
        }

        if (targetDepth > sourceVisualDepth) {
          const siblingAtSourceDepth = visualAncestorAtDepth(targetId, sourceVisualDepth);
          return siblingAtSourceDepth ? (visualParentForId(siblingAtSourceDepth) || null) : (sourceVisualParentId || null);
        }

        return sourceVisualParentId || null;
      };
      const previousVisualParentAtDepth = (order, sourceIndex, parentDepth) => {
        if (!Array.isArray(order) || sourceIndex <= 0 || parentDepth < 0) return null;
        for (let i = sourceIndex - 1; i >= 0; i -= 1) {
          const id = order[i];
          const candidate = nodeById.get(id);
          if (!candidate || candidate.isDirectory || sourceSet.has(id)) continue;
          const candidateDepth = visualDepthForId(id);
          if (candidateDepth === parentDepth) return id;
          if (candidateDepth < parentDepth) return null;
        }
        return null;
      };
      const repairMovedVisualParentsForOrder = (layout, parentKey, order) => {
        if (!layout || parentKey !== sourceParentKey || !Array.isArray(order)) return {};
        const visualParents = { ...(layout.visualParentByPath || {}) };
        const visualParentFromRepair = (id) => (
          hasOwn(visualParents, id)
            ? (visualParents[id] || null)
            : visualParentForId(id)
        );
        const visualDepthFromRepair = (id) => {
          let depth = 0;
          let cursor = visualParentFromRepair(id);
          const seen = new Set([id]);
          while (cursor && !seen.has(cursor) && nodeById.has(cursor)) {
            seen.add(cursor);
            depth += 1;
            cursor = visualParentFromRepair(cursor);
          }
          return depth;
        };
        const previousParentAtDepth = (sourceIndex, parentDepth) => {
          if (sourceIndex <= 0 || parentDepth < 0) return null;
          for (let i = sourceIndex - 1; i >= 0; i -= 1) {
            const id = order[i];
            const candidate = nodeById.get(id);
            if (!candidate || candidate.isDirectory || sourceSet.has(id)) continue;
            const candidateDepth = visualDepthFromRepair(id);
            if (candidateDepth === parentDepth) return id;
            if (candidateDepth < parentDepth) return null;
          }
          return null;
        };
        const repairedIds = [];
        for (const id of sourceBlockIds) {
          const visualParentId = visualParentFromRepair(id);
          if (!visualParentId) continue;
          const sourceIndex = order.indexOf(id);
          const parentIndex = order.indexOf(visualParentId);
          if (sourceIndex < 0 || parentIndex < 0 || sourceIndex > parentIndex) continue;
          const parentDepth = Math.max(0, visualDepthFromRepair(id) - 1);
          const nextParentId = previousParentAtDepth(sourceIndex, parentDepth);
          if (nextParentId) {
            visualParents[id] = nextParentId;
          } else {
            delete visualParents[id];
          }
          repairedIds.push(id);
        }
        if (repairedIds.length === 0) return {};
        layout.visualParentByPath = visualParents;
        return {
          visualParentRepairIds: repairedIds,
          visualParentRepairReason: 'source-before-parent',
        };
      };
      const buildLayoutWithVisualRepair = (kind, parentKey, order, meta = {}) => {
        const next = cloneLayout(normalizedSidebarLayout);
        next.orderByParent[parentKey] = order;
        const visualRepairMeta = repairMovedVisualParentsForOrder(next, parentKey, order);
        return {
          kind: 'layout',
          layout: next,
          detail: kind,
          nextOrderSize: order.length,
          ...meta,
          ...visualRepairMeta,
          ...commonDetail(parentKey),
        };
      };
      const getSourceBeforeParentViolation = (order, parentOverrides = null) => {
        if (!Array.isArray(order)) return null;
        for (const id of sourceBlockIds) {
          const visualParentId = parentOverrides && hasOwn(parentOverrides, id)
            ? (parentOverrides[id] || null)
            : visualParentForId(id);
          if (!visualParentId || sourceSet.has(visualParentId)) continue;
          const sourceIndex = order.indexOf(id);
          const parentIndex = order.indexOf(visualParentId);
          if (sourceIndex >= 0 && parentIndex >= 0 && sourceIndex < parentIndex) {
            return {
              id,
              visualParentId,
            };
          }
        }
        return null;
      };
      let verticalParentCandidateId = visualParentForVerticalReorder();
      let verticalParentCandidateReason = 'target-depth';
      if (singleFileDrag && sourceVisualParentId && sourceVisualDepth > 0) {
        const sourceIndexInNextOrder = nextOrder.indexOf(sourceData.fileId);
        const currentParentIndexInNextOrder = nextOrder.indexOf(sourceVisualParentId);
        if (
          sourceIndexInNextOrder >= 0 &&
          currentParentIndexInNextOrder >= 0 &&
          sourceIndexInNextOrder < currentParentIndexInNextOrder
        ) {
          const previousParentId = previousVisualParentAtDepth(
            nextOrder,
            sourceIndexInNextOrder,
            sourceVisualDepth - 1
          );
          if (previousParentId) {
            verticalParentCandidateId = previousParentId;
            verticalParentCandidateReason = 'before-current-parent';
          } else {
            verticalParentCandidateId = sourceVisualParentId;
            verticalParentCandidateReason = 'before-current-parent-blocked';
          }
        }
      }
      const verticalParentCandidateIsValid =
        singleFileDrag &&
        !!sourceVisualParentId &&
        !!verticalParentCandidateId &&
        verticalParentCandidateId !== sourceVisualParentId &&
        verticalParentCandidateId !== sourceData.fileId &&
        !sourceSet.has(verticalParentCandidateId) &&
        !!nodeById.get(verticalParentCandidateId);
      const sourceBeforeParentParentOverrides = verticalParentCandidateIsValid
        ? { [sourceData.fileId]: verticalParentCandidateId }
        : null;
	      const resolverDebugMeta = {
        sourceVisualDepth,
        targetVisualDepth,
        sourceVisualParentId: sourceVisualParentId || null,
        targetVisualParentId: targetVisualParentId || null,
        verticalParentCandidateId: verticalParentCandidateId || null,
        verticalParentCandidateReason,
      };
	      const getVerticalBlockHint = () => {
	        if (isFolderDropMode || !singleFileDrag || targetRow.isRootEnd || !targetRow.id) return null;
	        if (sourceSet.has(targetRow.id)) return null;
	        if (visualBlockBoundary) {
	          return {
	            verticalBlockHintReason: visualBlockBoundary.verticalBlockHintReason || 'adjacent-boundary',
	            verticalBlockHintIds: visualBlockBoundary.verticalBlockHintIds,
	            verticalBlockHintRootId: visualBlockBoundary.verticalBlockHintRootId,
	            verticalBlockHintTargetId: visualBlockBoundary.verticalBlockHintTargetId,
	          };
	        }
        const targetDepth = targetVisualDepth;
        if (sourceVisualParentId && targetDepth < sourceVisualDepth) {
          const sourceAncestorIds = collectVisualAncestorChainIds(sourceData.fileId).filter(id => !sourceSet.has(id));
          if (sourceAncestorIds.includes(targetRow.id)) return null;
          if (targetDepth < sourceVisualDepth - 1) return null;

          const targetPathIds = collectVisualPathIds(targetRow.id).filter(id => !sourceSet.has(id));
          if (targetPathIds.length > 1) {
            return {
              verticalBlockHintReason: 'shallower-target-path',
              verticalBlockHintIds: targetPathIds,
              verticalBlockHintRootId: targetPathIds[0],
              verticalBlockHintTargetId: targetRow.id,
            };
          }
        }
        if (targetDepth <= sourceVisualDepth) return null;
        const rootId = visualAncestorAtDepth(targetRow.id, sourceVisualDepth);
        if (!rootId || rootId === sourceData.fileId || sourceSet.has(rootId)) return null;
        const ids = collectVisualBlockIds(rootId).filter(id => !sourceSet.has(id));
        if (ids.length <= 1) return null;
        return {
          verticalBlockHintReason: 'deeper-target-block',
          verticalBlockHintIds: ids,
          verticalBlockHintRootId: rootId,
          verticalBlockHintTargetId: targetRow.id,
        };
      };
      const verticalBlockHintMeta = getVerticalBlockHint() || {};
      const hasNeighborParentGroupInDirection = (direction, ancestorId) => {
        if (!ancestorId || sourceVisualDepth <= 0) return false;
        const ancestorIndex = visualRows.findIndex(row => row.id === ancestorId);
        if (ancestorIndex < 0) return false;
        const parentDepth = sourceVisualDepth - 1;
        if (direction === 'up') {
          for (let i = ancestorIndex - 1; i >= 0; i -= 1) {
            const row = visualRows[i];
            if (!row || row.parentKey !== sourceParentKey) return false;
            const id = row.id;
            const depth = visualDepthForId(id);
            if (depth === parentDepth) return true;
            if (depth < parentDepth) return false;
          }
          return false;
        }
        if (direction === 'down') {
          for (let i = ancestorIndex + 1; i < visualRows.length; i += 1) {
            const row = visualRows[i];
            if (!row || row.parentKey !== sourceParentKey) return false;
            const id = row.id;
            if (sourceSet.has(id)) continue;
            const depth = visualDepthForId(id);
            if (depth === parentDepth) return true;
            if (depth < parentDepth) return false;
          }
        }
        return false;
      };
	      const getVerticalLimitHint = () => {
	        if (isFolderDropMode || !singleFileDrag || targetRow.isRootEnd || !targetRow.id) return null;
	        if (Array.isArray(verticalBlockHintMeta.verticalBlockHintIds) && verticalBlockHintMeta.verticalBlockHintIds.length > 1) return null;
	        if (verticalParentCandidateId !== (sourceVisualParentId || null)) return null;
	        if (!sourceVisualParentId || sourceSet.has(targetRow.id)) return null;
        const targetDepth = targetVisualDepth;
        if (targetDepth >= sourceVisualDepth) return null;
        const sourceAncestorIds = collectVisualAncestorChainIds(sourceData.fileId).filter(id => !sourceSet.has(id));
        const isOwnAncestor = sourceAncestorIds.includes(targetRow.id);
        const jumpsTooManyLevels = targetDepth < sourceVisualDepth - 1;
        if (!isOwnAncestor && !jumpsTooManyLevels) return null;
	        const sourceMid = geometry.sourceRow?.rect?.mid ?? rawY;
	        const direction = targetRow.rect.mid < sourceMid ? 'up' : 'down';
        if (isOwnAncestor && hasNeighborParentGroupInDirection(direction, targetRow.id)) return null;
        return {
          verticalLimitDirection: direction,
          verticalLimitReason: isOwnAncestor ? 'own-ancestor' : 'too-shallow',
          verticalLimitTargetId: targetRow.id,
        };
      };
      const verticalLimitMeta = getVerticalLimitHint() || {};
      const isHorizontalRepeatPending = (direction) => {
        const lastCommit = dragSessionRef.current?.lastHorizontalCommit;
        return !!lastCommit &&
          lastCommit.sourceId === sourceData.fileId &&
          lastCommit.direction === direction;
      };
      const findPreviousFileAtSourceDepth = () => {
        const sourceIndex = nextOrder.indexOf(sourceData.fileId);
        if (sourceIndex <= 0) return null;
        for (let i = sourceIndex - 1; i >= 0; i -= 1) {
          const id = nextOrder[i];
          const candidate = nodeById.get(id);
          if (!candidate || candidate.isDirectory || sourceSet.has(id)) continue;
          const candidateDepth = visualDepthForId(id);
          if (candidateDepth === sourceVisualDepth) return id;
          if (candidateDepth < sourceVisualDepth) return null;
        }
        return null;
      };
      const visualAttachParentId = singleFileDrag ? findPreviousFileAtSourceDepth() : null;
      const sourceVisualBlockIds = singleFileDrag ? collectVisualBlockIds(sourceData.fileId) : [];
      const sourceMaxRelativeDepth = sourceVisualBlockIds.reduce((maxDepth, id) => (
        Math.max(maxDepth, Math.max(0, visualDepthForId(id) - sourceVisualDepth))
      ), 0);
      const visualAttachDepth = visualAttachParentId
        ? visualDepthForId(visualAttachParentId) + 1
        : sourceVisualDepth;
      const visualAttachExceedsMaxDepth = !!visualAttachParentId
        && visualAttachDepth + sourceMaxRelativeDepth > MAX_VISUAL_HIERARCHY_DEPTH;
      const leftRepeatPending = isHorizontalRepeatPending('left');
      const rightRepeatPending = isHorizontalRepeatPending('right');
      const leftThreshold = leftRepeatPending
        ? DRAG_HORIZONTAL_REPEAT_THRESHOLD_PX
        : DRAG_VISUAL_DETACH_THRESHOLD_PX;
      const rightThreshold = rightRepeatPending
        ? DRAG_HORIZONTAL_REPEAT_THRESHOLD_PX
        : DRAG_VISUAL_ATTACH_THRESHOLD_PX;
      const visualCanLeft = !!sourceVisualParentId;
      const visualCanRight = !!visualAttachParentId && !visualAttachExceedsMaxDepth;
      const repeatPendingDirection =
        (deltaX < 0 && leftRepeatPending) ? 'left' :
        (deltaX > 0 && rightRepeatPending) ? 'right' :
        null;
      const visualIntentMeta = {
        visualCanLeft,
        visualCanRight,
        visualAttachParentId: visualAttachParentId || null,
        visualAttachDepth,
        sourceMaxRelativeDepth,
        visualMaxDepth: MAX_VISUAL_HIERARCHY_DEPTH,
        sourceVisualDepth,
        visualLeftThresholdPx: leftThreshold,
        visualRightThresholdPx: rightThreshold,
        visualIntentThresholdPx: deltaX < 0 ? leftThreshold : rightThreshold,
        visualRepeatPendingDirection: repeatPendingDirection,
        visualBlockedReason: visualAttachExceedsMaxDepth ? 'max-depth' : null,
      };
      const buildVisualLayout = (detail, mutateVisualParents, meta = {}) => {
        const next = cloneLayout(normalizedSidebarLayout);
        next.orderByParent[sourceParentKey] = nextOrder;
        const visualParentByPath = { ...next.visualParentByPath };
        mutateVisualParents(visualParentByPath);
        next.visualParentByPath = visualParentByPath;
        const visualRepairMeta = repairMovedVisualParentsForOrder(next, sourceParentKey, nextOrder);
        return {
          kind: 'layout',
          layout: next,
          detail,
          nextOrderSize: nextOrder.length,
        boundaryClamp,
        insertIndex: boundedInsertIndex,
        orderChanged,
        sourceParentSize: sourceParentOrder.length,
        ...resolverDebugMeta,
        ...verticalBlockHintMeta,
        ...visualIntentMeta,
        ...meta,
        ...visualRepairMeta,
        ...commonDetail(sourceParentKey),
      };
      };

	      if (singleFileDrag && deltaX <= -leftThreshold && sourceVisualParentId) {
	        const parentNode = nodeById.get(sourceVisualParentId);
	        const promotedParentId = hasOwn(dragVisualParentOverrides, sourceVisualParentId)
	          ? dragVisualParentOverrides[sourceVisualParentId] || null
	          : (
	              normalizedSidebarLayout.visualParentByPath?.[sourceVisualParentId] ||
	              parentNode?.visualParentId ||
	              null
	            );
	        const detail = promotedParentId ? 'outdent-visual-parent' : 'detach-visual-parent';
	        return buildVisualLayout(
	          detail,
	          (visualParents) => {
	            if (promotedParentId) {
	              visualParents[sourceData.fileId] = promotedParentId;
            } else {
              delete visualParents[sourceData.fileId];
            }
          },
          {
            visualParentId: promotedParentId || null,
            previousVisualParentId: sourceVisualParentId,
            visualChanged: true,
          }
        );
      }

	      if (singleFileDrag && deltaX >= rightThreshold) {
	        const visualParentId = visualAttachParentId;
	        const visualParentNode = visualParentId ? nodeById.get(visualParentId) : null;

	        if (!visualParentNode) {
          logResolveReject(
            'visual-attach-no-parent',
            `source=${shortPath(sourceData.fileId)} sourceParent=${shortPath(sourceParentKey)}` +
            ` insertIndex=${boundedInsertIndex} deltaX=${Math.round(deltaX)}` +
            ` target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}` +
            ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
          );
          return buildLayoutWithVisualRepair('reorder', sourceParentKey, nextOrder, {
            boundaryClamp,
            insertIndex: boundedInsertIndex,
          orderChanged,
          sourceParentSize: sourceParentOrder.length,
          ...resolverDebugMeta,
          ...verticalBlockHintMeta,
          ...visualIntentMeta,
          visualBlockedDirection: 'right',
	          });
	        }

	        if (visualAttachExceedsMaxDepth) {
	          logResolveReject(
	            'visual-attach-max-depth',
	            `source=${shortPath(sourceData.fileId)} parent=${shortPath(visualParentId)}` +
	            ` attachDepth=${visualAttachDepth} subtreeRelativeDepth=${sourceMaxRelativeDepth}` +
	            ` maxDepth=${MAX_VISUAL_HIERARCHY_DEPTH}`
	          );
	          return buildLayoutWithVisualRepair('reorder', sourceParentKey, nextOrder, {
	            boundaryClamp,
	            insertIndex: boundedInsertIndex,
	            orderChanged,
	            sourceParentSize: sourceParentOrder.length,
	            ...resolverDebugMeta,
	            ...verticalBlockHintMeta,
	            ...visualIntentMeta,
	            visualBlockedDirection: 'right',
	            visualBlockedReason: 'max-depth',
	          });
	        }

	        return buildVisualLayout(
	          'attach-visual-parent',
          (visualParents) => {
            visualParents[sourceData.fileId] = visualParentId;
          },
          {
            visualParentId,
            previousVisualParentId: sourceVisualParentId,
            visualChanged: sourceVisualParentId !== visualParentId,
          }
        );
      }

      const sourceBeforeParentViolation = getSourceBeforeParentViolation(
        nextOrder,
        sourceBeforeParentParentOverrides
      );
      if (sourceBeforeParentViolation) {
        const candidateLimitOrder = currentSourceParentOrder.length
          ? currentSourceParentOrder
          : sourceParentOrder;
        const verticalLimitOrder = getSourceBeforeParentViolation(
          candidateLimitOrder,
          sourceBeforeParentParentOverrides
        )
          ? sourceParentOrder
          : candidateLimitOrder;
        const sourceMid = geometry.sourceRow?.rect?.mid ?? rawY;
        const direction = targetRow.rect.mid < sourceMid ? 'up' : 'down';
        const reason = singleFileDrag ? 'source-before-parent' : 'multi-source-before-parent';
        logResolveReject(
          reason,
          `source=${shortPath(sourceData.fileId)}` +
          ` child=${shortPath(sourceBeforeParentViolation.id)}` +
          ` parent=${shortPath(sourceBeforeParentViolation.visualParentId)}` +
          ` target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}` +
          ` direction=${direction}` +
          ` sourceIds=${formatIdList(sourceBlockIds)}`
        );
        return buildLayoutWithVisualRepair('vertical-limit', sourceParentKey, verticalLimitOrder, {
          boundaryClamp,
          insertIndex: verticalLimitOrder.indexOf(sourceData.fileId),
          orderChanged: !sameOrder(sourceParentOrder, verticalLimitOrder),
          sourceParentSize: sourceParentOrder.length,
          ...resolverDebugMeta,
          verticalLimitDirection: direction,
          verticalLimitReason: reason,
          verticalLimitTargetId: targetRow.id,
          verticalLimitPreservePreview: !!dragPreviewLayoutRef.current,
          ...visualIntentMeta,
        });
      }

	      if (visualBlockBoundary) {
	        return buildLayoutWithVisualRepair('reorder-visual-block-boundary', sourceParentKey, visualBlockBoundary.nextOrder, {
	          boundaryClamp,
	          insertIndex: visualBlockBoundary.insertIndex,
	          orderChanged: visualBlockBoundary.orderChanged,
	          verticalBlockBoundaryDirection: visualBlockBoundary.direction,
	          verticalBlockBoundaryCrossed: visualBlockBoundary.crossed,
	          verticalBlockBoundarySide: visualBlockBoundary.side,
	          verticalBlockBoundaryThresholdY: visualBlockBoundary.verticalBlockBoundaryThresholdY,
	          verticalBlockSourceHeight: visualBlockBoundary.verticalBlockSourceHeight,
	          verticalBlockHintReason: visualBlockBoundary.verticalBlockHintReason || 'adjacent-boundary',
	          verticalActiveBoundary: visualBlockBoundary.activeBoundary,
	          verticalBlockBoundaryPhase: visualBlockBoundary.phase,
	          verticalBlockHintIds: visualBlockBoundary.verticalBlockHintIds,
	          verticalBlockHintRootId: visualBlockBoundary.verticalBlockHintRootId,
	          verticalBlockHintTargetId: visualBlockBoundary.verticalBlockHintTargetId,
	          sourceParentSize: sourceParentOrder.length,
	          ...resolverDebugMeta,
	          ...verticalBlockHintMeta,
          ...visualIntentMeta,
        });
      }

	      if (verticalLimitMeta.verticalLimitDirection) {
	        const verticalLimitOrder = currentSourceParentOrder.length
	          ? currentSourceParentOrder
	          : sourceParentOrder;
	        return buildLayoutWithVisualRepair('vertical-limit', sourceParentKey, verticalLimitOrder, {
          boundaryClamp,
          insertIndex: verticalLimitOrder.indexOf(sourceData.fileId),
          orderChanged: !sameOrder(sourceParentOrder, verticalLimitOrder),
          sourceParentSize: sourceParentOrder.length,
          ...resolverDebugMeta,
          ...verticalLimitMeta,
          verticalLimitPreservePreview: !!dragPreviewLayoutRef.current,
          ...visualIntentMeta,
        });
      }

	      if (singleFileDrag && sourceVisualParentId) {
	        const visualParentId = verticalParentCandidateId;
	        if (visualParentId !== sourceVisualParentId) {
	          if (verticalParentCandidateIsValid) {
	            return buildVisualLayout(
	              'move-visual-child',
	              (visualParents) => {
	                visualParents[sourceData.fileId] = visualParentId;
	              },
	              {
	                visualParentId,
	                previousVisualParentId: sourceVisualParentId,
	                visualChanged: true,
	              }
	            );
	          }
	          const verticalLimitOrder = currentSourceParentOrder.length
	            ? currentSourceParentOrder
	            : sourceParentOrder;
	          const sourceMid = geometry.sourceRow?.rect?.mid ?? rawY;
	          const direction = targetRow.rect.mid < sourceMid ? 'up' : 'down';
	          logResolveReject(
	            'vertical-parent-change-disabled',
	            `source=${shortPath(sourceData.fileId)}` +
	            ` parent=${shortPath(sourceVisualParentId)}` +
	            ` candidate=${shortPath(visualParentId)}` +
	            ` target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}` +
	            ` direction=${direction}` +
	            ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
	          );
	          return buildLayoutWithVisualRepair('vertical-limit', sourceParentKey, verticalLimitOrder, {
	            boundaryClamp,
	            insertIndex: verticalLimitOrder.indexOf(sourceData.fileId),
	            orderChanged: !sameOrder(sourceParentOrder, verticalLimitOrder),
	            sourceParentSize: sourceParentOrder.length,
	            ...resolverDebugMeta,
	            verticalLimitDirection: direction,
	            verticalLimitReason: 'vertical-parent-change-disabled',
	            verticalLimitTargetId: targetRow.id,
	            verticalLimitPreservePreview: !!dragPreviewLayoutRef.current,
	            ...visualIntentMeta,
	          });
	        }
	      }

	      return buildLayoutWithVisualRepair('reorder', sourceParentKey, nextOrder, {
	        boundaryClamp,
	        insertIndex: boundedInsertIndex,
	        orderChanged,
        sourceParentSize: sourceParentOrder.length,
        ...resolverDebugMeta,
        ...verticalBlockHintMeta,
        ...visualIntentMeta,
      });
    }

    if (isFolderDropMode && (edge || targetRow.isRootEnd) && canVirtualLayout) {
      logResolveReject(
        'cmd-same-parent-reorder-disabled',
        `source=${shortPath(sourceData.fileId)} sourceParent=${shortPath(sourceParentKey)}` +
        ` target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}` +
        ` hoverParent=${shortPath(rowParentKey)} edge=${edge || 'center'}` +
        ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
      );
      return null;
    }

    if (!isFolderDropMode && (edge || targetRow.isRootEnd) && canVirtualLayout) {
      const withoutSource = rowParentSiblingOrder.filter(id => !sourceSet.has(id));
      const targetIndexBase = targetRow.isRootEnd ? withoutSource.length : withoutSource.indexOf(targetRow.id);
      if (targetIndexBase < 0 && !targetRow.isRootEnd) {
        logResolveReject(
          'target-index-missing',
          `source=${shortPath(sourceData.fileId)} target=${shortPath(targetRow.id)}` +
          ` rowParent=${shortPath(rowParentKey)} siblings=${formatIdList(rowParentSiblingOrder)}`
        );
        return null;
      }
      const insertIndex = targetRow.isRootEnd
        ? withoutSource.length
        : targetIndexBase + (edge === 'bottom' ? 1 : 0);
      const nextOrder = [...withoutSource];
      nextOrder.splice(Math.max(0, Math.min(insertIndex, nextOrder.length)), 0, ...sourceBlockIds);
      return buildLayout('reorder', rowParentKey, nextOrder, {
        insertIndex,
        orderChanged: !sameOrder(rowParentSiblingOrder, nextOrder),
        sourceParentSize: rowParentSiblingOrder.length,
      });
    }

    if ((edge || targetRow.isRootEnd) && !canVirtualLayout) {
      return {
        kind: 'move',
        destinationFolder: destinationForParentKey(rowParentKey),
        isRoot: rowParentKey === ROOT_PARENT,
        overFolderId: rowParentKey === ROOT_PARENT ? null : rowParentKey,
        detail: 'move-to-target-parent',
        ...commonDetail(rowParentKey),
      };
    }

    if (isFolderDropMode && !edge && targetNode && !targetNode.isDirectory && targetNode.id !== sourceData.fileId && canVirtualLayout) {
      console.log(
        DND_LOG_PREFIX,
        `resolve center-file attachDisabled=1 source=${shortPath(sourceData.fileId)}` +
        ` target=${shortPath(targetNode.id)} rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)} mode=${mode}`
      );
    }

    if (isFolderDropMode && !edge && targetNode && !targetNode.isDirectory) {
      const destinationFolder = targetNode.parentId || folderPath;
      if (destinationFolder === destinationForParentKey(sourceParentKey)) {
        logResolveReject(
          'cmd-same-parent-file-disabled',
          `source=${shortPath(sourceData.fileId)} sourceParent=${shortPath(sourceParentKey)}` +
          ` target=${shortPath(targetNode.id)} destination=${shortPath(destinationFolder)}` +
          ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
        );
        return null;
      }
      return {
        kind: 'move',
        destinationFolder,
        isRoot: !targetNode.parentId,
        overFolderId: targetNode.parentId || null,
        detail: 'move-to-file-parent',
        ...commonDetail(),
      };
    }

    logResolveReject(
      'no-matching-branch',
      `source=${shortPath(sourceData.fileId)} mode=${mode}` +
      ` target=${targetRow.isRootEnd ? 'ROOT_END' : shortPath(targetRow.id)}` +
      ` targetKind=${targetNode?.isDirectory ? 'dir' : (targetNode?.isLink ? 'link' : 'file')}` +
      ` edge=${edge || 'center'} canVirtual=${canVirtualLayout ? 1 : 0}` +
      ` rawY=${Math.round(rawY)} effectiveY=${Math.round(effectiveY)}`
    );
    return null;
	  }, [captureDragGeometry, collectVisualChildren, currentDragSessionId, folderPath, getScrollSnapshot, sidebarLayout, logResolveReject, normalizeDragSelection]);

  const resolveAndApplyDragPreview = useCallback((sourceData, rawY, metaKey, reason = 'drag', clientX = null) => {
    if (!sourceData?.fileId) return null;
    const session = dragSessionRef.current;
    const pendingGeometrySeq = session?.geometryRefreshPendingSeq || 0;
    if (
      pendingGeometrySeq > dragGeometryRefreshAppliedSeqRef.current &&
      !String(reason).startsWith('geometry-refresh:')
    ) {
      logResolveReject(
        'geometry-rebase-pending',
        `reason=${reason}` +
        ` pendingSeq=${pendingGeometrySeq}` +
        ` appliedSeq=${dragGeometryRefreshAppliedSeqRef.current}` +
        ` previewRev=${session?.previewRevision ?? '-'}` +
        ` geometryRev=${session?.geometryRevision ?? '-'}` +
        ` rawY=${Math.round(rawY)}`
      );
      return dragLastResolvedActionRef.current;
    }
    const anchor = dragAnchorRef.current;
    const effectiveY = anchor ? rawY + anchor.offsetY : rawY;
    const action = resolveSidebarDrag(sourceData, effectiveY, rawY, { metaKey, clientX });
    const nextKey = previewActionKey(action);
    const prevKey = dragPreviewKeyRef.current;
    const actionChanged = nextKey !== prevKey;
    const scroll = getScrollSnapshot();
    const layoutChanged = action?.kind === 'layout'
      ? !sameSidebarLayout(sidebarLayout, action.layout)
      : null;
    const currentPreviewLayoutForAction = action?.kind === 'layout'
      ? (session?.previewLayout || dragPreviewLayoutRef.current || sidebarLayout)
      : null;
    const previewLayoutWillChange = action?.kind === 'layout'
      ? !sameSidebarLayout(currentPreviewLayoutForAction, action.layout)
      : false;
    const suppressStaleBoundaryBlockHint =
      action?.detail === 'reorder-visual-block-boundary' &&
      (previewLayoutWillChange || !!action.verticalBlockBoundaryCrossed);
    const actionLog = formatActionLog(action);
    dragLastResolvedActionRef.current = action;
    dragLastResolveSnapshotRef.current = {
      at: performance.now(),
      reason,
      rawY,
      effectiveY,
      metaKey,
      scrollTop: scroll.scrollTop,
      actionLog,
    };
    updateHorizontalDragIntent(sourceData, action, metaKey);
    updateVerticalBlockHint(
      sourceData,
      suppressStaleBoundaryBlockHint
        ? {
            ...action,
            verticalBlockHintIds: [],
            verticalBlockHintRootId: null,
            verticalBlockHintTargetId: null,
          }
        : action,
      metaKey
    );
    updateVerticalLimitHint(sourceData, action, metaKey);
    const boundaryIds = Array.isArray(action?.verticalBlockBoundaryIds)
      ? action.verticalBlockBoundaryIds.filter(Boolean)
      : action?.verticalBlockHintIds;
    if (
      action?.kind === 'layout' &&
      action.detail === 'reorder-visual-block-boundary' &&
      Array.isArray(boundaryIds) &&
      boundaryIds.length > 0
    ) {
      dragLastBoundaryPreviewRef.current = action;
      const nextActiveBoundary = {
        kind: action.verticalBlockBoundaryKind || 'visual-file',
        sourceId: sourceData.fileId,
        sourceParentKey: action.sourceParentKey,
        sourceVisualDepth: action.sourceVisualDepth,
        sourceVisualParentId: action.sourceVisualParentId || null,
        rootId: action.verticalBlockHintRootId || boundaryIds[0],
        ids: boundaryIds,
        side: action.verticalBlockBoundarySide || null,
      };
      if (dragSessionRef.current) {
        dragSessionRef.current.activeBlockBoundary = nextActiveBoundary;
      }
    } else if (action && action.detail !== 'reorder-visual-block-boundary') {
      if (dragSessionRef.current) {
        dragSessionRef.current.activeBlockBoundary = null;
      }
      if (action) {
        dragLastBoundaryPreviewRef.current = null;
      }
    }
    const moveKey =
      `${currentDragSessionId()}:${reason}:${nextKey || 'none'}` +
      `:${Math.round(rawY / DRAG_MOVE_Y_BUCKET_PX)}` +
      `:${Math.round(effectiveY / DRAG_MOVE_Y_BUCKET_PX)}` +
      `:${Math.round(scroll.scrollTop / DRAG_MOVE_SCROLL_BUCKET_PX)}` +
      `:${actionChanged ? 1 : 0}`;
    if (moveKey !== dragMoveLogKeyRef.current) {
      dragMoveLogKeyRef.current = moveKey;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} move` +
        ` reason=${reason}` +
        ` changed=${actionChanged ? 1 : 0}` +
        ` meta=${metaKey ? 1 : 0}` +
        ` layoutChanged=${layoutChanged == null ? '-' : (layoutChanged ? 1 : 0)}` +
        ` ${actionLog}` +
        ` ${formatScrollSnapshot(scroll)}` +
        ` ${sourceRectDiagnostics(sourceData.fileId)}`
      );
    }
    if (!actionChanged) return action;
    dragPreviewKeyRef.current = nextKey;

      if (!action) {
        const preservedPreview = !!dragPreviewLayoutRef.current;
      if (!preservedPreview) {
        setPreviewLayout(null);
        if (dragSessionRef.current) {
          dragSessionRef.current.activeBlockBoundary = null;
        }
      }
      setOverFolderId(null);
      setIsRootOver(false);
      cancelGlobalAutoExpand('no-action');
      console.log(
        DND_LOG_PREFIX,
        `preview none source=${shortPath(sourceData.fileId)}` +
        ` preservedPreview=${preservedPreview ? 1 : 0}`
      );
      return action;
      }

      if (action.kind === 'layout') {
        dragLastLayoutPreviewRef.current = {
          action,
          at: performance.now(),
          sessionId: currentDragSessionId(),
          metaKey,
          reason,
        };
        if (
          isVisualParentAction(action.detail) &&
          action.visualChanged &&
          action.sourceIds?.includes?.(sourceData.fileId)
        ) {
          dragLastVisualParentPreviewRef.current = {
            action,
            at: performance.now(),
            sessionId: currentDragSessionId(),
            metaKey,
            reason,
          };
        }
        updateDragVisualParentBaseline(sourceData, action, reason);
      const previewLayoutAlreadyApplied = !previewLayoutWillChange;
      if (!previewLayoutAlreadyApplied) {
        if (dragSessionRef.current) {
          dragSessionRef.current.previewRevision = (dragSessionRef.current.previewRevision || 0) + 1;
        }
        setPreviewLayout(action.layout);
        const refreshReason = isVisualParentAction(action.detail)
          ? `visual-parent:${action.detail}`
          : (
              action.detail === 'reorder-visual-block-boundary'
                ? `block-boundary:${action.verticalBlockBoundaryDirection || 'unknown'}`
                : `layout:${action.detail || 'unknown'}`
            );
        requestDragGeometryRefresh(
          refreshReason,
          action.visualParentId || action.verticalBlockHintRootId || action.targetId || null
        );
      }
      scheduleHorizontalPreviewAudit(action);
      setOverFolderId(null);
      setIsRootOver(false);
      cancelGlobalAutoExpand('layout');
      console.log(
        DND_LOG_PREFIX,
        `preview layout source=${shortPath(sourceData.fileId)}` +
        ` layoutAlreadyApplied=${previewLayoutAlreadyApplied ? 1 : 0}` +
        ` ${formatActionLog(action)}`
      );
      return action;
    }

    const preservedPreview = !!dragPreviewLayoutRef.current;
    setOverFolderId(action.overFolderId || null);
    setIsRootOver(!!action.isRoot);
    if ((action.detail === 'move-into-folder' || action.detail === 'spring-open-folder') && action.overFolderId) {
      scheduleGlobalAutoExpand(action.overFolderId);
    } else {
      cancelGlobalAutoExpand(action.detail || 'move');
    }
    console.log(
      DND_LOG_PREFIX,
      `preview move source=${shortPath(sourceData.fileId)}` +
      ` preservedPreview=${preservedPreview ? 1 : 0}` +
      ` ${formatActionLog(action)}`
    );
    return action;
  }, [
    cancelGlobalAutoExpand,
    currentDragSessionId,
    formatScrollSnapshot,
    getScrollSnapshot,
    resolveSidebarDrag,
    scheduleGlobalAutoExpand,
    scheduleHorizontalPreviewAudit,
    sidebarLayout,
    setPreviewLayout,
    requestDragGeometryRefresh,
    sourceRectDiagnostics,
    updateDragVisualParentBaseline,
    updateHorizontalDragIntent,
    updateVerticalBlockHint,
    updateVerticalLimitHint,
  ]);

  useLayoutEffect(() => {
    visibleNodesRef.current = visibleNodes;
    const scheduledSeq = dragGeometryRefreshSeqRef.current;
    const refreshSessionId = dragSessionRef.current?.id || null;
    if (!isDraggingGlobalRef.current || scheduledSeq <= dragGeometryRefreshAppliedSeqRef.current) return undefined;

    let raf1 = 0;
    let raf2 = 0;
    let cancelled = false;

    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const seq = dragGeometryRefreshSeqRef.current;
        const request = dragGeometryRefreshReasonRef.current || { reason: 'unknown', folderId: null };
        if (
          cancelled ||
          !isDraggingGlobalRef.current ||
          dragSessionRef.current?.id !== refreshSessionId ||
          seq <= dragGeometryRefreshAppliedSeqRef.current
        ) return;

        const rawY = lastDragClientYRef.current;
        const geometry = captureDragGeometry(rawY, dragSessionRef.current?.sourceId || null);
        if (!geometry?.rows?.length) {
          console.log(
            DND_LOG_PREFIX,
            `session=${currentDragSessionId()} geometry-refresh miss` +
            ` seq=${seq}` +
            ` reason=${request.reason}` +
            ` folder=${shortPath(request.folderId)}`
          );
          return;
        }

        dragGeometryRef.current = {
          ...geometry,
          source: `refresh-${request.reason}`,
          scrollTop: getScrollSnapshot().scrollTop,
        };
        dragGeometryRefreshAppliedSeqRef.current = seq;
        const session = dragSessionRef.current;
        if (session) {
          session.geometryRevision = session.previewRevision || 0;
          if ((session.geometryRefreshPendingSeq || 0) <= seq) {
            session.geometryRefreshPendingSeq = null;
          }
        }
        dragMoveLogKeyRef.current = '';
        dragRejectLogKeyRef.current = '';

        console.log(
          DND_LOG_PREFIX,
          `session=${currentDragSessionId()} geometry-refresh apply` +
          ` seq=${seq}` +
          ` reason=${request.reason}` +
	          ` folder=${shortPath(request.folderId)}` +
	          ` rows=${geometry.rows.length}` +
	          ` rawY=${rawY == null ? '-' : Math.round(rawY)}` +
	          ` sourceRow=${shortPath(geometry.sourceRow?.id)}` +
	          ` sourceFlipY=${Math.round(geometry.sourceRow?.rect?.flipTranslateY || 0)}` +
	          ` previewRev=${session?.previewRevision ?? '-'}` +
	          ` geometryRev=${session?.geometryRevision ?? '-'}` +
	          ` ${sourceRectDiagnostics(dragSessionRef.current?.sourceId || null)}`
	        );

        if (dragSourceDataRef.current && rawY != null) {
          resolveAndApplyDragPreview(
            dragSourceDataRef.current,
            rawY,
            !!dragLastModifiersRef.current?.metaKey,
            `geometry-refresh:${request.reason}`,
            lastDragClientXRef.current
          );
        }
      });
    });

    return () => {
      cancelled = true;
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
	  }, [visibleNodes, captureDragGeometry, currentDragSessionId, resolveAndApplyDragPreview, sourceRectDiagnostics]);

  // Sidebar drag autoscroll must use the same edge band as the visible hint.
  // Atlaskit's default auto-scroll hitbox is up to 180px on tall panes, which
  // makes the list scroll while our UI says "not near edge".
  useEffect(() => {
    if (!isDraggingGlobal) {
      if (dragAutoscrollFrameRef.current) {
        cancelAnimationFrame(dragAutoscrollFrameRef.current);
        dragAutoscrollFrameRef.current = null;
      }
      dragAutoscrollLogKeyRef.current = '';
      dragAutoscrollLastStepAtRef.current = 0;
      return;
    }

    const tick = () => {
      const scroller = getScroller();
      const y = lastDragClientYRef.current;
      if (scroller && y != null) {
        const rect = getVisibleScrollerRect(scroller);
        let direction = null;
        let ratio = 0;

        if (y >= rect.top && y <= rect.top + SCROLL_HINT_THRESHOLD_PX && scroller.scrollTop > 1) {
          direction = 'up';
          ratio = (rect.top + SCROLL_HINT_THRESHOLD_PX - y) / SCROLL_HINT_THRESHOLD_PX;
        } else if (
          y <= rect.bottom &&
          y >= rect.bottom - SCROLL_HINT_THRESHOLD_PX &&
          scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1
        ) {
          direction = 'down';
          ratio = (y - (rect.bottom - SCROLL_HINT_THRESHOLD_PX)) / SCROLL_HINT_THRESHOLD_PX;
        }

        if (direction) {
          const now = performance.now();
          const sinceLastStep = now - dragAutoscrollLastStepAtRef.current;
          if (sinceLastStep < DRAG_AUTOSCROLL_MIN_INTERVAL_MS) {
            dragAutoscrollFrameRef.current = requestAnimationFrame(tick);
            return;
          }
          dragAutoscrollLastStepAtRef.current = now;
          const before = scroller.scrollTop;
          const normalizedRatio = Math.min(1, Math.max(0, ratio));
          const step = Math.max(1, Math.ceil(DRAG_AUTOSCROLL_MAX_STEP_PX * normalizedRatio));
          scroller.scrollTop += direction === 'up' ? -step : step;
          if (before !== scroller.scrollTop) {
            const key =
              `${currentDragSessionId()}:${direction}` +
              `:${Math.round(scroller.scrollTop / DRAG_MOVE_SCROLL_BUCKET_PX)}` +
              `:${Math.round(y / DRAG_MOVE_Y_BUCKET_PX)}`;
            if (key !== dragAutoscrollLogKeyRef.current) {
              dragAutoscrollLogKeyRef.current = key;
              console.log(
                SCROLL_LOG_PREFIX,
                `session=${currentDragSessionId()} drag-autoscroll direction=${direction}` +
                ` before=${Math.round(before)} after=${Math.round(scroller.scrollTop)}` +
                ` y=${Math.round(y)} threshold=${SCROLL_HINT_THRESHOLD_PX}` +
                ` ratio=${normalizedRatio.toFixed(2)} step=${step}` +
                ` minInterval=${DRAG_AUTOSCROLL_MIN_INTERVAL_MS}ms`
              );
            }
          }
        }
      }
      dragAutoscrollFrameRef.current = requestAnimationFrame(tick);
    };

    console.log(SCROLL_LOG_PREFIX, `session=${currentDragSessionId()} drag-autoscroll-attach threshold=${SCROLL_HINT_THRESHOLD_PX}`);
    dragAutoscrollFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (dragAutoscrollFrameRef.current) {
        cancelAnimationFrame(dragAutoscrollFrameRef.current);
        dragAutoscrollFrameRef.current = null;
      }
      dragAutoscrollLastStepAtRef.current = 0;
    };
  }, [isDraggingGlobal, currentDragSessionId]);

  useEffect(() => {
    if (!isDraggingGlobal) return undefined;

    const handleWheel = (event) => {
      const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const pointerY = lastDragClientYRef.current;
      const logSkip = (reason, extra = '') => {
        const key = `${currentDragSessionId()}:${reason}:${Math.round(deltaY || 0)}:${pointerY == null ? '-' : Math.round(pointerY)}`;
        if (key === dragWheelSkipLogKeyRef.current) return;
        dragWheelSkipLogKeyRef.current = key;
        console.log(
          SCROLL_LOG_PREFIX,
          `session=${currentDragSessionId()} drag-wheel-skip reason=${reason}` +
          ` deltaY=${Math.round(deltaY || 0)}` +
          ` pointerY=${pointerY == null ? '-' : Math.round(pointerY)}` +
          extra
        );
      };

      if (!isDraggingGlobalRef.current) {
        logSkip('not-dragging');
        return;
      }
      const scroller = getScroller();
      if (!scroller) {
        logSkip('missing-scroller');
        return;
      }
      if (pointerY == null) {
        logSkip('missing-pointer');
        return;
      }

      const rect = getVisibleScrollerRect(scroller);
      const pointerInsideScroller = pointerY >= rect.top && pointerY <= rect.bottom;
      if (!pointerInsideScroller) {
        logSkip('pointer-outside', ` scroller=${Math.round(rect.top)}..${Math.round(rect.bottom)}`);
        return;
      }

      if (!deltaY) {
        logSkip('zero-delta', ` scroller=${Math.round(rect.top)}..${Math.round(rect.bottom)}`);
        return;
      }
      if (event.cancelable) event.preventDefault();

      const before = scroller.scrollTop;
      scroller.scrollTop += deltaY;
      const after = scroller.scrollTop;
      if (before === after) {
        logSkip(
          'at-scroll-edge',
          ` before=${Math.round(before)} scroller=${Math.round(rect.top)}..${Math.round(rect.bottom)}`
        );
        return;
      }

      const key = `${currentDragSessionId()}:${Math.round(after / DRAG_MOVE_SCROLL_BUCKET_PX)}:${Math.round(deltaY)}`;
      if (key !== dragWheelLogKeyRef.current) {
        dragWheelLogKeyRef.current = key;
        console.log(
          SCROLL_LOG_PREFIX,
          `session=${currentDragSessionId()} drag-wheel` +
          ` before=${Math.round(before)} after=${Math.round(after)}` +
          ` deltaY=${Math.round(deltaY)} pointerY=${Math.round(pointerY)}` +
          ` scroller=${Math.round(rect.top)}..${Math.round(rect.bottom)}`
        );
      }

      updateScrollHintEdge(pointerY, 'wheel');
      if (dragSessionRef.current?.sourceId) {
        updatePinnedDragSource(dragSessionRef.current.sourceId, 'wheel');
      }
      if (dragSourceDataRef.current) {
        resolveAndApplyDragPreview(
          dragSourceDataRef.current,
          pointerY,
          !!dragLastModifiersRef.current?.metaKey,
          'wheel',
          lastDragClientXRef.current
        );
      }
    };

    window.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    console.log(SCROLL_LOG_PREFIX, `session=${currentDragSessionId()} drag-wheel-attach`);
    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true });
      dragWheelLogKeyRef.current = '';
      dragWheelSkipLogKeyRef.current = '';
    };
  }, [isDraggingGlobal, currentDragSessionId, resolveAndApplyDragPreview, updatePinnedDragSource, updateScrollHintEdge]);

  const commitEarlyCmdMove = useCallback((event, eventSource = 'window') => {
    if (!isDraggingGlobalRef.current) return false;
    if (event?.buttons !== 0) return false;

    const pointerX = Number.isFinite(event?.clientX) ? event.clientX : lastDragClientXRef.current;
    const pointerY = Number.isFinite(event?.clientY) ? event.clientY : lastDragClientYRef.current;
    if (!isPointInsideDragSurface(pointerX, pointerY)) {
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} early-release skip reason=outside` +
        ` source=${eventSource} x=${pointerX == null ? '-' : Math.round(pointerX)}` +
        ` y=${pointerY == null ? '-' : Math.round(pointerY)}`
      );
      return false;
    }

    const sessionId = currentDragSessionId();
    if (dragEarlyCommitRef.current?.sessionId === sessionId) return true;

    const session = dragSessionRef.current;
    const pendingGeometrySeq = session?.geometryRefreshPendingSeq || 0;
    if (pendingGeometrySeq > dragGeometryRefreshAppliedSeqRef.current) {
      console.log(
        DND_LOG_PREFIX,
        `session=${sessionId} early-release defer reason=geometry-rebase-pending` +
        ` pendingSeq=${pendingGeometrySeq}` +
        ` appliedSeq=${dragGeometryRefreshAppliedSeqRef.current}` +
        ` previewRev=${session?.previewRevision ?? '-'}` +
        ` geometryRev=${session?.geometryRevision ?? '-'}`
      );
      return false;
    }

    const sourceData = dragSourceDataRef.current;
    const action = dragLastResolvedActionRef.current;
    const sourceId = sourceData?.fileId;
    if (!sourceId || !action || action.kind !== 'move' || action.mode !== 'cmd-folder' || !action.destinationFolder) {
      return false;
    }

    const nodesById = new Map(visibleNodesRef.current.map(node => [node.id, node]));
    const allSourceIds = sourceData.selectedIds && sourceData.selectedIds.length > 1
      ? sourceData.selectedIds
      : [sourceId];
    const moveIds = [];
    for (const sid of allSourceIds) {
      if (!sid) continue;
      const sourceNode = nodesById.get(sid);
      if (sourceNode?.isLink) {
        console.log(DND_LOG_PREFIX, `session=${sessionId} early-release skip link ${shortPath(sid)}`);
        continue;
      }
      const sourceParent = sid.substring(0, sid.lastIndexOf('/'));
      if (sourceParent === action.destinationFolder) {
        console.log(DND_LOG_PREFIX, `session=${sessionId} early-release skip already-in-target ${shortPath(sid)}`);
        continue;
      }
      moveIds.push(sid);
    }

    const expectedMoveIds = moveIds.map(sid => {
      const fileName = sid.split('/').pop();
      return `${action.destinationFolder}/${fileName}`;
    });
    const expectedIds = expectedMoveIds.length > 0 ? expectedMoveIds : [sourceId];
    const actionLog = formatActionLog(action);
    const earlyRecord = {
      sessionId,
      session,
      transportToken: session?.transportToken || String(sourceData.dragToken || ''),
      sourceId,
      expectedIds,
      actionLog,
      consumedByDrop: false,
      succeeded: false,
      finished: false,
      completion: null,
      layoutCommitted: false,
      expansionFinalized: false,
      startedAtWall: Date.now(),
    };
    dragEarlyCommitRef.current = earlyRecord;

    console.log(
      DND_LOG_PREFIX,
      `session=${sessionId} early-release commit` +
      ` source=${eventSource}` +
      ` event=${event?.type || 'unknown'}` +
      ` wall=${Date.now()}` +
      ` x=${event?.clientX == null ? '-' : Math.round(event.clientX)}` +
      ` y=${event?.clientY == null ? '-' : Math.round(event.clientY)}` +
      ` pointerY=${pointerY == null ? '-' : Math.round(pointerY)}` +
      ` moveCount=${moveIds.length}` +
      ` expected=${formatIdList(expectedIds)}` +
      ` ${actionLog}`
    );

    const previewLayoutCommitted = commitPendingPreviewLayoutForMove(sessionId, 'early-release-cmd-move');
    earlyRecord.layoutCommitted = previewLayoutCommitted;

    flushSync(() => {
      setSuppressTreeDropTargets(true);
      clearDragVisualState('early-release-begin', { clearPreview: true, clearSession: false });
    });

    const finishEarlyCommit = (reason, commitExpansion = false) => {
      earlyRecord.succeeded = commitExpansion;
      earlyRecord.finished = true;
      if (earlyRecord.consumedByDrop) return;
      console.log(DND_LOG_PREFIX, `session=${sessionId} early-release finish reason=${reason}`);
      const currentSession = dragSessionRef.current;
      const stillCurrent = currentSession?.id === sessionId
        && currentSession?.transportToken === earlyRecord.transportToken;
      if (stillCurrent) {
        flushSync(() => {
          setSuppressTreeDropTargets(false);
          clearDragVisualState(`early-release-${reason}`, {
            clearPreview: true,
            clearSession: true,
            finalizeExpansion: false,
          });
        });
      }
      if (!earlyRecord.expansionFinalized) {
        earlyRecord.expansionFinalized = true;
        finalizeTemporaryDragExpansions(earlyRecord.session, commitExpansion, `early-release-${reason}`);
      }
      if (dragEarlyCommitRef.current === earlyRecord) dragEarlyCommitRef.current = null;
    };

    if (moveIds.length > 0 && onMoveItems) {
      const t0 = performance.now();
      console.log(DND_LOG_PREFIX, `session=${sessionId} early-release move delegated count=${moveIds.length} dest=${shortPath(action.destinationFolder)}`);
      let optimisticRevealScheduled = false;
      const movePromise = onMoveItems(moveIds, action.destinationFolder, {
        sessionId,
        action,
        reason: 'dnd-early-release',
        onOptimisticMove: (targets) => {
          const optimisticTarget = Array.isArray(targets) ? targets[0] : targets;
          if (!optimisticTarget || optimisticRevealScheduled) return;
          optimisticRevealScheduled = true;
          schedulePostDropReveal(optimisticTarget, sessionId, 'early-release-optimistic');
        },
      });
      schedulePostDropFrameAudit('early-release-optimistic', {
        sessionId,
        sourceId,
        expectedIds,
        pointerY,
      });
      const completion = Promise.resolve(movePromise)
        .then(results => {
          const successTargets = successfulMoveTargets(results);
          console.log(
            DND_LOG_PREFIX,
            `session=${sessionId} early-release move delegated done count=${moveIds.length}` +
            ` elapsed=${Math.round(performance.now() - t0)}ms` +
            ` successTargets=${formatIdList(successTargets)}` +
            ` results=${formatMoveResults(results)}`
          );
          if (successTargets.length > 0) {
            schedulePostDropReveal(successTargets[0], sessionId, 'early-release-success');
            markDropConfirmed(successTargets, sessionId, 'early-release-success');
          } else {
            console.log(
              DND_LOG_PREFIX,
              `session=${sessionId} early-release reveal-skip reason=no-success` +
              ` results=${formatMoveResults(results)}`
            );
          }
          const succeeded = successTargets.length > 0 || previewLayoutCommitted;
          finishEarlyCommit(succeeded ? 'done' : 'no-success', succeeded);
          return succeeded;
        })
        .catch(error => {
          console.log(
            DND_LOG_PREFIX,
            `session=${sessionId} early-release move delegated error` +
            ` elapsed=${Math.round(performance.now() - t0)}ms` +
            ` message=${error?.message || String(error)}`
          );
          finishEarlyCommit('error', false);
          return false;
        });
      earlyRecord.completion = completion;
    } else if (moveIds.length > 0) {
      const completion = (async () => {
        const fallbackSuccessTargets = [];
        for (const sid of moveIds) {
          const fileName = sid.split('/').pop();
          const nextPath = `${action.destinationFolder}/${fileName}`;
          console.log(DND_LOG_PREFIX, `session=${sessionId} early-release moveItem ${shortPath(sid)} -> ${shortPath(action.destinationFolder)}`);
          const success = await fileApi?.moveItem?.(sid, action.destinationFolder);
          console.log(DND_LOG_PREFIX, `session=${sessionId} early-release moveItem result source=${shortPath(sid)} success=${success ? 1 : 0}`);
          if (success) {
            fallbackSuccessTargets.push(nextPath);
            if (onRename) onRename(sid, nextPath);
          }
        }
        if (fallbackSuccessTargets.length > 0) {
          schedulePostDropReveal(fallbackSuccessTargets[0], sessionId, 'early-release-fallback-success');
          markDropConfirmed(fallbackSuccessTargets, sessionId, 'early-release-fallback-success');
        }
        const succeeded = fallbackSuccessTargets.length > 0 || previewLayoutCommitted;
        finishEarlyCommit(succeeded ? 'done' : 'no-success', succeeded);
        return succeeded;
      })().catch(error => {
        console.log(
          DND_LOG_PREFIX,
          `session=${sessionId} early-release fallback error message=${error?.message || String(error)}`
        );
        finishEarlyCommit('error', false);
        return false;
      });
      earlyRecord.completion = completion;
      schedulePostDropFrameAudit('early-release-fallback', {
        sessionId,
        sourceId,
        expectedIds,
        pointerY,
      });
    } else {
      schedulePostDropFrameAudit('early-release-noop', {
        sessionId,
        sourceId,
        expectedIds,
        pointerY,
      });
      earlyRecord.completion = Promise.resolve(false);
      finishEarlyCommit(previewLayoutCommitted ? 'done' : 'noop', previewLayoutCommitted);
    }

    return true;
  }, [clearDragVisualState, commitPendingPreviewLayoutForMove, currentDragSessionId, finalizeTemporaryDragExpansions, isPointInsideDragSurface, markDropConfirmed, onMoveItems, onRename, schedulePostDropFrameAudit, schedulePostDropReveal]);

  useEffect(() => {
    if (!isDraggingGlobal) return undefined;

    const syncModifierMode = (event) => {
      if (event?.type === 'keydown' && event?.key === 'Escape') {
        event.preventDefault?.();
        if (dragEarlyCommitRef.current) dragEarlyCommitRef.current.expansionFinalized = true;
        dragEarlyCommitRef.current = null;
        flushSync(() => {
          setSuppressTreeDropTargets(false);
          clearDragVisualState('escape-cancel', { clearPreview: true, clearSession: true });
        });
        return;
      }
      const isMetaKeyEvent =
        event?.key === 'Meta' ||
        event?.code === 'MetaLeft' ||
        event?.code === 'MetaRight';
      const metaKey = event?.type === 'keyup' && isMetaKeyEvent
        ? false
        : !!(event?.metaKey || isMetaKeyEvent);
      dragLastModifiersRef.current = { metaKey };
      setDragFolderMode(metaKey, `modifier-${event?.type || 'event'}`);
      const sourceData = dragSourceDataRef.current;
      if (sourceData && lastDragClientYRef.current != null) {
        resolveAndApplyDragPreview(
          sourceData,
          lastDragClientYRef.current,
          metaKey,
          `modifier-${event?.type || 'event'}`,
          lastDragClientXRef.current
        );
      }
    };

    window.addEventListener('keydown', syncModifierMode, true);
    window.addEventListener('keyup', syncModifierMode, true);

    return () => {
      window.removeEventListener('keydown', syncModifierMode, true);
      window.removeEventListener('keyup', syncModifierMode, true);
    };
  }, [clearDragVisualState, isDraggingGlobal, resolveAndApplyDragPreview, setDragFolderMode]);

  useEffect(() => {
    if (!isDraggingGlobal) return undefined;

    const logNativeDragEvent = (event, eventSource = 'window') => {
      const now = performance.now();
      const wall = Date.now();
      const target = event?.target instanceof Element ? event.target : event?.target?.parentElement;
      const row = target?.closest?.('.arborist-node[data-node-id]');
      const rowId = row?.dataset?.nodeId || null;
      const lastResolve = dragLastResolveSnapshotRef.current;
      const session = dragSessionRef.current;
      const sinceStart = session?.startAt == null ? null : now - session.startAt;
      const sinceLastResolve = lastResolve?.at == null ? null : now - lastResolve.at;
      const dropEffect = event?.dataTransfer?.dropEffect || '-';
      const effectAllowed = event?.dataTransfer?.effectAllowed || '-';
      const isTerminalEvent = ['drop', 'dragend', 'dragleave'].includes(event?.type);
      const key = [
        eventSource,
        event?.type || 'unknown',
        rowId || '-',
        event?.metaKey ? 1 : 0,
        Math.round((event?.clientY ?? -1) / DRAG_MOVE_Y_BUCKET_PX),
        dropEffect,
        effectAllowed,
      ].join(':');
      const shouldLog = isTerminalEvent
        || key !== dragNativeEventLogKeyRef.current
        || now - dragNativeEventLastAtRef.current >= 120;
      if (!shouldLog) return;

      dragNativeEventLogKeyRef.current = key;
      dragNativeEventLastAtRef.current = now;
      console.log(
        DND_LOG_PREFIX,
        `session=${currentDragSessionId()} native-event` +
        ` source=${eventSource}` +
        ` type=${event?.type || 'unknown'}` +
        ` wall=${wall}` +
        ` sinceStart=${sinceStart == null ? '-' : `${Math.round(sinceStart)}ms`}` +
        ` sinceLastResolve=${sinceLastResolve == null ? '-' : `${Math.round(sinceLastResolve)}ms`}` +
        ` x=${event?.clientX == null ? '-' : Math.round(event.clientX)}` +
        ` y=${event?.clientY == null ? '-' : Math.round(event.clientY)}` +
        ` meta=${event?.metaKey ? 1 : 0}` +
        ` buttons=${event?.buttons == null ? '-' : event.buttons}` +
        ` defaultPrevented=${event?.defaultPrevented ? 1 : 0}` +
        ` dropEffect=${dropEffect}` +
        ` effectAllowed=${effectAllowed}` +
        ` target=${shortPath(rowId)}` +
        ` targetDir=${row?.dataset?.isDirectory === 'true' ? 1 : 0}` +
        ` lastReason=${lastResolve?.reason || '-'}` +
        ` lastAction=${lastResolve?.actionLog || '-'}`
      );
    };

    const handleNativeDragEnd = (event, eventSource = 'window') => {
      logNativeDragEvent(event, eventSource);
      const eventType = event?.type || 'unknown';
      const reason = `end-fallback-${eventType}`;
      const now = performance.now();
      const session = dragSessionRef.current;
      const fallbackSessionId = session?.id || null;
      const fallbackTransportToken = session?.transportToken || null;
      const lastResolve = dragLastResolveSnapshotRef.current;
      const isFirstPhysicalEnd = !dragPhysicalEndRef.current;
      if (isFirstPhysicalEnd) {
        dragPhysicalEndRef.current = {
          at: now,
          eventType,
          clientX: event?.clientX,
          clientY: event?.clientY,
          lastResolve,
        };
      }

      const sinceStart = session?.startAt == null ? null : now - session.startAt;
      const sinceLastResolve = lastResolve?.at == null ? null : now - lastResolve.at;
      const physicalKey =
        `${currentDragSessionId()}:${eventSource}:${eventType}:${isFirstPhysicalEnd ? 1 : 0}` +
        `:${Math.round(event?.clientX ?? -1)}:${Math.round(event?.clientY ?? -1)}`;
      if (physicalKey !== dragPhysicalEndLogKeyRef.current) {
        dragPhysicalEndLogKeyRef.current = physicalKey;
        console.log(
          DND_LOG_PREFIX,
          `session=${currentDragSessionId()} physical-end` +
          ` source=${eventSource}` +
          ` event=${eventType}` +
          ` first=${isFirstPhysicalEnd ? 1 : 0}` +
          ` sinceStart=${sinceStart == null ? '-' : `${Math.round(sinceStart)}ms`}` +
          ` sinceLastResolve=${sinceLastResolve == null ? '-' : `${Math.round(sinceLastResolve)}ms`}` +
          ` x=${event?.clientX == null ? '-' : Math.round(event.clientX)}` +
          ` y=${event?.clientY == null ? '-' : Math.round(event.clientY)}` +
          ` lastReason=${lastResolve?.reason || '-'}` +
          ` lastRawY=${lastResolve?.rawY == null ? '-' : Math.round(lastResolve.rawY)}` +
          ` lastEffectiveY=${lastResolve?.effectiveY == null ? '-' : Math.round(lastResolve.effectiveY)}` +
          ` lastMeta=${lastResolve?.metaKey ? 1 : 0}` +
          ` dropStarted=${dragDropStartedRef.current ? 1 : 0}` +
          ` dragging=${isDraggingGlobalRef.current ? 1 : 0}` +
          ` lastAction=${lastResolve?.actionLog || '-'}`
        );
      }

      window.setTimeout(() => {
        const currentSession = dragSessionRef.current;
        if (
          !isDraggingGlobalRef.current
          || !fallbackSessionId
          || currentSession?.id !== fallbackSessionId
          || currentSession?.transportToken !== fallbackTransportToken
        ) return;
        console.log(DND_LOG_PREFIX, `session=${currentDragSessionId()} end-fallback reason=${reason}`);
        clearDragVisualState(reason, { clearPreview: true, clearSession: true });
      }, DRAG_END_FALLBACK_DELAY_MS);
    };

    const container = containerRef.current;
    const onWindowEnd = (event) => handleNativeDragEnd(event, 'window');
    const onDocumentEnd = (event) => handleNativeDragEnd(event, 'document');
    const onContainerEnd = (event) => handleNativeDragEnd(event, 'container');
    const eventTypes = ['pointerup', 'mouseup', 'dragend', 'drop'];
    const nativeDragTypes = ['dragenter', 'dragover', 'dragleave'];
    const handleNativeDragEvent = (event, eventSource) => {
      logNativeDragEvent(event, eventSource);
      const earlyCommit = dragEarlyCommitRef.current;
      if (earlyCommit || !isDraggingGlobalRef.current) return;
      const metaKey = !!event?.metaKey;
      dragLastModifiersRef.current = { metaKey };
      setDragFolderMode(metaKey, `native-${event?.type || 'event'}`);
      if (event?.type === 'dragover' || event?.type === 'dragleave') {
        commitEarlyCmdMove(event, eventSource);
      }
    };
    const onWindowNative = (event) => handleNativeDragEvent(event, 'window');
    const onDocumentNative = (event) => handleNativeDragEvent(event, 'document');
    const onContainerNative = (event) => handleNativeDragEvent(event, 'container');
    for (const eventType of eventTypes) {
      window.addEventListener(eventType, onWindowEnd, true);
      document.addEventListener(eventType, onDocumentEnd, true);
      container?.addEventListener(eventType, onContainerEnd, true);
    }
    for (const eventType of nativeDragTypes) {
      window.addEventListener(eventType, onWindowNative, true);
      document.addEventListener(eventType, onDocumentNative, true);
      container?.addEventListener(eventType, onContainerNative, true);
    }

    return () => {
      for (const eventType of eventTypes) {
        window.removeEventListener(eventType, onWindowEnd, true);
        document.removeEventListener(eventType, onDocumentEnd, true);
        container?.removeEventListener(eventType, onContainerEnd, true);
      }
      for (const eventType of nativeDragTypes) {
        window.removeEventListener(eventType, onWindowNative, true);
        document.removeEventListener(eventType, onDocumentNative, true);
        container?.removeEventListener(eventType, onContainerNative, true);
      }
    };
  }, [clearDragVisualState, commitEarlyCmdMove, currentDragSessionId, isDraggingGlobal, setDragFolderMode]);

  // Drop Monitor
  useEffect(() => {
    return monitorForElements({
      onDragStart: (args) => {
        // Только для drag из sidebar (TREE_NODE), не для табов
        if (args.source.data.type !== 'TREE_NODE') return;
        const initialInput = args.location.initial.input;
        const y = initialInput.clientY;
        const sessionId = `${Date.now().toString(36)}-${dragSessionSeqRef.current += 1}`;
        const scroll = getScrollSnapshot();
        const nodeById = new Map(visibleNodesRef.current.map(node => [node.id, node]));
        const sourceNode = nodeById.get(args.source.data.fileId);
        const geometry = captureDragGeometry(y, args.source.data.fileId);
        const {
          selectedRootIds: selectedIds,
          isMultiSelection,
        } = normalizeDragSelection(
          args.source.data,
          nodeById,
          (geometry?.rows || []).map(row => row.id)
        );
        const sourceBlockIds = (() => {
          if (!isMultiSelection) {
            return [args.source.data.fileId, ...collectVisualChildren(args.source.data.fileId, nodeById)];
          }
          const expanded = new Set();
          selectedIds.forEach(id => {
            if (!nodeById.has(id)) return;
            expanded.add(id);
            collectVisualChildren(id, nodeById).forEach(childId => expanded.add(childId));
          });
          return (geometry?.rows || [])
            .map(row => row.id)
            .filter(id => expanded.has(id));
        })();
        const sourceRenderBlockIds = (() => {
          const displayed = new Set(sourceBlockIds);
          selectedIds.forEach(id => {
            if (!nodeById.get(id)?.isDirectory) return;
            const prefix = `${id}/`;
            (geometry?.rows || []).forEach(row => {
              if (row.id.startsWith(prefix)) displayed.add(row.id);
            });
          });
          return (geometry?.rows || [])
            .map(row => row.id)
            .filter(id => displayed.has(id));
        })();
        dragSessionRef.current = {
          id: sessionId,
          transportToken: String(args.source.data.dragToken || ''),
          sourceId: args.source.data.fileId,
          startAt: performance.now(),
          startX: initialInput.clientX,
	          horizontalBaseX: initialInput.clientX,
	          visualParentByPath: {},
          visualParentCommitKey: '',
	          sourceOrderIds: sourceBlockIds,
	          sourceRenderBlockIds,
	          previewLayout: null,
	          previewRevision: 0,
	          geometryRevision: 0,
	          geometryRefreshPendingSeq: null,
	          activeBlockBoundary: null,
	          expandedBeforeDrag: { ...expandedIdsRef.current },
	          temporaryExpandedIds: new Set(),
	          startY: y,
          startScrollTop: scroll.scrollTop,
          lastScrollTop: scroll.scrollTop,
        };
        lastDragClientYRef.current = y;
        lastDragClientXRef.current = initialInput.clientX;
        dragSourceDataRef.current = args.source.data;
        dragGeometryRef.current = geometry
          ? { ...geometry, source: 'drag-start', scrollTop: scroll.scrollTop }
          : null;
        dragAnchorRef.current = geometry?.sourceRow
          ? {
              offsetY: geometry.sourceRow.rect.mid - y,
              sourceId: geometry.sourceRow.id,
            }
          : null;
        dragLastModifiersRef.current = { metaKey: !!initialInput.metaKey };
        dragPreviewKeyRef.current = '';
        dragMoveLogKeyRef.current = '';
        dragRejectLogKeyRef.current = '';
        dragScrollLogKeyRef.current = '';
        dragGeometryRefreshSeqRef.current = 0;
        dragGeometryRefreshAppliedSeqRef.current = 0;
        dragGeometryRefreshReasonRef.current = null;
        dragLastResolvedActionRef.current = null;
        dragLastLayoutPreviewRef.current = null;
        dragLastVisualParentPreviewRef.current = null;
        dragLastResolveSnapshotRef.current = null;
        dragPhysicalEndRef.current = null;
        dragPhysicalEndLogKeyRef.current = '';
        dragEarlyCommitRef.current = null;
        dragDropStartedRef.current = false;
        setSuppressTreeDropTargets(false);
        setDragSourceBlock({ ids: sourceRenderBlockIds, rootIds: selectedIds });
        setPreviewLayout(null);
        setDragVerticalBlockHint(null);
        setDragVerticalLimitHint(null);
        setDragFolderMode(!!initialInput.metaKey, 'drag-start');
        dragVerticalBlockHintLogKeyRef.current = '';
        dragVerticalLimitHintLogKeyRef.current = '';
        updateScrollHintEdge(y, 'drag-start');
        console.log(
          DND_LOG_PREFIX,
          `session=${sessionId} start` +
          ` wall=${Date.now()}` +
          ` source=${shortPath(args.source.data.fileId)}` +
          ` sourceKind=${sourceNode?.isDirectory ? 'dir' : (sourceNode?.isLink ? 'link' : 'file')}` +
          ` sourceParent=${shortPath(pathParentKey(args.source.data.fileId, folderPath))}` +
          ` selected=${formatIdList(selectedIds)}` +
          ` block=${formatIdList(sourceBlockIds)}` +
          ` rows=${geometry?.rows?.length || 0}` +
          ` sourceRect=${formatRect(geometry?.sourceRow?.rect)}` +
          ` anchorOffset=${dragAnchorRef.current ? Math.round(dragAnchorRef.current.offsetY) : '-'}` +
          ` x=${Math.round(initialInput.clientX)}` +
          ` y=${Math.round(y)} ${formatScrollSnapshot(scroll)}`
        );
        isDraggingGlobalRef.current = true;
        setIsDraggingGlobal(true);
        updatePinnedDragSource(args.source.data.fileId, 'drag-start');
      },
      onDrag: ({ location, source }) => {
        // Only react to sidebar drags — ignore tab/directory-bar sources
        if (source.data.type !== 'TREE_NODE') return;
        const activeSession = dragSessionRef.current;
        if (
          !activeSession
          || activeSession.sourceId !== source.data.fileId
          || activeSession.transportToken !== String(source.data.dragToken || '')
        ) {
          console.log(
            DND_LOG_PREFIX,
            `session=${activeSession?.id || '-'} drag-skip stale-transport` +
            ` source=${shortPath(source.data.fileId)}` +
            ` token=${source.data.dragToken || '-'} activeToken=${activeSession?.transportToken || '-'}`
          );
          return;
        }
        // Electron can emit one more dragover after the early-release path has
        // already committed and cleared the gesture. Treat the early-commit ref
        // as a tombstone so that stale events cannot recreate a one-frame target.
        if (dragEarlyCommitRef.current || !isDraggingGlobalRef.current) return;
        const input = location.current.input;
        const metaKey = !!input.metaKey;
        dragLastModifiersRef.current = { metaKey };
        setDragFolderMode(metaKey, 'drag');
        dragSourceDataRef.current = source.data;
        lastDragClientXRef.current = input.clientX;
        lastDragClientYRef.current = input.clientY;
        updateScrollHintEdge(input.clientY, 'drag');
        updatePinnedDragSource(source.data.fileId, 'drag');
        resolveAndApplyDragPreview(source.data, input.clientY, metaKey, 'drag', input.clientX);
      },
      onDragLeave: () => {
        setOverFolderId(null);
        setIsRootOver(false);
        setDragVerticalBlockHint(null);
        setDragVerticalLimitHint(null);
        setDragFolderMode(false, 'drag-leave');
        dragVerticalBlockHintLogKeyRef.current = '';
        dragVerticalLimitHintLogKeyRef.current = '';
        setPreviewLayout(null);
        dragPreviewKeyRef.current = '';
        dragSourceDataRef.current = null;
        dragLastModifiersRef.current = { metaKey: false };
        dragLastLayoutPreviewRef.current = null;
        dragLastVisualParentPreviewRef.current = null;
        dragLastResolvedActionRef.current = null;
        dragLastBoundaryPreviewRef.current = null;
        dragLastResolveSnapshotRef.current = null;
        if (dragSessionRef.current) dragSessionRef.current.activeBlockBoundary = null;
        lastDragClientXRef.current = null;
        lastDragClientYRef.current = null;
        updatePinnedDragSource(null, 'drag-leave');
        resetScrollHintEdge('drag-leave');
        cancelGlobalAutoExpand('drag-leave');
        console.log(DND_LOG_PREFIX, `session=${currentDragSessionId()} leave`);
      },
      onDrop: async ({ source, location }) => {
        // Только для drag из sidebar
        if (source.data.type !== 'TREE_NODE') return;

        const sourceId = source.data.fileId;
        const sourceTransportToken = String(source.data.dragToken || '');
        const activeSessionAtDrop = dragSessionRef.current;
        const earlyRecordAtDrop = dragEarlyCommitRef.current;
        const activeTransportMatches = !!activeSessionAtDrop
          && activeSessionAtDrop.sourceId === sourceId
          && activeSessionAtDrop.transportToken === sourceTransportToken;
        const earlyTransportMatches = !!earlyRecordAtDrop
          && earlyRecordAtDrop.sourceId === sourceId
          && earlyRecordAtDrop.transportToken === sourceTransportToken;
        if (!activeTransportMatches && !earlyTransportMatches) {
          console.log(
            DND_LOG_PREFIX,
            `session=${activeSessionAtDrop?.id || '-'} drop-skip stale-transport` +
            ` source=${shortPath(sourceId)} token=${sourceTransportToken || '-'}` +
            ` activeToken=${activeSessionAtDrop?.transportToken || '-'}`
          );
          return;
        }
        // A late Atlaskit drop from an early-committed gesture must not touch a
        // newer gesture that has already replaced the active session.
        if (!activeTransportMatches && earlyTransportMatches) return;

        const sessionId = activeSessionAtDrop.id;
        const dropAt = performance.now();
        const physicalEnd = dragPhysicalEndRef.current;
        const physicalDelay = physicalEnd?.at == null ? null : dropAt - physicalEnd.at;
        const sinceStart = dragSessionRef.current?.startAt == null ? null : dropAt - dragSessionRef.current.startAt;
        dragDropStartedRef.current = true;
        const input = location.current.input;
        const dropClientX = input.clientX;
        const dropClientY = input.clientY;
        const currentDropTargets = Array.isArray(location.current.dropTargets)
          ? location.current.dropTargets
          : [];
        const treeRoot = containerRef.current;
        const hasCurrentTreeTarget = currentDropTargets.some(target => (
          target?.element === treeRoot || treeRoot?.contains?.(target?.element)
        ));
        const isInsideSurface = isPointInsideDragSurface(dropClientX, dropClientY);
        if ((!isInsideSurface || !hasCurrentTreeTarget) && !earlyTransportMatches) {
          const cancelReason = isInsideSurface ? 'no-current-target' : 'outside';
          console.log(
            DND_LOG_PREFIX,
            `session=${sessionId} drop cancelled reason=${cancelReason} source=${shortPath(sourceId)}` +
            ` x=${Math.round(dropClientX)} y=${Math.round(dropClientY)}` +
            ` targets=${currentDropTargets.length}`
          );
          dragEarlyCommitRef.current = null;
          flushSync(() => {
            clearDragVisualState(`drop-${cancelReason}`, { clearPreview: true, clearSession: true });
          });
          schedulePostDropFrameAudit(`drop-${cancelReason}`, {
            sessionId,
            sourceId,
            pointerY: dropClientY,
          });
          return;
        }
        const earlyCommit = dragEarlyCommitRef.current;
        if (
          sourceId &&
          earlyCommit &&
          !earlyCommit.consumedByDrop &&
          earlyCommit.sourceId === sourceId &&
          earlyCommit.transportToken === sourceTransportToken
        ) {
          const earlySessionId = earlyCommit.sessionId || sessionId;
          earlyCommit.consumedByDrop = true;
          const earlySucceeded = earlyCommit.completion
            ? await Promise.resolve(earlyCommit.completion).catch(() => false)
            : !!earlyCommit.succeeded;
          console.log(
            DND_LOG_PREFIX,
            `session=${earlySessionId} drop-skip early-commit` +
            ` wall=${Date.now()}` +
            ` source=${shortPath(sourceId)}` +
            ` expected=${formatIdList(earlyCommit.expectedIds)}` +
            ` succeeded=${earlySucceeded ? 1 : 0}` +
            ` sinceEarly=${earlyCommit.startedAtWall ? `${Date.now() - earlyCommit.startedAtWall}ms` : '-'}` +
            ` ${earlyCommit.actionLog || ''}`
          );
          const currentSession = dragSessionRef.current;
          const stillCurrent = currentSession?.id === earlySessionId
            && currentSession?.transportToken === earlyCommit.transportToken;
          if (stillCurrent) {
            flushSync(() => {
              setSuppressTreeDropTargets(false);
              clearDragVisualState('drop-skip-early-commit', {
                clearPreview: true,
                clearSession: true,
                finalizeExpansion: false,
              });
            });
          }
          if (!earlyCommit.expansionFinalized) {
            earlyCommit.expansionFinalized = true;
            finalizeTemporaryDragExpansions(
              earlyCommit.session,
              earlySucceeded,
              'drop-skip-early-commit'
            );
          }
          schedulePostDropFrameAudit('drop-skip-early-commit', {
            sessionId: earlySessionId,
            sourceId,
            expectedIds: earlyCommit.expectedIds,
            pointerY: input.clientY,
          });
          if (dragEarlyCommitRef.current === earlyCommit) dragEarlyCommitRef.current = null;
          return;
        }

        const dropMetaKey = !!input.metaKey;
        const lastMetaKey = !!dragLastModifiersRef.current?.metaKey;
        const metaKey = dropMetaKey || lastMetaKey;
        const anchor = dragAnchorRef.current;
        const effectiveY = anchor ? dropClientY + anchor.offsetY : dropClientY;
        let dropSession = dragSessionRef.current;
        let geometryRebasePending =
          (dropSession?.geometryRefreshPendingSeq || 0) > dragGeometryRefreshAppliedSeqRef.current;
        if (geometryRebasePending) {
          await waitForTwoAnimationFrames();
          dropSession = dragSessionRef.current;
          geometryRebasePending =
            dropSession?.id !== sessionId ||
            (dropSession?.geometryRefreshPendingSeq || 0) > dragGeometryRefreshAppliedSeqRef.current;

          if (dropSession?.id === sessionId && geometryRebasePending) {
            const geometry = captureDragGeometry(dropClientY, sourceId);
            if (geometry?.rows?.length) {
              const seq = dropSession.geometryRefreshPendingSeq || dragGeometryRefreshSeqRef.current;
              dragGeometryRef.current = {
                ...geometry,
                source: 'drop-rebase',
                scrollTop: getScrollSnapshot().scrollTop,
              };
              dragGeometryRefreshAppliedSeqRef.current = Math.max(
                dragGeometryRefreshAppliedSeqRef.current,
                seq
              );
              dropSession.geometryRevision = dropSession.previewRevision || 0;
              dropSession.geometryRefreshPendingSeq = null;
              geometryRebasePending = false;
              console.log(
                DND_LOG_PREFIX,
                `session=${sessionId} geometry-refresh apply-drop` +
                ` seq=${seq}` +
                ` rows=${geometry.rows.length}` +
                ` sourceRow=${shortPath(geometry.sourceRow?.id)}` +
                ` previewRev=${dropSession.previewRevision}` +
                ` geometryRev=${dropSession.geometryRevision}`
              );
            }
          }
        }
        if (
          dragSessionRef.current?.id !== sessionId
          || dragSessionRef.current?.transportToken !== sourceTransportToken
        ) {
          console.log(DND_LOG_PREFIX, `session=${sessionId} drop-skip session-replaced-during-rebase`);
          return;
        }
        const resolvedAction = geometryRebasePending
          ? null
          : resolveSidebarDrag(source.data, effectiveY, dropClientY, {
              metaKey,
              clientX: dropClientX,
            });
        const lastPreviewAction = dragLastResolvedActionRef.current;
        const lastBoundaryPreviewAction = dragLastBoundaryPreviewRef.current;
        const lastLayoutPreview = dragLastLayoutPreviewRef.current;
        const lastLayoutPreviewAction = lastLayoutPreview?.action || null;
        const lastVisualParentPreview = dragLastVisualParentPreviewRef.current;
        const lastVisualParentPreviewAction = lastVisualParentPreview?.action || null;
        const currentIsBoundaryPreview =
          resolvedAction?.kind === 'layout' &&
          resolvedAction?.detail === 'reorder-visual-block-boundary';
        const currentIsRefreshNoopReorder =
          resolvedAction?.kind === 'layout' &&
          resolvedAction?.detail === 'reorder' &&
          String(resolvedAction?.targetSource || '').startsWith('refresh-visual-parent') &&
          !resolvedAction?.orderChanged;
        const useLastBoundaryPreview =
          !metaKey &&
          lastBoundaryPreviewAction?.kind === 'layout' &&
          lastBoundaryPreviewAction?.detail === 'reorder-visual-block-boundary' &&
          lastBoundaryPreviewAction?.sourceIds?.includes?.(sourceId) &&
          (!resolvedAction || currentIsBoundaryPreview);
        const canUseLastVisualParentPreview =
          !useLastBoundaryPreview &&
          !metaKey &&
          currentIsRefreshNoopReorder &&
          lastVisualParentPreviewAction?.kind === 'layout' &&
          isVisualParentAction(lastVisualParentPreviewAction.detail) &&
          lastVisualParentPreviewAction?.sourceIds?.includes?.(sourceId) &&
          lastVisualParentPreview?.sessionId === sessionId;
        const canUseLastLayoutPreview =
          !useLastBoundaryPreview &&
          !canUseLastVisualParentPreview &&
          !metaKey &&
          !resolvedAction &&
          !!dragPreviewLayoutRef.current &&
          lastLayoutPreviewAction?.kind === 'layout' &&
          lastLayoutPreviewAction?.detail !== 'vertical-limit' &&
          lastLayoutPreviewAction?.sourceIds?.includes?.(sourceId) &&
          lastLayoutPreview?.sessionId === sessionId;
        const action = useLastBoundaryPreview
          ? lastBoundaryPreviewAction
          : (canUseLastVisualParentPreview
              ? lastVisualParentPreviewAction
              : (canUseLastLayoutPreview ? lastLayoutPreviewAction : resolvedAction));
        console.log(
          DND_LOG_PREFIX,
          `session=${sessionId} drop-resolve meta=${metaKey ? 1 : 0}` +
          ` wall=${Date.now()}` +
          ` metaDrop=${dropMetaKey ? 1 : 0} metaLast=${lastMetaKey ? 1 : 0} metaUsed=${metaKey ? 1 : 0}` +
          ` physicalEnd=${physicalEnd?.eventType || '-'}` +
          ` physicalDelay=${physicalDelay == null ? '-' : `${Math.round(physicalDelay)}ms`}` +
          ` sinceStart=${sinceStart == null ? '-' : `${Math.round(sinceStart)}ms`}` +
          ` geometryPending=${geometryRebasePending ? 1 : 0}` +
          ` previewRev=${dropSession?.previewRevision ?? '-'}` +
          ` geometryRev=${dropSession?.geometryRevision ?? '-'}` +
          ` actionSource=${useLastBoundaryPreview ? 'last-boundary-preview' : (canUseLastVisualParentPreview ? 'last-visual-parent-preview' : (canUseLastLayoutPreview ? 'last-layout-preview' : 'current-resolve'))}` +
          ` currentDetail=${resolvedAction?.detail || 'none'}` +
          ` lastDetail=${lastPreviewAction?.detail || 'none'}` +
          ` lastBoundaryDetail=${lastBoundaryPreviewAction?.detail || 'none'}` +
          ` lastLayoutDetail=${lastLayoutPreviewAction?.detail || 'none'}` +
          ` lastVisualParentDetail=${lastVisualParentPreviewAction?.detail || 'none'}` +
          ` ${formatActionLog(action)} ${formatScrollSnapshot(getScrollSnapshot())}`
        );
        if (!sourceId) {
          flushSync(() => {
            clearDragVisualState('drop-no-source', { clearPreview: true, clearSession: true });
          });
          schedulePostDropFrameAudit('drop-no-source', {
            sessionId,
            sourceId,
            pointerY: dropClientY,
          });
          return; // Not a file drag?
        }

        if (!action) {
            console.log(DND_LOG_PREFIX, `session=${sessionId} drop cancelled source=${shortPath(sourceId)}`);
            flushSync(() => {
              clearDragVisualState('drop-cancel', { clearPreview: true, clearSession: true });
            });
            schedulePostDropFrameAudit('drop-cancel', {
              sessionId,
              sourceId,
              pointerY: dropClientY,
            });
            return;
        }

        if (action.kind === 'layout' && action.detail === 'vertical-limit') {
          console.log(DND_LOG_PREFIX, `session=${sessionId} drop cancelled reason=vertical-limit source=${shortPath(sourceId)} ${formatActionLog(action)}`);
          flushSync(() => {
            clearDragVisualState('drop-vertical-limit', { clearPreview: true, clearSession: true });
          });
          schedulePostDropFrameAudit('drop-vertical-limit', {
            sessionId,
            sourceId,
	            pointerY: dropClientY,
          });
          return;
        }

        if (action.kind === 'layout' && action.visualBlockedReason && !action.orderChanged) {
          console.log(
            DND_LOG_PREFIX,
            `session=${sessionId} drop cancelled reason=${action.visualBlockedReason}` +
            ` source=${shortPath(sourceId)} ${formatActionLog(action)}`
          );
          flushSync(() => {
            clearDragVisualState('drop-horizontal-blocked', { clearPreview: true, clearSession: true });
          });
          return;
        }

        const capturedDropSession = dragSessionRef.current;
        flushSync(() => {
          clearDragVisualState('drop-begin', {
            clearPreview: true,
            clearSession: true,
            finalizeExpansion: false,
          });
        });
        let finishReason = action.kind === 'layout' ? 'drop-layout' : 'drop-move';
        let finishExpectedIds = [sourceId];
        let dropSucceeded = false;

        try {
          if (action.kind === 'layout') {
            flushSync(() => {
              onApplySidebarLayout?.(action.layout, { activateManualOrder: true, reason: 'dnd-reorder' });
            });
            finishExpectedIds = [sourceId];
            console.log(DND_LOG_PREFIX, `session=${sessionId} drop layout source=${shortPath(sourceId)} ${formatActionLog(action)}`);
            schedulePostDropReveal(sourceId, sessionId, 'drop-layout');
            markDropConfirmed(sourceId, sessionId, 'drop-layout');
            dropSucceeded = true;
            return;
          }

          const destinationFolder = action.destinationFolder;
          console.log(DND_LOG_PREFIX, `session=${sessionId} drop move source=${shortPath(sourceId)} ${formatActionLog(action)}`);
          const previewLayoutCommitted = commitPendingPreviewLayoutForMove(sessionId, 'drop-cmd-move');
          dropSucceeded = previewLayoutCommitted;

          // 2. Execute Move (multi-select: move all selected items)
          if (destinationFolder) {
            const nodesById = new Map(visibleNodesRef.current.map(node => [node.id, node]));
            const allSourceIds = source.data.selectedIds && source.data.selectedIds.length > 1
              ? source.data.selectedIds
              : [sourceId]

            const moveIds = [];
            for (const sid of allSourceIds) {
              if (!sid) continue
              const sourceNode = nodesById.get(sid);
              if (sourceNode?.isLink) {
                  console.log(DND_LOG_PREFIX, `skip physical move for link ${shortPath(sid)}`);
                  continue;
              }
              const sParent = sid.substring(0, sid.lastIndexOf('/'));
              if (sParent === destinationFolder) {
                  console.log(DND_LOG_PREFIX, `${shortPath(sid)} already in target folder, skipping`);
                  continue;
              }
              moveIds.push(sid);
            }

            const expectedMoveIds = moveIds.map(sid => {
              const fName = sid.split('/').pop();
              return `${destinationFolder}/${fName}`;
            });
            if (expectedMoveIds.length > 0) {
              finishExpectedIds = expectedMoveIds;
            }

            if (moveIds.length > 0 && onMoveItems) {
              const t0 = performance.now();
              console.log(DND_LOG_PREFIX, `session=${sessionId} move delegated count=${moveIds.length} dest=${shortPath(destinationFolder)}`);
              let optimisticRevealScheduled = false;
              const movePromise = onMoveItems(moveIds, destinationFolder, {
                sessionId,
                action,
                onOptimisticMove: (targets) => {
                  const optimisticTarget = Array.isArray(targets) ? targets[0] : targets;
                  if (!optimisticTarget || optimisticRevealScheduled) return;
                  optimisticRevealScheduled = true;
                  schedulePostDropReveal(optimisticTarget, sessionId, 'drop-move-optimistic');
                },
              });
              schedulePostDropFrameAudit('drop-move-optimistic', {
                sessionId,
                sourceId,
                expectedIds: expectedMoveIds,
                pointerY: input.clientY,
              });
              const results = await movePromise;
              const successTargets = successfulMoveTargets(results);
              if (successTargets.length > 0) {
                finishExpectedIds = successTargets;
                dropSucceeded = true;
                schedulePostDropReveal(successTargets[0], sessionId, 'drop-move-success');
                markDropConfirmed(successTargets, sessionId, 'drop-move-success');
              } else {
                finishExpectedIds = [sourceId];
                console.log(
                  DND_LOG_PREFIX,
                  `session=${sessionId} drop move reveal-skip reason=no-success` +
                  ` results=${formatMoveResults(results)}`
                );
              }
              console.log(
                DND_LOG_PREFIX,
                `session=${sessionId} move delegated done count=${moveIds.length}` +
                ` elapsed=${Math.round(performance.now() - t0)}ms` +
                ` successTargets=${formatIdList(successTargets)}` +
                ` results=${formatMoveResults(results)}`
              );
            } else {
              for (const sid of moveIds) {
                const fName = sid.split('/').pop();
                const nPath = `${destinationFolder}/${fName}`;
                console.log(DND_LOG_PREFIX, `moveItem ${shortPath(sid)} -> ${shortPath(destinationFolder)}`);
                const success = await fileApi?.moveItem?.(sid, destinationFolder);
                if (success) {
                    dropSucceeded = true;
                    console.log(DND_LOG_PREFIX, `move success ${shortPath(nPath)}`);
                    if (onRename) onRename(sid, nPath);
                    schedulePostDropReveal(nPath, sessionId, 'drop-move-fallback');
                } else {
                    console.log(DND_LOG_PREFIX, `move failed ${shortPath(sid)}`);
                }
              }
            }
          }
        } finally {
          finalizeTemporaryDragExpansions(capturedDropSession, dropSucceeded, finishReason);
          schedulePostDropFrameAudit(finishReason, {
            sessionId,
            sourceId,
            expectedIds: finishExpectedIds,
            pointerY: dropClientY,
          });
        }
      }
    });
  }, [folderPath, onRename, onApplySidebarLayout, onMoveItems, sidebarLayout, captureDragGeometry, collectVisualChildren, normalizeDragSelection, resolveSidebarDrag, resolveAndApplyDragPreview, clearDragVisualState, cancelGlobalAutoExpand, scheduleGlobalAutoExpand, schedulePostDropReveal, schedulePostDropFrameAudit, updatePinnedDragSource, updateScrollHintEdge, resetScrollHintEdge, getScrollSnapshot, formatScrollSnapshot, sourceRectDiagnostics, currentDragSessionId, finalizeTemporaryDragExpansions, isPointInsideDragSurface, setPreviewLayout, commitPendingPreviewLayoutForMove, markDropConfirmed, setDragFolderMode, fileApi]);

  // Root Drop Target (The empty area)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    return dropTargetForElements({
        element: el,
        canDrop: ({ source }) => source.data.type === 'TREE_NODE',
        getData: () => ({ isRoot: true }),
    });
  }, []);

  // Native Finder / Downloads file drops. Pragmatic's element adapter only sees
  // app-origin drags; OS file drags arrive as native DragEvents with File objects.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onExternalFilesDrop) return;

    const hasExternalFiles = (event) => {
      const types = event.dataTransfer?.types;
      return !!types && Array.from(types).includes('Files');
    };

    const resetExternalDrag = () => {
      setOverFolderId(null);
      setIsRootOver(false);
      setIsDraggingGlobal(false);
    };

    const resolveTarget = (event) => {
      const rawTarget = event.target;
      const targetEl = rawTarget instanceof Element ? rawTarget : rawTarget?.parentElement;
      const row = targetEl?.closest?.('.arborist-node');

      if (row && el.contains(row)) {
        const id = row.dataset.nodeId;
        const isDirectory = row.dataset.isDirectory === 'true';
        const parentId = row.dataset.parentId || null;

        if (isDirectory && id) {
          return { destinationFolder: id, visualFolderId: id, isRoot: false };
        }

        return {
          destinationFolder: parentId || folderPath,
          visualFolderId: parentId,
          isRoot: false,
        };
      }

      return { destinationFolder: folderPath, visualFolderId: null, isRoot: true };
    };

    const scrollNearEdge = (clientY) => {
      const scroller = getScroller();
      if (!scroller) return;
      const rect = getVisibleScrollerRect(scroller);
      const threshold = SCROLL_HINT_THRESHOLD_PX;
      const maxStep = 18;

      if (clientY < rect.top + threshold) {
        const ratio = Math.min(1, (rect.top + threshold - clientY) / threshold);
        const before = scroller.scrollTop;
        scroller.scrollTop -= Math.ceil(maxStep * ratio);
        if (before !== scroller.scrollTop) {
          console.log(
            SCROLL_LOG_PREFIX,
            `external-autoscroll direction=up before=${Math.round(before)}` +
            ` after=${Math.round(scroller.scrollTop)} y=${Math.round(clientY)}`
          );
        }
      } else if (clientY > rect.bottom - threshold) {
        const ratio = Math.min(1, (clientY - (rect.bottom - threshold)) / threshold);
        const before = scroller.scrollTop;
        scroller.scrollTop += Math.ceil(maxStep * ratio);
        if (before !== scroller.scrollTop) {
          console.log(
            SCROLL_LOG_PREFIX,
            `external-autoscroll direction=down before=${Math.round(before)}` +
            ` after=${Math.round(scroller.scrollTop)} y=${Math.round(clientY)}`
          );
        }
      }
    };

    const updateExternalVisual = (event) => {
      const target = resolveTarget(event);
      setIsDraggingGlobal(true);
      setIsRootOver(!!target?.isRoot);
      setOverFolderId(target?.visualFolderId || null);
      scrollNearEdge(event.clientY);
      return target;
    };

    const handleDragOver = (event) => {
      if (!hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      updateExternalVisual(event);
    };

    const handleDragLeave = (event) => {
      if (!hasExternalFiles(event)) return;
      const rect = el.getBoundingClientRect();
      const outside =
        event.clientX <= rect.left ||
        event.clientX >= rect.right ||
        event.clientY <= rect.top ||
        event.clientY >= rect.bottom;

      if (outside) resetExternalDrag();
    };

    const handleDrop = async (event) => {
      if (!hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';

      const target = resolveTarget(event);
      const files = Array.from(event.dataTransfer?.files || []);
      const paths = files
        .map(file => fileApi?.getPathForFile?.(file) || file.path || '')
        .filter(Boolean);

      resetExternalDrag();

      if (paths.length > 0 && target?.destinationFolder) {
        console.log('[dnd]', `[ExternalDrop] ${paths.length} file(s) -> ${target.destinationFolder}`);
        await onExternalFilesDrop(paths, target.destinationFolder);
      }
    };

    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', handleDrop);

    return () => {
      el.removeEventListener('dragover', handleDragOver);
      el.removeEventListener('dragleave', handleDragLeave);
      el.removeEventListener('drop', handleDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPath, onExternalFilesDrop, fileApi]);

  return (
    <div 
        ref={containerRef} 
        className={`arborist-tree file-tree-container ${isRootOver ? 'root-drop-active' : ''} ${isDraggingGlobal ? 'is-dragging-global' : ''} ${dragFolderModeActive ? 'is-cmd-folder-mode' : ''}`}
        style={{ minHeight: '100%', paddingBottom: '100px', position: 'relative' }} // Increased padding
        onPointerDownCapture={() => clearDropConfirmed('sidebar-pointerdown')}
        onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
                onContextMenu(e, null); // Context menu on empty area
            }
        }}
    >
      <ScrollHints
        containerRef={containerRef}
        active={isDraggingGlobal}
        edge={scrollHintEdge}
        zoneSize={SCROLL_HINT_THRESHOLD_PX}
      />

      {dragPinnedSource && (
        <div className="sidebar-drag-source-pin-wrap" aria-hidden="true">
          <div className="sidebar-drag-source-pin" data-node-id={dragPinnedSource.id}>
            <span className="arborist-icon">
              <FileIcon
                name={dragPinnedSource.name}
                isDirectory={dragPinnedSource.isDirectory}
                expanded={false}
                customIcons={customIcons}
                theme={iconTheme}
                settings={settings}
              />
            </span>
            <span className="arborist-name">{dragPinnedSource.name}</span>
          </div>
        </div>
      )}

      {/* Visual indicator for Root Drop */}
      {isRootOver && (
        <div className="root-drop-indicator">
            <span>Drop to move to root</span>
        </div>
      )}

      {visibleNodes.map((node, index) => {
        const blockHintIndex = dragVerticalBlockHint?.ids?.indexOf(node.id) ?? -1;
          const verticalBlockHint = blockHintIndex >= 0
          ? {
              rootId: dragVerticalBlockHint.rootId,
              isFirst: blockHintIndex === 0,
              isLast: blockHintIndex === dragVerticalBlockHint.ids.length - 1,
            }
          : null;
        const dragSourceMeta = dragSourceBlockMeta.get(node.id) || null;
        return (
          <FileRow
            key={node.id}
            node={node}
            level={node.level}
            hasNextVisualSibling={visualTreeMeta.get(node.id)?.hasLaterVisualSibling || false}
            visualContinuationDepths={visualTreeMeta.get(node.id)?.visualContinuationDepths || []}
            visualParentLevel={visualTreeMeta.get(node.id)?.visualParentLevel}
            horizontalIntent={dragHorizontalIntent?.sourceId === node.id ? dragHorizontalIntent : null}
            verticalBlockHint={verticalBlockHint}
            dragSourceMeta={dragSourceMeta}
            verticalLimitHint={dragVerticalLimitHint?.sourceId === node.id ? dragVerticalLimitHint : null}
            isExpanded={expandedIds[node.id]}
            isSelected={activeFilePath === node.id}
            isEditing={editingId === node.id}
            isOverFolder={overFolderId === node.id}
            springOpenState={dragFolderSpringState?.folderId === node.id ? dragFolderSpringState : null}
            isInsideOverFolder={overFolderId && node.id.startsWith(overFolderId + '/')}
            isDropConfirmed={dropConfirmedIds.has(node.id)}
            onToggle={handleToggle}
            onSelect={(modifiers) => onFileSelect(node.id, node.isDirectory, modifiers)}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            onStartRename={onStartRename}
            customIcons={customIcons}
            iconTheme={iconTheme}
            settings={settings}
            onContextMenu={onContextMenu}
            sidebarFocused={sidebarFocused}
            isFocused={focusedId === node.id}
            isMultiSelected={multiSelected.has(node.id)}
            multiSelected={multiSelected}
            isIndexed={node.isDirectory && indexedFolders.has(node.id)}
            indexPresets={indexPresets[node.id]}
            onChangeIndexPresets={onChangeIndexPresets}
            indexSortMode={sortMode}
            onRevealLink={onRevealLink}
            onRemoveLink={onRemoveLink}
            rawNode={nodeMap.get(node.id)}
            fileProjects={!node.isDirectory ? projects.filter(p => (p.files || []).includes(node.id)) : null}
            isGlobalDragging={isDraggingGlobal}
            suppressDropTargets={suppressTreeDropTargets}
            IndexButtonComponent={IndexButtonComponent}
            onOpenProjectFile={onOpenProjectFile}
          />
        );
      })}
    </div>
  );
};

export default PragmaticFileTree;
