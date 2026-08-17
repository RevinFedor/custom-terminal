// ONE implementation of the visual signals a tab card carries. Every surface
// that draws a "tab" renders these through this file — the vertical sidebar
// list, the pane header, the Ctrl+Tab switcher, the Run after picker.
//
// Why this file exists: the same three signals used to be re-declared in each
// of those surfaces, sharing only the color table in tabChrome.ts. They drifted
// exactly as duplicated code does — the pane-header copy anchored its process
// bar to the ROW (1215px wide) instead of the tab chip (195px), so the bar sat
// ~900px away from the tab it described while still being the right width, the
// right color and on the right edge. A fifth copy would have drifted the same
// way, so the geometry now lives in one place and the callers only say WHERE
// the box is.
//
// Contract for callers:
//   • The host element must be `position: relative` (or otherwise a containing
//     block) and should be the element the signal is ABOUT — the tab chip, the
//     card, the row — never a wider layout wrapper.
//   • Edge is not a per-surface choice: it comes from Settings
//     (processBar.position) so every bar in the app points the same way. A bar
//     on the opposite edge reads as a different signal.
//   • Orientation is fixed VERTICAL, full height of the host. A horizontal bar
//     along the bottom seam is a different signal to the eye, even with the
//     same color and thickness.

import React, { useEffect, useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';

const { ipcRenderer } = window.require('electron');

/** Width of the process bar. Same on every surface. */
export const TAB_PROCESS_BAR_W_PX = 3;

export interface TabProcessBarProps {
  /** A PTY/SDK runtime is alive → static colored bar. */
  hasProcess: boolean;
  /** The AI turn is streaming → shimmer crawls over the bar. */
  busy: boolean;
  /** Busy inherited from a linked tab → purple base + purple-safe shimmer. */
  inheritedBusy?: boolean;
  /** Rounded corners on the bar's own side; pass the host's radius. */
  radius?: number | string;
  /**
   * Pull the bar outward by N px. Cards reserving a transparent border for
   * dashed drag states need this so the bar lands on the visible edge.
   */
  outset?: number;
  zIndex?: number;
  /**
   * Local overrides of the process-bar CSS variables. Only the Settings preview
   * uses this: it must show CANDIDATE values the user is dragging, before they
   * are committed to :root. Live surfaces must never pass this — they inherit
   * the committed values so every bar in the app looks the same.
   */
  cssVars?: React.CSSProperties;
  /** Force the bar's edge, ignoring Settings. Settings preview only. */
  positionOverride?: 'left' | 'right';
}

/**
 * Process / AI-busy bar: a vertical strip on the configured edge of its host,
 * carrying two INDEPENDENT signals at once — a static color while a runtime is
 * alive, and a moving shimmer while the agent is thinking. Either can show
 * without the other (an SDK tab thinks with no PTY at all).
 *
 * Renders nothing when there is no signal, so callers can mount it
 * unconditionally.
 */
export function TabProcessBar({
  hasProcess,
  busy,
  inheritedBusy = false,
  radius = 0,
  outset = 0,
  zIndex = 5,
  cssVars,
  positionOverride,
}: TabProcessBarProps) {
  const position = useUIStore((s) => s.processBar.position);
  if (!hasProcess && !busy && !inheritedBusy) return null;
  const onRight = (positionOverride ?? position) === 'right';
  const edge = outset ? `${-outset}px` : 0;
  return (
    <span
      className="tab-process-bar-static"
      data-tab-process-bar
      aria-hidden
      style={{
        position: 'absolute',
        ...(onRight ? { right: edge } : { left: edge }),
        top: 0,
        bottom: 0,
        width: `${TAB_PROCESS_BAR_W_PX}px`,
        // Clips the shimmer overlay to the strip.
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex,
        ...(inheritedBusy
          ? { backgroundColor: 'var(--process-bar-inherited-color, #A855F7)' }
          : null),
        ...(onRight
          ? { borderTopRightRadius: radius, borderBottomRightRadius: radius }
          : { borderTopLeftRadius: radius, borderBottomLeftRadius: radius }),
        ...cssVars,
      }}
    >
      {busy && <span className="tab-process-bar-ai-shimmer-overlay" />}
      {inheritedBusy && (
        <span className="tab-process-bar-ai-shimmer-overlay tab-process-bar-inherited-shimmer-overlay" />
      )}
    </span>
  );
}

/**
 * Live process / AI-busy signals for ONE tab, read from the same broadcasts the
 * sidebar list consumes.
 *
 * THREE signals, not two. The third — "this tab is waiting for a delegated
 * session it started" — used to be missing here, so every surface built on this
 * hook (the pane header chip, the pane's recent-tabs list) drew an idle tab
 * while the sidebar card drew the purple waiting strip for the SAME tab at the
 * SAME moment. The sidebar was not more correct, only better wired: it asked
 * the orchestration store itself. Asking it once, here, is what keeps the
 * surfaces from disagreeing again — the whole reason this file exists.
 *
 * Subscribed per surface rather than threaded down as props: the pane header is
 * rendered from three call sites, and a prop chain left some of them silently
 * without a loader.
 *
 * THE STARTING VALUE IS THE HARD PART. The broadcasts carry only TRANSITIONS —
 * "this tab just started answering", "it just finished". A surface that mounts
 * while an answer is already in flight has missed the start and will hear
 * nothing until the end, so it renders an idle tab for as long as the work
 * lasts. That is exactly what the pane header did: the sidebar showed the
 * loader, the header for the SAME tab showed none, because the header had been
 * mounted after the turn began.
 *
 * So neither signal is bootstrapped from the broadcasts:
 *   • "a process is alive"   ← asked from the main process on mount;
 *   • "an answer is running" ← read from the tab record in the store, which the
 *     app-wide listeners keep current for EVERY tab regardless of which one is
 *     on screen (store.setAiBusy).
 * After that, transitions keep both up to date as before.
 */
export function useTabActivitySignals(tabId: string): {
  hasProcess: boolean;
  busy: boolean;
  inheritedBusy: boolean;
} {
  const [hasProcess, setHasProcess] = useState(false);
  // Waiting for a delegated session. Same source and same precedence as the
  // sidebar card: a tab answering itself shows its OWN colour, so the two
  // states never paint over each other.
  const orchestrationBusy = useOrchestrationStore((s) => s.inheritedBusyTabIds.has(tabId));
  // Seed from the durable per-tab flag, then follow the live edges. Subscribing
  // to the store here (instead of reading it once) also covers the tabs whose
  // busy state arrives through a channel this hook does not listen to — SDK
  // tabs have no PTY broadcast of their own.
  const storeBusy = useWorkspaceStore((s) => {
    for (const workspace of s.openProjects.values()) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return !!tab.aiBusy;
    }
    return false;
  });
  const [busyEdge, setBusyEdge] = useState<boolean | null>(null);
  const busy = busyEdge ?? storeBusy;

  useEffect(() => {
    let disposed = false;
    setHasProcess(false);
    setBusyEdge(null);
    const onBusy = (_: unknown, data: { tabId?: string; busy?: boolean; reason?: string }) => {
      if (disposed || data?.tabId !== tabId) return;
      // Spinner frames are a presentation heuristic, not a turn boundary — the
      // same exclusion the queue runner applies.
      if (data.reason === 'spinner') return;
      setBusyEdge(data.busy === true);
    };
    const onStarted = (_: unknown, data: { tabId?: string }) => {
      if (!disposed && data?.tabId === tabId) setHasProcess(true);
    };
    const onFinished = (_: unknown, data: { tabId?: string }) => {
      if (!disposed && data?.tabId === tabId) setHasProcess(false);
    };
    ipcRenderer.on('claude:busy-state', onBusy);
    ipcRenderer.on('codex:busy-state', onBusy);
    ipcRenderer.on('gemini:busy-state', onBusy);
    ipcRenderer.on('terminal:command-started', onStarted);
    ipcRenderer.on('terminal:command-finished', onFinished);
    ipcRenderer.invoke('terminal:getCommandState', { tabId, caller: 'TabSignals' })
      .then((state: any) => { if (!disposed) setHasProcess(!!state?.isRunning); })
      .catch(() => {});
    return () => {
      disposed = true;
      ipcRenderer.removeListener('claude:busy-state', onBusy);
      ipcRenderer.removeListener('codex:busy-state', onBusy);
      ipcRenderer.removeListener('gemini:busy-state', onBusy);
      ipcRenderer.removeListener('terminal:command-started', onStarted);
      ipcRenderer.removeListener('terminal:command-finished', onFinished);
    };
  }, [tabId]);

  return { hasProcess, busy, inheritedBusy: orchestrationBusy && !busy };
}

// Task squares along the card's bottom seam. Geometry is shared so the pane
// header and the sidebar card draw the same lane; only the host differs.
export const TASK_MARKER_SIZE_PX = 8;
export const TASK_MARKER_GAP_PX = 3;
export const TASK_MARKER_HOVER_SCALE = 1.32;
export const TASK_MARKER_LANE_HEIGHT_PX = Math.ceil(TASK_MARKER_SIZE_PX * TASK_MARKER_HOVER_SCALE);
export const TASK_MARKER_DEFAULT_COLOR = '#73737a';

/** One task square. Click is the caller's business (navigate, focus, …). */
export function TabTaskMarker({
  color,
  shape,
  title,
  onClick,
}: {
  color: string;
  shape: 'dot' | 'square';
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-task-plan-tab-marker
      title={title}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: TASK_MARKER_SIZE_PX,
        height: TASK_MARKER_SIZE_PX,
        flex: `0 0 ${TASK_MARKER_SIZE_PX}px`,
        padding: 0,
        borderRadius: shape === 'square' ? 1 : '50%',
        backgroundColor: color,
        border: '1px solid rgba(0,0,0,0.38)',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        cursor: 'pointer',
        outline: 'none',
        transform: `scale(${hovered ? TASK_MARKER_HOVER_SCALE : 1})`,
        transformOrigin: 'center bottom',
        transition: 'transform 90ms ease, filter 90ms ease',
        filter: hovered ? 'brightness(1.18)' : 'none',
      }}
    />
  );
}

export interface TabStatusMarkerProps {
  /** Resolved status color; falsy → nothing renders. */
  color?: string | null;
  title?: string;
  /** Overrides the size from Settings (task lane needs a slightly larger dot). */
  sizePx?: number;
  /** Distance from the host's left edge. Clears the process bar by default. */
  left?: number;
  /** Vertical nudge, compensating optical baseline shift of lowercase text. */
  topOffsetPx?: number;
  zIndex?: number;
}

/**
 * Session status marker — a dot or square whose shape and size come from
 * Settings. Always on the LEFT, even when the process bar is on the right: it
 * belongs next to the tab NAME, and reading it means reading the name.
 */
export function TabStatusMarker({
  color,
  title,
  sizePx,
  left = 5,
  topOffsetPx = 1,
  zIndex = 6,
}: TabStatusMarkerProps) {
  const shape = useUIStore((s) => s.statusMarker.shape);
  const settingsSize = useUIStore((s) => s.statusMarker.sizePx);
  if (!color) return null;
  const size = sizePx ?? settingsSize;
  return (
    <span
      data-tab-status-marker
      title={title}
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `calc(50% + ${topOffsetPx}px)`,
        transform: 'translateY(-50%)',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: shape === 'square' ? '2px' : '50%',
        backgroundColor: color,
        border: '1px solid rgba(0,0,0,0.4)',
        pointerEvents: 'none',
        zIndex,
      }}
    />
  );
}
