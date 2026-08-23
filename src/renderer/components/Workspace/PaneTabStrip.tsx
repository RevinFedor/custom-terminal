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
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import { groupOverflowByKind, groupStripByProject, paneStripOverflowStateKey, resolveStripOverflow, scrollOffsetForChip } from '../../utils/paneStripLayout.mjs';
import { hiddenToastCountForChips, hiddenToastOwnerCounts } from '../../utils/toastPlacement.mjs';
import PaneTabChip from './PaneTabChip';
import type { SharedTabActivityMaps } from './TabSignals';
import { TAB_COLORS, adjustRgbaAlpha } from './tabChrome';

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
          style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.65 }}
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
   * Compatibility-only: action buttons used to overlay the strip and passed a
   * guessed covered width. They are flex siblings now, so this value must not
   * participate in measurement or reveal geometry.
   */
  endInsetPx?: number;
  /** App-wide tab activity maps from Workspace; stable across workflow switches. */
  sharedActivity?: SharedTabActivityMaps | null;
}

export default function PaneTabStrip({
  entries, shownTabId, focused, paneIndex, inSplit, onCreateTab, wrap = false,
  autoReveal = false, endInsetPx = 0,
  sharedActivity = null,
}: PaneTabStripProps) {
  // Keep the old optional prop source-compatible without reviving inset math.
  void endInsetPx;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const entriesKey = entries.map((entry) => `${entry.projectId}:${entry.tabId}`).join('|');
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
  const inStrip = entries.length > 1;

  const kindOfTab = useCallback((tabId: string) => {
    const st = useWorkspaceStore.getState();
    const owner = entriesRef.current.find((e) => e.tabId === tabId)?.projectId;
    const color = owner ? st.openProjects.get(owner)?.tabs.get(tabId)?.color : undefined;
    return color && TAB_COLORS.some((c) => c.color === color && c.color !== 'default')
      ? String(color)
      : 'default';
  }, []);

  // Primitive fingerprint: colours can change while their chips are offscreen.
  const kindsKey = useWorkspaceStore((s) => entries
    .map((e) => s.openProjects.get(e.projectId)?.tabs.get(e.tabId)?.color || '-')
    .join(','));

  const measure = useCallback((): boolean => {
    const el = scrollerRef.current;
    if (!el) return false;
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
  const runs = groupStripByProject(entries);
  const indexOfTab = new Map(entries.map((entry, i) => [entry.tabId, i]));

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
    if (store.splitFocusedIndex !== paneIndex) store.focusSplitPane(paneIndex);
  };

  return (
    <div
      data-pane-tab-strip
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
        {runs.map((run, runIndex) => (
          <React.Fragment key={`${run.projectId}:${runIndex}`}>
            <StripProjectIcon projectId={run.projectId} />
            {run.tabIds.map((tabId) => (
              <span
                key={tabId}
                data-strip-item
                data-strip-tab-id={tabId}
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
                style={{ display: 'inline-flex', flexShrink: (inStrip || wrap) ? 0 : 1, minWidth: 0 }}
              >
                <PaneTabChip
                  projectId={run.projectId}
                  tabId={tabId}
                  shown={tabId === shownTabId}
                  paneFocused={focused}
                  paneIndex={paneIndex}
                  inSplit={inSplit}
                  index={indexOfTab.get(tabId) ?? 0}
                  inStrip={inStrip}
                  sharedActivity={sharedActivity}
                />
              </span>
            ))}
          </React.Fragment>
        ))}
      </div>
      <StripOverflowCount side="right" groups={overflow.right} errorCount={rightErrors} onClick={() => {
        scrollBy(1);
        focusPaneAfterHeaderClick();
      }} />
    </div>
  );
}
