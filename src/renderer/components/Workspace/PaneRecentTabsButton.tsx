// "Recent tabs" control in a pane header, right of the tab name.
//
// The SECOND of the two ways into a tab list, and the only one that does not
// move focus: picking here puts the tab into THIS pane and leaves the center,
// the focused pane and the sidebar exactly where they were. The full switcher
// (system bar button / Cmd+P) stays the navigating one.
//
// It LOOKS like Ctrl+Tab because it IS Ctrl+Tab's rows: same component
// (TabListRows), same chrome tint, same process strip and shimmer, same status
// marker. It was first written as its own plainer list — a dot, a name, a grey
// project — and that made the same tab read as two different things depending
// on which list you opened, while quietly dropping every signal the card
// carries. Only the container differs now: this one is small, anchored to the
// button, and resizable by its right edge.
//
// Deliberately NOT a search field: this is a short "what did I have open"
// list, and a second search UI beside the real one would be two answers to the
// same question. Order is the Ctrl+Tab order, from the same model, so the two
// lists cannot disagree about what "recent" means.
//
// Opens on HOVER, and stays open while the cursor is over the button, over the
// list, or in the gap between them.
//
// That last part is the whole trick. This list is a portal, so it does not
// exist in the DOM while closed: an `onMouseLeave` on the button would unmount
// it in the SAME frame, before the cursor could reach it — the list would then
// be impossible to actually point at (сценарии-багов-design.md::2.7). So there
// is no mouseleave handler anywhere here. Instead a single global mousemove
// listener, alive only while open, tests the cursor against both rectangles
// plus the bridge between them, and closes only when it is outside all three.
//
// A click on the button still works as a toggle — for anyone who clicks before
// the hover has opened anything.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, ChevronDown } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import {
  useUIStore,
  PANE_RECENT_TABS_MIN_WIDTH,
  PANE_RECENT_TABS_MAX_WIDTH,
} from '../../store/useUIStore';
import { buildSwitcherRows } from '../../utils/tabSwitcherModel.mjs';
import { TabListProjectHeader, TabListTabRow } from './TabListRows';
import { useTabActivitySignals } from './TabSignals';

const MAX_ROWS = 12;
// Slack around every rectangle: sub-pixel layout and fast pointer sampling
// otherwise register a "miss" while the cursor is visually still on the target.
const HOVER_TOLERANCE = 4;

const pointInRect = (rect: DOMRect | undefined, x: number, y: number): boolean => (
  !!rect
  && x >= rect.left - HOVER_TOLERANCE && x <= rect.right + HOVER_TOLERANCE
  && y >= rect.top - HOVER_TOLERANCE && y <= rect.bottom + HOVER_TOLERANCE
);

// The gap between the button and the list below it. Run after has the same idea
// but a HORIZONTAL bridge (its menu opens sideways); this one must be vertical,
// or the cursor crosses dead space on the way down and the list vanishes.
const pointInBridge = (btn: DOMRect | undefined, menu: DOMRect | undefined, x: number, y: number): boolean => {
  if (!btn || !menu) return false;
  const top = Math.min(btn.bottom, menu.top) - HOVER_TOLERANCE;
  const bottom = Math.max(btn.bottom, menu.top) + HOVER_TOLERANCE;
  const left = Math.min(btn.left, menu.left) - HOVER_TOLERANCE;
  const right = Math.max(btn.right, menu.right) + HOVER_TOLERANCE;
  return x >= left && x <= right && y >= top && y <= bottom;
};

interface Props {
  /** Pane this control belongs to; -1 in single mode (no pane list). */
  paneIndex: number;
  /** Tab currently shown here — never offered as a target for itself. */
  currentTabId: string;
}

/**
 * One row. Its own component only because each row subscribes to ITS tab's
 * live signals — a process starting, an answer running — and a hook cannot be
 * called inside a map.
 *
 * No project name on the row: the project is named once, in the header above
 * its tabs, exactly as in Ctrl+Tab.
 */
function PaneRecentTabRow({
  row,
  index,
  sessionStatuses,
  onPick,
  onForget,
}: {
  row: any;
  index: number;
  sessionStatuses: any[];
  onPick: () => void;
  onForget: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { hasProcess, busy, inheritedBusy } = useTabActivitySignals(row.tab.id);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <TabListTabRow
        tab={row.tab}
        index={index}
        selected={hovered}
        hasProcess={hasProcess || !!row.tab.sdkProcessAlive}
        busy={busy}
        inheritedBusy={inheritedBusy}
        sessionStatuses={sessionStatuses}
        // Layout map: which pane this tab is already open in. This list PUTS a tab
        // into a pane, so knowing it is already in one — and in which — is the
        // difference between filling a slot and moving what you are looking at.
        paneMapProjectId={row.projectId}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // MIDDLE click forgets the row instead of opening it — same gesture,
          // same meaning, as in the Ctrl+Tab and Cmd+P lists. The list stays
          // open: the user is editing what it offers.
          if (e.button === 1) { onForget(); return; }
          if (e.button !== 0) return;
          onPick();
        }}
      />
    </div>
  );
}

export function PaneRecentTabsButton({ paneIndex, currentTabId }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const projectsMeta = useProjectsStore((s) => s.projects);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const width = useUIStore((s) => s.paneRecentTabsWidth);
  const setWidth = useUIStore((s) => s.setPaneRecentTabsWidth);
  // Fingerprint, not an object: an array/object selector allocates on every
  // store write and re-renders this header constantly (fix-performance-lags).
  // Colour and status are part of the key because the rows now DRAW them — a
  // recolour that did not change the name used to leave a stale row behind.
  const inventoryKey = useWorkspaceStore((s) => {
    const parts: string[] = [];
    for (const [projectId, workspace] of s.openProjects) {
      for (const tab of workspace.tabs.values()) {
        parts.push(projectId + ':' + tab.id + ':' + tab.name
          + ':' + (tab.color || '') + ':' + (tab.sessionStatus || '') + ':' + (tab.tabType || ''));
      }
    }
    return parts.join('|');
  });
  const mruKey = useWorkspaceStore((s) => s.globalTabMru.map((e) => e.tabId).join(','));
  const paneTabIds = useWorkspaceStore((s) => s.splitPanes.map((p) => p.tabId).join(','));

  const rows = useMemo(() => {
    const state = useWorkspaceStore.getState();
    const projects = Array.from(state.openProjects.entries()).map(([projectId, workspace]) => ({
      projectId,
      // projectPath can be missing on a workspace that is being torn down (the
      // project was just closed, or its record went away while its tabs were
      // still mounted): reading `.split` off undefined crashed the whole
      // window through the error boundary — a list of tabs must never be able
      // to take the app down.
      projectName: projectsMeta[projectId]?.name
        || (workspace.projectPath || '').split('/').filter(Boolean).pop()
        || 'Project',
      projectIcon: projectsMeta[projectId]?.icon || null,
      tabs: Array.from(workspace.tabs.values()).map((tab) => ({
        id: tab.id,
        name: tab.name,
        color: tab.color,
        tabType: tab.tabType,
        commandType: tab.commandType,
        groupId: tab.groupId,
        // The row draws the status marker and the process strip, so the data
        // behind them has to travel with the tab.
        sessionStatus: tab.sessionStatus,
        sdkProcessAlive: tab.sdkProcessAlive,
        filePath: tab.filePath,
      })),
    }));
    const all = buildSwitcherRows({ projects, globalMru: state.globalTabMru });
    // Grouped under project headers with an icon, exactly like Ctrl+Tab — the
    // project is said ONCE above its tabs instead of being repeated in grey at
    // the end of every row. That repetition was both noisier and misleading:
    // the same word sat where a tab's own trailing information would go.
    const openElsewhere = new Set(state.splitPanes.map((p) => p.tabId).filter(Boolean));
    const keep = all.filter((row: any) => (
      row.kind === 'project'
      || (row.tab.id !== currentTabId && !openElsewhere.has(row.tab.id))
    ));
    // Cap counts TABS, not rows: cutting a fixed number of rows would spend the
    // budget on headers and could even end on one, leaving a project title with
    // nothing under it.
    const capped: any[] = [];
    let tabs = 0;
    for (const row of keep) {
      if (row.kind === 'tab') {
        if (tabs >= MAX_ROWS) break;
        tabs += 1;
      }
      capped.push(row);
    }
    // A header whose tabs were all filtered out (open elsewhere, or this pane's
    // own tab) would otherwise stand alone over the next project's rows.
    return capped.filter((row: any, i: number) => (
      row.kind !== 'project' || capped[i + 1]?.kind === 'tab'
    ));
    // inventoryKey/mruKey/paneTabIds are the change signals; the data itself is
    // read from the store at call time.
  }, [inventoryKey, mruKey, paneTabIds, projectsMeta, currentTabId]);

  useEffect(() => {
    if (!open) return undefined;
    // Geometric hit-test. NOT onMouseLeave: see the note at the top of this
    // file — leaving the button must not close a list the cursor is on its way
    // to.
    //
    // Deliberately NOT throttled through requestAnimationFrame. A hidden or
    // occluded window stops painting, so rAF callbacks never run (measured:
    // starved past 1700ms while the window was hidden) and the list would hang
    // open until the window came back. The test itself is a few rect reads —
    // cheap enough to run per event, and per event it is always correct.
    const onMove = (e: MouseEvent) => {
      // A resize drag is the one time the cursor is SUPPOSED to be outside the
      // list: the user grabs the right edge and pulls, and the pointer leads
      // the edge it is dragging. Without this the list closes on the first
      // pixel of the drag and the handle can never be used — the classic way a
      // hover-closed popup and a resizable popup contradict each other.
      if (resizingRef.current) return;
      const btn = btnRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!menu) return; // not painted yet — nothing to test against
      const { clientX: x, clientY: y } = e;
      if (pointInRect(btn, x, y) || pointInRect(menu, x, y) || pointInBridge(btn, menu, x, y)) return;
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if ((t as HTMLElement)?.closest?.('[data-pane-recent-menu]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !resizingRef.current) setOpen(false); };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // ── resize by the RIGHT edge ────────────────────────────────────────────
  // Mirrors the side panels' handle, flipped: those grow leftwards from a
  // right-docked panel, this one is anchored at its LEFT (under the button)
  // and grows rightwards, so the new width is cursor − left edge.
  const resizingRef = useRef(false);
  const startResize = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    // Without this the drag selects the row text under the cursor and the
    // browser starts a native drag instead of a resize.
    event.preventDefault();
    event.stopPropagation();
    resizingRef.current = true;
    const left = menuRef.current?.getBoundingClientRect().left ?? event.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      // Measured against the list's own left edge, not against a start offset:
      // the pointer can outrun the clamped edge (dragging far past the max),
      // and a delta-based version then desyncs — the edge stops but the width
      // keeps counting, so coming back does nothing until the cursor catches
      // up with its own phantom.
      setWidth(e.clientX - left);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };
    // Capture phase, on window: the pointer routinely leaves the small list
    // during a drag, and a handler bound to the element would stop receiving
    // moves exactly when the drag gets interesting.
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }, [setWidth]);

  // A drag interrupted by anything else (the list closing, this header being
  // unmounted by a pane change) must not leave the whole app stuck with a
  // resize cursor and text selection disabled.
  useEffect(() => () => {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const openMenu = () => {
    if (open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Downward from the control: the header sits flush against the top of the
    // pane, so there is no room above it.
    setAnchor({
      top: r.bottom + 4,
      left: Math.max(8, Math.min(window.innerWidth - PANE_RECENT_TABS_MIN_WIDTH - 8, r.left)),
    });
    setOpen(true);
  };

  const toggle = () => {
    if (open) { setOpen(false); return; }
    openMenu();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-pane-recent-button
        title="Недавние вкладки — открыть в этой панели, не переходя на неё"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.button !== 0) e.preventDefault();
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Two glyphs wide instead of one. The clock alone was a 16px square
          // that read as decoration on a busy header; at this size it reads as
          // a control, and the chevron says WHAT KIND — something opens here.
          // That is also why the chevron rather than a second icon: a button
          // this small can only afford one meaning, and "opens a list" is the
          // one the user needs before clicking, not after.
          gap: 2,
          width: 32,
          height: 18,
          flexShrink: 0,
          padding: 0,
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          // A standing tint, not only on hover: an invisible-until-hovered
          // control is only found by accident. Kept faint so the tab name
          // beside it stays the loudest thing in the header.
          background: open ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)',
          color: open ? '#f0f0f2' : '#c2c2c8',
          transition: 'background-color 0.12s ease, color 0.12s ease',
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget as HTMLElement;
          el.style.background = 'rgba(255,255,255,0.16)';
          el.style.color = '#f0f0f2';
          openMenu();
        }}
        // Only the tint is restored here. Closing belongs to the global
        // hit-test above — doing it on leave would kill the list before the
        // cursor could reach it.
        onMouseLeave={(e) => {
          const el = e.currentTarget as HTMLElement;
          el.style.background = open ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
          el.style.color = open ? '#f0f0f2' : '#c2c2c8';
        }}
      >
        <History size={11} />
        {/* Points down because that is where the list appears — the header is
            flush against the top of the pane, so it can only open downward. */}
        <ChevronDown size={9} style={{ opacity: 0.85 }} />
      </button>

      {open && anchor && createPortal(
        <div
          ref={menuRef}
          data-pane-recent-menu
          style={{
            position: 'fixed',
            top: anchor.top,
            left: anchor.left,
            width,
            maxHeight: 320,
            zIndex: 9999,
            // Same panel surface as the switcher, so the two lists read as the
            // same thing shown at two sizes.
            background: '#1d1d1f',
            border: '1px solid #3a3a3d',
            borderRadius: 6,
            boxShadow: '0 12px 34px rgba(0,0,0,0.55)',
            fontSize: 13,
            color: '#ddd',
            userSelect: 'none',
            // The handle is positioned against this box; overflow lives on the
            // scroller inside, or the handle would scroll away with the rows.
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="tab-list-scroll" style={{ overflowY: 'auto', flex: 1, padding: '4px 6px 6px' }}>
            {rows.length === 0 && (
              <div style={{ padding: 14, textAlign: 'center', color: '#777', fontSize: 12.5 }}>
                Нет других вкладок
              </div>
            )}
            {rows.map((row: any, index: number) => (
              row.kind === 'project' ? (
                <TabListProjectHeader
                  key={`p:${row.projectId}:${index}`}
                  projectName={row.projectName}
                  projectIcon={row.projectIcon}
                />
              ) : (
                <PaneRecentTabRow
                  key={row.tab.id}
                  row={row}
                  index={index}
                  sessionStatuses={sessionStatuses}
                  onPick={() => {
                    setOpen(false);
                    useWorkspaceStore.getState().setSplitPaneTab(paneIndex, row.projectId, row.tab.id);
                  }}
                  // This list is the GLOBAL order (it offers every tab, not just
                  // this pane's past), so forgetting here edits the global
                  // history — the same list Ctrl+Tab and Cmd+P show.
                  onForget={() => {
                    useWorkspaceStore.getState().forgetGlobalTabVisit(row.projectId, row.tab.id);
                  }}
                />
              )
            ))}
          </div>

          {/* Resize handle on the RIGHT edge — the list is anchored under the
              button on its left, so that is the edge that can move. Sits inside
              the box (not straddling it) so it cannot overlap the neighbouring
              pane's controls. */}
          <div
            data-pane-recent-resize="e"
            onMouseDown={startResize}
            title="Потянуть — ширина списка"
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: 'col-resize',
              zIndex: 2,
              background: 'transparent',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#5b9cf5'; }}
            onMouseLeave={(e) => { if (!resizingRef.current) e.currentTarget.style.background = 'transparent'; }}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
