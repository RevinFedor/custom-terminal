import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
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
import {
  adjustRgbaAlpha,
  flattenRgbaOnTabbarPanel,
  getTabChromeColorConfig,
} from './tabChrome';
import { isFileMissing, probeFiles, subscribeMissingFiles } from '../../utils/missingFileTracker';

// Ctrl+Tab (MRU hold-and-release) + Cmd+P (search) switcher over ALL open
// projects. Projects render as non-selectable headers; tabs indent under
// them and carry the full tab visual language: chrome tint, process bar
// strip (+AI shimmer), session status marker, folder badge, file icon.
//
// Self-contained singleton: mounted once in App.tsx, owns its window-level
// key listeners (capture phase, so xterm/composer never see the keys). See
// методология "Глобальные события → singleton hook на корне".

type Mode = 'ctrl' | 'search';

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
function computeRowsFromStores(query: string): Row[] {
  const ws = useWorkspaceStore.getState();
  const projectsMeta = useProjectsStore.getState().projects as Record<string, { name?: string; icon?: string | null }>;
  const recentFirst = [...ws.projectHistory].reverse();
  const orderedIds = [
    ...recentFirst.filter((id) => ws.openProjects.has(id)),
    ...Array.from(ws.openProjects.keys()).filter((id) => !recentFirst.includes(id)),
  ];
  const blocks = orderedIds.map((projectId) => {
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
  return buildSwitcherRows({ projects: blocks, globalMru: ws.globalTabMru, query }) as Row[];
}

export default function TabSwitcherOverlay({ processStatus, busyTabs, pasteBusyTabs }: TabSwitcherOverlayProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [query, setQuery] = useState('');
  const visible = mode !== null;

  const openProjects = useWorkspaceStore((s) => s.openProjects);
  const projectHistory = useWorkspaceStore((s) => s.projectHistory);
  const globalTabMru = useWorkspaceStore((s) => s.globalTabMru);
  const projectsMeta = useProjectsStore((s) => s.projects);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);
  const processBarPosition = useUIStore((s) => s.processBar.position);

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
  const rows: Row[] = useMemo(() => {
    if (!visible) return [];
    return computeRowsFromStores(mode === 'search' ? query : '');
  }, [visible, openProjects, projectHistory, projectsMeta, globalTabMru, query, mode, missingProbeTick]);
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
  }, []);

  const commitRow = useCallback((row: Row | undefined) => {
    close();
    if (!row || row.kind !== 'tab') return;
    // Single activation entry point: applies the split rules (focus-jump /
    // replace-focused-pane) and the cross-project view switch. switchTab
    // inside puts the chosen tab at the MRU head FIRST, so showWorkspace's
    // own touch becomes a no-op — the toggle order stays correct.
    useWorkspaceStore.getState().activateCenterTab(row.projectId, row.tab.id);
  }, [close]);

  const openCtrl = useCallback((shiftKey: boolean) => {
    mouseBlockedRef.current = true;
    setQuery('');
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
      } else {
        setSelectedIndex(initialCtrlIndex(rows, globalTabMru, activeTabId));
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
      // Cmd+P — open search mode (toggle). e.code → works on RU layout.
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyP') {
        swallow(e);
        if (cur === 'search') { close(); return; }
        mouseBlockedRef.current = true;
        setQuery('');
        setMode('search');
        setSelectedIndex(-1);
        setTimeout(() => inputRef.current?.focus(), 30);
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
          // target inline so the classic toggle still fires.
          const st = useWorkspaceStore.getState();
          const activeWs = st.activeProjectId ? st.openProjects.get(st.activeProjectId) : null;
          effectiveRows = computeRowsFromStores('');
          idx = initialCtrlIndex(effectiveRows, st.globalTabMru, activeWs?.activeTabId || null);
        }
        commitRow(effectiveRows[idx]);
      }
    };

    const onBlur = () => { if (modeRef.current === 'ctrl') close(); };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [openCtrl, close, commitRow]);

  // Refs mirroring latest rows/selection for the stable key handlers above.
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

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

  return (
    <div
      data-tab-switcher-root
      data-tab-switcher-mode={mode || ''}
      style={{ position: 'fixed', inset: 0, zIndex: Z_INDEX, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 90 }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        style={{
          width: 480,
          maxHeight: 'min(440px, calc(100vh - 140px))',
          background: PANEL_BG,
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 8,
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

        <div ref={listRef} style={{ overflowY: 'auto', flex: 1, padding: '4px 6px 6px' }}>
          {rows.length === 0 && (
            <div style={{ padding: 14, textAlign: 'center', color: '#777', fontSize: 12.5 }}>No tabs found</div>
          )}
          {rows.map((row, index) => {
            if (row.kind === 'project') {
              // TOC separator, not a landmark: the flat list follows global
              // tab recency, so the same project header can appear several
              // times per open. Icon deliberately small (12px) and dimmed —
              // frequent repetition must not shout. Non-clickable.
              const headerKey = `p:${row.projectId}:${index}`;
              return (
                <div
                  key={headerKey}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '6px 8px 2px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#8a8a8f',
                    pointerEvents: 'none',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {row.projectIcon && (
                    <img
                      src={row.projectIcon}
                      alt=""
                      style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.65 }}
                      draggable={false}
                    />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.projectName}</span>
                </div>
              );
            }

            const tab = row.tab;
            const missing = !!row.missing;
            const selected = index === selectedIndex;
            const chrome = getTabChromeColorConfig(tab);
            const hasColor = !!tab.color && tab.color !== 'default';
            const rawBg = selected
              ? (hasColor || tab.tabType === 'file' ? adjustRgbaAlpha(chrome.bgColor, 0.25) : 'rgba(255,255,255,0.18)')
              : (hasColor || tab.tabType === 'file' ? chrome.bgColor : 'rgba(255,255,255,0.04)');
            const bg = flattenRgbaOnTabbarPanel(rawBg === '#181725' ? 'rgba(24,23,37,1)' : rawBg);
            const statusMeta = tab.sessionStatus ? sessionStatuses.find((s: any) => s.id === tab.sessionStatus) : null;
            const busy = isBusy(tab.id);
            const proc = hasProcess(tab);

            return (
              <div
                key={tab.id}
                data-switcher-index={index}
                ref={selected ? (el) => { if (el) el.scrollIntoView({ block: 'nearest' }); } : undefined}
                onPointerEnter={() => { if (!mouseBlockedRef.current && !missing) setSelectedIndex(index); }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (missing) return; // vanished file — dead row, not a target
                  commitRow(row);
                }}
                title={missing ? 'Файл не найден на диске (перемещён или удалён)' : undefined}
                style={{
                  position: 'relative',
                  marginLeft: 4, // "вкладки внутри проектов с небольшим отступом"
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '5px 10px',
                  paddingLeft: 16, // room for strip (3px) + status marker
                  borderRadius: 5,
                  cursor: missing ? 'default' : 'pointer',
                  background: bg,
                  boxShadow: selected ? 'inset 0 0 0 1px rgba(255,255,255,0.30)' : 'none',
                  marginBottom: 1,
                  overflow: 'hidden',
                  userSelect: 'none',
                  opacity: missing ? 0.55 : 1,
                }}
              >
                {/* Process bar strip — same two independent signals as TabBar:
                    static colorA while the PTY/SDK runtime is alive, shimmer
                    overlay while the AI turn streams. */}
                {(proc || busy) && (
                  <div
                    className="tab-process-bar-static"
                    style={{
                      position: 'absolute',
                      ...(processBarPosition === 'right' ? { right: 0 } : { left: 0 }),
                      top: 0,
                      bottom: 0,
                      width: 3,
                      pointerEvents: 'none',
                      overflow: 'hidden',
                      ...(processBarPosition === 'right'
                        ? { borderTopRightRadius: 5, borderBottomRightRadius: 5 }
                        : { borderTopLeftRadius: 5, borderBottomLeftRadius: 5 }),
                    }}
                  >
                    {busy && <div className="tab-process-bar-ai-shimmer-overlay" />}
                  </div>
                )}

                {/* Session status marker */}
                {statusMeta && (
                  <span
                    title={statusMeta.label}
                    style={{
                      position: 'absolute',
                      left: 6,
                      top: 'calc(50% + 1px)',
                      transform: 'translateY(-50%)',
                      width: statusMarkerSize,
                      height: statusMarkerSize,
                      borderRadius: statusMarkerShape === 'square' ? 2 : '50%',
                      backgroundColor: statusMeta.color,
                      border: '1px solid rgba(0,0,0,0.4)',
                      pointerEvents: 'none',
                    }}
                  />
                )}

                {tab.tabType === 'file' && (
                  // Red icon = the linked file is gone from disk.
                  <FileText size={12} style={{ color: missing ? '#f87171' : '#a78bfa', flexShrink: 0, opacity: 0.9 }} />
                )}

                <span
                  style={{
                    color: missing ? '#9a9a9e' : '#e6e6e6',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {tab.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
