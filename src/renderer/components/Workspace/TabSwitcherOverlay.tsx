import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import {
  buildSwitcherRows,
  initialCtrlIndex,
  selectableIndices,
  stepIndex,
} from '../../utils/tabSwitcherModel.mjs';
import { onScreenTabIds } from '../../utils/tabVisitHistoryRule.mjs';
import { restorablePaneHistory } from '../../utils/splitPanesModel.mjs';
import {
  resolveSwitcherScope,
  filterProjectsToPaneHistory,
} from '../../utils/paneSwitcherScope.mjs';
import {
  keyboardOwnerFromPress,
  pressCanMoveKeyboardOwner,
} from '../../utils/keyboardOwnerGesture.mjs';
import { isFileMissing, probeFiles, subscribeMissingFiles } from '../../utils/missingFileTracker';
import { TabListProjectHeader, TabListTabRow } from './TabListRows';

// Ctrl+Tab (MRU hold-and-release) + Cmd+P (search) switcher over ALL open
// projects. Projects render as non-selectable headers; tabs indent under
// them and carry the full tab visual language: chrome tint, process bar
// strip (+AI shimmer), session status marker, folder badge, file icon.
//
// Self-contained singleton: mounted once in App.tsx, owns its window-level
// key listeners (capture phase, so xterm/composer never see the keys). See
// методология "Глобальные события → singleton hook на корне".
//
// Mouse entry point: any surface can open the search-mode panel by dispatching
// TAB_SWITCHER_OPEN_EVENT. A window event, not a store field — the overlay owns
// its own transient open state (mode/query/selection), and lifting that into
// the store would make every keystroke in the search box a global update.

export const TAB_SWITCHER_OPEN_EVENT = 'tab-switcher:open';

/** Open the full switcher panel (search mode) from a click anywhere in the UI. */
export function openTabSwitcherPanel(): void {
  window.dispatchEvent(new CustomEvent(TAB_SWITCHER_OPEN_EVENT));
}

type Mode = 'ctrl' | 'search';

// Ctrl+Tab's SCOPE. Global = the classic centered panel over everything.
// Pane = the same rows in a small panel anchored at that pane's header — the
// window the hover button opens, reached from the keyboard. `null` scope in
// state means global.
interface PaneScope { paneIndex: number }

/** Live pane history entries, shaped for the row builder. */
function readPaneHistory(paneIndex: number): Array<{ projectId: string; tabId: string }> {
  const st = useWorkspaceStore.getState();
  return restorablePaneHistory(
    st.splitPanes,
    paneIndex,
    (pid: string, tid: string) => !!st.openProjects.get(pid)?.tabs.get(tid),
  );
}

/** Which pane owns the keyboard right now, or -1. */
function keyboardPaneIndex(): number {
  const st = useWorkspaceStore.getState();
  if (!st.workspaceOwnsKeyboard || st.splitPanes.length === 0) return -1;
  return st.splitFocusedIndex;
}

interface SwitcherTab {
  id: string;
  name: string;
  color?: string;
  tabType?: string;
  commandType?: string;
  groupId?: string;
  sessionStatus?: string;
  sdkProcessAlive?: boolean;
  cwd?: string;
  filePath?: string;
  missing?: boolean;
}

interface RowProject { kind: 'project'; projectId: string; projectName: string; projectIcon?: string | null }
interface RowTab { kind: 'tab'; projectId: string; projectName: string; tab: SwitcherTab; missing?: boolean }
type Row = RowProject | RowTab;

const PANEL_BG = '#1d1d1f';
const PANEL_BORDER = '#3a3a3d';
// Titlebar (40) + ProjectToolbar (30). The panel's top edge sits flush against
// the bottom of that strip: it is opened from there, both by the toolbar button
// and by the keyboard. Keep in sync with App.tsx `title-bar h-[40px]` and
// ProjectToolbar `h-[30px]`.
const SWITCHER_DOCK_TOP_PX = 70;
// Radius: only the bottom corners are rounded — the top edge is glued to the
// bar above it, and a rounded top would show the seam as a gap.
const SWITCHER_RADIUS = '0 0 8px 8px';
// Above FilePreview (z:100000) — the switcher is a top-level navigation
// surface and must never hide under an open markdown preview.
const Z_INDEX = 100500;

interface TabSwitcherOverlayProps {
  processStatus: Map<string, boolean>;
  busyTabs: Map<string, boolean>;
  pasteBusyTabs: Map<string, boolean>;
}

// Build switcher rows straight from store snapshots. Used by the fast-tap
// fallback: Ctrl can be released before React renders the first frame of the
// overlay, and the classic "toggle to previous tab" gesture must still land.
//
// `paneIndex >= 0` scopes the rows to that pane's own history: same builder,
// same row shape, but the project pool is filtered to the pane's past and the
// RANKING is the pane history instead of the global MRU — so the pane window
// and the global window cannot disagree about what a row looks like, only
// about which rows exist and in what order.
function computeRowsFromStores(query: string, paneIndex = -1): Row[] {
  const ws = useWorkspaceStore.getState();
  const projectsMeta = useProjectsStore.getState().projects as Record<string, { name?: string; icon?: string | null }>;
  const recentFirst = [...ws.projectHistory].reverse();
  const orderedIds = [
    ...recentFirst.filter((id) => ws.openProjects.has(id)),
    ...Array.from(ws.openProjects.keys()).filter((id) => !recentFirst.includes(id)),
  ];
  let blocks = orderedIds.map((projectId) => {
    const workspace = ws.openProjects.get(projectId)!;
    const projectName = projectsMeta[projectId]?.name
      || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : (workspace.projectPath?.split('/').filter(Boolean).pop() || 'Project'));
    const tabs = (Array.from(workspace.tabs.values()) as any[])
      .filter((t) => !t.parentTabId)
      .map((t) => (
        t.tabType === 'file' && isFileMissing(t.filePath)
          ? { ...t, missing: true }
          : t
      )) as SwitcherTab[];
    return { projectId, projectName, projectIcon: projectsMeta[projectId]?.icon || null, tabs };
  }).filter((b) => b.tabs.length > 0);
  let ranking = ws.globalTabMru;
  if (paneIndex >= 0) {
    const history = readPaneHistory(paneIndex);
    blocks = filterProjectsToPaneHistory(blocks, history) as typeof blocks;
    ranking = history;
  }
  return buildSwitcherRows({ projects: blocks, globalMru: ranking, query }) as Row[];
}

export default function TabSwitcherOverlay({ processStatus, busyTabs, pasteBusyTabs }: TabSwitcherOverlayProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [query, setQuery] = useState('');
  // Ctrl-mode scope: null = the classic global panel; a pane = that pane's own
  // history, anchored at the pane. Resolved ONCE at open (resolveSwitcherScope)
  // and held — the scope must not shift under the keys mid-cycle.
  const [paneScope, setPaneScope] = useState<PaneScope | null>(null);
  const visible = mode !== null;

  const openProjects = useWorkspaceStore((s) => s.openProjects);
  const projectHistory = useWorkspaceStore((s) => s.projectHistory);
  const globalTabMru = useWorkspaceStore((s) => s.globalTabMru);
  const projectsMeta = useProjectsStore((s) => s.projects);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Phantom-hover guard: ignore pointerenter until the mouse REALLY moves
  // (opening under a static cursor must not steal keyboard selection).
  const mouseBlockedRef = useRef(true);
  const modeRef = useRef<Mode | null>(null);
  modeRef.current = mode;

  // Probe linked-file existence on every open; a vanished file turns its row
  // red and unselectable on the probe's next tick (cache → instant on reopen).
  // Declared before the rows memo that depends on it: a `const` referenced
  // above its own declaration throws at module evaluation, not at call time.
  const [missingProbeTick, setMissingProbeTick] = useState(0);
  useEffect(() => subscribeMissingFiles(() => setMissingProbeTick((v) => v + 1)), []);

  // ── rows ────────────────────────────────────────────────────────────────
  // Store subscriptions above keep this memo fresh; the builder itself reads
  // the same live snapshots so the fast-tap fallback shares one code path.
  const splitPanesKey = useWorkspaceStore((s) => s.splitPanes
    .map((p) => p.tabId + ':' + (p.history?.length || 0)).join('|'));
  const rows: Row[] = useMemo(() => {
    if (!visible) return [];
    return computeRowsFromStores(
      mode === 'search' ? query : '',
      mode === 'ctrl' && paneScope ? paneScope.paneIndex : -1,
    );
  }, [visible, openProjects, projectHistory, projectsMeta, globalTabMru, query, mode, missingProbeTick, paneScope, splitPanesKey]);
  useEffect(() => {
    if (!visible) return;
    const paths: string[] = [];
    openProjects.forEach((ws) => {
      ws.tabs.forEach((t: any) => {
        if (t.tabType === 'file' && t.filePath && !t.parentTabId) paths.push(t.filePath);
      });
    });
    probeFiles(paths, true);
  }, [visible, openProjects]);

  // Reset selection when rows change in search mode (query typed).
  useEffect(() => {
    if (mode !== 'search') return;
    const sel = selectableIndices(rows);
    setSelectedIndex(sel.length > 0 ? sel[0] : -1);
  }, [mode, rows]);

  // ── open/close/commit ───────────────────────────────────────────────────
  const close = useCallback(() => {
    setMode(null);
    setQuery('');
    setSelectedIndex(-1);
    setPaneScope(null);
  }, []);

  const commitRow = useCallback((row: Row | undefined) => {
    close();
    if (!row || row.kind !== 'tab') return;
    // Single activation entry point: applies the split rules (focus-jump /
    // replace-focused-pane) and the cross-project view switch. switchTab
    // inside puts the chosen tab at the MRU head FIRST, so showWorkspace's
    // own touch becomes a no-op — the toggle order stays correct.
    //
    // Same call for BOTH scopes on purpose: in pane scope the chosen tab is
    // never visible elsewhere (restorablePaneHistory filters those out), so
    // the standard rule — replace the focused pane's slot — puts it exactly
    // into the pane whose history was walked. The pane keeps focus, so this
    // is "bring my tab back here", not a navigation elsewhere.
    useWorkspaceStore.getState().activateCenterTab(row.projectId, row.tab.id);
  }, [close]);

  // Middle-click on a row: FORGET the entry, keep the window open. Not a
  // navigation and not a close — the user is editing the list they look at.
  const forgetRow = useCallback((row: Row | undefined) => {
    if (!row || row.kind !== 'tab') return;
    const st = useWorkspaceStore.getState();
    if (modeRef.current === 'ctrl' && paneScopeRef.current) {
      st.forgetPaneTabVisit(paneScopeRef.current.paneIndex, row.tab.id);
    } else {
      st.forgetGlobalTabVisit(row.projectId, row.tab.id);
    }
  }, []);

  // Search mode is reachable from the keyboard (Cmd+P) and from a click on the
  // toolbar button; both go through this one function so the two entry points
  // cannot drift apart.
  const openSearch = useCallback(() => {
    mouseBlockedRef.current = true;
    setQuery('');
    setMode('search');
    setSelectedIndex(-1);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const openCtrl = useCallback((shiftKey: boolean) => {
    mouseBlockedRef.current = true;
    setQuery('');
    // Scope is decided HERE, once per open: the pane that owns the keyboard
    // walks its OWN history; no owner / no history → the classic global panel.
    // (An empty pane history falling through to global is the approved answer
    // to "what does Ctrl+Tab do in a fresh pane" — never an empty box.)
    const st = useWorkspaceStore.getState();
    const kbdPane = keyboardPaneIndex();
    const scope = resolveSwitcherScope({
      keyboardPaneIndex: kbdPane,
      panes: st.splitPanes,
      paneHistoryCount: kbdPane >= 0 ? readPaneHistory(kbdPane).length : 0,
    });
    setPaneScope(scope.scope === 'pane' ? { paneIndex: scope.paneIndex } : null);
    setMode('ctrl');
    // rows are computed on next render; compute here from the same inputs to
    // pick the initial index synchronously (previous tab across projects).
    // We re-derive after mount via effect below instead — simpler and safe.
    setSelectedIndex(-2 - (shiftKey ? 1 : 0)); // sentinel: -2 fwd, -3 back
  }, []);

  // Resolve the sentinel initial index once rows exist.
  useEffect(() => {
    if (!visible) return;
    if (selectedIndex >= 0) return;
    if (mode === 'ctrl') {
      if (rows.length === 0) return;
      const st = useWorkspaceStore.getState();
      const activeWs = st.activeProjectId ? st.openProjects.get(st.activeProjectId) : null;
      const activeTabId = activeWs?.activeTabId || null;
      if (selectedIndex === -3) {
        // Shift+Ctrl+Tab opening: start from the LAST selectable row.
        const sel = selectableIndices(rows);
        setSelectedIndex(sel.length > 0 ? sel[sel.length - 1] : -1);
      } else if (paneScope) {
        // Pane scope: the rows ARE the pane's past, most recent first, and
        // every one of them is off-screen by construction (the restorable
        // filter removed visible tabs). The first selectable row is exactly
        // "what this pane showed last" — the A↔B toggle target.
        const sel = selectableIndices(rows);
        setSelectedIndex(sel.length > 0 ? sel[0] : -1);
      } else {
        // Highlight the most recent tab that is NOT already on screen: Ctrl+Tab is
        // for bringing back what you cannot see. In a split every pane's tab is
        // visible, so without this the highlight landed on the neighbouring pane.
        setSelectedIndex(initialCtrlIndex(
          rows,
          globalTabMru,
          activeTabId,
          onScreenTabIds({ panes: st.splitPanes, centerTabId: activeTabId }),
        ));
      }
    }
  }, [visible, mode, rows, selectedIndex, globalTabMru]);

  // ── global key handling ─────────────────────────────────────────────────
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof (e as any).stopImmediatePropagation === 'function') (e as any).stopImmediatePropagation();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const cur = modeRef.current;
      // Ctrl+Tab — open or step. Layout-agnostic (Tab is Tab everywhere).
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        swallow(e);
        if (cur === null) {
          openCtrl(e.shiftKey);
        } else {
          setSelectedIndex((prev) => stepIndex(rowsRef.current, prev, e.shiftKey ? -1 : +1));
        }
        return;
      }
      // Cmd+P / Ctrl+P — open search mode (toggle). e.code → works on RU
      // layout. Ctrl+P is a synonym so the hand that just used Ctrl+Tab does
      // not have to change modifiers to reach the search.
      if ((e.metaKey !== e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyP') {
        swallow(e);
        if (cur === 'search') { close(); return; }
        openSearch();
        return;
      }
      if (cur === null) return;

      // Keys while open.
      if (e.key === 'Escape') {
        swallow(e);
        close();
        return;
      }
      if (cur === 'ctrl') {
        // Arrows also navigate in ctrl mode; everything else stays swallowed
        // so keystrokes don't leak into the terminal underneath.
        if (e.key === 'ArrowDown') { swallow(e); setSelectedIndex((p) => stepIndex(rowsRef.current, p, +1)); return; }
        if (e.key === 'ArrowUp') { swallow(e); setSelectedIndex((p) => stepIndex(rowsRef.current, p, -1)); return; }
        if (e.key === 'Enter') { swallow(e); commitRow(rowsRef.current[selectedIndexRef.current]); return; }
      }
      if (cur === 'search') {
        // Input owns typing; window-level capture handles list navigation so
        // it works даже когда фокус ушёл с input.
        if (e.key === 'ArrowDown') { swallow(e); setSelectedIndex((p) => stepIndex(rowsRef.current, p, +1)); return; }
        if (e.key === 'ArrowUp') { swallow(e); setSelectedIndex((p) => stepIndex(rowsRef.current, p, -1)); return; }
        if (e.key === 'Enter') { swallow(e); commitRow(rowsRef.current[selectedIndexRef.current]); return; }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (modeRef.current !== 'ctrl') return;
      if (e.key === 'Control') {
        let effectiveRows = rowsRef.current;
        let idx = selectedIndexRef.current;
        if (idx < 0) {
          // Fast tap: Ctrl released before React rendered the first frame.
          // Rebuild rows from the live stores and resolve the "previous tab"
          // target inline so the classic toggle still fires — INCLUDING the
          // pane scope: a fast tap in a pane must toggle that PANE's A↔B, not
          // the global one. The state may not have committed yet, so the scope
          // is re-derived from the same inputs openCtrl used.
          const st = useWorkspaceStore.getState();
          const activeWs = st.activeProjectId ? st.openProjects.get(st.activeProjectId) : null;
          const kbdPane = keyboardPaneIndex();
          const scope = resolveSwitcherScope({
            keyboardPaneIndex: kbdPane,
            panes: st.splitPanes,
            paneHistoryCount: kbdPane >= 0 ? readPaneHistory(kbdPane).length : 0,
          });
          if (scope.scope === 'pane') {
            effectiveRows = computeRowsFromStores('', scope.paneIndex);
            idx = selectableIndices(effectiveRows)[0] ?? -1;
            commitRow(effectiveRows[idx]);
            return;
          }
          effectiveRows = computeRowsFromStores('');
          idx = initialCtrlIndex(
            effectiveRows,
            st.globalTabMru,
            activeWs?.activeTabId || null,
            onScreenTabIds({ panes: st.splitPanes, centerTabId: activeWs?.activeTabId || null }),
          );
        }
        commitRow(effectiveRows[idx]);
      }
    };

    const onBlur = () => { if (modeRef.current === 'ctrl') close(); };

    // Mouse entry point (toolbar button). Toggles like Cmd+P so a second click
    // on the same button closes the panel instead of re-opening it.
    const onExternalOpen = () => {
      if (modeRef.current !== null) { close(); return; }
      openSearch();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener(TAB_SWITCHER_OPEN_EVENT, onExternalOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener(TAB_SWITCHER_OPEN_EVENT, onExternalOpen);
    };
  }, [openCtrl, openSearch, close, commitRow]);

  // Refs mirroring latest rows/selection for the stable key handlers above.
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const paneScopeRef = useRef<PaneScope | null>(paneScope);
  paneScopeRef.current = paneScope;

  // ── keyboard ownership ──────────────────────────────────────────────────
  // The single writer of "where do keystrokes go". Lives here because this
  // component is the singleton consumer (Ctrl+Tab's scope) — but the rule
  // itself is keyboardOwnerGesture.mjs, tested without a DOM. Capture phase,
  // like pane focus: the answer must be updated before anything else reacts
  // to the same press. Presses on overlays and unmarked surfaces return null
  // and change nothing.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!pressCanMoveKeyboardOwner(e.button)) return;
      const owner = keyboardOwnerFromPress(e.target as Element | null);
      if (owner === null) return;
      useWorkspaceStore.getState().setWorkspaceOwnsKeyboard(owner === 'workspace');
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  // Unblock phantom hover on the first REAL mouse move; immediately select
  // the row under the cursor (GT pattern, see fix-tab-switcher-mru.md).
  useEffect(() => {
    if (!visible) return;
    mouseBlockedRef.current = true;
    const unblock = (e: MouseEvent) => {
      mouseBlockedRef.current = false;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const item = el?.closest('[data-switcher-index]');
      if (item) {
        const idx = Number(item.getAttribute('data-switcher-index'));
        if (Number.isFinite(idx)) setSelectedIndex(idx);
      }
    };
    window.addEventListener('mousemove', unblock, { once: true });
    return () => window.removeEventListener('mousemove', unblock);
  }, [visible]);

  if (!visible) return null;

  const isBusy = (tabId: string) => !!(busyTabs.get(tabId) || pasteBusyTabs.get(tabId));
  const hasProcess = (tab: SwitcherTab) => !!(processStatus.get(tab.id) || tab.sdkProcessAlive);

  // Where the panel hangs. Global scope keeps the classic centred dock under
  // the system bars. Pane scope anchors it to THAT PANE's header — the same
  // place the hover button opens its list, so "whose history am I walking" is
  // answered by where the window is, not by memory. (Same lesson as the toast
  // fix: a message about one pane must not appear at the window's corner.)
  const paneRect = paneScope
    ? document
      .querySelector(`[data-terminal-pane-wrapper][data-split-pane-index="${paneScope.paneIndex}"]`)
      ?.getBoundingClientRect()
    : null;
  const anchored = !!paneRect;

  return (
    <div
      data-tab-switcher-root
      data-tab-switcher-mode={mode || ''}
      data-tab-switcher-scope={paneScope ? 'pane' : 'global'}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: Z_INDEX,
        display: anchored ? 'block' : 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        // Docked to the bottom edge of the system bars (titlebar 40 + project
        // toolbar 30) instead of floating at an arbitrary 90px: the panel is
        // opened FROM that strip, so it should read as hanging off it. Measured
        // from the real bars — if their height changes, update both constants.
        paddingTop: anchored ? 0 : SWITCHER_DOCK_TOP_PX,
      }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        style={{
          // Anchored: sized and placed against the pane, never wider than it,
          // clamped so a narrow pane at the screen edge still shows the panel.
          ...(paneRect
            ? {
              position: 'fixed' as const,
              top: Math.round(paneRect.top + 30),
              left: Math.round(Math.max(8, Math.min(window.innerWidth - 8 - Math.min(420, Math.max(240, paneRect.width - 16)), paneRect.left + 8))),
              width: Math.min(420, Math.max(240, paneRect.width - 16)),
              maxHeight: `min(420px, ${Math.max(160, Math.round(paneRect.height - 48))}px)`,
              borderRadius: 8,
              border: `1px solid ${PANEL_BORDER}`,
            }
            : {
              width: 480,
              maxHeight: `min(440px, calc(100vh - ${SWITCHER_DOCK_TOP_PX + 24}px))`,
              border: `1px solid ${PANEL_BORDER}`,
              borderTop: 'none',
              borderRadius: SWITCHER_RADIUS,
            }),
          background: PANEL_BG,
          boxShadow: '0 12px 34px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontSize: 13,
        }}
      >
        {/* No "Open Tabs" header — the list speaks for itself; search mode
            shows the input instead. */}
        {mode === 'search' && (
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search tabs…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              border: 'none',
              borderBottom: `1px solid ${PANEL_BORDER}`,
              color: '#e8e8e8',
              fontSize: 13,
              outline: 'none',
            }}
          />
        )}

        <div ref={listRef} className="tab-list-scroll" style={{ overflowY: 'auto', flex: 1, padding: '4px 6px 6px' }}>
          {rows.length === 0 && (
            <div style={{ padding: 14, textAlign: 'center', color: '#777', fontSize: 12.5 }}>
              {/* A pane list can only be empty if every remembered tab was
                  closed or is showing elsewhere — the "no past at all" case
                  never opens in pane scope (openCtrl falls through to global). */}
              {paneScope ? 'В этой панели больше нечего вернуть' : 'No tabs found'}
            </div>
          )}
          {rows.map((row, index) => {
            if (row.kind === 'project') {
              // TOC separator, not a landmark: the flat list follows global
              // tab recency, so the same project header can appear several
              // times per open. Icon deliberately small (12px) and dimmed —
              // frequent repetition must not shout. Non-clickable.
              return (
                <TabListProjectHeader
                  key={`p:${row.projectId}:${index}`}
                  projectName={row.projectName}
                  projectIcon={row.projectIcon}
                />
              );
            }

            const tab = row.tab;
            const missing = !!row.missing;
            const selected = index === selectedIndex;

            // Row visuals live in TabListRows — the pane header's recent-tabs
            // list renders the same component, so the two lists cannot drift
            // into looking like different things.
            return (
              <div
                key={tab.id}
                ref={selected ? (el) => { if (el) el.scrollIntoView({ block: 'nearest' }); } : undefined}
              >
                <TabListTabRow
                  tab={tab}
                  index={index}
                  selected={selected}
                  missing={missing}
                  hasProcess={hasProcess(tab)}
                  busy={isBusy(tab.id)}
                  sessionStatuses={sessionStatuses}
                  // Layout map: which pane this tab is already open in. Same mark
                  // as the sidebar card, so "this is the side pane's tab" is
                  // visible while choosing.
                  paneMapProjectId={row.projectId}
                  onPointerEnter={() => { if (!mouseBlockedRef.current && !missing) setSelectedIndex(index); }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // MIDDLE click = forget this row, and the window stays open:
                    // the user is editing the list, not navigating. Works on a
                    // missing-file row too — a dead row is exactly what one
                    // wants to clear out. Handled on pointerdown like the pick,
                    // so both gestures are answered by one handler.
                    if (e.button === 1) { forgetRow(row); return; }
                    if (e.button !== 0) return;
                    if (missing) return; // vanished file — dead row, not a target
                    commitRow(row);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
