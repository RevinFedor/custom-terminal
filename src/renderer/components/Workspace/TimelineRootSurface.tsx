import { TimelineCodexTokenChip } from './TimelineCodexUsage';
import { timelineFinalNavigationIdentity } from '../../utils/timelineEntryPreview.mjs';
import { readTimelineViewReview, saveTimelineViewReview, clearTimelineViewReview } from '../../utils/timelineViewReviewJobs.mjs';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpToLine, Copy, Pencil, RefreshCw, Repeat2, Scissors, StickyNote, Trash2, X } from 'lucide-react';
import { TimelineViewReadModel, registerTimelineView } from '../../utils/timelineViewReadModel.mjs';
import { TimelineViewClient, mergeTimelineReadClass } from '../../utils/timelineViewClient.mjs';
import { TimelineSemanticGroupHeader } from './TimelineSemanticGroupHeader';
import { TimelineEntryPreview } from './TimelineEntryPreview';
import EditRangePanel from './EditRangePanel';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { refreshRootTimelineSummaries, useTimelineSummaryStore } from '../../store/useTimelineSummaryStore';
import { publishTimelineRootStatus, clearTimelineRootStatus } from '../../store/useTimelineRootStatusStore';
import { historySearchMarkerFlags, useHistorySearchMarkers } from '../../utils/historySearchMarkers';
import { historyForegroundPriority } from '../../utils/historyForegroundPriority.mjs';
import { shouldBypassTimelineApplyPriority } from '../../utils/timelineApplyPriority.mjs';
import { makeHistorySnapshotKey } from '../../utils/historySnapshotCache';
import { makeTimelineSnapshotKey } from '../../utils/timelineSnapshotCache.mjs';
import { projectTimelineSentHandoffs, projectTimelineLiveUserMessage, projectTimelineLiveCompactEntry, readPresentedHistorySurface, matchesHistorySurfacePresented, historyNavigationIdentityForTimelineEntry } from '../../utils/timelineTranscriptRefresh.mjs';
import { getHistoryPromptHandoffsSnapshot, subscribeHistoryPromptHandoffs } from '../../utils/historyPromptHandoffs';
import { consumeQueuedRewindTarget, pendingQueuedRewindTarget } from '../../utils/queuedRewindTarget.mjs';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { getHistoryAgentRuntime } from '../../utils/historyAgentRuntimes';
import { nativeTimelineViewRewind, rewriteTimelineViewTail, mutateTimelineViewRange } from '../../utils/timelineViewActions';
import { generateTimelineActionLabelFromPrompt } from '../../utils/generateTabTitle';
import { timelineSummarySourceHash } from '../../store/useTimelineSummaryStore';
import { TIMELINE_GROUPING_PROMPT_ID, usePromptsStore } from '../../store/usePromptsStore';
import { getGeminiApiKey } from '../../utils/geminiApiKey.mjs';
import { copySessionFiltersFromState } from '../../utils/copySessionFilters';
import { uiPerformancePhase } from '../../utils/uiPerformanceDiagnostics.mjs';
import { usePointerGesture } from '../../hooks/usePointerGesture';
import type { TimelineInitialSourceSignal } from './Timeline';

const { ipcRenderer, clipboard } = window.require('electron');
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
const emit = (name: string, detail: any) => window.dispatchEvent(new CustomEvent(name, { detail }));
const fail = (reply: any) => { if (reply?.success !== true) throw new Error(reply?.error || 'operation_unconfirmed'); return reply; };
const positive = (n: any) => Number.isFinite(n) && n > 0;
const cancelled = (error: any) => error?.code === 'HISTORY_READ_CANCELLED';
const popupStyle: React.CSSProperties = { position: 'fixed', zIndex: 100060, background: 'rgba(18,18,18,0.98)',
  border: '1px solid rgba(255,255,255,.15)', borderRadius: 6, padding: 4, color: '#e4e4e7', boxShadow: '0 8px 30px #0008' };
const menuClass = 'w-full text-left px-3 py-2 text-xs rounded transition-colors cursor-pointer flex items-center gap-2 hover:bg-white/10';

type Props = {
  tabId: string; sessionId: string | null; cwd: string; toolType?: string;
  isActive?: boolean; isTurnBusy?: boolean; isVisible?: boolean; isOpen?: boolean;
  readOnly?: boolean; historySurfaceVisible?: boolean; presentationExternallyManaged?: boolean;
  backgroundPrewarmAdmitted?: boolean; onInitialSourceSignal?: (signal: TimelineInitialSourceSignal) => void;
  renderRow: (props: any) => React.ReactNode; onUnsupportedComposite: () => void;
};

// Current viewport + one pending viewport, plus explicit menu/preview/range/note
// subjects. This component never mounts the legacy controller or its N-selectors.
export function TimelineRootSurface(props: Props) {
  const { tabId, sessionId, cwd, isVisible = true, isTurnBusy = false, isOpen = true,
    readOnly = false, historySurfaceVisible = false } = props;
  const livePointRef = useRef<any>(null), noteAnchorRef = useRef<any>(null);
  const presentationRevision = useRef(0);
  const fingerprint = useCallback((text: string) => window.require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex'), []);
  const tree = useUIStore(s => s.timelineTreeModeTabs[tabId] ?? false);
  const expanded = !readOnly && tree;
  const widthSetting = useUIStore(s => s.timelineWidth);
  const fontSize = useUIStore(s => s.timelineFontSize);
  const summaryFontSize = useUIStore(s => s.timelineSummaryFontSize);
  const lineClamp = useUIStore(s => s.timelineLineClamp);
  const responseLines = useUIStore(s => s.timelinePreviewResponseLines);
  const tooltipWidth = useUIStore(s => s.timelineTooltipWidth);
  const historyOpen = useUIStore(s => s.historyPanelOpenTabs[tabId] ?? false);
  const historyVisible = useUIStore(s => s.historyVisibleUuids[tabId]);
  const summaryAuto = useTimelineSummaryStore(s => s.globalAuto || s.autoByTab[tabId] === true);
  const summarySince = useTimelineSummaryStore(s => {
    const values = [s.globalAuto ? s.globalAutoSince : 0, s.autoByTab[tabId] ? s.autoSinceByTab[tabId] : 0].filter(value => value > 0);
    return values.length ? Math.min(...values) : 0;
  });
  const autoSummarySource = useRef('');
  const width = expanded ? widthSetting : 32;
  const scrollRef = useRef<HTMLDivElement>(null), containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null), atomNodes = useRef(new Map<string, HTMLElement>());
  const segmentNodes = useRef(new Map<number, HTMLElement>());
  const measurementObserver = useRef<ResizeObserver | null>(null);
  const latest = useRef<any>(props); latest.current = { ...props, expanded, width, fontSize, summaryFontSize, lineClamp };
  const statusLease = useMemo(() => ({}), []);
  const [viewport, setViewport] = useState({ width, height: 0 });
  const [historyGate, setHistoryGate] = useState(!historySurfaceVisible || props.backgroundPrewarmAdmitted === true);
  const activeRef = useRef(true);
  const owner = useMemo(() => ({ tabId, sessionId, cwd }), [tabId, sessionId, cwd]);
  const timelineOwner = makeTimelineSnapshotKey({ ...owner, sessionId: sessionId || '', toolType: 'codex' });
  const expectedHistoryOwner = makeHistorySnapshotKey({ ...owner, sessionId: sessionId || '', toolType: 'codex' });
  const gateRef = useRef(historyGate); gateRef.current = historyGate;
  const model = useMemo(() => new TimelineViewReadModel(invoke, { deferPreviousRelease: true, beforeAdopt: async () => {
    const result = await historyForegroundPriority.waitForBackgroundSlot({ shouldBypass: () => shouldBypassTimelineApplyPriority({
      ownerCurrent: activeRef.current, presented: latest.current.isVisible !== false && gateRef.current
        && document.visibilityState === 'visible', hasDurableEntries: !!model.current,
      phase: 'root-adopt',
    }) });
    uiPerformancePhase('timeline-root-adopt-slot', { tab: tabId, ms: result.waitedMs });
  } }), [tabId, sessionId, cwd]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const physical = useRef({ origin: 0, extent: 0 });
  const layoutInputs = useRef(''), previousExpanded = useRef(expanded);
  const bottom = useRef(true), desiredOffset = useRef(0);
  const [physicalOrigin, setPhysicalOrigin] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  const modifier = useRef(false), locked = useRef(false), lockChord = useRef(false);
  const uiPins = useRef(new Map<string, () => Promise<any>>());
  const [popup, updatePopup] = useState<any>(null);
  const [selected, updateSelected] = useState<any>(null);
  const [contextMarked, setContextMarked] = useState<string | null>(null);
  const [rangeMenu, updateRangeMenu] = useState<any>(null);
  const [rangePaintGeometry, setRangePaintGeometry] = useState<any>(null);
  const [note, updateNote] = useState<any>(null);
  const [noteText, setNoteText] = useState('');
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteNeighbours, setNoteNeighbours] = useState<any>(null);
  const [notePosition, setNotePosition] = useState<'dot' | 'before' | 'after'>('before');
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [clicked, setClicked] = useState<{ rank: number; status: 'loading' | 'failed'; identity?: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [editor, updateEditor] = useState<any>(() => readTimelineViewReview(owner));
  const pinState = (slot: string, update: (value: any) => void, value: any) => {
    if (!activeRef.current) return;
    const release = value?.client?.retain();
    const old = uiPins.current.get(slot);
    if (release) uiPins.current.set(slot, release); else uiPins.current.delete(slot);
    void old?.(); update(value);
  };
  const setPopup = (value: any) => { if (!value) popupSequence.current++; pinState('popup', updatePopup, value); };
  const setSelected = (value: any) => pinState('selection', updateSelected, value);
  const setRangeMenu = (value: any) => pinState('range', updateRangeMenu, value);
  const setNote = (value: any) => pinState('note', updateNote, value);
  const setEditor = (value: any) => {
    if (value) saveTimelineViewReview(owner, value); else clearTimelineViewReview(owner);
    if (activeRef.current) updateEditor(value);
    else if (value) useUIStore.getState().showToast('Rewind готов — открыть вкладку', 'pink', 5000, false,
      undefined, undefined, () => { void useWorkspaceStore.getState().openTabById(tabId, { reason: 'rewind-ready-toast' }); });
  };
  const [queuedTarget, setQueuedTarget] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<'selection' | 'through-start' | null>(null);
  const [postPrompt, setPostPrompt] = useState('');
  const actionPending = useRef(false);
  const popupSequence = useRef(0);
  const refreshPending = useRef<'source' | 'metadata' | 'view' | null>(null);
  const intents = useRef<any[]>([]);
  const report = useCallback((error: any) => {
    if (cancelled(error)) return;
    if (error?.code === 'HISTORY_ROOT_COMPOSITE_NOT_MIGRATED') {
      publishTimelineRootStatus(tabId, { lease: statusLease, sessionId: sessionId || '', legacy: true });
      props.onUnsupportedComposite(); return;
    }
    console.warn('[TimelineRoot] action/read failed code=' + String(error?.code || error?.message || error));
    useUIStore.getState().showToast(String(error?.message || error), 'error', 5000, false, undefined, undefined, undefined, tabId);
  }, [tabId, sessionId, statusLease, props.onUnsupportedComposite]);
  const payload = useCallback(() => {
    const settings = latest.current;
    return { ...owner, toolType: 'codex', source: 'Timeline.root', visible: settings.isVisible !== false,
      timelineViewOptions: { expandedLayout: settings.expanded, treeMode: tree, width: settings.width,
        viewportExtent: scrollRef.current?.clientHeight || viewport.height, fontSize: settings.fontSize,
        summaryFontSize: settings.summaryFontSize, lineClamp: settings.lineClamp,
        layoutFingerprint: JSON.stringify([settings.expanded, settings.width, settings.fontSize, settings.summaryFontSize, settings.lineClamp]) },
      viewIntents: intents.current.slice(0, 8),
      activeRangeAction: !!selected || !!rangeMenu,
      ...(noteEditing && note && model.current?.client.header.logicalRevisionToken === note.subject?.logicalRevision
        ? { editNote: { logicalRank: note.logicalRank, position: notePosition } } : {}),
      // These are existing app-owned volatile inputs, not a Timeline index.
      // No canonical rows/UUIDs are retained or materialized for composition.
      timelinePresentation: {
        revision: presentationRevision.current,
        sentHandoffs: projectTimelineSentHandoffs(getHistoryPromptHandoffsSnapshot(tabId), { toolType: 'codex', sessionId, fingerprint }),
        liveEntries: livePointRef.current ? [livePointRef.current] : [],
        noteAnchors: noteAnchorRef.current ? [noteAnchorRef.current] : [],
      },
    };
  }, [owner, tree, viewport.height, tabId, sessionId, fingerprint, !!selected, !!rangeMenu, noteEditing, note?.logicalRank, notePosition]);
  const refresh = useCallback((readClass: 'source' | 'metadata' | 'view' = 'source', verifiedPoint = false) => {
    if (!sessionId) return;
    if (!positive(scrollRef.current?.clientHeight)) {
      refreshPending.current = mergeTimelineReadClass(refreshPending.current, readClass); return;
    }
    const current = latest.current;
    // Exact live receipts may wake a busy PRESENTED surface. They do not
    // bypass presentation admission or start a hidden UI read. Background
    // actions keep their separate independent capability path.
    if (!gateRef.current || current.isVisible === false || document.visibilityState !== 'visible'
      || !verifiedPoint && current.isTurnBusy) {
      const old = refreshPending.current;
      refreshPending.current = old === 'source' || readClass === 'source' ? 'source' : old === 'metadata' || readClass === 'metadata' ? 'metadata' : 'view';
      return;
    }
    // Admission consumes the accumulated register synchronously. Later events
    // still create their own trailing demand in the model's existing flight.
    const admittedClass = mergeTimelineReadClass(refreshPending.current, readClass);
    refreshPending.current = null;
    const acceptedIntents = intents.current;
    return model.refresh(payload(), admittedClass).then(() => {
      if (!activeRef.current) return;
      // Intents arriving during OPEN belong to the coalesced trailing request.
      if (intents.current === acceptedIntents) intents.current = [];
      props.onInitialSourceSignal?.({ tabId, sessionId, ownerKey: timelineOwner, phase: 'load', status: 'success' });
      return true;
    }).catch(error => {
      props.onInitialSourceSignal?.({ tabId, sessionId, ownerKey: timelineOwner, phase: 'load', status: 'failure' }); report(error); return false;
    });
  }, [model, payload, report, sessionId, tabId, timelineOwner, props.onInitialSourceSignal]);
  const demand = useCallback((offset = desiredOffset.current, atBottom = bottom.current) => {
    const element = scrollRef.current; if (!element || !positive(element.clientHeight)) return;
    desiredOffset.current = offset; bottom.current = atBottom;
    void model.requestWindow({ offset: Math.max(0, offset), extent: element.clientHeight,
      overscan: element.clientHeight / 2, bottom: atBottom }).catch(report);
  }, [model, report]);
  const act = useCallback(async (name: string, operation: () => Promise<any>) => {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(name);
    const release = model.current?.client.retain();
    try { return await operation(); } catch (error) { report(error); }
    finally { await release?.(); actionPending.current = false; if (activeRef.current) setBusy(''); }
  }, [report, model]);
  useEffect(() => {
    activeRef.current = true;
    publishTimelineRootStatus(tabId, { lease: statusLease, sessionId: sessionId || '', ready: false });
    const unregister = registerTimelineView(owner, model);
    return () => { activeRef.current = false; popupSequence.current++; unregister();
      clearTimelineRootStatus(tabId, statusLease); for (const release of uiPins.current.values()) void release(); uiPins.current.clear(); void model.close(); };
  }, [model, owner, tabId, sessionId, statusLease]);
  useEffect(() => {
    if (!historySurfaceVisible || props.backgroundPrewarmAdmitted) { setHistoryGate(true); return; }
    const match = (detail: any) => matchesHistorySurfacePresented({ detail, ...owner,
      sessionId: sessionId || '', toolType: 'codex', ownerKey: expectedHistoryOwner });
    if (readPresentedHistorySurface({ ...owner, sessionId: sessionId || '', toolType: 'codex', ownerKey: expectedHistoryOwner })) setHistoryGate(true);
    const listener = (event: Event) => { if (match((event as CustomEvent).detail)) setHistoryGate(true); };
    window.addEventListener('history-panel:surface-presented', listener);
    return () => window.removeEventListener('history-panel:surface-presented', listener);
  }, [historySurfaceVisible, props.backgroundPrewarmAdmitted, expectedHistoryOwner, owner, sessionId]);
  useLayoutEffect(() => {
    const element = scrollRef.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect || !positive(rect.height)) return;
      setViewport(previous => previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (viewport.height > 0) {
    if (expanded && !previousExpanded.current) bottom.current = true; previousExpanded.current = expanded;
    demand();
    const key = JSON.stringify([expanded, width, fontSize, summaryFontSize, lineClamp]);
    if (model.current && layoutInputs.current === key && model.current.client.layout.viewportExtent !== viewport.height)
      void model.resizeViewport(viewport.height).catch(report);
    else if (!model.current || layoutInputs.current !== key) refresh('view');
    layoutInputs.current = key;
  } },
    [viewport.height, viewport.width, expanded, width, fontSize, summaryFontSize, lineClamp, historyGate]);
  useEffect(() => {
    if (!isTurnBusy && isVisible && historyGate && refreshPending.current) {
      const readClass = refreshPending.current; refreshPending.current = null; refresh(readClass);
    }
  }, [isTurnBusy, isVisible, historyGate, refresh]);
  useEffect(() => {
    if (model.current) refresh('view', true);
  }, [!!selected, !!rangeMenu, noteEditing, note?.logicalRank, notePosition]);
  useEffect(() => {
    setRangePaintGeometry(null);
    const view = model.current, layout = state?.layout;
    if (!rangeMenu || !view || !layout
      || view.client.header.logicalRevisionToken !== rangeMenu.client.header.logicalRevisionToken) return;
    let current = true;
    const release = view.client.retain();
    void model.range(rangeMenu.facts.startLogicalRank, rangeMenu.facts.endLogicalRank, view.client).then(facts => {
      if (current && model.current === view && facts.geometry?.layoutId === layout.layoutId) setRangePaintGeometry(facts.geometry);
    }).catch(error => { if (current) report(error); }).finally(release);
    return () => { current = false; };
  }, [rangeMenu, state?.layout, model, report]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    if (!sessionId) return;
    const consumerId = 'timeline-view-' + tabId + '-' + globalThis.crypto.randomUUID();
    let disposed = false;
    const signal = (phase: 'subscribe', success: boolean) => props.onInitialSourceSignal?.({ tabId, sessionId,
      ownerKey: timelineOwner, phase, status: success ? 'success' : 'failure' });
    const changed = (_event: any, detail: any) => { if (detail?.sessionId === sessionId && (!detail.toolType || detail.toolType === 'codex')) refreshRef.current('source'); };
    const liveMessage = (_event: any, detail: any) => {
      if (detail?.tabId !== tabId || detail?.sessionId !== sessionId || detail?.toolType !== 'codex') return;
      const point = projectTimelineLiveUserMessage(detail, { toolType: 'codex', sessionId, fingerprint })
        || projectTimelineLiveCompactEntry(detail, { toolType: 'codex', sessionId });
      if (!point) return;
      livePointRef.current = point; presentationRevision.current++;
      refreshRef.current('source', true);
    };
    const force = (event: Event) => { if ((event as CustomEvent).detail?.tabId === tabId) refreshRef.current('metadata'); };
    const visible = () => { if (document.visibilityState === 'visible') {
      void invoke('agent-transcript:refresh', { ...owner, toolType: 'codex', reason: 'visibility-resume' }).catch(report);
      refreshRef.current('source');
    } };
    const workContextChanged = (_event: any, snapshot: any) => {
      if (snapshot?.tabId !== tabId) return;
      presentationRevision.current++; refreshRef.current('metadata', true);
    };
    ipcRenderer.on('tab-work-context:changed', workContextChanged);
    ipcRenderer.on('agent-transcript:changed', changed); ipcRenderer.on('agent-transcript:live-message', liveMessage);
    window.addEventListener('timeline:force-refresh', force); document.addEventListener('visibilitychange', visible);
    void invoke('agent-transcript:subscribe', { consumerId, ...owner, toolType: 'codex' }).then((reply: any) => {
      if (!disposed) signal('subscribe', reply?.success === true);
      else void invoke('agent-transcript:unsubscribe', { consumerId }).catch(report);
    }).catch(() => { if (!disposed) signal('subscribe', false); });
    // Exact confirmed receipts wake the reader projection. No local preview
    // array or guessed canonical UUID is retained by the renderer.
    const unsubscribe = subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {
      const confirmed = snapshot.some(handoff => handoff.toolType === 'codex' && handoff.queueStatus === 'sent'
        && handoff.auditProof?.sessionId === sessionId && handoff.auditProof?.entryUuid);
      if (confirmed || change.type === 'canonical-adopt' || change.type === 'consume' || change.type === 'retract') {
        presentationRevision.current++; refreshRef.current('source', true);
      }
    });
    return () => { disposed = true; unsubscribe(); ipcRenderer.removeListener('tab-work-context:changed', workContextChanged); ipcRenderer.removeListener('agent-transcript:changed', changed);
      ipcRenderer.removeListener('agent-transcript:live-message', liveMessage); window.removeEventListener('timeline:force-refresh', force);
      document.removeEventListener('visibilitychange', visible); void invoke('agent-transcript:unsubscribe', { consumerId }).catch(report); };
  }, [sessionId, tabId, cwd, model]);
  useEffect(() => {
    if (!state?.status) return;
    const status = state.status;
    publishTimelineRootStatus(tabId, { lease: statusLease, sessionId: sessionId || '', ready: true,
      summaryCount: status.summaryCount, outlineCount: status.outlineCount, outlineNewCount: status.outlineNewCount,
      eligibleCount: status.eligibleCount });
  }, [state?.status, statusLease, tabId, sessionId]);

  // Physical scrolling is a moving corridor into the reader's global logical
  // geometry. Very tall sources never become one Blink-clamped giant element.
  useLayoutEffect(() => {
    const element = scrollRef.current, layout = state?.layout, window = state?.window;
    if (!element || !layout || !window) return;
    model.commitPresentation(state.adoption);
    bottom.current = model.demand.bottom === true;
    const physicalExtent = Math.min(layout.totalExtent, Math.max(element.clientHeight * 8, 1_000_000));
    let origin = physical.current.origin;
    const logical = bottom.current ? Math.max(0, layout.totalExtent - element.clientHeight) : window.offset;
    if (layout.totalExtent <= physicalExtent) origin = 0;
    else if (logical < origin + element.clientHeight || logical + element.clientHeight > origin + physicalExtent - element.clientHeight)
      origin = Math.max(0, Math.min(layout.totalExtent - physicalExtent, logical - physicalExtent / 2));
    physical.current = { origin, extent: physicalExtent }; setPhysicalOrigin(origin);
    desiredOffset.current = logical; element.scrollTop = logical - origin;
    uiPerformancePhase('timeline-root-window-commit', { tab: tabId, rows: window.items.length });
    const raf = requestAnimationFrame(() => {
      if (activeRef.current && latest.current.isVisible !== false && document.visibilityState === 'visible'
        && model.snapshot() === state) uiPerformancePhase('timeline-root-window-paint', { tab: tabId, rows: window.items.length });
    });
    return () => cancelAnimationFrame(raf);
  }, [state?.window, state?.layout]);
  useLayoutEffect(() => {
    measurementObserver.current?.disconnect();
    const client = state?.client, layout = state?.layout;
    if (!client || !expanded) return;
    let batch: any[] = [], scheduled = 0, running = false;
    const flush = async () => {
      scheduled = 0; if (running || !batch.length || model.current?.client !== client) return;
      running = true; const measurements = batch; batch = [];
      try { await model.measure(measurements); } catch (error) { report(error); }
      finally { running = false; if (batch.length && !scheduled) scheduled = requestAnimationFrame(() => void flush()); }
    };
    const observer = new ResizeObserver(entries => {
      if (model.current?.client !== client || client.layout.layoutId !== layout.layoutId || client.layout.layoutRevision !== layout.layoutRevision) return;
      for (const entry of entries) {
        const atom = state.window.items.find((item: any) => atomNodes.current.get(item.header.key) === entry.target);
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (!atom || !atom.geometry.intrinsic || !positive(height)
          || !atom.geometry.estimated && Math.abs(height - atom.geometry.extent) < 0.5) continue;
        const value = { ordinal: atom.geometry.ordinal, key: atom.geometry.key, identity: atom.geometry.identity,
          layoutFingerprint: layout.layoutFingerprint, intrinsicExtent: height };
        const at = batch.findIndex(item => item.ordinal === value.ordinal);
        if (at >= 0) batch[at] = value; else batch.push(value);
      }
      if (batch.length && !scheduled) scheduled = requestAnimationFrame(() => void flush());
    });
    measurementObserver.current = observer;
    for (const node of atomNodes.current.values()) observer.observe(node);
    return () => { observer.disconnect(); measurementObserver.current = null; if (scheduled) cancelAnimationFrame(scheduled); batch = []; };
  }, [state?.window, state?.layout, expanded, model, report]);

  const findSubject = useCallback((rank: number) => state?.window?.items.find((item: any) => item.header.logicalRank === rank)?.subject,
    [state?.window]);
  const openPopup = useCallback(async (rank: number, mode = 'preview', y?: number) => {
    const sequence = ++popupSequence.current, presented = state;
    if (!presented?.client) return;
    let retained: TimelineViewClient | null = null;
    try {
      retained = await presented.client.retainSnapshot();
      const selectedView = { client: retained };
      const subject = await model.selected(selectedView, rank, () => activeRef.current && sequence === popupSequence.current);
      if (!activeRef.current || sequence !== popupSequence.current) return;
      const element = segmentNodes.current.get(rank);
      setBodyExpanded(false); setDeleteConfirm(null); setRangeMenu(null);
      const atom = presented.window?.items.find((item: any) => item.header.logicalRank === rank
        && (mode !== 'fork' || item.header.kind === 'fork' || item.header.kind === 'fork-beginning'));
      const group = atom?.header.groupKey ? await retained.group(atom.header.groupKey) : atom?.group;
      const presence = mode === 'menu' ? await getHistoryAgentRuntime('codex').getPresence(tabId) : null;
      const details = mode === 'fork' && atom?.header.markerOrdinal != null
        ? await retained.annotation('fork', atom.header.markerOrdinal) : null;
      if (!activeRef.current || sequence !== popupSequence.current || latest.current.isVisible === false) return;
      if (mode !== 'menu' && !modifier.current && !locked.current && !useUIStore.getState().freezeCmdPopups) return;
      setPopup({ subject, client: retained, mode: mode === 'preview' && atom?.header.kind === 'automatic-header' ? 'group' : mode, group, details, presence, top: y ?? element?.getBoundingClientRect().top ?? 60 });
    } catch (error) { report(error); }
    finally { await retained?.close(); }
  }, [model, findSubject, state, report]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (latest.current.isVisible === false) return;
      modifier.current = event.metaKey || event.ctrlKey;
      if (event.key === 'Escape') { setPopup(null); setSelected(null); setRangeMenu(null); setNote(null); locked.current = false;
        if (queuedTarget) emit('prompt-queue:rewind-target-cancelled', { tabId, requestId: queuedTarget }); setQueuedTarget(null); }
      const chord = modifier.current && event.shiftKey;
      if (event.type === 'keydown' && chord && !lockChord.current && !event.repeat) locked.current = !locked.current;
      lockChord.current = chord;
      if (modifier.current && hoveredRef.current != null && !popup && !note) void openPopup(hoveredRef.current);
      if (!modifier.current && !locked.current && !useUIStore.getState().freezeCmdPopups) {
        if (['preview', 'group', 'semantic', 'fork'].includes(popup?.mode)) setPopup(null); if (note && !noteEditing) setNote(null);
      }
    };
    const blur = () => { modifier.current = false; locked.current = false; lockChord.current = false; if (['preview', 'group', 'semantic', 'fork'].includes(popup?.mode)) setPopup(null); };
    const outside = (event: MouseEvent) => {
      if (popupRef.current?.contains(event.target as Node) || containerRef.current?.contains(event.target as Node)) return;
      if (!busy) { setPopup(null); setRangeMenu(null); setSelected(null); locked.current = false; }
    };
    window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', blur);
    window.addEventListener('mousedown', outside);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', blur); window.removeEventListener('mousedown', outside); };
  }, [popup, note, noteEditing, openPopup, busy, queuedTarget, tabId]);
  useEffect(() => {
    if (!(['preview', 'group', 'semantic', 'fork'].includes(popup?.mode) || note && !noteEditing) || locked.current) return;
    const move = (event: MouseEvent) => {
      if (locked.current || bodyExpanded || useUIStore.getState().freezeCmdPopups) return;
      const rail = containerRef.current?.getBoundingClientRect(), box = popupRef.current?.getBoundingClientRect();
      if (!rail || !box) return;
      const x = event.clientX, y = event.clientY;
      if (x >= box.left - 2 && x <= rail.right + 2 && y >= Math.min(box.top, rail.top) - 2 && y <= Math.max(box.bottom, rail.bottom) + 2) return;
      setPopup(null); if (note && !noteEditing) setNote(null);
    };
    window.addEventListener('mousemove', move); return () => window.removeEventListener('mousemove', move);
  }, [popup, note, noteEditing, bodyExpanded]);
  useEffect(() => {
    if (!clicked) return;
    const captured = clicked;
    const timer = setTimeout(() => setClicked(current => current === captured ? null : current), clicked.status === 'failed' ? 1200 : 22000);
    return () => clearTimeout(timer);
  }, [clicked]);
  const navigate = async (subject: any, event?: React.MouseEvent) => {
    const entry = subject.entry, rank = subject.logicalRank; setContextMarked(null);
    if (queuedTarget) {
      if (entry.type !== 'user' || entry.isCompactSummary || entry.isGoalContinuation) throw new Error('Выбери пользовательский prompt');
      const context = await model.current.client.query('rewind', { logicalRank: rank });
      emit('prompt-queue:rewind-target-selected', { ...owner, toolType: 'codex', requestId: queuedTarget,
        uuid: entry.uuid, text: entry.content, iteration: context.targetIndex + 1 }); setQueuedTarget(null); return;
    }
    if (selected) {
      event?.preventDefault(); event?.stopPropagation();
      if (selected.entry.uuid === entry.uuid) { setSelected(null); return; }
      const client = selected.client;
      const target = await client.query('resolve', { uuid: entry.sourceIdentity || entry.uuid });
      if (!target.found || target.ambiguous) throw new Error('stale_transcript_revision');
      const facts = await model.range(selected.logicalRank, target.logicalRank, client);
      setRangeMenu({ facts, client, top: event?.clientY ?? 60 }); setPopup(null); return;
    }
    if (historySurfaceVisible || historyOpen || readOnly || event?.metaKey || event?.ctrlKey) {
      const uuid = historyNavigationIdentityForTimelineEntry(entry);
      if (!historySurfaceVisible && !historyOpen) useUIStore.getState().setHistoryPanelOpen(tabId, true);
      useUIStore.getState().setHistoryScrollToUuid(uuid, tabId);
      setClicked({ rank, identity: uuid, status: 'loading' }); return;
    }
    // Explicit source query supplies duplicate provenance/previous anchor; no
    // all-entry terminal-position graph is rebuilt by this renderer.
    const client=subject.client,release=client.retain(),terminal=terminalRegistry.get(tabId),presentation=terminalRegistry.getPresentationIdentity(tabId);
    const owns=()=>{const current=terminalRegistry.getPresentationIdentity(tabId);return activeRef.current&&latest.current.isVisible!==false
      &&latest.current.tabId===tabId&&latest.current.sessionId===sessionId&&latest.current.cwd===cwd
      &&!!presentation&&current?.instanceId===presentation.instanceId&&current.generation===presentation.generation
      &&current.generationOrdinal===presentation.generationOrdinal&&terminalRegistry.get(tabId)===terminal
      &&useWorkspaceStore.getState().getCodexSessionId(tabId)===sessionId;};
    try{
      if(!terminal||!presentation){setClicked({rank,status:'failed'});return;}
      let packet=await client.query('terminal-navigation',{logicalRank:rank},{owns}),fact=packet.terminalNavigation;
      const valid=(value:any)=>value?.kind==='timeline-terminal-navigation-v1'
        &&value.logicalRevision===client.header.logicalRevisionToken&&value.revision===value.logicalRevision
        &&value.logicalRank===rank&&Number.isSafeInteger(value.occurrenceBefore)&&value.occurrenceBefore>=0
        &&Array.isArray(value.searchLines)&&value.searchLines.length<=3
        &&value.searchLines.every((line:any)=>typeof line==='string'&&line.length<=50);
      if(!valid(fact))throw new Error('TIMELINE_TERMINAL_NAVIGATION_FACTS_REQUIRED');
      if(!fact.navigable)return;
      const {searchLines,occurrenceBefore}=fact;let startAfterRow=-1;
      while(fact.previousAnchor){
        const previous=fact.previousAnchor;
        if(!Number.isSafeInteger(previous.logicalRank)||previous.logicalRank>=fact.previousBeforeRank
          ||!Number.isSafeInteger(previous.occurrenceBefore)||previous.occurrenceBefore<0
          ||!Array.isArray(previous.searchLines)||previous.searchLines.length>3
          ||previous.searchLines.some((line:any)=>typeof line!=='string'||line.length>50))
          throw new Error('TIMELINE_TERMINAL_NAVIGATION_FACTS_REQUIRED');
        if(!owns())return;
        startAfterRow=terminalRegistry.findTextBufferRow(tabId,previous.searchLines,previous.occurrenceBefore,-1);
        if(startAfterRow>=0||fact.nextPreviousBeforeRank===null)break;
        const bound=fact.nextPreviousBeforeRank;
        if(!Number.isSafeInteger(bound)||bound<0||bound>=fact.previousBeforeRank)
          throw new Error('TIMELINE_TERMINAL_NAVIGATION_PROGRESS');
        packet=await client.query('terminal-navigation',{logicalRank:rank,beforeLogicalRank:bound,ifRevision:fact.logicalRevision},{owns});
        fact=packet.terminalNavigation;if(!valid(fact))throw new Error('TIMELINE_TERMINAL_NAVIGATION_FACTS_REQUIRED');
      }
      if(!owns())return;
      let found=terminalRegistry.scrollToTextInBuffer(tabId,searchLines,occurrenceBefore,startAfterRow);
      if(!found&&startAfterRow>=0)found=terminalRegistry.scrollToTextInBuffer(tabId,searchLines,occurrenceBefore,-1);
      setClicked(found?null:{rank,status:'failed'});
    }finally{await release();}
  };
  const navigateRef = useRef(navigate); navigateRef.current = navigate;
  const withPresentedSubject = useCallback(async (uuid: string, operation: (subject: any, client: any) => Promise<any>) => {
    if (!state?.client) throw new Error('TIMELINE_VIEW_NOT_READY');
    const client = await state.client.retainSnapshot();
    try {
      const point = await client.query('resolve', { uuid });
      if (!point.found || point.ambiguous) throw new Error('stale_transcript_revision');
      const row = await client.row(point.logicalRank);
      return await operation({ ...row, client, annotations: {} }, client);
    } finally { await client.close(); }
  }, [state?.client]);
  const rootApi = useMemo(() => ({
    handleMouseEnterSegment: (rank: number) => { hoveredRef.current = rank; setHovered(rank); if (modifier.current) void openPopup(rank); },
    handleMouseLeaveSegment: () => { hoveredRef.current = null; setHovered(null); },
    handleEntryClick: (entry: any, event?: React.MouseEvent) => act('navigate', async () => {
      const subject = state?.window?.items.find((item: any) => item.subject?.entry.uuid === entry.uuid)?.subject;
      if (!subject) throw new Error('stale_transcript_revision');
      const release = subject.client.retain();
      try { await navigateRef.current(subject, event); } finally { await release(); }
    }),
    handleEntryDoubleClick: (entry: any) => { if (!readOnly) return act('select', () => withPresentedSubject(entry.uuid, async (subject: any) => {
      setSelected(subject); setPopup(null);
    })); },
    handleRightClick: (event: React.MouseEvent, entry: any) => { event.preventDefault(); event.stopPropagation();
      if (readOnly) { setContextMarked(entry.uuid); return; }
      return act('menu', async () => { const subject = state?.window?.items.find((item: any) => item.subject?.entry.uuid === entry.uuid)?.subject;
        if (!subject) throw new Error('stale_transcript_revision'); await openPopup(subject.logicalRank, 'menu', event.clientY); }); },
    openEntryAgents: (entry: any) => {
      const agents = entry.subAgents || []; if (!agents.length) return;
      if (!latest.current.historySurfaceVisible && !useUIStore.getState().historyPanelOpenTabs[tabId]) useUIStore.getState().setHistoryPanelOpen(tabId, true);
      emit('history-panel:open-agent', { tabId, entryUuid: entry.uuid, ...(agents.length === 1 ? { agentKey: agents[0].key } : {}) });
    },
    handleNoteStripEnter: (rank: number) => { if (modifier.current) void act('note', async () => {
      const source = findSubject(rank); if (source) await withPresentedSubject(source.entry.uuid, async (selected: any, client: any) => {
        const subject = await model.selected({ client }, selected.logicalRank, () => activeRef.current);
        const atom = model.snapshot()?.window?.items.find((item: any) => item.header.logicalRank === rank && /^note-/.test(item.header.kind));
        const top = atom ? atomNodes.current.get(atom.header.key)?.getBoundingClientRect().top : undefined;
        setNoteEditing(false); setNote({ ...subject, top }); setNoteText(subject.annotations.note?.content || ''); setNotePosition(subject.facts.notePosition || 'before'); setPopup(null);
      });
    }); },
    handleNoteStripLeave: () => {}, // popup geometric bridge owns dismissal
    flashStripFailed: (rank: number) => setClicked({ rank, status: 'failed' }),
    expandGroup: (key: string) => { intents.current = [{ key, expanded: true }]; refresh('view', true); },
    collapseGroup: (key: string) => { intents.current = [{ key, expanded: false }]; refresh('view', true); },
    setSegmentRef: (rank: number, node: HTMLElement | null) => { if (node) segmentNodes.current.set(rank, node); else segmentNodes.current.delete(rank); },
    onForkMarkerEnter: (rank: number) => { if (modifier.current) void openPopup(rank, 'fork'); },
    onForkMarkerLeave: () => {},
  }), [model, openPopup, act, readOnly, findSubject, refresh, payload, state?.window, withPresentedSubject]);
  useEffect(() => {
    const scrolled = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tabId === tabId && detail.uuid === clicked?.identity) setClicked(detail.found === false ? { ...clicked, status: 'failed' } : null);
    };
    const rewind = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tabId !== tabId || !detail.uuid || readOnly) return;
      void act('Rewind', async () => {
        await model.withActionSubject(detail.uuid, payload(), async (subject: any, client: any) => {
          if (detail.mode === 'ai') await openEditor(subject, true); else await nativeTimelineViewRewind(owner, subject, client);
        });
      });
    };
    const target = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail?.tabId !== tabId || !detail.requestId) return;
      if (readOnly || !sessionId) { emit('prompt-queue:rewind-target-cancelled', detail); return; }
      consumeQueuedRewindTarget(tabId, detail.requestId); setQueuedTarget(detail.requestId); setPopup(null); setSelected(null);
    };
    const request = pendingQueuedRewindTarget(tabId); if (request) target(new CustomEvent('target', { detail: request }));
    const goBottom = (event: Event) => { if ((event as CustomEvent).detail?.tabId === tabId) demand(0, true); };
    window.addEventListener('history-panel:scrolled-to', scrolled); window.addEventListener('history-panel:request-rewind', rewind);
    window.addEventListener('prompt-queue:request-rewind-target', target); window.addEventListener('timeline:scroll-to-bottom', goBottom);
    return () => { window.removeEventListener('history-panel:scrolled-to', scrolled); window.removeEventListener('history-panel:request-rewind', rewind);
      window.removeEventListener('prompt-queue:request-rewind-target', target); window.removeEventListener('timeline:scroll-to-bottom', goBottom); };
  }, [model, owner, readOnly, sessionId, clicked, demand, act, payload]);

  useEffect(() => {
    const run = (force: boolean) => {
      const client = model.current?.client;
      if (!sessionId) return;
      void refreshRootTimelineSummaries({ address: { tabId, sessionId, cwd }, parent: client,
        force, since: force ? 0 : summarySince }).then(() => refresh('metadata', true)).catch(report);
    };
    const manual = (event: Event) => { if ((event as CustomEvent).detail?.tabId === tabId) run(true); };
    window.addEventListener('timeline-summary:refresh-tab', manual);
    const source = state?.header?.sourceSnapshot;
    const sourceKey = source ? JSON.stringify([source.fileIdentity, source.sourceGeneration, source.size,
      state.header.canonicalEntryCount, summarySince]) : '';
    if (summaryAuto && sourceKey && autoSummarySource.current !== sourceKey) { autoSummarySource.current = sourceKey; run(false); }
    return () => window.removeEventListener('timeline-summary:refresh-tab', manual);
  }, [model, state?.header, summaryAuto, summarySince, tabId, sessionId, cwd, refresh, report]);

  const rangeFor = async (subject: any, tail = false) => model.range(subject.logicalRank,
    tail ? subject.client.header.logicalEntryCount - 1 : subject.logicalRank, subject.client);
  const copy = async (client: TimelineViewClient, range: any, action = 'range') => {
    const text = await client.document({ action, range, copyOptions: copySessionFiltersFromState(useUIStore.getState()) });
    clipboard.writeText(text);
  };
  const openEditor = async (subject: any, automatic: boolean, explicitRange?: any) => {
    const client = subject.client, release = client.retain();
    try {
    const presence = await getHistoryAgentRuntime('codex').getPresence(tabId);
    if (latest.current.isTurnBusy || ['busy', 'starting', 'stopping', 'unknown'].includes(presence?.status)
      || presence?.runtimeSnapshot?.canRewriteHistory !== true) throw new Error('Дождись готовности Codex перед AI/Chat Rewind');
    const facts = explicitRange || await rangeFor(subject, true);
    const sourceContent = await client.document({ action: 'range', range: facts, copyOptions: copySessionFiltersFromState(useUIStore.getState()) });
    const store = usePromptsStore.getState(); if (!store.isLoaded) await store.loadPrompts();
    const config = usePromptsStore.getState().getPromptById(usePromptsStore.getState().rewindPromptId);
    if (!config) throw new Error('Не настроен Rewind-промпт');
    let initialInput = config.content;
    if (config.filePaths?.length) {
      const files = fail(await invoke('ai-prompts:read-files', config.filePaths));
      initialInput += '\n\n' + files.data.map((file: any) => `--- File: ${file.path} ---\n${file.content}`).join('\n\n');
    }
    let initialCompact = '';
    if (automatic) {
      const key = await getGeminiApiKey();
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          contents: [{ parts: [{ text: (postPrompt ? `ПРИОРИТЕТНАЯ ИНСТРУКЦИЯ:\n${postPrompt}\n\n` : '') + initialInput + sourceContent }] }],
          ...(config.model.includes('gemini-3') && config.thinkingLevel !== 'NONE'
            ? { generationConfig: { thinkingConfig: { thinkingLevel: config.thinkingLevel } } } : {}),
        }),
      });
      const result = await response.json(); initialCompact = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!response.ok || !initialCompact) throw new Error(result.error?.message || 'Gemini вернул пустой ответ');
    }
    setEditor({ facts, client, sourceContent, initialInput: automatic ? '' : initialInput, initialCompact });
    setPopup(null); setRangeMenu(null); setSelected(null);
    } finally { await release(); }
  };
  const saveNote = async (direction?: -1 | 1) => {
    const subject = note, client = note?.client;
    if (!subject || !client) return;
    const previous = subject.annotations.note?.content;
    let target = { entryUuid: subject.entry.uuid, sourceIdentity: subject.entry.sourceIdentity, position: notePosition };
    if (direction) {
      const result = await client.query('note-neighbour', { logicalRank: subject.logicalRank, position: subject.facts.notePosition, direction });
      if (!result.target) return;
      target = result.target;
    }
    if (!noteText.trim()) {
      fail(await invoke('timeline:delete-note', { sessionId, entryUuid: subject.entry.uuid })); setNote(null);
    } else {
      const result = fail(await invoke('timeline:save-note', { ...owner, ...target, content: noteText.trim(),
        ...(direction ? { previousEntryUuid: previous ? subject.entry.uuid : undefined, expectedPreviousContent: previous } : {}) }));
      if (result.anchor) { noteAnchorRef.current = result.anchor; presentationRevision.current++; }
      if (!direction) setNote(null);
    }
    const applied = await refresh('metadata', true);
    if (direction && applied) { const next = await model.subject(target.entryUuid);
      const resolved = await model.resolve(target.entryUuid);
      const top = resolved.geometry ? (containerRef.current?.getBoundingClientRect().top || 0) + resolved.geometry.start - desiredOffset.current : note.top;
      setNote({ ...next, top }); setNotePosition(next.facts.notePosition); }
  };
  const refreshAction = async (subject: any) => {
    const { entry, facts, client, logicalRank } = subject;
    const release = client.retain();
    try {
    if (!facts.titleEligible || !sessionId) return;
    const assistantText = await client.document({ action: 'turn', subject: subject.subject,
      copyOptions: { ...copySessionFiltersFromState(useUIStore.getState()), assistantOnly: true, maxChars: 8000 } });
    if (!assistantText) throw new Error('Для этой итерации нет завершённого ответа');
    const previousUserMessages: string[] = [];
    const contextCount = Math.max(1, useTimelineSummaryStore.getState().previousUserContextCount);
    for (let rank = logicalRank - 1; rank >= 0 && previousUserMessages.length < contextCount; rank--) {
      const previous = await client.row(rank); if (previous.facts.titleEligible) previousUserMessages.unshift(previous.entry.content);
    }
    const prefix = await model.range(0, logicalRank, client);
    const config = usePromptsStore.getState().getPromptById(TIMELINE_GROUPING_PROMPT_ID);
    const actionLabel = await generateTimelineActionLabelFromPrompt(entry.content, assistantText, config, {
      previousUserMessages, usageMetadata: { tabId, toolType: 'codex', sessionId, entryUuid: entry.uuid, iterationIndex: prefix.titleEligibleCount },
    });
    if (!actionLabel) throw new Error('Не удалось обновить действие');
    const sourceHash = timelineSummarySourceHash(JSON.stringify({ version: 1, content: entry.content, previousUserMessages,
      promptId: config?.id || TIMELINE_GROUPING_PROMPT_ID, promptContent: config?.content || '',
      model: config?.model || 'gemini-3.5-flash-lite', thinkingLevel: config?.thinkingLevel || 'LOW' }));
    fail(await invoke('timeline-turn-action-overrides:save', { toolType: 'codex', sessionId, entryUuid: entry.uuid,
      actionLabel, sourceHash, promptId: config?.id || TIMELINE_GROUPING_PROMPT_ID,
      model: config?.model || 'gemini-3.5-flash-lite', thinkingLevel: config?.thinkingLevel || 'LOW' }));
    refresh('metadata', true);
    } finally { await release(); }
  };
  const beginNote = (subject: any) => { setNoteEditing(true); setNote({ ...subject, top: popup?.top }); setNoteText(subject.annotations.note?.content || '');
    setNotePosition(subject.facts.notePosition || 'before'); setPopup(null); };
  useEffect(() => {
    setNoteNeighbours(null);
    if (!note || !noteEditing || !note.annotations.note?.content || note.facts.notePosition === 'dot') return;
    let current = true;
    const client = note.client, release = client.retain();
    void (async () => {
      try {
        const up = await client.query('note-neighbour', { logicalRank: note.logicalRank, position: note.facts.notePosition, direction: -1 });
        const down = await client.query('note-neighbour', { logicalRank: note.logicalRank, position: note.facts.notePosition, direction: 1 });
        if (current) setNoteNeighbours({ up: up.target, down: down.target });
      } catch (error) { if (current) report(error); }
      finally { await release(); }
    })();
    return () => { current = false; };
  }, [note, noteEditing, report]);
  const searchMarkerRevision=useHistorySearchMarkers(s => s.markerRevisions[tabId] || 0);
  const [rootMarkerFlags,setRootMarkerFlags]=useState<any>(null);
  const markerReadMemo=useRef<any>(null);
  useEffect(()=>{
    const marker=useHistorySearchMarkers.getState().byTab[tabId],client=state?.client,reader=marker?.rootClient;
    if(!reader||marker.sessionId!==sessionId||!client||!state?.window||!isVisible){markerReadMemo.current=null;setRootMarkerFlags((old:any)=>old===null?old:null);return;}
    const targets=[...state.window.items];if(state.window.sticky&&!targets.some((a:any)=>a.header.key===state.window.sticky.header.key))targets.push(state.window.sticky);
    const signature=JSON.stringify(targets.map((a:any)=>[a.header.key,a.header.logicalRank,a.header.groupKey,a.header.kind,a.header.expanded]));
    const previous=markerReadMemo.current;
    if(previous?.client===client&&previous.reader===reader&&previous.index===marker.currentMatchIndex&&previous.signature===signature)return;
    let current=true,releaseReader:any,releaseView:any;
    try{releaseReader=reader.retain();releaseView=client.retain();}
    catch(error){void releaseReader?.();if(!reader.closed&&!client.closed)report(error);return;}
    void(async()=>{
      try{
        const flags:Record<string,any>={};let pending=false;
        for(const atom of targets){
          const header=atom.header;if(header.logicalRank==null)continue;
          const grouped=header.kind==='semantic-header'||header.kind==='automatic-header'&&!header.expanded;
          const result=await client.query('search-markers',{searchRootLease:reader.identity,currentMatchIndex:marker.currentMatchIndex,
            ...(grouped?{groupKey:header.groupKey}:{logicalRank:header.logicalRank})},{owns:()=>current&&activeRef.current});
          if(!current)return;
          if(result.coverage==='source-mismatch'){
            if(result.flags!==null||result.requiredClass!=='source')throw Error('TIMELINE_SEARCH_MARKER_FACTS_REQUIRED');
            pending=true;continue;
          }
          if(!['exact-source','source-prefix'].includes(result.coverage))throw Error('TIMELINE_SEARCH_MARKER_FACTS_REQUIRED');
          if(!result.flags||typeof result.flags.match!=='boolean'||typeof result.flags.current!=='boolean'
            ||typeof result.flags.currentMatchCovered!=='boolean'||result.flags.current&&!result.flags.match)throw Error('TIMELINE_SEARCH_MARKER_FACTS_REQUIRED');
          flags[header.key]=result.flags;pending||=!result.flags.currentMatchCovered;
        }
        if(current&&activeRef.current){
          const next={client,reader,index:marker.currentMatchIndex,signature,flags,pending};markerReadMemo.current=next;setRootMarkerFlags(next);
        }
      }catch(error){if(current&&!cancelled(error))report(error);}
      finally{for(const result of await Promise.allSettled([releaseView(),releaseReader()]))if(result.status==='rejected')
        console.warn('[TimelineSearch] release-unconfirmed code='+String(result.reason?.code||result.reason?.message));}
    })();
    return()=>{current=false;};
  },[searchMarkerRevision,state?.client,state?.window,tabId,sessionId,report,isVisible]);
  const visibleMatches = (atom: any, current = false) => {
    const marker=useHistorySearchMarkers.getState().byTab[tabId];
    if(marker?.rootClient){
      const held=rootMarkerFlags?.client===state?.client&&rootMarkerFlags.reader===marker.rootClient
        &&rootMarkerFlags.index===marker.currentMatchIndex?rootMarkerFlags.flags[atom.header.key]:null;
      return current?held?.current===true:held?.match===true;
    }
    const flags=atom.subject?historySearchMarkerFlags(tabId,sessionId,atom.subject.entry):null;
    return current?flags?.current===true:flags?.match===true;
  };
  const renderAtom = (atom: any, sticky = false) => {
    const { header, geometry, subject, group } = atom;
    if (header.kind === 'semantic-header') return <TimelineSemanticGroupHeader title={group?.title || ''} searchMatch={visibleMatches(atom)}
      count={group?.groupSize || 0} expanded={header.expanded} onToggle={() => {
        intents.current = [{ key: header.groupKey, expanded: !header.expanded }]; refresh('view', true);
      }} onMouseEnter={() => { if (modifier.current) {
        const sequence = ++popupSequence.current;
        void act('group description', async () => {
          const retained = await state.client.retainSnapshot();
          try {
            const selected = await retained.group(header.groupKey);
            const description = await retained.field(selected.detail, 'description');
            if (activeRef.current && sequence === popupSequence.current && (modifier.current || locked.current))
              setPopup({ mode: 'semantic', group: { ...selected, description }, client: retained, top: 60 });
          } finally { await retained.close(); }
        });
      } }} />;
    if (!subject) return null;
    const { entry, facts, annotations } = subject;
    const automatic = group?.kind !== 'semantic' ? group : null;
    const collapsedAutomatic = automatic && header.kind === 'automatic-header' && !header.expanded;
    return props.renderRow({ entry, index: subject.logicalRank, api: rootApi, atomPart: header.kind,
      presentationCounts: collapsedAutomatic ? { edited: automatic.editedCount || 0, searched: automatic.searchedCount || 0, subagents: automatic.subagentCount || 0 } : undefined,
      groupInfo: automatic ? { isGroupHeader: header.kind === 'automatic-header', isGroupChild: header.kind === 'entry',
        groupId: header.groupKey || automatic.key, groupSize: automatic.groupSize, agentName: automatic.agentName || '',
        hasTimeout: automatic.hasTimeout, groupKind: automatic.kind, startIndex: automatic.startIndex } : undefined,
      groupPresentation: collapsedAutomatic ? { isLoop: automatic.isLoop, hasPromptChip: automatic.hasPromptChip } : undefined,
      compactClusterCount: header.compactClusterCount, hasSemanticMembership: facts.semanticIndex != null,
      metaPromptTitle: annotations.meta?.title || null, semanticActionText: annotations.action?.actionLabel || facts.semanticDetail || null,
      semanticActionManual: !!annotations.action, summaryText: annotations.summary?.summary || '', summaryLoading: false,
      isGroupExpanded: automatic?.expanded ?? true, active: selected?.entry.uuid === entry.uuid || popup?.subject?.entry.uuid === entry.uuid || contextMarked === entry.uuid,
      forkMarkerVisible: header.kind === 'fork' || header.kind === 'fork-beginning',
      isPlanModeBoundary: header.kind === 'plan-boundary' || header.kind === 'plan-beginning',
      isInViewport: historyVisible?.includes(entry.uuid) || false, isResponseOnly: false, isUnreachable: false,
      dotClickState: clicked?.rank === subject.logicalRank ? clicked.status : null,
      isHovered: hovered === subject.logicalRank, noteHovered: note?.logicalRank === subject.logicalRank,
      hasNote: header.noteDot, notePos: 'dot', isRewindMarked: facts.rewindMarked,
      isOldHistory: header.isOldHistory, isChainBreakZone: false, isLastBoundary: header.kind === 'last-boundary',
      failedFlashKind: clicked?.rank === subject.logicalRank && clicked.status === 'failed' ? header.kind : null,
      isForkActive: popup?.mode === 'fork' && popup?.subject?.logicalRank === subject.logicalRank,
      forkCmdHeld: modifier.current, isExpandedLayout: expanded, treeMode: tree, isCodex: true, isSdkTab: false,
      historyTargetVisible: historySurfaceVisible || historyOpen, timelineFontSize: fontSize,
      timelineSummaryFontSize: summaryFontSize, timelineLineClamp: lineClamp, intrinsicPreviewFontSize: fontSize,
      searchMatch: visibleMatches(atom), searchCurrent: visibleMatches(atom, true),
    });
  };
  const { start: startResize } = usePointerGesture();
  const right = Math.max(0, window.innerWidth - (containerRef.current?.getBoundingClientRect().left ?? window.innerWidth)) + 6;
  const top = Math.max(40, Math.min((note?.top ?? rangeMenu?.top ?? popup?.top ?? 80) - 60, window.innerHeight - 300));
  const layout = state?.layout;
  const selectionGeometry = rangePaintGeometry;
  const nativeReady = popup?.presence?.runtimeSnapshot?.canNativeRewind === true
    && !['busy', 'starting', 'stopping', 'unknown'].includes(popup?.presence?.status) && !isTurnBusy;
  return <div style={{ width: isOpen ? 32 : 0, height: '100%', flexShrink: 0, position: 'relative' }}>
    <div ref={containerRef} data-timeline data-timeline-root="timeline-view-v1" data-history-search-pending={rootMarkerFlags?.pending?'true':undefined} className="relative flex flex-col group"
      style={{ width: isOpen ? width : 0, height: '100%', backgroundColor: '#1a1a1a', fontSize,
        position: expanded ? 'absolute' : 'static', right: expanded ? 0 : undefined,
        top: expanded ? 0 : undefined, zIndex: expanded ? 110 : 40,
        overflow: isOpen ? 'visible' : 'hidden', visibility: props.presentationExternallyManaged || isVisible ? 'inherit' : 'hidden' }}>
      {!tree && <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-white/10 -translate-x-1/2 pointer-events-none" />}
      {expanded && isOpen && <div data-timeline-resize-handle style={{ position: 'absolute', left: -2, top: 0, bottom: 0, width: 6, cursor: 'ew-resize', zIndex: 45 }}
        onPointerDown={event => { event.preventDefault(); const x = event.clientX, initial = width;
          startResize(event, { cursor: 'ew-resize', onMove: move => useUIStore.getState().setTimelineWidth(initial + x - move.clientX) }); }} />}
      <div ref={scrollRef} className="scrollbar-hide" style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowAnchor: 'none' }}
        onScroll={event => { const element = event.currentTarget;
          const offset = physical.current.origin + element.scrollTop;
          // The layout writer sets desiredOffset before writing scrollTop.
          // Its matching event must not turn a held reading position into a
          // new follow intent just because that position is near the tail.
          if (Math.abs(offset - desiredOffset.current) < 0.5) return;
          const remaining = layout ? layout.totalExtent - offset - element.clientHeight : Infinity;
          // Moving up leaves follow even when the complete overflow is under
          // 60px. Downward entry keeps the existing tail tolerance; a resize
          // clamp at the actual global end also preserves following.
          const atBottom = !!layout && (remaining <= 1 || offset > desiredOffset.current && remaining < 60);
          demand(offset, atBottom);
        }}>
        <div className="relative" style={{ height: layout ? Math.min(layout.totalExtent, Math.max(viewport.height * 8, 1_000_000)) : viewport.height, minHeight: '100%' }}>
          {selectionGeometry && <div data-timeline-range-selection style={{ position: 'absolute', left: 0, width: '100%',
            top: Math.max(selectionGeometry.start.start, physicalOrigin) - physicalOrigin,
            height: Math.max(0, Math.min(selectionGeometry.end.end, physicalOrigin + physical.current.extent)
              - Math.max(selectionGeometry.start.start, physicalOrigin)),
            background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.28)', pointerEvents: 'none', zIndex: 1 }} />}
          {state?.window?.items.map((atom: any) => <div key={atom.header.key} data-timeline-atom={atom.header.kind}
            ref={node => { const previous = atomNodes.current.get(atom.header.key);
              if (previous && previous !== node) measurementObserver.current?.unobserve(previous);
              if (node) { atomNodes.current.set(atom.header.key, node); measurementObserver.current?.observe(node); }
              else atomNodes.current.delete(atom.header.key); }}
            style={{ position: 'absolute', top: atom.geometry.start - physicalOrigin, left: 0, width: '100%',
              display: 'flex', flexDirection: 'column', ...(expanded && atom.geometry.intrinsic ? {} : { height: atom.geometry.extent }) }}>
            {renderAtom(atom)}
          </div>)}
        </div>
      </div>
      {state?.window?.sticky && <div data-timeline-sticky style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 6 }}>{renderAtom(state.window.sticky, true)}</div>}
      {queuedTarget && <div data-prompt-queue-rewind-target-mode style={{ position: 'absolute', inset: 0, border: '1px solid #a78bfa', pointerEvents: 'none' }} />}
      {!state?.window && !state?.error && sessionId && <div className="absolute inset-0 z-[70] flex items-center justify-center bg-[#1a1a1a]/90 pointer-events-none" role="status" aria-label="Loading timeline">
        <div className={`flex items-center justify-center text-white/65 ${expanded ? 'gap-2 px-3 py-2' : ''}`}>
          <RefreshCw size={expanded ? 16 : 14} className="animate-spin shrink-0" />
          {expanded && <span className="text-[11px] font-medium whitespace-nowrap">Loading timeline…</span>}
        </div>
      </div>}
      {state?.error && <div role="alert" title={String(state.error.message)} className="absolute bottom-0 text-red-400 text-xs">!</div>}
      {!bottom.current && <button title="В конец Timeline" className="absolute bottom-0 right-0" onClick={() => { if (historySurfaceVisible || historyOpen) emit('history-panel:scroll-to-bottom', { tabId }); demand(0, true); }}><ArrowUpToLine size={14} style={{ transform: 'rotate(180deg)' }} /></button>}
    </div>
    {isVisible && (popup || rangeMenu || note) && createPortal(<div ref={popupRef} data-timeline-context-menu style={{ ...popupStyle, right, top, width: note ? 280 : popup?.mode === 'preview' ? tooltipWidth : 250 }}
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <button className="absolute right-1 top-1 z-10" title="Закрыть" onClick={() => { setPopup(null); setRangeMenu(null); setNote(null); }}><X size={12} /></button>
      {note ? noteEditing ? <>
        <textarea autoFocus value={noteText} onChange={event => setNoteText(event.target.value)} className="w-full bg-transparent text-xs p-1" rows={6} />
        <div className="flex gap-1 text-xs">
          <select value={notePosition} onChange={event => setNotePosition(event.target.value as any)}>
            <option value="before">before</option><option value="dot">dot</option><option value="after">after</option>
          </select>
          <button onClick={() => act('save note', () => saveNote())}>Сохранить</button>
          <button disabled={!noteNeighbours?.up} onClick={() => void act('move note', () => saveNote(-1))}>↑</button>
          <button disabled={!noteNeighbours?.down} onClick={() => void act('move note', () => saveNote(1))}>↓</button>
          <button onClick={() => void act('delete note', async () => { fail(await invoke('timeline:delete-note', { sessionId, entryUuid: note.entry.uuid })); setNote(null); refresh('metadata', true); })}><Trash2 size={12} /></button>
        </div>
      </> : <>
        {note.facts.notePosition === 'dot' && <div className="text-white/50 leading-snug font-mono text-[11px] line-clamp-2 pb-1 mb-1 border-b border-white/5">{note.entry.content}</div>}
        <div className="text-white/80 leading-snug font-mono text-[11px] whitespace-pre-wrap">{note.annotations.note?.content}</div>
        <button className={menuClass} onClick={() => setNoteEditing(true)}><Pencil size={12} />Редактировать</button>
      </> : rangeMenu ? <>
        <div className="px-2 py-1 text-xs">{rangeMenu.facts.count} записей</div>
        <button className={menuClass} onClick={() => void act('copy range', () => copy(rangeMenu.client, rangeMenu.facts))}><Copy size={12} />Копировать</button>
        <button className={menuClass} onClick={() => void act('AI', () => openEditor(selected, true, rangeMenu.facts))}><Pencil size={12} />AI</button>
        <button className={menuClass} onClick={() => void act('Chat', () => openEditor(selected, false, rangeMenu.facts))}>Chat</button>
        <button className={menuClass} onClick={() => setDeleteConfirm('selection')}><Trash2 size={12} />Удалить историю</button>
        {deleteConfirm && <div className="text-xs p-1"><label><input type="checkbox" checked={deleteConfirm === 'through-start'} onChange={event => setDeleteConfirm(event.target.checked ? 'through-start' : 'selection')} />С начала</label>
          <button onClick={() => void act('delete', async () => {
            const facts = deleteConfirm === 'through-start' ? await model.range(0, rangeMenu.facts.endLogicalRank) : rangeMenu.facts;
            await mutateTimelineViewRange(owner, facts); setRangeMenu(null); setSelected(null);
          })}>Подтвердить</button></div>}
      </> : popup?.mode === 'preview' || popup?.mode === 'group' ? <TimelineEntryPreview entry={popup.subject.entry} toolType="codex" expanded={bodyExpanded}
        compact={popup.subject.entry.type === 'compact' || popup.subject.entry.isCompactSummary ? { text: '', encrypted: true, loading: false, postTokens: popup.subject.entry.postTokens } : undefined}
        group={popup.mode === 'group' ? { kind: popup.group.kind, aggregate: {
          count: popup.group.groupSize, failed: popup.group.failedCount, mcp: popup.group.mcpCount || 0, sc: popup.group.scCount || 0,
          editedCount: popup.group.editedCount || 0, searchedCount: popup.group.searchedCount || 0,
        } } : undefined}
        tokenChip={popup.subject.entry.type === 'user' && !popup.subject.entry.isCompactSummary ? <TimelineCodexTokenChip entry={popup.subject.entry} /> : undefined}
        note={popup.subject.annotations.note?.content ? <button className="text-cyan-300 text-xs" onClick={() => beginNote(popup.subject)}>{popup.subject.annotations.note.content}</button> : undefined}
        responseLines={responseLines} fontSize={fontSize} onExpand={() => setBodyExpanded(value => !value)}
        onNavigatePrompt={() => void act('navigate', () => navigate(popup.subject, { metaKey: true } as any))}
        onNavigateAnswer={() => { const identity = timelineFinalNavigationIdentity(popup.subject.entry.responsePreview);
          if (identity) { useUIStore.getState().setHistoryPanelOpen(tabId, true); useUIStore.getState().setHistoryScrollToUuid(identity, tabId); } }}
        onSourceNavigate={() => { setPopup(null); setBodyExpanded(false); }}
        onCopy={text => clipboard.writeText(text)}
        loadResponse={(_preview, signal) => popup.client.document({ action: 'full', subject: popup.subject.subject }, { signal })}
        loadImages={async (_entry, signal) => {
          const row = await popup.client.row(popup.subject.logicalRank, { signal });
          if (row.entry.uuid !== popup.subject.entry.uuid || row.subject.revision !== popup.subject.subject.revision)
            throw new Error('TIMELINE_PROMPT_IMAGES_SOURCE_CHANGED');
          if (!Array.isArray(row.entry.imagePaths) && row.entry.hasImage) throw new Error('TIMELINE_PROMPT_IMAGES_UNAVAILABLE');
          return row.entry.imagePaths || [];
        }} />
      : popup?.mode === 'semantic' ? <div className="p-1 text-xs">{popup.group.description || popup.group.title}</div>
      : popup?.mode === 'fork' ? <div className="p-1 text-xs">Fork от <span className="text-blue-200 font-mono">{popup.details?.source_session_id?.slice(0, 8)}</span><button className={menuClass} onClick={() => void act('fork metadata', async () => {
        const marker = popup.details;
        if (!marker?.source_session_id || !marker?.fork_session_id) throw new Error('TIMELINE_FORK_ANNOTATION_REQUIRED');
        fail(await invoke('timeline:delete-fork-marker', { sourceSessionId: marker.source_session_id, forkSessionId: marker.fork_session_id }));
        setPopup(null); refresh('metadata', true);
      })}>Удалить маркер</button></div>
      : popup && <>
        {popup.subject.entry.type === 'user' && !popup.subject.entry.isCompactSummary && !popup.subject.entry.isGoalContinuation && <><button disabled={!nativeReady} title={!nativeReady ? 'Дождись готовности Codex перед Rewind' : undefined} data-testid="timeline-rewind-native-single" style={{ color: '#fbbf24' }} className={menuClass} onClick={() => void act('Rewind', () => nativeTimelineViewRewind(owner, popup.subject, popup.client))}><Repeat2 size={12} />Rewind (Codex)</button>
        <div className="flex text-xs text-purple-300">
          <button className={menuClass} onClick={() => void act('Rewind', async () => rewriteTimelineViewTail(owner, popup.subject, await rangeFor(popup.subject, true)))}>Rewind</button>
          <button className={menuClass} onClick={() => void act('AI', () => openEditor(popup.subject, true))}>AI</button>
          <button className={menuClass} onClick={() => void act('Chat', () => openEditor(popup.subject, false))}>Chat</button>
        </div></>}
        <input className="text-xs w-full bg-transparent px-2" placeholder="Дополнительная инструкция" value={postPrompt} onChange={event => setPostPrompt(event.target.value)} />
        <button className={menuClass} onClick={() => { setSelected(popup.subject); setPopup(null); }}><Scissors size={12} />Выделить диапазон</button>
        <button className={menuClass} onClick={() => void act('copy', async () => copy(popup.client, await rangeFor(popup.subject), 'turn'))}><Copy size={12} />Копировать</button>
        {popup.subject.facts.titleEligible && <button className={menuClass} onClick={() => void act('refresh action', () => refreshAction(popup.subject))}><RefreshCw size={12} />Обновить название</button>}
        <button className={menuClass} style={{ color: '#22d3ee' }} onClick={() => beginNote(popup.subject)}><StickyNote size={12} />Заметка</button>
        {!popup.subject.entry.isGoalContinuation && ['user', 'compact'].includes(popup.subject.entry.type) && <button className={menuClass} onClick={() => setDeleteConfirm('selection')}><Trash2 size={12} />Удалить</button>}
        {deleteConfirm && <button className={menuClass} onClick={() => void act('delete', async () => { await mutateTimelineViewRange(owner, await rangeFor(popup.subject)); setPopup(null); })}>Подтвердить удаление</button>}
      </>}
      {busy && <div className="px-2 text-xs text-white animate-glow-white">{busy.toUpperCase()}…</div>}
    </div>, document.body)}
    {isVisible && editor && <EditRangePanel sourceContent={editor.sourceContent} initialCompact={editor.initialCompact} initialInput={editor.initialInput}
      anchorTop={top} anchorHeight={100} rightOffset={right} onClose={() => setEditor(null)}
      onApply={async (text, progress) => { const result = await mutateTimelineViewRange(owner, editor.facts, text, progress);
        clearTimelineViewReview(owner); return result; }} onApplyError={report} />}
  </div>;
}
