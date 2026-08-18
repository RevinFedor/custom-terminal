import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, PanelBottom, PanelTop } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import {
  resolveSplitAttachRowHeight,
  resolveTabCardBottomOverhang,
} from '../../utils/tabCardVisual.mjs';
import {
  isEmptyPane,
  paneGridRects,
  paneTabs,
  normalizeSplitSizes,
  resizeFractions,
  splitAvailability,
  splitDividerDescriptors,
} from '../../utils/splitPanesModel.mjs';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { EMPTY_TAB_NAME } from '../../utils/emptyTab.mjs';
import PaneTabStrip from './PaneTabStrip';
import { TabLocationLine } from './TabLocationLine';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

const { ipcRenderer } = window.require('electron');

// Fallback height only (empty-pane header, restore paths that render before
// settings are read). Real rows size themselves from the chip via
// useSplitAttachRowHeight — a 26px constant under a Settings-sized chip is
// exactly the bug where the chip poked over the pane separator above it.
export const SPLIT_ATTACH_ROW_H = 26;

/**
 * Live height of the pane header, derived from the same Settings → Размеры
 * values the chip inside it obeys. Every surface that positions content BELOW
 * the row (pane content top, toast anchor, single-mode header slot, file
 * preview offset) must use this hook, not the constant — one of them reading a
 * different number is how the chip and the separator ended up crossing.
 *
 * The header is TWO lines: the tab chip, and the tab's working directory under
 * it (moved here 2026-08-17 from a full-width row of its own — see
 * TabLocationLine). Both lines are inside the same reserved slot, so callers ask
 * this one question and get the whole header's height.
 */
export function useSplitAttachRowHeight(): number {
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  return resolveSplitAttachRowHeight(tabGeo, { fontSize: tabsFontSize, withPath: true });
}

// Fractional columns, fractional rows inside a column (equal when sizes are
// absent). Geometry comes from the pure model so the rectangles and the layout
// rules can never disagree — see splitPanesModel::paneGridRects.
export function splitPaneRectStyle(
  paneIndex: number,
  panes: Array<{ projectId: string; tabId: string; column?: number }>,
  sizes: { cols: number[]; rows: number[][] } | null = null,
): React.CSSProperties {
  const rect = paneGridRects(panes, sizes)[paneIndex];
  if (!rect) return { position: 'absolute', inset: 0 };
  return {
    position: 'absolute',
    left: `${rect.leftPct}%`,
    width: `${rect.widthPct}%`,
    top: `${rect.topPct}%`,
    height: `${rect.heightPct}%`,
  };
}

interface AttachRowProps {
  projectId: string;
  tabId: string;
  focused: boolean;
  /** Pane index in split mode — the split button inserts the new pane right
   *  after THIS pane. Omitted in single mode (append semantics). */
  paneIndex?: number;
}

// Top strip of a split pane: [project chip][tab chip], split button on the
// right. The tab chip reuses the shared tab chrome so the card language
// matches the sidebar. Middle-click on the tab chip removes the pane from the
// split (like middle-click closes things elsewhere) — there is no ✕ button.
// The terminal/transcript toggle lives in the composer's top line, not here.
//
// There is deliberately NO "pick target pane" toggle here: clicking a pane and
// then clicking a tab already does the same thing in the same two clicks, so a
// separate armed mode was pure surface for a rare case.

export function SplitPaneAttachRow({ projectId, tabId, focused, paneIndex }: AttachRowProps) {
  const splitPanes = useWorkspaceStore((s) => s.splitPanes);
  const tabExists = useWorkspaceStore((s) => !!s.openProjects.get(projectId)?.tabs.get(tabId));
  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null);
  // Measured position of the split-direction menu, clamped into the window.
  const splitMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [splitMenuPos, setSplitMenuPos] = useState<{ x: number; y: number } | null>(null);
  // The SAME size settings the sidebar card obeys (Settings → Размеры), so
  // changing them there moves this header too instead of leaving two sizes.
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  // The button STAYS and greys out at the limit instead of disappearing: a
  // control that vanishes reads as a bug ("кнопка пропала"), a greyed one with
  // a tooltip states the rule. Each direction is asked about separately —
  // three columns full does not mean this column cannot still be stacked.
  const splitCan = splitAvailability(splitPanes, paneIndex ?? null);
  const inSplit = splitPanes.length > 0;

  // The strip this header draws. A STRING selector (Fingerprint Pattern) — a
  // selector returning the entry array would allocate on every store write and
  // repaint every header in the workspace.
  const stripKey = useWorkspaceStore((s) => {
    const pane = paneIndex === null || paneIndex === undefined ? null : s.splitPanes[paneIndex];
    if (pane) return paneTabs(pane).map((e: any) => `${e.projectId}:${e.tabId}`).join(',');
    // Single mode has no pane object, so the strip lives per project — keyed by
    // the project the CENTRE is showing, which is not always the project of the
    // tab this header was handed (a strip can hold another project's tab). A
    // project with no strip is exactly the pre-strip behaviour: the header names
    // the one tab it was given.
    const center = s.centerStrips[s.activeProjectId || projectId];
    if (!center || center.length === 0) return `${projectId}:${tabId}`;
    return center.map((e) => `${e.projectId}:${e.tabId}`).join(',');
  });
  const entries = React.useMemo(
    () => stripKey.split(',').filter(Boolean).map((pair) => {
      const at = pair.lastIndexOf(':');
      return { projectId: pair.slice(0, at), tabId: pair.slice(at + 1) };
    }),
    [stripKey],
  );

  // Double-click on the strip's empty space: a brand-new tab joins THIS window.
  //
  // Created at the END of the project's list, like every other new tab — the
  // sidebar order is the user's own map and a window must not insert into the
  // middle of it. The tab is created without an agent: it is a live shell, and
  // the launch strip inside it is how it becomes Claude or Codex. Юзер: *«кликаю
  // два раза, открывается новая вкладка сбоку»*.
  const createTabInThisWindow = React.useCallback(async () => {
    const store = useWorkspaceStore.getState();
    const owner = paneIndex === null || paneIndex === undefined
      ? projectId
      : (store.splitPanes[paneIndex]?.projectId || projectId);
    const workspace = store.openProjects.get(owner);
    if (!workspace) return;
    const projectPath = workspace.projectPath && !workspace.projectPath.startsWith('__unset__')
      ? workspace.projectPath
      : '';
    const cwd = projectPath || workspace.tabs.get(workspace.activeTabId || '')?.cwd || '';
    // `background` keeps createTab from activating it: the arrival is the
    // STRIP's business, and the store action below both adds the chip and shows
    // it in one write. Letting createTab activate first would run activation
    // against a strip that does not contain the tab yet — i.e. the replace rule,
    // which would swap out the very chip the user is adding a neighbour to.
    //
    // Named, not auto-numbered: `tab-7` says only that six others came before
    // it. This tab is a terminal with nothing started in it, and the name says
    // exactly that — see emptyTab.mjs on why it is not called «пустая»: in this
    // app «пусто» already means "no tab at all", which is what an empty window
    // says. It keeps the name until it is renamed or an agent is launched here.
    const newTabId = await store.createTab(owner, EMPTY_TAB_NAME, cwd, {
      skipInitialRename: true,
      background: true,
    });
    if (!newTabId) return;
    if (paneIndex === null || paneIndex === undefined) {
      useWorkspaceStore.getState().addTabToCenterStrip(owner, newTabId);
      return;
    }
    useWorkspaceStore.getState().addTabToSplitPaneStrip(paneIndex, owner, newTabId);
  }, [paneIndex, projectId]);

  // Clamp the split-direction menu into the window once it has a measurable
  // box. useLayoutEffect, not useEffect: the corrected position must land in
  // the same frame, or the menu is visibly drawn outside the app and then
  // jumps. Declared ABOVE the early return below — hooks cannot be conditional.
  React.useLayoutEffect(() => {
    if (!splitMenu) { setSplitMenuPos(null); return; }
    const el = splitMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampMenuToViewport({
      x: splitMenu.x,
      y: splitMenu.y + 4,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setSplitMenuPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
  }, [splitMenu]);

  if (!tabExists) return null;
  // Derived from the SAME settings as the chips, so the row always fits them.
  // The wrapper that reserves this slot uses the same hook — see
  // useSplitAttachRowHeight.
  const rowH = resolveSplitAttachRowHeight(tabGeo, { fontSize: tabsFontSize, withPath: true });
  const seamH = resolveTabCardBottomOverhang(tabGeo);
  return (
    <div
      data-split-attach-row
      data-focused={focused ? 'true' : undefined}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: rowH,
        // TWO lines: the strip of tab chips, and the working directory of the
        // tab currently shown. The path moved here from a full-width row of its
        // own — it belongs to the tab, so it belongs where the tab is named, and
        // every window now answers about its own folder instead of only the
        // active one.
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        // The seam a chip's marks hang into. In the sidebar that is the gap
        // before the next card; here it has to be asked for, or the context
        // number and the task squares land on the path text. Same number the
        // height above reserves — one resolver, so they cannot disagree.
        rowGap: seamH,
        padding: '0 8px',
        background: 'transparent',
        boxSizing: 'border-box',
        zIndex: 3,
        userSelect: 'none',
        // Pane wrappers are pointer-events:none; every interactive surface
        // re-enables its own hits.
        pointerEvents: 'auto',
      }}
    >
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {/* The strip: project icon per RUN of same-project chips, then the chips.
          The icon labels a run rather than riding on every chip — with one icon
          per chip it sits BETWEEN two of them and it is unreadable which of the
          two it belongs to. */}
      <PaneTabStrip
        entries={entries}
        shownTabId={tabId}
        paneIndex={paneIndex ?? null}
        inSplit={inSplit}
        onCreateTab={createTabInThisWindow}
      />

      {/* No spacer: the strip itself takes the free width, so the split button
          stays pinned right whether there is one chip or twelve. */}

      {/* VS Code header pattern (approved 2026-08-17): pane ACTIONS show on
          the focused pane only; an unfocused pane reveals them on header
          hover (see globals.css [data-split-attach-row]). The button stays
          mounted either way — the reveal is opacity, so the header layout
          never shifts and the "кнопка пропала" bug class stays impossible. */}
      <button
        data-split-button
        data-split-horizontal={splitCan.horizontal ? '1' : '0'}
        data-split-vertical={splitCan.vertical ? '1' : '0'}
        // Количество панелей больше не ограничено (2026-08-17), поэтому
        // единственная оставшаяся причина отказа — незаполненная пустая панель.
        title={splitCan.horizontal || splitCan.vertical
          ? 'Разделить рабочую область. Правый клик — разделить по горизонтали'
          : 'Сначала выберите вкладку для пустой панели'}
        onClick={(e) => {
          e.stopPropagation();
          // Left click means "split sideways". When only the vertical
          // direction is left, the click OPENS THE MENU instead of doing
          // nothing: the gesture keeps leading somewhere, and the menu is the
          // place that names the remaining direction.
          if (splitCan.horizontal) {
            useWorkspaceStore.getState().addEmptySplitPane(paneIndex ?? null);
          } else if (splitCan.vertical) {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setSplitMenu({ x: r.left, y: r.bottom });
          }
        }}
        // Right-click offers the OTHER direction. Two commands rather than a
        // modifier: "above" and "below" are not one action with a flag, and a
        // menu can say which pane it will act on.
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!splitCan.vertical) return;
          setSplitMenu({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          // Left press may focus; a right press opens a menu ABOUT this pane
          // and must not move focus out from under it.
          if (e.button !== 0) e.preventDefault();
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 4,
          cursor: (splitCan.horizontal || splitCan.vertical) ? 'pointer' : 'not-allowed',
          background: 'transparent',
          border: 'none',
          // Dimmed, not gone: the control keeps its place in the row so the
          // header layout never shifts when the last slot is taken.
          color: (splitCan.horizontal || splitCan.vertical) ? '#8f8f94' : '#4a4a4e',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!splitCan.horizontal && !splitCan.vertical) return;
          (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)';
          (e.currentTarget as HTMLElement).style.color = '#eee';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
          (e.currentTarget as HTMLElement).style.color = (splitCan.horizontal || splitCan.vertical) ? '#8f8f94' : '#4a4a4e';
        }}
      >
        <Columns2 size={12} />
      </button>
      </div>

      {/* Line 2 — where this tab's terminal actually is. */}
      <TabLocationLine projectId={projectId} tabId={tabId} />

      {/* Rendered through a portal: the header is short with overflow
          clipping, so an inline menu would be cut off at the first row. */}
      {splitMenu && createPortal(
        <>
          <div
            onMouseDown={() => setSplitMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setSplitMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
          />
          <div
            ref={splitMenuRef}
            data-split-direction-menu
            style={{
              position: 'fixed',
              // Clamped to the window: this menu is opened from the RIGHT-most
              // control of a pane header, so raw cursor coordinates put its body
              // outside the app — a DOM menu, unlike an OS one, is not moved back
              // by anyone. Measured after the first paint (see the effect above);
              // until then it renders at the cursor, which is already correct
              // everywhere except the edges.
              top: splitMenuPos ? splitMenuPos.y : splitMenu.y + 4,
              left: splitMenuPos ? splitMenuPos.x : splitMenu.x,
              zIndex: 9999,
              // Was 190px for «Разделить: панель сверху/снизу» — a sentence
              // that repeated the verb of the button it opened from. The menu
              // only ever answers WHERE, so the items say just that, and the
              // box shrinks to what two short answers need.
              minWidth: 108,
              padding: '4px 0',
              background: '#242427',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 6,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              fontSize: 12,
              color: '#ddd',
              userSelect: 'none',
            }}
          >
            {/* Icon + one word. The verb lives on the button that opened this
                menu; repeating it in both rows made the reader compare two long
                strings to find the single word that differs. The panel icons
                show the shape of the result, so the word only has to name the
                side. */}
            {([
              { side: 'above' as const, label: 'Сверху', Icon: PanelTop },
              { side: 'below' as const, label: 'Снизу', Icon: PanelBottom },
            ]).map(({ side, label, Icon }) => (
              <div
                key={side}
                data-split-direction-item={side}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setSplitMenu(null);
                  useWorkspaceStore.getState().addVerticalSplitPane(paneIndex ?? null, side);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 12px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <Icon size={13} style={{ flexShrink: 0, color: '#9a9aa0' }} />
                {label}
              </div>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** Above every surface a pane can host, so the frame is never interrupted. */
export const SPLIT_PANE_FOCUS_FRAME_Z = 200;

/**
 * Gap between a pane's content and its frame.
 *
 * The frame is a 1px line drawn ON the pane's edge. Content flush against that
 * column touches it, and anything light there — a scrollbar thumb, the
 * Timeline's rail — fuses with the line, making the frame look thicker on that
 * side than on the other three. Two pixels separate them without costing any
 * visible layout.
 */
export const SPLIT_PANE_CONTENT_INSET_PX = 2;

/**
 * Contour shown while the cursor is over an UNFOCUSED pane.
 *
 * Its job is to explain the swallowed first click BEFORE it happens: the
 * pane lights up under the cursor, so "this click will select this pane"
 * is visible in advance instead of felt afterwards as a dead click.
 *
 * Between the two neighbour states (0.08 side lines) and the active-but-no-
 * keyboard state (0.30 full contour): loud enough to notice, quiet enough not
 * to be mistaken for focus itself.
 */
export const SPLIT_PANE_HOVER_RING = 'inset 0 0 0 1px rgba(255,255,255,0.20)';

// White focus frame of the focused pane; hairline separator on the others.
export function SplitPaneFocusFrame({ focused }: { focused: boolean }) {
  // Two states only: focused (full bright contour) and idle (side hairlines,
  // hover ring). The third state — "active but the keyboard is elsewhere" —
  // died with per-pane Ctrl+Tab (2026-08-17): the gesture is always global
  // now, so the frame has nothing extra to signal.
  //
  // Brightness, not colour: tabs carry their own colours and a coloured
  // contour would fight them, and violet already means "drag me" on the
  // resize handles.
  const state = focused ? 'focused' : 'idle';
  return (
    <div
      aria-hidden
      data-split-pane-focus-frame={focused ? '1' : '0'}
      data-split-pane-frame-state={state}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        // The frame draws the pane's BOUNDARY, so it must sit above everything
        // inside the pane. At z=4 it was painted under the docked input (z=140)
        // and the side panels (z=130): the composer covered the bottom edge and
        // the line visibly broke where they met. A boundary with a gap in it
        // reads as "this pane ends here", which is exactly wrong.
        zIndex: SPLIT_PANE_FOCUS_FRAME_Z,
        // 1px everywhere, same thickness as the inter-pane separators — focus
        // is carried by brightness, not by weight.
        // The idle frame leaves its box-shadow to the STYLESHEET (see
        // globals.css: `[data-split-pane-frame-state="idle"]`), because that is
        // the only state with a :hover variant — and an inline box-shadow here
        // would win over any :hover rule, which is exactly why the first
        // CSS-only attempt rendered nothing at all.
        ...(focused ? { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.75)' } : null),
        transition: 'box-shadow 0.12s ease',
      }}
    />
  );
}

// ── Resizable dividers ────────────────────────────────────────────────────

/** 6px grab strip centred on the 1px boundary — same feel as the TabSidebar
 *  handle, and the same violet: violet already means "drag me" here. */
const SPLIT_DIVIDER_HIT_PX = 6;
const SPLIT_DIVIDER_HOVER_BG = 'rgba(99,102,241,0.4)';

type LiveSizes = { cols: number[]; rows: number[][] };

/**
 * One layer over the whole split, hosting every divider strip.
 *
 * The live drag does NOT write the store: pane wrappers are positioned
 * directly in the DOM from the in-flight fractions, and the store learns the
 * result once, on mouseup (commitSplitSizes). A store write per mousemove
 * would rebuild the terminals memo — every pane of every project — at
 * pointer speed. The strips themselves follow via this component's local
 * state, which re-renders only this thin layer.
 */
export function SplitDividerLayer() {
  const panes = useWorkspaceStore((s) => s.splitPanes);
  const committedSizes = useWorkspaceStore((s) => s.splitSizes);
  const [liveSizes, setLiveSizes] = useState<LiveSizes | null>(null);
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const liveRef = React.useRef<LiveSizes | null>(null);
  // The strip's violet is managed by HAND (mouseenter/leave + drag), never by
  // the style prop: this layer re-renders on every drag move to keep the strip
  // under the pointer, and a React-managed background would be wiped by each
  // of those renders the moment the prop reads undefined.
  const draggingIdRef = React.useRef<string | null>(null);
  const cancelDragRef = React.useRef<(() => void) | null>(null);

  // A pane write mid-drag (tab closed elsewhere, project closed — pane
  // HISTORY purges rewrite the array too) invalidates both the in-flight
  // fractions and the grab-time baseline: cancel, and put the wrappers back
  // on the COMMITTED geometry ourselves. The memo cannot be relied on for
  // that — a same-tabIds write (history purge) changes neither its key nor
  // the sizes fingerprint, so nothing else would ever repaint the wrappers
  // out of their mid-drag positions.
  useEffect(() => {
    if (!cancelDragRef.current && !liveRef.current) return;
    cancelDragRef.current?.();
    liveRef.current = null;
    setLiveSizes(null);
    const host = layerRef.current?.parentElement;
    if (!host || panes.length < 2) return;
    const rects = paneGridRects(panes, useWorkspaceStore.getState().splitSizes);
    host.querySelectorAll<HTMLElement>('[data-terminal-pane-wrapper][data-split-pane-index]').forEach((el) => {
      const idx = Number(el.getAttribute('data-split-pane-index'));
      const rect = rects[idx];
      if (!rect) return;
      el.style.left = `${rect.leftPct}%`;
      el.style.width = `${rect.widthPct}%`;
      el.style.top = `${rect.topPct}%`;
      el.style.height = `${rect.heightPct}%`;
    });
  }, [panes]);

  if (panes.length < 2) return null;
  const sizes = liveSizes ?? committedSizes;
  const dividers = splitDividerDescriptors(panes, sizes);
  if (dividers.length === 0) return null;

  // Reposition the pane wrappers straight in the DOM — the exact styles the
  // memo would write, minus the memo. Wrapper lookup by the pane-index attr
  // works because the wrappers are SIBLINGS of this layer in the same host.
  const applyLiveGeometry = (next: LiveSizes) => {
    const host = layerRef.current?.parentElement;
    if (!host) return;
    const rects = paneGridRects(panes, next);
    host.querySelectorAll<HTMLElement>('[data-terminal-pane-wrapper][data-split-pane-index]').forEach((el) => {
      const idx = Number(el.getAttribute('data-split-pane-index'));
      const rect = rects[idx];
      if (!rect) return;
      el.style.left = `${rect.leftPct}%`;
      el.style.width = `${rect.widthPct}%`;
      el.style.top = `${rect.topPct}%`;
      el.style.height = `${rect.heightPct}%`;
    });
  };

  const startDrag = (
    e: React.MouseEvent,
    divider: ReturnType<typeof splitDividerDescriptors>[number],
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const layer = layerRef.current;
    const strip = e.currentTarget as HTMLElement;
    if (!layer) return;
    const hostRect = layer.getBoundingClientRect();
    if (hostRect.width === 0 || hostRect.height === 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    // Drag math runs against the sizes AT GRAB TIME (normalized to the current
    // structure), so the min-size clamp never accumulates across moves.
    const base = normalizeSplitSizes(panes, sizes) as LiveSizes;
    draggingIdRef.current = divider.id;
    strip.style.background = SPLIT_DIVIDER_HOVER_BG;
    const onMove = (ev: MouseEvent) => {
      let next: LiveSizes;
      if (divider.kind === 'col') {
        const deltaFr = (ev.clientX - startX) / hostRect.width;
        next = { cols: resizeFractions(base.cols, divider.dividerIndex, deltaFr), rows: base.rows };
      } else {
        // Columns are full height, so a row's fraction is of the host height.
        const deltaFr = (ev.clientY - startY) / hostRect.height;
        const rows = base.rows.map((r, c) => (
          c === divider.columnIndex ? resizeFractions(r, divider.dividerIndex, deltaFr) : r
        ));
        next = { cols: base.cols, rows };
      }
      liveRef.current = next;
      setLiveSizes(next); // repositions the strips (this thin layer only)
      applyLiveGeometry(next); // repositions the pane wrappers, no store write
    };
    const stopListening = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      draggingIdRef.current = null;
      cancelDragRef.current = null;
      if (!strip.matches(':hover')) strip.style.background = '';
    };
    const onUp = () => {
      stopListening();
      const finalSizes = liveRef.current;
      liveRef.current = null;
      setLiveSizes(null);
      // ONE store write per finished drag. The memo then repaints the wrappers
      // from the same fractions the DOM already shows — no visual jump. A
      // clean click (no move) commits nothing, which is what lets dblclick
      // below mean "reset" without the two mousedowns fighting it.
      if (finalSizes) useWorkspaceStore.getState().commitSplitSizes(finalSizes);
    };
    cancelDragRef.current = stopListening;
    document.body.style.cursor = divider.kind === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={layerRef}
      data-split-divider-layer
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}
    >
      {dividers.map((d) => (
        <div
          key={d.id}
          data-split-divider={d.id}
          onMouseDown={(e) => startDrag(e, d)}
          // Double-click = back to the equal split, all dividers at once.
          // (Micro-jitter between the two clicks is harmless: a near-equal
          // drag packs to null anyway — see EQUAL_EPS in the model.)
          onDoubleClick={() => useWorkspaceStore.getState().commitSplitSizes(null)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = SPLIT_DIVIDER_HOVER_BG; }}
          onMouseLeave={(e) => {
            if (draggingIdRef.current !== d.id) (e.currentTarget as HTMLElement).style.background = '';
          }}
          style={{
            position: 'absolute',
            pointerEvents: 'auto',
            ...(d.kind === 'col'
              ? {
                left: `calc(${d.xPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
                top: 0,
                bottom: 0,
                width: SPLIT_DIVIDER_HIT_PX,
                cursor: 'col-resize',
              }
              : {
                top: `calc(${d.yPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
                left: `${d.leftPct}%`,
                width: `${d.widthPct}%`,
                height: SPLIT_DIVIDER_HIT_PX,
                cursor: 'row-resize',
              }),
          }}
        />
      ))}
    </div>
  );
}

// Markdown/file content INSIDE a split pane. The global FilePreview overlay
// stays the single-mode surface; a pane needs its own reader because the
// overlay is a fixed singleton covering the whole window.
export function SplitFilePane({ filePath, visible }: { filePath: string; visible: boolean }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fontSize = 13;

  useEffect(() => {
    let cancelled = false;
    if (!filePath) return undefined;
    setContent(null);
    setError(null);
    ipcRenderer.invoke('file:read', filePath).then((result: any) => {
      if (cancelled) return;
      if (result?.success) setContent(String(result.content ?? ''));
      else setError(result?.error || 'Не удалось прочитать файл');
    }).catch((e: any) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [filePath, visible]);

  if (!visible) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#161522', overflow: 'hidden', display: 'flex', flexDirection: 'column', pointerEvents: 'auto' }}>
      {error ? (
        <div style={{ padding: 16, color: '#f87171', fontSize: 12.5 }}>{error}</div>
      ) : content === null ? (
        <div style={{ padding: 16, color: '#777', fontSize: 12.5 }}>Загрузка…</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <MarkdownEditor
            content={content}
            onChange={() => {}}
            readOnly
            fontSize={fontSize}
            showLineNumbers={false}
            compact
          />
        </div>
      )}
    </div>
  );
}
