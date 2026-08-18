// ONE chip of a pane's strip: the tab's card as it appears in a window header.
//
// This lived inside SplitPaneAttachRow while a pane showed exactly one tab, so
// "the header" and "the chip" were the same component and the same subscriptions.
// A strip draws N of them, and each has to answer for ITSELF — its own process
// bar, its own status marker, its own task squares, its own name. Sharing one
// component's state across N chips is how a loader ends up on the neighbour of
// the tab that is actually busy.
//
// It also gained a state the single-chip version could not have: SHOWN vs merely
// PRESENT. Only one chip of a strip fills the window; the others are tabs the
// user parked here. The difference is carried the same way the sidebar carries
// "active": by the card's own background rule (resolveTabCardBackground), so a
// coloured tab stays its colour in both states instead of being painted over.

import React, { useEffect, useRef, useState } from 'react';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { FileText, Folder } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { getTabChromeColorConfig, flattenRgbaOnTabbarPanel, adjustRgbaAlpha } from './tabChrome';
import {
  resolveTabCardBackground,
  resolveTabCardMetrics,
  TAB_CARD_LINE_HEIGHT,
} from '../../utils/tabCardVisual.mjs';
import { openTabContextMenuAt, TAB_RENAME_REQUEST_EVENT } from './TabBar';
import {
  TabProcessBar,
  TabStatusMarker,
  TabTaskMarker,
  TASK_MARKER_GAP_PX,
  TASK_MARKER_LANE_HEIGHT_PX,
  TASK_MARKER_DEFAULT_COLOR,
  useTabActivitySignals,
} from './TabSignals';
import { requestTaskPlanNavigation } from '../../utils/taskPlanNavigation';
import { isEmptyTab } from '../../utils/emptyTab.mjs';

// Один ключ на источник и цель: чип принимает только чипы, и только своей
// полосы — карточка проекта, файл или вкладка из бокового списка сюда не лягут.
const PANE_CHIP_DND = 'PANE_TAB_CHIP';

export interface PaneTabChipProps {
  projectId: string;
  tabId: string;
  /** Is this the chip whose tab fills the window right now? */
  shown: boolean;
  /** Pane index, or null in single mode. Decides which gestures are available. */
  paneIndex: number | null;
  /** True when the workspace is split — middle-click semantics depend on it. */
  inSplit: boolean;
  /** Position in the strip; used by the drag to compute the drop target. */
  index?: number;
  /** The strip has more than one chip — enables reordering and per-chip close. */
  inStrip?: boolean;
}

export default function PaneTabChip({
  projectId, tabId, shown, paneIndex, inSplit, index = 0, inStrip = false,
}: PaneTabChipProps) {
  // Subscribe to the PRIMITIVE fields, never to the tab object: rename mutates
  // `tab.name` in place and only swaps the openProjects Map, so the object
  // reference stays equal and an object-returning selector never re-renders —
  // the header kept the stale name until some unrelated update repainted it.
  // (Same Fingerprint-Pattern rule as fix-performance-lags.md.)
  const tabExists = useWorkspaceStore((s) => !!s.openProjects.get(projectId)?.tabs.get(tabId));
  const tabName = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.name || '');
  const tabColor = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.color);
  const tabType = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.tabType);
  const tabSessionStatus = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.sessionStatus);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMeta = tabSessionStatus
    ? sessionStatuses.find((s) => s.id === tabSessionStatus)
    : undefined;
  const { hasProcess, busy, inheritedBusy } = useTabActivitySignals(tabId);
  const taskPlan = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.taskPlan);
  const taskStatuses = useUIStore((s) => s.taskStatuses);
  const taskStatusShape = useUIStore((s) => s.taskStatusMarker.shape);
  // The SAME size settings the sidebar card obeys (Settings → Размеры), so
  // changing them there moves this chip too instead of leaving two sizes.
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  const taskItems = taskPlan?.items || [];

  // «Пустая» — ничего не запущено. Читается из тех же полей вкладки, что и
  // везде: это описание, а не отдельное состояние (см. emptyTab.mjs).
  const isEmpty = useWorkspaceStore((s) => {
    const tab = s.openProjects.get(projectId)?.tabs.get(tabId);
    return tab ? isEmptyTab(tab) : false;
  });

  const chipRef = useRef<HTMLSpanElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  // Rename in place: same action as double-click in the sidebar list, so a tab
  // can be renamed from whichever surface the user is already looking at.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  const commitRename = () => {
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === tabName) return;
    useWorkspaceStore.getState().renameTab(projectId, tabId, next);
  };

  // This chip identifies itself to the tab menu it opens, so the menu's Rename
  // comes back HERE instead of opening an input in the sidebar list. The id
  // names the CHIP, not just the tab: the same tab can be shown in the
  // single-mode header and in a pane at once, and only the one that was
  // right-clicked should start editing.
  const renameHostId = `split-pane-header:${paneIndex ?? 'center'}:${tabId}`;
  React.useEffect(() => {
    const onRenameRequest = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        { host?: string; tabId?: string } | undefined;
      if (detail?.host !== renameHostId || detail?.tabId !== tabId) return;
      // Read the name at THIS moment: the menu may have been open long enough
      // for the tab to be renamed from somewhere else.
      const current = useWorkspaceStore.getState()
        .openProjects.get(projectId)?.tabs.get(tabId)?.name || '';
      setRenameDraft(current);
      setRenaming(true);
    };
    window.addEventListener(TAB_RENAME_REQUEST_EVENT, onRenameRequest);
    return () => window.removeEventListener(TAB_RENAME_REQUEST_EVENT, onRenameRequest);
  }, [renameHostId, projectId, tabId]);

  // Перетаскивание чипа внутри своей полосы — тем же механизмом, что карточки
  // проектов в титлбаре (`@atlaskit/pragmatic-drag-and-drop` + белая линия 2px
  // по ближней кромке). Один язык на оба списка: человек уже знает этот жест.
  //
  // Область — ТОЛЬКО своя полоса: чип, утащенный в чужое окно, означал бы «одна
  // вкладка в двух окнах», чего живой терминал не умеет. Перенос между окнами
  // делает отдельный жест — ПКМ → «Move to window», где цель называется явно.
  useEffect(() => {
    const element = chipRef.current;
    if (!element || !inStrip) return undefined;
    const stripId = `${paneIndex ?? 'center'}`;
    return combine(
      draggable({
        element,
        getInitialData: () => ({ type: PANE_CHIP_DND, tabId, index, stripId }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => source.data.type === PANE_CHIP_DND
          && source.data.stripId === stripId
          && source.data.tabId !== tabId,
        getData: ({ input }) => attachClosestEdge(
          { type: PANE_CHIP_DND, tabId, index, stripId },
          { element, input, allowedEdges: ['left', 'right'] },
        ),
        onDrag: ({ self }) => setClosestEdge(extractClosestEdge(self.data) as Edge | null),
        onDragLeave: () => setClosestEdge(null),
        onDrop: ({ source, self }) => {
          setClosestEdge(null);
          const from = Number(source.data.index);
          if (!Number.isFinite(from) || from === index) return;
          const edge = extractClosestEdge(self.data);
          // Куда встанет чип: слева от этого — на его место, справа — сразу за
          // ним. Когда тащат СЛЕВА направо, изъятие сдвигает всё после себя на
          // одну позицию, поэтому целевой индекс уменьшается на единицу.
          let to = edge === 'right' ? index + 1 : index;
          if (from < to) to -= 1;
          const movedTabId = String(source.data.tabId || '');
          if (!movedTabId) return;
          const store = useWorkspaceStore.getState();
          if (paneIndex === null) store.reorderCenterStripTab(projectId, movedTabId, to);
          else store.reorderSplitPaneTab(paneIndex, movedTabId, to);
        },
      }),
    );
  }, [inStrip, paneIndex, projectId, tabId, index]);

  if (!tabExists) return null;
  const chrome = getTabChromeColorConfig({ color: tabColor, tabType });
  const hasColor = !!tabColor && tabColor !== 'default';
  // Size, colour and hover all come from the shared card rules, so this chip
  // and the sidebar card cannot look like two different objects for the same
  // tab. Before this, the chip was 21px tall at 11.5px text next to a 27px
  // card at 14px, and its hover painted a flat white wash OVER the tab's own
  // colour — a green tab flashed grey-green and read as another widget.
  const cardMetrics = resolveTabCardMetrics(tabGeo, {
    fontSize: tabsFontSize,
    showTaskLane: taskItems.length > 0,
    hasStatusMarker: !!statusMeta,
  });
  // `active` = this chip's tab fills the window. Only meaningful once the strip
  // has more than one chip: with a single chip there is nothing to distinguish
  // it FROM, and lighting it up would just make every header brighter for no
  // information. That also keeps single-tab windows pixel-identical to before.
  const chipBg = flattenRgbaOnTabbarPanel(resolveTabCardBackground(
    { bgColor: chrome.bgColor, hasColor, active: inStrip && shown, hovered },
    adjustRgbaAlpha,
  ));
  const chipTitle = inStrip
    ? (shown
      ? 'Клик — эта вкладка уже показана. Средний клик — убрать её из окна'
      : 'Клик — показать эту вкладку в окне. Средний клик — убрать её из окна')
    : (inSplit
      ? 'Клик — перейти на вкладку. Средний клик — убрать вкладку из этого окна (окно останется)'
      : 'Клик — перейти на вкладку');

  return (
    <span
      ref={chipRef}
      // Named so a test can ask "does the chip FOR THIS TAB carry the
      // loader" — the question the process-bar bugs kept getting wrong,
      // and one that is unanswerable without knowing which tab a chip is.
      data-split-pane-tab-chip
      data-tab-id={tabId}
      data-chip-shown={shown ? '1' : '0'}
      data-chip-index={index}
      title={chipTitle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Only a LEFT press may take focus. A right-click opens a menu about
      // this tab — inspecting a tab is not switching to it, and stealing
      // focus there moves the surface out from under the menu the user just
      // opened. (pointerdown fires for every button, hence the check.)
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) e.preventDefault();
      }}
      // Перетаскивание — та же библиотека и тот же язык, что у карточек
      // проектов в титлбаре: белая линия 2px по БЛИЖНЕЙ кромке соседа. Свой
      // HTML5-drag здесь был третьим механизмом перетаскивания в одном
      // приложении и не умел показывать, куда именно ляжет чип.
      onClick={(e) => {
        // "Show this tab here". Activation itself brings the sidebar to the
        // tab's project now (one-pointer model), so the chip needs no
        // special project-following path anymore.
        e.stopPropagation();
        if (renaming) return;
        useWorkspaceStore.getState().activateCenterTab(projectId, tabId);
      }}
      onDoubleClick={(e) => {
        // Same gesture as in the sidebar list. File tabs keep their file
        // name — renaming one there would promise something the file
        // itself does not do.
        //
        // Stopped here so it never reaches the strip's own double-click, which
        // means "one more tab in this window": a double-click ON a chip is
        // about that chip.
        e.preventDefault();
        e.stopPropagation();
        if (tabType === 'file') return;
        setRenameDraft(tabName);
        setRenaming(true);
      }}
      onContextMenu={(e) => {
        // The sidebar's own menu, opened for THIS tab — not a second copy.
        // It renders downward from the click: the header is flush against
        // the top of the pane, so there is no room above it.
        e.preventDefault();
        e.stopPropagation();
        // `renameHost` says "if the user picks Rename, hand the input to
        // me". Without it the sidebar list opened the input on ITS copy of
        // the tab — the name committed correctly on Enter, but the editing
        // happened out of sight, on another surface than the one clicked.
        openTabContextMenuAt(projectId, tabId, e.clientX, e.clientY, { renameHost: renameHostId });
      }}
      onAuxClick={(e) => {
        // Middle-click takes this tab OUT OF THE WINDOW: its chip goes, the
        // neighbouring chip takes over, and the tab keeps living in the sidebar
        // list — it is not closed. The window itself survives even when its last
        // chip leaves; closing it is the placeholder's own ✕, so a stray middle
        // click can never destroy a layout the user built.
        //
        // It acts on the tab NAMED IN THIS CHIP and on nothing else. The guard
        // below is not defensive noise: the header is also rendered in single
        // mode from the CENTER tab, so a stale/foreign tabId here would silently
        // empty a pane the user is not even looking at.
        if (e.button !== 1) return;
        if (!inSplit) {
          // Single mode: a chip can only be taken out of the CENTRE's strip, and
          // only while there is a strip to take it out of. Without one this
          // gesture would be "remove the only thing on screen".
          if (!inStrip) return;
          e.preventDefault();
          e.stopPropagation();
          useWorkspaceStore.getState().removeTabFromCenterStrip(projectId, tabId);
          return;
        }
        const store = useWorkspaceStore.getState();
        const paneOfThisTab = store.splitPanes
          .some((p) => p.projectId === projectId && p.tabId === tabId);
        if (!paneOfThisTab && !inStrip) return;
        e.preventDefault();
        e.stopPropagation();
        // A file pane steps BACK to whatever this pane showed before it.
        // Opening a file from an agent and middle-clicking it is "undo
        // that", not "clear this window" — the pane returns to its previous
        // tab instead of going empty. Only when this chip is the one SHOWING,
        // because that is the only case where "what was here before" is a
        // question about the window rather than about a chip.
        if (shown && store.restoreSplitPanePreviousTab(tabId)) return;
        store.clearTabFromSplitPane(tabId);
      }}
      style={{
        // The signals below are absolutely positioned against THIS chip.
        position: 'relative',
        // In a strip a chip keeps its natural width and the STRIP scrolls;
        // shrinking every chip to fit would turn six tabs into six unreadable
        // stubs. A lone chip still shrinks, so a long name cannot push the
        // split button out of a narrow window.
        flexShrink: inStrip ? 0 : 1,
        minWidth: 0,
        maxWidth: inStrip ? 220 : undefined,
        // NOT `overflow: hidden`. The task squares hang a few px BELOW the
        // bottom edge on purpose — they mark the boundary, and a lane that
        // stops inside the card says nothing. Clipping here trimmed them
        // flush and made them look like a row inside the chip.
        // The name gets its own clipping instead, on the text node.
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: cardMetrics.fontSize,
        // Pinned, not browser-default: the row height PREDICTS the chip's
        // height from this number (resolveSplitAttachRowHeight), and the
        // default 'normal' is font-dependent — the prediction would drift.
        lineHeight: TAB_CARD_LINE_HEIGHT,
        // A parked chip's name is dimmer: the strip should read as "this one,
        // and these others are here too" at a glance, without comparing
        // backgrounds. Same two-tier rule the sidebar list uses.
        color: (!inStrip || shown) ? '#e8e8e8' : '#9b9ba1',
        cursor: 'pointer',
        // Hover brightens the tab's OWN colour (shared rule), it does not
        // paint over it.
        background: chipBg,
        // ПОКАЗАННАЯ вкладка помечена яркой полосой по ВЕРХНЕЙ кромке.
        //
        // Фона для этого не хватает: у цветной вкладки «активный» фон — её же
        // цвет, только ярче, и рядом с показанной бесцветной она читается
        // громче неё. На живом экране так и вышло — оранжевый Claude выглядел
        // выбранным, хотя показана была серая «Пустая вкладка». А «какая из них
        // сейчас на экране» — главный вопрос к полосе, и отвечать на него
        // признаком, который перебивается цветом вкладки, нельзя.
        //
        // Полоса СВЕРХУ, а не снизу: снизу живёт полоска квадратов задач, она
        // намеренно свисает за кромку. Внутренняя тень, а не рамка: рамка
        // съела бы 2px изнутри и показанный чип стал бы ниже соседей.
        // Только в полосе из нескольких — одинокому чипу не с чем спорить.
        boxShadow: inStrip && shown ? 'inset 0 2px 0 0 rgba(255,255,255,0.75)' : undefined,
        border: `1px solid ${chrome.borderColor}55`,
        borderRadius: cardMetrics.borderRadius,
        // Left padding clears the status marker when one is shown, so the
        // name never sits under it — same rule as the sidebar card.
        padding: cardMetrics.padding,
        transition: 'background-color 0.12s ease, color 0.12s ease',
        // Перетаскиваемый чип бледнеет — он сейчас «в руке», а не на месте.
        opacity: dragging ? 0.4 : 1,
      }}
    >
      {/* Белая линия по ближней кромке — ровно та, что показывают карточки
          проектов. Позиционируется по краю чипа и на половину выступает
          наружу, чтобы читаться как «между этими двумя», а не «внутри». */}
      {closestEdge && (
        <span
          aria-hidden
          data-pane-chip-drop-edge={closestEdge}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: 2,
            background: '#fff',
            pointerEvents: 'none',
            zIndex: 99999,
            ...(closestEdge === 'left'
              ? { left: 0, transform: 'translateX(-50%)' }
              : { right: 0, transform: 'translateX(50%)' }),
          }}
        />
      )}
      {/* Signals belong to the TAB, so they hang off the chip — not off the
          header row. The row is the full pane width (~1215px) while the chip
          is ~195px: anchoring the bar to the row put it ~900px away from the
          tab it describes, next to the split button, even though its width,
          color and edge were all correct. Shared component, so the sidebar
          card and this chip cannot drift apart again. */}
      <TabProcessBar
        hasProcess={hasProcess}
        busy={busy}
        inheritedBusy={inheritedBusy}
        radius={4}
        zIndex={4}
      />
      <TabStatusMarker color={statusMeta?.color} title={statusMeta?.label} />
      {/* Молнии Fast и числа заполнения контекста здесь НЕТ — они живут только
          на карточке в боковом списке (юзер, 2026-08-18). Боковой список — это
          обзор: там читают состояние всех вкладок сразу, и метки отвечают на
          вопрос, который там и задают. Чип в шапке говорит про ОДНО окно, и в
          полосе из нескольких чипов те же метки превращались бы в рябь вокруг
          имён. Плюс они свисают за нижнюю кромку, а под чипом идёт строка пути.
          Полоска процесса и метка статуса остаются: они про «работает ли эта
          вкладка прямо сейчас», а это вопрос к окну, на которое смотришь. */}
      {/* Молнии Fast и числа контекста здесь НЕТ намеренно.
          Обе метки живут только на карточке в боковом списке — там карточка
          принадлежит вкладке целиком и является её постоянным «домом». Чип в
          шапке окна — это строка вкладок ВНУТРИ панели: он ниже, теснее, стоит
          вплотную к соседям и к кнопке разделения, и обе метки, выходящие за
          его границы, там читались как мусор поверх чужих элементов, а не как
          свойство вкладки (решение пользователя, 2026-08-18). */}
      {tabType === 'file' && <FileText size={10} style={{ color: '#a78bfa', flexShrink: 0 }} />}
      {/* Пустая вкладка — серая папка на месте цвета агента. A tab with an agent
          carries that agent's colour, which is how the strip is read at a
          glance; a tab with nothing started has no colour to carry, and an
          unmarked grey chip is indistinguishable from a tab whose colour was
          simply never set. The folder says what it is instead. */}
      {isEmpty && <Folder size={10} style={{ color: '#8a8a92', flexShrink: 0 }} />}
      {renaming ? (
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') setRenaming(false);
          }}
          style={{
            width: Math.max(60, renameDraft.length * 6.5 + 12),
            minWidth: 60,
            padding: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: '#fff',
            font: 'inherit',
          }}
        />
      ) : (
        // The name clips itself now that the chip no longer clips its
        // children — otherwise a long tab name would stretch the header.
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tabName}
        </span>
      )}
      {/* Task squares along the bottom seam of the chip — the same lane the
          sidebar card carries, from the same component. Partial overlap with
          the content below is intended: they mark the boundary. */}
      {taskItems.length > 0 && (
        <span
          data-task-plan-tab-markers
          style={{
            position: 'absolute',
            left: 6,
            right: 6,
            // Hangs below the bottom edge by the shared rule, same as the
            // sidebar card — the squares straddle the seam rather than
            // sitting inside it.
            bottom: `${cardMetrics.laneBottomPx}px`,
            height: `${TASK_MARKER_LANE_HEIGHT_PX}px`,
            display: 'flex',
            alignItems: 'flex-end',
            gap: `${TASK_MARKER_GAP_PX}px`,
            overflow: 'hidden',
            pointerEvents: 'none',
            zIndex: 7,
          }}
        >
          {taskItems.map((task: any) => {
            const status = task.statusId
              ? taskStatuses.find((candidate) => candidate.id === task.statusId)
              : undefined;
            return (
              <TabTaskMarker
                key={task.id}
                color={status?.color || TASK_MARKER_DEFAULT_COLOR}
                shape={taskStatusShape}
                title={task.title}
                onClick={(event) => {
                  event.stopPropagation();
                  useWorkspaceStore.getState().activateCenterTab(projectId, tabId);
                  requestTaskPlanNavigation({ tabId, taskId: task.id, view: 'active' });
                }}
              />
            );
          })}
        </span>
      )}
    </span>
  );
}
