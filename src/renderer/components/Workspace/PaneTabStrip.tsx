// The strip of tab chips in a window's header.
//
// A window used to show one tab, so its header named that tab. It now holds a
// LIST with one of them shown, and this draws the list: project icon per RUN of
// same-project chips, the chips themselves, and — instead of a scrollbar — a
// count of what has scrolled out of sight on each side.
//
// Юзер: *«если будет много вкладок горизонтальный скролл. Скролл не показывать,
// это он будет ещё высоту занимать, показывать вместо этого слева либо справа
// +1, +2… ограничения по ширине во вкладке нет и не будет»*.
//
// The arithmetic of both rules lives in paneStripLayout.mjs, so it can be held
// by tests without a DOM; this file owns only how it is drawn and what the
// gestures do.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import { groupOverflowByKind, groupStripByProject, paneStripOverflowStateKey, paneStripRenderItems, resolveStripOverflow, scrollOffsetForChip } from '../../utils/paneStripLayout.mjs';
import { hiddenToastCountForChips, hiddenToastOwnerCounts } from '../../utils/toastPlacement.mjs';
import PaneTabChip from './PaneTabChip';
import PaneChooserChip from './PaneChooserChip';
import { moveEntriesToIndex } from '../../utils/horizontalReorder.mjs';
import {
  beginPaneTabDrag,
  endPaneTabDrag,
  getPaneTabDragSnapshot,
  paneStripKey,
  paneTabSourceFromDragData,
  PANE_TAB_DND_TYPE,
  resolvePaneTabDropTarget,
  setPaneTabDragTarget,
  usePaneTabDragSnapshot,
} from '../../utils/paneTabDragBridge';
import { commitPaintedPaneTabDrop } from '../../utils/paneTabDropCommit';
import { useHorizontalOrderPreview } from '../../hooks/useHorizontalOrderPreview';
import type { SharedTabActivityMaps } from './TabSignals';
import { TAB_COLORS, adjustRgbaAlpha } from './tabChrome';
import { requestFocusedWorkspacePrimaryInput } from '../../utils/tabPrimaryInputFocus';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { splitPanesFingerprint } from '../../utils/splitPanesModel.mjs';
import {
  CONTEXT_MENU_PANEL_STYLE,
} from '../UI/contextMenuMetrics.mjs';
import NewTabMenuRows from './NewTabMenuRows';

export interface StripEntry { projectId: string; tabId: string }

/** The project icon that labels a RUN of chips. Inert — it is a label. */
function StripProjectIcon({ projectId }: { projectId: string }) {
  const meta = useProjectsStore((s) => s.projects[projectId]);
  const path = useWorkspaceStore((s) => s.openProjects.get(projectId)?.projectPath || '');
  const name = meta?.name
    || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : null)
    || path.split('/').filter(Boolean).pop()
    || 'Project';
  return (
    <span
      data-strip-project-icon={projectId}
      title={name + (path ? `\n${path}` : '')}
      // Иконка — подпись группы чипов, а не пустое место полосы: двойной клик по
      // ней означал бы «ещё одну вкладку сюда», хотя человек целился в метку.
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
    >
      {meta?.icon ? (
        <img
          data-project-icon={projectId}
          src={meta.icon}
          alt=""
          draggable={false}
          style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0 }}
        />
      ) : (
        // No icon set (or Inbox): the same dashed placeholder square as the
        // titlebar card, so the header never reads as "icon failed to load"
        // and the chip's left edge does not shift between projects.
        <span
          aria-hidden
          style={{
            width: 12,
            height: 12,
            borderRadius: 2,
            flexShrink: 0,
            border: '1px dashed rgba(148,163,184,0.8)',
            background: 'rgba(148,163,184,0.08)',
          }}
        />
      )}
    </span>
  );
}

/** Как называется вид вкладки для счётчика: её цвет и есть её вид. */
const KIND_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  default: 'без агента',
};

/**
 * «×N» — вкладки, полностью ушедшие за край, по одному квадратику на вид.
 *
 * Цвет берётся из общей таблицы вкладок, а не подбирается здесь: оранжевый — то
 * же «Claude», что у самих чипов, и счётчик читается без легенды. Заливка чуть
 * плотнее, чем у чипа: квадратик мельче, а на той же прозрачности мелкое пятно
 * выглядит выцветшим рядом с полноразмерным чипом того же цвета.
 *
 * Несколько видов идут СТОЛБИКОМ, а не в строку: полоса — одна строка, и
 * второй квадратик рядом отъедал бы ширину у самих вкладок. Юзер: *«если там
 * оба, писать по вертикали друг над другом»*.
 */
function StripOverflowCount({ side, groups, errorCount = 0, onClick }: {
  side: 'left' | 'right';
  groups: Array<{ kind: string; count: number }>;
  /** Ошибки в чипах, ушедших за этот край: они не видны и текстом не всплывают. */
  errorCount?: number;
  onClick: () => void;
}) {
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const where = side === 'left' ? 'слева' : 'справа';
  const title = `${where}: `
    + groups.map((g) => `${g.count} × ${KIND_LABEL[g.kind] || g.kind}`).join(', ')
    + (errorCount > 0 ? `, ошибок: ${errorCount}` : '')
    + ' — клик прокрутит';
  return (
    <button
      type="button"
      data-strip-overflow={side}
      data-strip-overflow-count={total}
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      // Двойной клик по счётчику — это два клика прокрутки, а не «ещё одна
      // вкладка сюда»: жест полосы принадлежит её ПУСТОМУ месту, а здесь стоит
      // кнопка. Без этого быстрая двойная прокрутка молча создавала вкладку.
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 1,
        padding: 0,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* Красная сумма — ошибки в чипах, которых не видно за этим краем. Она
          стоит ПЕРВОЙ и отдельной коробкой: остальные числа отвечают «сколько
          там вкладок», а это — «сколько там сломалось», и смешивать их в один
          столбик значило бы прятать вторую новость внутрь первой. Считается тем
          же счётчиком, что красит рамку чипа, — иначе рамка и сумма разошлись
          бы. */}
      {errorCount > 0 && (
        <span
          data-strip-overflow-errors={errorCount}
          title={`Ошибок в скрытых вкладках: ${errorCount}`}
          style={{
            display: 'block',
            minWidth: 15,
            padding: '0 3px',
            height: 13,
            lineHeight: '13px',
            fontSize: 9.5,
            fontWeight: 700,
            textAlign: 'center',
            color: '#fff',
            background: '#dc2626',
            borderRadius: 3,
          }}
        >
          {errorCount}
        </span>
      )}
      {groups.map((g) => {
        const entry = TAB_COLORS.find((c) => c.color === g.kind);
        const bg = entry && entry.bgColor !== 'transparent'
          ? adjustRgbaAlpha(entry.bgColor, 0.14)
          : 'rgba(255,255,255,0.10)';
        return (
          <span
            key={g.kind}
            data-strip-overflow-kind={g.kind}
            style={{
              display: 'block',
              minWidth: 15,
              padding: '0 3px',
              height: 13,
              lineHeight: '13px',
              fontSize: 9.5,
              fontWeight: 700,
              textAlign: 'center',
              color: entry?.borderColor && g.kind !== 'default' ? entry.borderColor : '#c2c2c8',
              background: bg,
              borderRadius: 3,
            }}
          >
            {'\u00D7' + g.count}
          </span>
        );
      })}
    </button>
  );
}

export interface PaneTabStripProps {
  entries: StripEntry[];
  /** The tab filling the window — exactly one of `entries`. */
  shownTabId: string;
  /** Exactly one split pane owns the active-card background. */
  focused: boolean;
  paneIndex: number | null;
  inSplit: boolean;
  /** Double-click on empty space in the strip: one more tab in THIS window. */
  onCreateTab: () => void;
  /**
   * Режим ПЕРЕНОСА: чипы, не влезшие в ширину окна, уходят на следующую строку,
   * и полоса растёт вниз вместо того, чтобы прокручиваться вбок.
   *
   * Это ДРУГАЯ раскладка, а не флажок поверх прежней: прокрутка и перенос
   * отвечают на один вопрос «куда девать лишние вкладки» двумя несовместимыми
   * способами. Поэтому в режиме переноса молчат и счётчики «×N» (прятать
   * нечего), и доводка полосы до выбранного чипа (двигать нечего).
   */
  wrap?: boolean;
  /** Reveal selected chips automatically. Manual scrolling wins when false. */
  autoReveal?: boolean;
  /**
   * Trailing scroll reserve used only while focus-actions are out of layout.
   * It keeps the strip's right-edge coordinate space stable without leaving a
   * visible black layout box.
   */
  endInsetPx?: number;
  /** App-wide tab activity maps from Workspace; stable across workflow switches. */
  sharedActivity?: SharedTabActivityMaps | null;
  /**
   * МЕСТА окна по порядку: чипы вкладок и открытые страницы выбора вместе.
   *
   * Полоса рисует их одной строкой, но порядок вкладок продолжает приходить в
   * `entries` — во время перетаскивания он отличается от сохранённого, и
   * читать порядок отсюда значило бы рисовать полосу до жеста. Пусто/не задано
   * = окно без заготовок, то есть ровно прежнее поведение.
   */
  slots?: Array<{ projectId?: string; tabId?: string; slotId?: string }>;
  /** Какая страница выбора сейчас показана в этом окне. */
  selectedSlotId?: string;
}

export default function PaneTabStrip({
  entries, shownTabId, focused, paneIndex, inSplit, onCreateTab, wrap = false,
  autoReveal = false, endInsetPx = 0,
  sharedActivity = null, slots, selectedSlotId = '',
}: PaneTabStripProps) {
  const stripRootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeSpaceId = useWorkspaceStore((s) => s.activeSpaceId);
  const paneKey = paneStripKey(paneIndex);
  const paneDrag = usePaneTabDragSnapshot();
  const baseEntriesKey = entries.map((entry) => `${entry.projectId}:${entry.tabId}`).join('|');
  const baseIds = React.useMemo(() => entries.map((entry) => entry.tabId), [baseEntriesKey]);
  const horizontalPreview = useHorizontalOrderPreview(
    baseIds,
    scrollerRef,
    '[data-strip-item]',
    'data-strip-tab-id',
  );
  const desiredPreviewEntries = React.useMemo(() => {
    if (!paneDrag.active || !paneDrag.source || paneDrag.target?.paneKey !== paneKey) return null;
    return moveEntriesToIndex(entries, paneDrag.source.entries, paneDrag.target.at);
  }, [baseEntriesKey, paneDrag.active, paneDrag.revision, paneDrag.source, paneDrag.target, paneKey]);
  useEffect(() => {
    horizontalPreview.updatePreview(desiredPreviewEntries?.map((entry) => entry.tabId) || null);
  }, [desiredPreviewEntries, horizontalPreview.updatePreview]);
  const entryById = React.useMemo(() => {
    const out = new Map(entries.map((entry) => [entry.tabId, entry]));
    paneDrag.source?.entries.forEach((entry) => out.set(entry.tabId, entry));
    return out;
  }, [baseEntriesKey, paneDrag.source]);
  const previewEntries = horizontalPreview.displayedIds
    .map((tabId) => entryById.get(tabId))
    .filter((entry): entry is StripEntry => !!entry);
  const baseEntryIds = React.useMemo(() => new Set(entries.map((entry) => entry.tabId)), [entries]);
  const entriesRef = useRef(previewEntries);
  entriesRef.current = previewEntries;
  const entriesKey = previewEntries.map((entry) => `${entry.projectId}:${entry.tabId}`).join('|');
  // Разбивка по видам, не два числа: badge inherits the tab kind/color.
  const [overflow, setOverflow] = useState<{
    left: Array<{ kind: string; count: number }>;
    right: Array<{ kind: string; count: number }>;
    leftIds: string[];
    rightIds: string[];
  }>({ left: [], right: [], leftIds: [], rightIds: [] });
  const desiredOverflowKeyRef = useRef(paneStripOverflowStateKey());
  const pendingRevealRef = useRef<string | null>(null);
  const pendingRevealReasonRef = useRef('unknown');
  const revealSettlePassRef = useRef(0);
  const autoRevealShownRef = useRef<string | null>(null);
  const bodyDragRevealKeyRef = useRef<string | null>(null);
  const inStrip = previewEntries.length > 1;

  const kindOfTab = useCallback((tabId: string) => {
    const st = useWorkspaceStore.getState();
    const owner = entriesRef.current.find((e) => e.tabId === tabId)?.projectId;
    const color = owner ? st.openProjects.get(owner)?.tabs.get(tabId)?.color : undefined;
    return color && TAB_COLORS.some((c) => c.color === color && c.color !== 'default')
      ? String(color)
      : 'default';
  }, []);

  // Primitive fingerprint: colours can change while their chips are offscreen.
  const kindsKey = useWorkspaceStore((s) => previewEntries
    .map((e) => s.openProjects.get(e.projectId)?.tabs.get(e.tabId)?.color || '-')
    .join(','));

  const measure = useCallback((): boolean => {
    const el = scrollerRef.current;
    if (!el) return false;
    // Overflow badges are flex siblings of the scroller. Recomputing them from
    // a moving preview changes viewportLeft/clientWidth, which changes the
    // drag target and feeds back into the preview. Keep their footprint frozen
    // for the gesture; the browser-delivered post-release pass refreshes them.
    if (getPaneTabDragSnapshot().active) return false;
    if (wrap || !inStrip) {
      const key = paneStripOverflowStateKey();
      if (desiredOverflowKeyRef.current === key) return false;
      desiredOverflowKeyRef.current = key;
      setOverflow({ left: [], right: [], leftIds: [], rightIds: [] });
      return true;
    }
    const chips = Array.from(el.querySelectorAll<HTMLElement>('[data-strip-item]'))
      .map((node) => ({
        left: node.offsetLeft,
        width: node.offsetWidth,
        tabId: node.dataset.stripTabId || '',
      }));
    const next = resolveStripOverflow({
      chips,
      scrollLeft: el.scrollLeft,
      // Badge stacks are real flex siblings; clientWidth is already the
      // currently committed visible width. No guessed inset participates.
      viewportWidth: el.clientWidth,
    });
    const left = groupOverflowByKind(next.hiddenLeftIds, kindOfTab);
    const right = groupOverflowByKind(next.hiddenRightIds, kindOfTab);
    // Visual kind/count is not membership identity. If hidden Claude A is
    // replaced by hidden Claude B, the badge still reads `claude:1`, but its
    // toast owner must change from A to B. Include exact ids so leftIds/rightIds
    // can never stay stale behind an unchanged-looking badge.
    const key = paneStripOverflowStateKey({
      hiddenLeftIds: next.hiddenLeftIds,
      hiddenRightIds: next.hiddenRightIds,
      leftGroups: left,
      rightGroups: right,
    });
    // Update desired identity BEFORE React state. Scroll/layout callbacks fired
    // before the commit now dedupe synchronously instead of queuing the same
    // object repeatedly.
    if (desiredOverflowKeyRef.current === key) return false;
    desiredOverflowKeyRef.current = key;
    setOverflow({ left, right, leftIds: next.hiddenLeftIds, rightIds: next.hiddenRightIds });
    return true;
  }, [inStrip, kindOfTab, wrap]);

  // Ошибки в чипах, ушедших за края. Считаются ЗДЕСЬ, а не в счётчике: сумма и
  // красная рамка на чипе обязаны отвечать одним числом, и источник у них один
  // (см. toastPlacement.mjs). Селектор возвращает пару чисел, а не список
  // уведомлений, — иначе любое всплывающее сообщение приложения перерисовывало
  // бы полосу.
  const hiddenErrorsKey = useUIStore((s) => {
    if (overflow.leftIds.length === 0 && overflow.rightIds.length === 0) return '0|0';
    // «Видно» здесь — показанная вкладка ЭТОГО окна. Больше ничего проверять не
    // нужно: чип за краем лежит в этой полосе, а вкладка живёт ровно в одном
    // окне — значит нигде больше она показана быть не может.
    const counts = hiddenToastOwnerCounts(s.toasts, [shownTabId]);
    return hiddenToastCountForChips(counts, overflow.leftIds)
      + '|' + hiddenToastCountForChips(counts, overflow.rightIds);
  });
  const [leftErrors, rightErrors] = hiddenErrorsKey.split('|').map((n) => Number(n) || 0);

  const revealChip = useCallback((targetTabId: string): { moved: boolean; overflowChanged: boolean } => {
    const el = scrollerRef.current;
    if (!el || !targetTabId || wrap) return { moved: false, overflowChanged: false };
    const node = el.querySelector<HTMLElement>(`[data-strip-item][data-strip-tab-id="${CSS.escape(targetTabId)}"]`);
    if (!node) return { moved: false, overflowChanged: false };
    // Both rectangles belong to this exact committed layout, including the
    // real width already taken by one or several overflow badges.
    const chipRect = node.getBoundingClientRect();
    const viewportRect = el.getBoundingClientRect();
    const next = scrollOffsetForChip({
      chip: { left: chipRect.left, right: chipRect.right },
      viewport: { left: viewportRect.left, right: viewportRect.right },
      scrollLeft: el.scrollLeft,
    });
        const moved = next !== el.scrollLeft;
        if (moved) {
          const before = el.scrollLeft;
          el.scrollLeft = next;
          console.warn('[PaneTabStrip:Reveal] pane=' + (paneIndex ?? 'center')
            + ' reason=' + pendingRevealReasonRef.current
            + ' tab=' + targetTabId.slice(-12)
            + ' from=' + before.toFixed(1)
            + ' to=' + next.toFixed(1)
            + ' viewport=' + el.clientWidth
            + ' scrollWidth=' + el.scrollWidth);
        }
    return { moved, overflowChanged: measure() };
  }, [measure, paneIndex, wrap]);

  const requestReveal = useCallback((targetTabId: string, reason: string) => {
    if (!autoReveal || !targetTabId || wrap) return;
    pendingRevealRef.current = targetTabId;
    pendingRevealReasonRef.current = reason;
    revealSettlePassRef.current = 0;
    const result = revealChip(targetTabId);
    if (!result.overflowChanged) pendingRevealRef.current = null;
  }, [autoReveal, revealChip, wrap]);

  // A body drop explicitly means "append and show this tab". It is a user
  // placement command, not the optional selection auto-reveal policy, so the
  // preview scrolls to the future chip even when autoReveal is disabled.
  useEffect(() => {
    const rootTabId = paneDrag.source?.rootTabId || '';
    const target = paneDrag.target;
    if (!paneDrag.active || !rootTabId || target?.paneKey !== paneKey || target.zone !== 'body' || wrap) {
      bodyDragRevealKeyRef.current = null;
      return;
    }
    const el = scrollerRef.current;
    const node = el?.querySelector<HTMLElement>(
      `[data-strip-item][data-strip-tab-id="${CSS.escape(rootTabId)}"]`,
    );
    if (!node) return;
    const key = `${paneDrag.source?.sourceSpaceId || 'sidebar'}:${paneKey}:${rootTabId}`;
    if (bodyDragRevealKeyRef.current === key) return;
    bodyDragRevealKeyRef.current = key;
    pendingRevealReasonRef.current = 'body-drop-preview';
    revealChip(rootTabId);
  }, [entriesKey, paneDrag.active, paneDrag.revision, paneDrag.source, paneDrag.target, paneKey, revealChip, wrap]);

  useEffect(() => {
    if (paneDrag.active) return undefined;
    const frame = window.requestAnimationFrame(() => measure());
    return () => window.cancelAnimationFrame(frame);
  }, [measure, paneDrag.active]);

  // Immediate pass for the current layout. A fully visible chip is a strict
  // no-op; a clipped one moves by exactly the clipping delta. Geometry-only
  // changes (focus actions appearing/disappearing, ResizeObserver measurement,
  // overflow badge reflow) MUST NOT re-arm this pass: they did not select a
  // tab, and re-revealing the already shown chip overwrote manual scroll.
  useLayoutEffect(() => {
    if (!inStrip || wrap) {
      autoRevealShownRef.current = null;
      return;
    }
    if (autoRevealShownRef.current === shownTabId) return;
    autoRevealShownRef.current = shownTabId;
    requestReveal(shownTabId, 'shown-change');
  }, [shownTabId, inStrip, requestReveal, wrap]);

  // A requested badge state has now committed. Re-read the real rect once and
  // continue only if that measurement requested another badge footprint.
  // Passive effect = no nested layout-state loop. A hard cap is a fail-safe for
  // a browser rounding oscillation; normal convergence is one or two passes.
  useEffect(() => {
    if (!autoReveal) {
      pendingRevealRef.current = null;
      return;
    }
    const targetTabId = pendingRevealRef.current;
    if (!targetTabId || wrap) return;
    revealSettlePassRef.current += 1;
    if (revealSettlePassRef.current > 4) {
      console.warn('[PaneTabStrip] reveal-settle-cap tab=' + targetTabId.slice(-12));
      pendingRevealRef.current = null;
      return;
    }
    const result = revealChip(targetTabId);
    if (!result.overflowChanged) pendingRevealRef.current = null;
  }, [autoReveal, overflow, revealChip, wrap]);

  // Measure only from the browser's committed-layout delivery. Reading the
  // first chip's offsetLeft in a React layout effect made that innocent read
  // the synchronous boundary for recalculating the ENTIRE freshly switched
  // workspace (90ms per strip in the four-pane fixture). ResizeObserver gives
  // the same chip/scroller geometry after layout already exists. Observe the
  // chips too: their text can change scrollWidth without changing the
  // scroller's own content box. Selection/focus does not alter geometry and
  // therefore cannot reset manual scroll.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      measure();
    });
    ro.observe(el);
    el.querySelectorAll<HTMLElement>('[data-strip-item]').forEach((chip) => ro.observe(chip));
    return () => ro.disconnect();
  }, [entriesKey, kindsKey, measure]);
  // Что рисуется в строке: группы вкладок и страницы выбора между ними.
  // Порядок вкладок — из предпросмотра перетаскивания, позиции заготовок — из
  // мест окна; склейка живёт в `paneStripLayout`, чтобы третьего порядка не
  // появилось (см. комментарий там). Окно без заготовок даёт ровно тот же
  // список групп, что и прежний `groupStripByProject`.
  const renderItems = React.useMemo(() => {
    const chooserSlots = (slots || []).filter((slot) => slot && !slot.tabId && slot.slotId);
    if (chooserSlots.length === 0) {
      return groupStripByProject(previewEntries).map((run) => ({ kind: 'run' as const, ...run }));
    }
    return paneStripRenderItems(slots || [], previewEntries);
  }, [slots, entriesKey, previewEntries]);
  const indexOfTab = new Map(previewEntries.map((entry, i) => [entry.tabId, i]));

  // Empty header space is a real target too. Chip targets own their own exact
  // edge; this parent handles project icons/gaps/trailing space and computes
  // the same insertion index from committed chip rectangles.
  useEffect(() => {
    const element = stripRootRef.current;
    if (!element) return undefined;
    return dropTargetForElements({
      element,
      getData: () => ({ type: 'PANE_TAB_STRIP_TARGET', paneKey, paneIndex }),
      canDrop: ({ source }) => !element.closest('[data-pane-focus-isolated="1"]')
        && source.data.type === PANE_TAB_DND_TYPE,
      onDrag: ({ source, location }) => {
        const sourceState = paneTabSourceFromDragData(source.data as Record<string, unknown>);
        if (!sourceState) return;
        beginPaneTabDrag(sourceState);
        const target = resolvePaneTabDropTarget(
          element,
          location.current.input.clientX,
          sourceState.entries.map((entry) => entry.tabId),
          location.current.input.clientY,
        );
        if (target) setPaneTabDragTarget(target);
      },
      onDragLeave: () => {
        const current = getPaneTabDragSnapshot();
        if (current.target?.paneKey === paneKey && current.target.zone === 'strip') {
          setPaneTabDragTarget(null);
        }
      },
      onDrop: ({ source }) => {
        const sourceState = paneTabSourceFromDragData(source.data as Record<string, unknown>);
        if (!sourceState) return;
        const result = commitPaintedPaneTabDrop(sourceState.rootTabId);
        console.log('[PaneTabDnd:drop] source=' + sourceState.rootTabId.slice(-12)
          + ' owner=strip pane=' + paneKey
          + ' at=' + (result.target?.at ?? '-')
          + ' claimed=' + (result.claimed ? 1 : 0)
          + ' committed=' + (result.committed ? 1 : 0));
        endPaneTabDrag(sourceState.rootTabId);
      },
    });
  }, [paneIndex, paneKey]);

  // Меню «что начать здесь» для свободного места полосы. Позиция — курсор;
  // прижимается к окну тем же резолвером, что и остальные меню шапки, потому
  // что шапка низкая и обрезает своё содержимое (портал + clamp).
  // Меню запоминает ТОЧНЫЙ адрес окна в момент открытия: workflow и позицию
  // полосы. Голого `paneIndex` мало — он означает «N-е окно текущей
  // раскладки», а раскладка под открытым меню может смениться.
  // Адрес меню — не только номер окна. Номер означает «N-е окно текущей
  // раскладки», а окна внутри ОДНОГО workflow можно закрыть или переставить,
  // и освободившийся номер тут же займёт другое окно: команда создала бы
  // вкладку не там, куда человек целился. Поэтому вместе с номером
  // запоминается отпечаток самой раскладки — он меняется при любой её правке.
  const [newTabMenu, setNewTabMenu] = useState<
    {
      x: number;
      y: number;
      spaceId: string | null;
      paneIndex: number | null;
      layoutRevision: string;
    } | null
  >(null);
  const newTabMenuRef = useRef<HTMLDivElement | null>(null);
  const [newTabMenuPos, setNewTabMenuPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!newTabMenu) { setNewTabMenuPos(null); return; }
    const el = newTabMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampMenuToViewport({
      x: newTabMenu.x,
      y: newTabMenu.y + 4,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setNewTabMenuPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
  }, [newTabMenu]);

  // Обычный жизненный цикл меню, а не только клик по подложке.
  //
  // Меню рисуется порталом в `document.body`, поэтому оно ПЕРЕЖИВАЕТ скрытие
  // своей шапки: уход в другой workflow оставлял его висеть над чужой
  // раскладкой, где его команды означали уже не то. Escape и потеря окна —
  // тот же контракт, что у остальных меню шапки.
  useEffect(() => {
    if (!newTabMenu) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setNewTabMenu(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [newTabMenu]);

  // Меню закрывается, как только его адрес перестал существовать: сменился
  // workflow ИЛИ переставили/закрыли окна внутри текущего. Это подстраховка
  // показа; решает всё равно проверка в самом действии (см. `createTabHere`),
  // потому что эффект может не успеть выполниться до клика.
  const liveLayoutRevision = useWorkspaceStore((s) => splitPanesFingerprint(s.splitPanes));
  useEffect(() => {
    if (!newTabMenu) return;
    if (newTabMenu.spaceId !== activeSpaceId
      || newTabMenu.layoutRevision !== liveLayoutRevision) {
      setNewTabMenu(null);
    }
  }, [newTabMenu, activeSpaceId, liveLayoutRevision]);

  // Команда меню создаёт вкладку СРАЗУ, минуя страницу выбора: человек уже
  // назвал ответ. Место при этом всё равно заводится — оно и есть адрес, по
  // которому вкладка приземлится ровно сюда, а не «в текущее окно» после
  // ожидания. Открывается и материализуется одним жестом, поэтому чип со
  // страницей выбора на экране не мелькает.
  const createTabHere = useCallback((action: 'terminal' | 'claude' | 'codex') => {
    const menu = newTabMenu;
    setNewTabMenu(null);
    if (!menu) return;
    const store = useWorkspaceStore.getState();
    // Проверка стоит В ДЕЙСТВИИ, а не только в эффекте: эффект — следующий
    // кадр, а клик мог случиться в том же. Раскладка сверяется целиком, потому
    // что номер окна переиспользуется: закрыли соседа — и «второе окно» стало
    // другим окном.
    if (menu.spaceId !== store.activeSpaceId) return;
    if (menu.layoutRevision !== splitPanesFingerprint(store.splitPanes)) {
      console.log('[Split] newTabMenu stale layout — команда отменена');
      return;
    }
    const slotId = store.openWindowTabChooser(menu.paneIndex);
    if (!slotId) return;
    void store.createTabForWindowChooser(slotId, action);
  }, [newTabMenu]);

  const scrollBy = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el || wrap) return;
    el.scrollLeft += direction * Math.max(80, el.clientWidth * 0.6);
    measure();
  };

  const focusPaneAfterHeaderClick = () => {
    useUIStore.getState().setActiveArea('workspace');
    if (paneIndex === null || paneIndex === undefined) return;
    const store = useWorkspaceStore.getState();
    // Re-clicking the already focused pane restores its project if the sidebar
    // was explicitly parked elsewhere; focus index equality is not a no-op.
    store.focusSplitPane(paneIndex);
    requestFocusedWorkspacePrimaryInput('pane-header-click');
  };

  return (
    <div
      ref={stripRootRef}
      data-pane-tab-strip
      data-pane-tab-drop-zone="strip"
      data-pane-key={paneKey}
      data-space-id={activeSpaceId}
      // The empty space right of the last chip belongs to the STRIP, so the
      // double-click that means "one more tab here" has somewhere to land even
      // when the chips do not fill the row. It is also why this wrapper — not
      // the scroller — carries the gesture: the scroller's empty area is inside
      // its content box only while the content is narrower than the viewport.
      onDoubleClick={(e) => {
        // A double-click ON a chip is that chip's rename; it stops there.
        e.stopPropagation();
        onCreateTab();
      }}
      // ПКМ по свободному месту полосы — та же тема, что и двойной клик по
      // нему: «что здесь начать». Разница только в том, что меню называет
      // ответ сразу и пропускает страницу выбора: человек уже решил.
      //
      // Меню принадлежит СВОБОДНОМУ месту, а не всей шапке: у чипа вкладки
      // своё меню, у кнопок окна — свои, и перехват здесь отобрал бы их.
      // Открытие меню НЕ двигает фокус (см. onPointerDown ниже): рассматривать
      // окно — не то же, что перейти в него; фокусируется уже результат.
      onContextMenu={(e) => {
        if ((e.target as HTMLElement | null)?.closest?.('[data-strip-item], [data-pane-chooser-chip], [data-strip-project-icon], button')) return;
        e.preventDefault();
        e.stopPropagation();
        setNewTabMenu({
          x: e.clientX,
          y: e.clientY,
          spaceId: activeSpaceId,
          paneIndex: paneIndex ?? null,
          layoutRevision: splitPanesFingerprint(useWorkspaceStore.getState().splitPanes),
        });
      }}
      style={{
        display: 'flex',
        // В переносе полоса — это НЕСКОЛЬКО строк, и выравнивать их по центру
        // общей коробки нечего: строки заполняются сверху вниз.
        alignItems: wrap ? 'flex-start' : 'center',
        gap: 4,
        minWidth: 0,
        flex: 1,
      }}
    >
      <StripOverflowCount side="left" groups={overflow.left} errorCount={leftErrors} onClick={() => {
        scrollBy(-1);
        focusPaneAfterHeaderClick();
      }} />
      <div
        ref={scrollerRef}
        data-pane-tab-strip-scroller
        data-pane-tab-strip-wrap={wrap ? 'true' : 'false'}
        data-pane-tab-drop-zone="strip"
        data-pane-key={paneKey}
        data-space-id={activeSpaceId}
        onScroll={measure}
        // Клик по чипу, наполовину ушедшему за край, доводит полосу до него.
        //
        // Обрезанный чип остаётся кликабельным — значит им и пользуются, — и
        // выбранной оказывалась вкладка, чьё имя так и осталось разрезанным
        // краем окна. Ловим на ПОГРУЖЕНИИ: сам чип останавливает всплытие, и
        // обычный обработчик на полосе до неё бы не дошёл. Работает и когда
        // кликнули уже показанную вкладку — там `shownTabId` не меняется, и
        // правило «показать при смене» промолчало бы.
        onClickCapture={(e) => {
          const node = (e.target as HTMLElement | null)?.closest?.('[data-strip-item]') as HTMLElement | null;
          const clicked = node?.dataset?.stripTabId;
          if (clicked) requestReveal(clicked, 'chip-click');
        }}
        // Wheel over the strip scrolls it sideways: the row is one line tall and
        // there is nothing to scroll vertically here, so a vertical wheel that
        // did nothing would read as a dead surface.
        onWheel={(e) => {
          const el = scrollerRef.current;
          // В переносе полоса не прокручивается: перехватывать колесо здесь
          // значило бы съедать его у того, кто под ним.
          if (wrap) return;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!delta) return;
          e.preventDefault();
          e.stopPropagation();
          el.scrollLeft += delta;
          measure();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          // Перенос строк вместо прокрутки. Вертикальный зазор — тот же, что
          // между чипами по горизонтали, чтобы вторая строка не выглядела
          // отдельным блоком под первой.
          flexWrap: wrap ? 'wrap' : 'nowrap',
          gap: 6,
          rowGap: wrap ? 6 : undefined,
          minWidth: 0,
          flex: 1,
          overflowX: wrap ? 'hidden' : 'auto',
          overflowY: 'hidden',
          // No visible bar: the counts on either side say the same thing in a
          // line that is already there. See the header note.
          scrollbarWidth: 'none',
        }}
      >
        {renderItems.map((item, itemIndex) => (item.kind === 'chooser' ? (
          <PaneChooserChip
            key={`chooser:${item.slotId}`}
            slotId={item.slotId}
            paneIndex={paneIndex}
            selected={item.slotId === selectedSlotId}
            paneFocused={focused}
          />
        ) : (
          <React.Fragment key={`${item.projectId}:${itemIndex}`}>
            {item.tabIds.map((tabId, tabIndex) => (
              <span
                key={tabId}
                data-strip-item
                data-strip-tab-id={tabId}
                data-strip-project-start={tabIndex === 0 ? item.projectId : undefined}
                // Чип НЕ сжимается в полосе. Обёртка — элемент flex-строки, а
                // flex по умолчанию ужимает элементы, лишь бы строка влезла:
                // ширина обёртки становилась меньше чипа, а сам чип шире не
                // становился (`whiteSpace: nowrap`, обрезки нет намеренно —
                // под нижней кромкой висят квадратики задач). Итог — чипы
                // наезжали друг на друга, и прокручивать было нечего: строка
                // «влезала».
                //
                // Одиночному чипу сжатие оставлено: он делит строку с кнопками
                // окна, и там длинное имя не должно выдавливать их за край.
                // The project label and its first tab are one flex item, so
                // wrapping cannot strand the icon on the preceding line.
                // Tight inner spacing and a wider run boundary make the icon
                // read as a prefix of the tabs to its right.
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3,
                  marginLeft: tabIndex === 0 && itemIndex > 0 ? 4 : undefined,
                  flexShrink: (inStrip || wrap) ? 0 : 1, minWidth: 0 }}
              >
                {tabIndex === 0 && <StripProjectIcon projectId={item.projectId} />}
                <PaneTabChip
                  projectId={item.projectId}
                  tabId={tabId}
                  shown={tabId === shownTabId}
                  paneFocused={focused}
                  paneIndex={paneIndex}
                  inSplit={inSplit}
                  index={indexOfTab.get(tabId) ?? 0}
                  inStrip={inStrip}
                  sharedActivity={sharedActivity}
                  previewOnly={!baseEntryIds.has(tabId)}
                  dragPlaceholder={paneDrag.active && paneDrag.source?.entries.some((entry) => entry.tabId === tabId)}
                />
              </span>
            ))}
          </React.Fragment>
        )))}
        {!wrap && endInsetPx > 0 && (
          <span
            aria-hidden
            data-pane-strip-end-reserve
            style={{
              display: 'block',
              flex: `0 0 ${Math.max(0, endInsetPx)}px`,
              width: Math.max(0, endInsetPx),
              height: 1,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      <StripOverflowCount side="right" groups={overflow.right} errorCount={rightErrors} onClick={() => {
        scrollBy(1);
        focusPaneAfterHeaderClick();
      }} />

      {/* Портал по той же причине, что и у прочих меню шапки: строка низкая и
          обрезает своё содержимое. */}
      {newTabMenu && createPortal(
        <>
          {/* Подложка ловит закрывающий клик ЦЕЛИКОМ: и нажатие, и сам click.
              Только `onMouseDown` закрывал меню на нажатии, после чего click
              долетал до элемента под курсором — то есть жест, которым человек
              всего лишь убирал меню, попутно нажимал вкладку или кнопку под
              ним. */}
          <div
            data-pane-new-tab-menu-backdrop
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setNewTabMenu(null); }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setNewTabMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
          />
          <div
            ref={newTabMenuRef}
            data-pane-new-tab-menu
            role="menu"
            style={{
              ...CONTEXT_MENU_PANEL_STYLE,
              position: 'fixed',
              top: newTabMenuPos ? newTabMenuPos.y : newTabMenu.y + 4,
              left: newTabMenuPos ? newTabMenuPos.x : newTabMenu.x,
              zIndex: 9999,
              padding: '4px 0',
              background: '#242427',
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              fontSize: 12,
              color: '#ddd',
              userSelect: 'none',
            }}
          >
            {/* No window zone here: this menu already belongs to ONE window —
                the strip the user right-clicked — so "which window?" is the
                question the click has answered. */}
            <NewTabMenuRows
              rowAttributes={(action) => ({ 'data-pane-new-tab-menu-item': action })}
              onCreate={createTabHere}
            />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
