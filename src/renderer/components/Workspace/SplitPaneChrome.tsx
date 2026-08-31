import React, { useEffect, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ArrowLeftRight, Columns2, LocateFixed, MoreVertical, PanelBottom, PanelLeft, PanelRightClose, PanelRightOpen, PanelTop, WrapText } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import {
  resolveSplitAttachRowHeight,
  resolveTabCardBottomOverhang,
  resolveTabCardBoxHeight,
} from '../../utils/tabCardVisual.mjs';
import {
  isEmptyPane,
  paneGridRects,
  paneTabs,
  normalizeSplitSizes,
  resizeFractions,
  splitAvailability,
  splitDividerDescriptors, splitCornerDescriptors,
} from '../../utils/splitPanesModel.mjs';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { EMPTY_TAB_NAME } from '../../utils/emptyTab.mjs';
import PaneTabStrip from './PaneTabStrip';
import MoveToWindowMenu, { WorkspaceWindowSwapPicker } from './MoveToWindowMenu';
import {
  beginWorkspaceWindowSwapPicker,
  endWorkspaceWindowSwapPicker,
  useWorkspaceWindowSwapPickerSnapshot,
} from '../../utils/workspaceWindowSwapPicker.mjs';
import GitStatusButton from './GitStatusButton';
import type { SharedTabActivityMaps } from './TabSignals';
import {
  CONTEXT_MENU_ICON_SLOT_STYLE,
  CONTEXT_MENU_METRICS_HOOK,
  CONTEXT_MENU_PANEL_STYLE,
  CONTEXT_MENU_ROW_STYLE,
} from '../UI/contextMenuMetrics.mjs';
import { useProjectsStore } from '../../store/useProjectsStore';
import { isInboxProjectId } from '../../constants/systemProjects';
import { markRendererActivity } from '../../utils/rendererActivityTrail';
import { paneResizeFreezeBox } from '../../utils/splitResizeFreeze.mjs';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

const { ipcRenderer } = window.require('electron');

/**
 * CSS-переменная, которой шапка окна сообщает свою ИЗМЕРЕННУЮ высоту.
 *
 * Всё, что лежит под шапкой, отступает на неё: `top: var(--pane-header-h, Npx)`,
 * где N — предсказание по настройкам (useSplitAttachRowHeight). Пока полоса
 * вкладок в один ряд, измеренное и предсказанное совпадают, и переменная просто
 * подтверждает число; в режиме ПЕРЕНОСА шапка выше ровно на столько строк,
 * сколько заняли чипы, и предсказать это нельзя — поэтому она и измеряется.
 *
 * Fallback в `var()` обязателен: у пустой панели своя шапка, она эту переменную
 * не ставит, и без запасного значения содержимое уехало бы под верхний край.
 */
export const PANE_HEADER_HEIGHT_VAR = '--pane-header-h';
export const splitPaneHeaderHeightVar = (paneIndex: number): string => (
  `${PANE_HEADER_HEIGHT_VAR}-${paneIndex}`
);
// The pane-index variable belongs to the CURRENT space and is removed with its
// chrome. Cache the same measured value on the singleton tab wrapper so a
// dormant surface keeps wrapped-header geometry while another space is shown.
export const TAB_SURFACE_HEADER_HEIGHT_VAR = '--tab-surface-header-height';

// Fallback height only (empty-pane header, restore paths that render before
// settings are read). Real rows size themselves from the chip via
// useSplitAttachRowHeight — a 26px constant under a Settings-sized chip is
// exactly the bug where the chip poked over the pane separator above it.
export const SPLIT_ATTACH_ROW_H = 26;

const STRIP_MENU_ACTIVE_BACKGROUND = 'rgba(34,197,94,0.13)';
const STRIP_MENU_ACTIVE_HOVER_BACKGROUND = 'rgba(34,197,94,0.2)';
const STRIP_MENU_ACTIVE_FRAME = 'inset 0 0 0 1px rgba(74,222,128,0.58)';

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
  // withPath: false — строка пути уехала из шапки в боковую панель (2026-08-20).
  return resolveSplitAttachRowHeight(tabGeo, { fontSize: tabsFontSize, withPath: false });
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
  sharedActivity?: SharedTabActivityMaps | null;
  /** Exact workflow-owned layout. Persistent chrome must not subscribe to the
   *  currently visible workflow and overwrite its dormant tab strip. */
  paneLayout?: Array<{
    projectId: string;
    tabId: string;
    column?: number;
    tabs?: Array<{ projectId: string; tabId: string }>;
  }>;
  spaceId?: string;
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

export function SplitPaneAttachRow({
  projectId,
  tabId,
  focused,
  paneIndex,
  sharedActivity = null,
  paneLayout,
  spaceId,
}: AttachRowProps) {
  const splitPanes = useWorkspaceStore((s) => paneLayout || s.splitPanes);
  const tabExists = useWorkspaceStore((s) => !!s.openProjects.get(projectId)?.tabs.get(tabId));
  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null);
  // Меню трёх точек — настройки САМОЙ ПОЛОСЫ (пока одна: перенос вкладок).
  // Отдельное от меню деления: то отвечает на вопрос «куда добавить окно»,
  // это — «как показывать вкладки», и складывать их в одно меню значило бы
  // спрятать постоянную настройку внутрь редкого действия.
  const [stripMenu, setStripMenu] = useState<{ x: number; y: number } | null>(null);
  const stripMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [stripMenuPos, setStripMenuPos] = useState<{ x: number; y: number } | null>(null);
  const stripMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  // The cross-workflow picker is a SECOND menu level. Its anchor is the row
  // that names the action, not the ellipsis that opened the root menu: keeping
  // both levels visible preserves context and also puts the picker below the
  // workflow strip instead of centring it over navigation.
  const stripSwapMenuItemRef = React.useRef<HTMLButtonElement | null>(null);
  // A persistent workflow chrome owns one space even while another is shown.
  // Returning the prop keeps dormant rows off the activeSpaceId subscriber.
  const activeSpaceId = useWorkspaceStore((s) => spaceId || s.activeSpaceId);
  const workspaceSwapPicker = useWorkspaceWindowSwapPickerSnapshot();
  const sourcePaneAddress = paneIndex ?? null;
  const ownsWorkspaceSwapPicker = workspaceSwapPicker.active
    && workspaceSwapPicker.sourceSpaceId === activeSpaceId
    && workspaceSwapPicker.sourcePaneIndex === sourcePaneAddress;
  const stripWrap = useUIStore((s) => s.paneTabStripWrap);
  const setStripWrap = useUIStore((s) => s.setPaneTabStripWrap);
  const stripAutoReveal = useUIStore((s) => s.paneTabStripAutoReveal);
  const setStripAutoReveal = useUIStore((s) => s.setPaneTabStripAutoReveal);
  const timelineTreeMode = useUIStore((s) => s.timelineTreeModeTabs[tabId] ?? false);
  const setTimelineTreeMode = useUIStore((s) => s.setTimelineTreeMode);
  const historyPinned = useUIStore((s) => s.historyPinned);
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const activeArea = useUIStore((s) => s.activeArea);
  // Scroll mode trades Git+split for horizontal tab viewport outside focus.
  // Wrap mode has no horizontal viewport to reclaim, so hiding this block buys
  // nothing and only makes stable controls blink when pane focus moves.
  const focusActionsVisible = stripWrap || (focused && activeArea !== 'sidebar');
  // Живая высота шапки. В переносе она зависит от того, сколько строк заняли
  // чипы, — то есть от ширины окна и числа вкладок, а не только от настроек
  // размеров. Публикуется РОДИТЕЛЮ переменной CSS, чтобы содержимое окна
  // отступало ровно на неё; см. PANE_HEADER_HEIGHT_VAR.
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const focusActionsRef = React.useRef<HTMLDivElement | null>(null);
  const [focusActionsWidth, setFocusActionsWidth] = useState(0);
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
  const toggleStripMenuFromButton = (button: HTMLElement) => {
    if (ownsWorkspaceSwapPicker) {
      endWorkspaceWindowSwapPicker();
      setStripMenu(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    setStripMenu((prev) => (prev ? null : { x: rect.right - 168, y: rect.bottom }));
  };

  // Git этой шапки: проект — тот, кому принадлежит показанная вкладка, путь —
  // её собственный (вкладка может сидеть в worktree). Строковые селекторы, а
  // не объекты: шапка есть у каждого окна, и селектор, отдающий объект, давал
  // бы новую ссылку на каждую запись в стор (правило Fingerprint).
  const ownerProjectId = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.tabs.has(tabId) ? projectId : ''
  ));
  const gitCwd = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || ''
  ));
  const gitProjectPath = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.projectPath || ''
  ));
  const gitProjectName = useProjectsStore((s) => s.projects[projectId]?.name || '');
  // У Inbox нет своего репозитория — вкладки там чужие, и ветка «проекта»
  // ничего не значила бы. То же исключение, что было в верхней полосе.
  const gitAvailable = !!ownerProjectId && !!gitCwd && !isInboxProjectId(projectId);

  // In scroll mode hidden focus-actions stay measurable but leave normal flex
  // layout. Their exact width becomes a trailing reserve inside PaneTabStrip.
  // Wrap mode keeps the block in flow and never consumes this reserve.
  useEffect(() => {
    const element = focusActionsRef.current;
    if (!element) return undefined;
    const accept = (width: number) => {
      const next = Math.ceil(width || 0);
      if (next <= 0) return;
      setFocusActionsWidth((previous) => previous === next ? previous : next);
    };
    if (typeof ResizeObserver === 'undefined') {
      accept(element.getBoundingClientRect().width);
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const borderBox = Array.isArray(entry?.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry?.borderBoxSize;
      accept(borderBox?.inlineSize || entry?.contentRect.width || 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [gitAvailable]);

  // The strip this header draws. A STRING selector (Fingerprint Pattern) — a
  // selector returning the entry array would allocate on every store write and
  // repaint every header in the workspace.
  const stripKey = useWorkspaceStore((s) => {
    const pane = paneIndex === null || paneIndex === undefined
      ? null
      : (paneLayout?.[paneIndex] || s.splitPanes[paneIndex]);
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

  // Двойной клик по пустому месту полосы: сюда приходит НОВАЯ ОБЫЧНАЯ вкладка.
  //
  // Обычная — значит ровно та же, что делает `Cmd+T`: живой shell, строка в
  // боковом списке, обычное сохранение и поиск. Никакого «только для окна»: у
  // вкладки, спрятанной из списка, не остаётся второго способа до неё добраться,
  // и она становилась недостижимой, как только чип уходил из полосы.
  //
  // В списке она — СОСЕД показанной здесь вкладки и встаёт после неё вместе со
  // всем, что нарисовано внутри её карточки (`visualParentTabId: ''` — явный
  // отказ от наследования родителя, по нему же считается место соседа). Не
  // ребёнок: жест «дай ещё одну ЗДЕСЬ» не значит «внутрь этой».
  //
  // Имя не автономерное: `tab-7` говорит только, что до неё было шесть.
  // «Пустая вкладка» — последний явный контракт пользователя; пустое ОКНО
  // отдельно говорит «Нет вкладки».
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
    const shownTabId = paneIndex === null || paneIndex === undefined
      ? (workspace.activeTabId || '')
      : (store.splitPanes[paneIndex]?.tabId || workspace.activeTabId || '');
    const cwd = projectPath || workspace.tabs.get(shownTabId)?.cwd || '';
    // `background` не даёт `createTab` активировать её: приход вкладки — дело
    // ПОЛОСЫ, и действие стора ниже одной записью и добавляет чип, и показывает
    // его. Активация до этого сработала бы против полосы, в которой вкладки ещё
    // нет, то есть по правилу замены — и вытеснила бы как раз тот чип, рядом с
    // которым человек просил соседа.
    const newTabId = await store.createTabAfterCurrent(owner, EMPTY_TAB_NAME, cwd, {
      skipInitialRename: true,
      background: true,
      afterTabId: shownTabId || undefined,
      visualParentTabId: '',
    });
    if (!newTabId) return;
    if (paneIndex === null || paneIndex === undefined) {
      useWorkspaceStore.getState().addTabToCenterStrip(owner, newTabId);
      return;
    }
    useWorkspaceStore.getState().addTabToSplitPaneStrip(paneIndex, owner, newTabId);
  }, [paneIndex, projectId]);

  // Used by the layout-effect dependency list below. Keep this declaration
  // above the first hook that reads it: a `const` declared after the effect is
  // still in the temporal dead zone while React evaluates `[stripWrap, rowH]`
  // (DEV 20.08: `Cannot access 'rowH' before initialization`).
  const rowH = resolveSplitAttachRowHeight(tabGeo, { fontSize: tabsFontSize, withPath: false });
  const currentHeaderTabIdRef = React.useRef(tabId);
  currentHeaderTabIdRef.current = tabId;
  const publishedHeaderHeightRef = React.useRef(rowH);
  const headerHeightBindingRef = React.useRef<{
    host: HTMLElement;
    heightVar: string;
  } | null>(null);

  // Шапка СООБЩАЕТ окну свою настоящую высоту.
  //
  // Обычно её можно предсказать по настройкам размеров (resolveSplitAttachRowHeight),
  // и всё, что стоит ниже, отступает на это число. В режиме переноса предсказать
  // нельзя: сколько строк займут чипы, зависит от ширины окна и от того, сколько
  // вкладок в него положили. Поэтому измеряем и публикуем переменной CSS на
  // самом окне — содержимое читает её, а не второе вычисление рядом.
  //
  // Пишем в DOM, а не в стор: перенос строк меняется при каждом движении
  // перегородки, и запись в стор на каждый кадр перестраивала бы все окна.
  React.useLayoutEffect(() => {
    const startedAt = performance.now();
    const el = rowRef.current;
    // Кому сообщать. Стабильные split-шапки — siblings терминальных tab-wrapper'ов,
    // поэтому публикуют pane-scoped переменную на общем TerminalArea root.
    // Одиночная шапка по-прежнему пишет обычную переменную в свой header-host.
    const heightVar = paneIndex === null || paneIndex === undefined
      ? PANE_HEADER_HEIGHT_VAR
      : splitPaneHeaderHeightVar(paneIndex);
    const host = (paneIndex === null || paneIndex === undefined
      ? (el?.closest('[data-pane-header-host]') || el?.parentElement)
      : el?.closest('[data-terminal-pane-chrome-host]')) as HTMLElement | null;
    if (!el || !host) return undefined;
    const previousBinding = headerHeightBindingRef.current;
    if (previousBinding
        && (previousBinding.host !== host || previousBinding.heightVar !== heightVar)) {
      previousBinding.host.style.removeProperty(previousBinding.heightVar);
    }
    headerHeightBindingRef.current = { host, heightVar };

    const publish = (height: number) => {
      const h = Math.ceil(height || 0);
      if (!h) return;
      publishedHeaderHeightRef.current = h;
      const cssHeight = h + 'px';
      // Inline-value comparison is not a geometry read. Apart from avoiding a
      // useless style invalidation, it keeps the pane-scoped variable stable
      // while another workflow merely retargets this pane-index chrome.
      if (host.style.getPropertyValue(heightVar) !== cssHeight) {
        host.style.setProperty(heightVar, cssHeight);
      }
      if (paneIndex !== null && paneIndex !== undefined) {
        const currentTabId = currentHeaderTabIdRef.current;
        const wrapper = document.querySelector<HTMLElement>(
          `[data-terminal-pane-wrapper="${CSS.escape(currentTabId)}"]`,
        );
        if (wrapper?.style.getPropertyValue(TAB_SURFACE_HEADER_HEIGHT_VAR) !== cssHeight) {
          wrapper?.style.setProperty(TAB_SURFACE_HEADER_HEIGHT_VAR, cssHeight);
        }
      }
    };

    // The one-row mode is known from settings and can publish immediately.
    // Wrapped height is content-driven, but reading getBoundingClientRect in
    // this layout effect made every incoming pane synchronously lay out the
    // entire workspace. Keep the last/fallback height for this commit and let
    // ResizeObserver publish the exact border box from the browser's single
    // shared layout pass before paint.
    publish(stripWrap ? (publishedHeaderHeightRef.current || rowH) : rowH);
    const syncMs = performance.now() - startedAt;
    if (syncMs >= 8) {
      console.warn('[Perf:PaneHeaderCommit] pane=' + (paneIndex ?? 'center')
        + ' wrap=' + (stripWrap ? '1' : '0')
        + ' syncMs=' + syncMs.toFixed(1));
    }
    if (!stripWrap || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const borderBox = Array.isArray(entry?.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry?.borderBoxSize;
      publish(borderBox?.blockSize || entry?.contentRect.height || 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [paneIndex, stripWrap, rowH]);

  // The pane-index chrome is stable while its shown tab changes. Copy the
  // already published height only to the newly shown tab wrapper; do not tear
  // down/recreate the inherited pane variable on the TerminalArea root.
  React.useLayoutEffect(() => {
    if (paneIndex === null || paneIndex === undefined) return;
    const h = publishedHeaderHeightRef.current || rowH;
    const wrapper = document.querySelector<HTMLElement>(
      `[data-terminal-pane-wrapper="${CSS.escape(tabId)}"]`,
    );
    const cssHeight = h + 'px';
    if (wrapper?.style.getPropertyValue(TAB_SURFACE_HEADER_HEIGHT_VAR) !== cssHeight) {
      wrapper?.style.setProperty(TAB_SURFACE_HEADER_HEIGHT_VAR, cssHeight);
    }
  }, [paneIndex, rowH, tabId]);

  // Окно переживает свою шапку (пустая панель рисует собственную): только
  // настоящий unmount pane-index chrome снимает его переменную. Смена tabId
  // больше не выглядит как unmount и не инвалидирует весь workspace.
  useEffect(() => () => {
    const binding = headerHeightBindingRef.current;
    binding?.host.style.removeProperty(binding.heightVar);
    headerHeightBindingRef.current = null;
  }, []);


  // Clamp the strip menu into the window — тем же способом, что и меню деления.
  React.useLayoutEffect(() => {
    if (!stripMenu) { setStripMenuPos(null); return; }
    const el = stripMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampMenuToViewport({
      x: stripMenu.x,
      y: stripMenu.y + 4,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setStripMenuPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
  }, [stripMenu]);

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
  const seamH = resolveTabCardBottomOverhang(tabGeo);
  // Высота ОДНОГО чипа. Кнопки окна равняются по ней, а не по всей шапке: в
  // переносе шапка выше на столько строк, сколько заняли вкладки, и кнопка
  // ростом со всю шапку стала бы вертикальной колонкой рядом с ними.
  const chipH = resolveTabCardBoxHeight(tabGeo, { fontSize: tabsFontSize });
  const hiddenFocusReservePx = focusActionsVisible || focusActionsWidth <= 0
    ? 0
    : focusActionsWidth + 2;
  return (
    <div
      ref={rowRef}
      data-split-attach-row
      data-focused={focused ? 'true' : undefined}
      data-strip-wrap={stripWrap ? '1' : undefined}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        // В переносе высота — СЛЕДСТВИЕ раскладки, а не настройка: сколько
        // строк заняли чипы, столько шапка и занимает. Поэтому здесь минимум,
        // а точное число измеряется и публикуется окну (см. эффект выше).
        ...(stripWrap ? { minHeight: rowH } : { height: rowH }),
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
    <div style={{
      display: 'flex',
      // В переносе строки чипов заполняются сверху вниз, и кнопки окна стоят у
      // ПЕРВОЙ строки, а не по центру выросшей коробки.
      alignItems: stripWrap ? 'flex-start' : 'center',
      gap: 6,
      minWidth: 0,
      position: 'relative',
    }}>
      {/* The strip: project icon per RUN of same-project chips, then the chips.
          The icon labels a run rather than riding on every chip — with one icon
          per chip it sits BETWEEN two of them and it is unreadable which of the
          two it belongs to. */}
      <PaneTabStrip
        entries={entries}
        shownTabId={tabId}
        focused={focused}
        paneIndex={paneIndex ?? null}
        inSplit={inSplit}
        onCreateTab={createTabInThisWindow}
        wrap={stripWrap}
        autoReveal={stripAutoReveal}
        endInsetPx={hiddenFocusReservePx}
        sharedActivity={sharedActivity}
      />

      {/* Действия окна — один flex-ряд у правого края, сосед scroller'а. Сам ряд
          живёт всегда, потому что `⋮` живёт всегда. Focus-блок Git+split вне
          фокуса снимается из flex-layout ТОЛЬКО в scroll-режиме, но его ширина
          превращается в невидимый trailing reserve ВНУТРИ scroll-content.
          Поэтому чёрной коробки нет, а правый scroll-anchor не прыгает. В
          переносе строк блок всегда в потоке: горизонтального scroll-space там
          всё равно нет.

          Внутри ряда — два РАЗНЫХ по смыслу блока:
            • Git + деление — про рабочее место. В scroll-режиме они принадлежат
              фокусу; в wrap-режиме видны у каждого окна, потому что их место
              нельзя превратить в дополнительный горизонтальный viewport;
            • три точки — про саму полосу вкладок («как их показывать»), и это
              вопрос к любому окну, а не только к рабочему. Видимы всегда и
              стоят последними, замыкая правый край. */}
      <div
        data-split-pane-actions
        style={{
          // В ПОТОКЕ, а не слоем поверх полосы (2026-08-20, вторая итерация).
          // Слой поверх давал три бага разом: чип уезжал ПОД кнопки («вкладка
          // должна оканчиваться там, где начинается компонент гита»), колесо
          // полосы молчало — её scrollWidth ≤ clientWidth, потому что
          // clientWidth включал закрытую кнопками часть, и полоса «думала»,
          // что прокручивать нечего, — а подложка рисовала вторую вертикальную
          // границу с отступом слева от собственной рамки Git. Юзер: «он,
          // наверное, всегда должен быть блочным, по логике».
          //
          // Ряд — обычный сосед полосы: не сжимается, чипы заканчиваются на
          // его левом крае, видимой области полосы соответствует её clientWidth
          // без поправок. В scroll-режиме фокус меняет состав внутреннего ряда;
          // в wrap-режиме ряд стабилен. `⋮` и сам внешний ряд остаются.
          position: 'relative',
          flexShrink: 0,
          // Ростом с ОДИН чип: в переносе шапка выше на столько строк, сколько
          // заняли чипы, и кнопки во всю её высоту стали бы колонкой.
          height: chipH,
          display: 'flex',
          // Кнопки — РОСТОМ С ЧИП, как вкладки рядом: своя высота внутри более
          // высокой строки оставляла воздух, и подсветка при наведении вставала
          // отдельной коробкой посреди шапки.
          alignItems: 'stretch',
          gap: 2,
        }}
      >

      {/* Git — рядом с кнопкой деления, слева от неё.
          Он следует за директорией ПОКАЗАННОЙ ЗДЕСЬ вкладки, а не активной: в
          верхней полосе Git отвечал про одну вкладку на всё приложение, и с
          несколькими окнами это стало враньём — в каждом окне может быть свой
          worktree и своя ветка. Теперь на вопрос «какая тут ветка» отвечает та
          шапка, над которой человек и смотрит.
          `projectPath` остаётся ПРОЕКТНЫМ: он опознаёт сохранённое состояние
          панели и список репозиториев. Подменить его путём вкладки значило бы
          пересоздавать панель на каждое переключение и стирать наполовину
          написанное сообщение коммита. */}
      {/* Git + деление — ОДИН блок рабочего места. В scroll-режиме он
          принадлежит фокусу: вне фокуса не виден и не резервирует чёрную
          layout-коробку. В wrap-режиме он всегда visible/relative, потому что
          освобождённая ширина не создаёт больше места — чипы всё равно идут на
          следующую строку. */}
      <div
        ref={focusActionsRef}
        data-split-pane-focus-actions
        data-wrap-pinned={stripWrap ? '1' : undefined}
        data-visible={focusActionsVisible ? '1' : '0'}
        aria-hidden={!focusActionsVisible}
        inert={!focusActionsVisible}
        style={{
          display: 'flex',
          position: focusActionsVisible ? 'relative' : 'absolute',
          ...(focusActionsVisible ? null : { right: '100%', top: 0 }),
          visibility: focusActionsVisible ? 'visible' : 'hidden',
          alignItems: 'stretch',
          alignSelf: 'stretch',
          gap: 2,
          flexShrink: 0,
          opacity: focusActionsVisible ? 1 : 0,
          pointerEvents: focusActionsVisible ? 'auto' : 'none',
        }}
      >
      {gitAvailable && (
        // `data-split-button` — тот же признак, что у кнопки деления.
        // Высота — ОТ РЯДА, а не своя: `height: 20` внутри более высокой
        // строки оставлял по паре пикселей воздуха сверху и снизу, и рамка
        // чипа Git читалась как ещё одна вложенная коробка рядом с рамкой
        // самого ряда. Теперь кнопка занимает всю доступную высоту, как чипы
        // вкладок слева.
        <div data-split-button style={{ display: 'flex', alignItems: 'stretch', alignSelf: 'stretch', borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
          <GitStatusButton
            projectId={ownerProjectId}
            projectName={gitProjectName}
            projectPath={gitProjectPath}
            tabCwd={gitCwd}
          />
        </div>
      )}

      {/* Split remains mounted and visible in every pane. `splitCan` changes
          only whether the action is available; it never changes geometry. */}
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
          // Открываем ВСЕГДА. Раньше меню было целиком про «куда добавить
          // панель» и молчало, когда добавлять уже некуда; теперь его первый
          // пункт — обмен местами между существующими окнами, и он от этого
          // запрета не зависит. Недоступные направления гасятся внутри меню.
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
          width: 22,
          // Та же высота, что у соседей по ряду: подсветка при наведении
          // обязана совпасть с их границами, иначе кнопка выглядит вложенным
          // блоком внутри шапки.
          alignSelf: 'stretch',
          padding: 0,
          borderRadius: 4,
          cursor: (splitCan.horizontal || splitCan.vertical) ? 'pointer' : 'not-allowed',
          background: 'transparent',
          border: 'none',
          // Dimmed, not gone: the control keeps its place in the row so the
          // header layout never shifts when the last slot is taken.
          color: (splitCan.horizontal || splitCan.vertical) ? '#8f8f94' : '#4a4a4e',
          flexShrink: 0,
          // Свои хиты — на кнопке, а не на слое-подложке: см. комментарий там.
          pointerEvents: 'auto',
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
      {/* Три точки — меню САМОЙ ПОЛОСЫ вкладок. Она про полосу целиком («как
          показывать вкладки»), а это вопрос к ЛЮБОМУ окну, а не только к
          рабочему, — поэтому кнопка видима всегда и стоит последней, замыкая
          правый край.

          Коробка идёт во всю высоту ряда и до самого края шапки. Её ширина —
          та же, что у вертикального Timeline rail под ней: их левые границы
          образуют одну линию. Отрицательный отступ съедает поле шапки, чтобы
          правая граница кнопки совпала с правой границей окна. */}
      <button
        ref={stripMenuButtonRef}
        data-split-strip-menu-button
        title="Меню полосы вкладок"
        aria-label="Меню полосы вкладок"
        aria-haspopup="menu"
        aria-expanded={!!stripMenu || ownsWorkspaceSwapPicker}
        onClick={(e) => {
          e.stopPropagation();
          toggleStripMenuFromButton(e.currentTarget as HTMLElement);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleStripMenuFromButton(e.currentTarget as HTMLElement);
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.button !== 0) e.preventDefault();
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Квадрат той же меры, что сам chip/header row. 32px Timeline-slot
          // делал кнопку шире собственной высоты и оставлял ощущение отдельной
          // правой панели вместо последнего действия полосы.
          width: chipH,
          alignSelf: 'stretch',
          // До самого края: поле шапки (8px) съедается, иначе справа остаётся
          // полоска, которая выглядит частью кнопки, но ею не является.
          marginRight: -8,
          padding: 0,
          borderRadius: 4,
          cursor: 'pointer',
          background: (stripMenu || ownsWorkspaceSwapPicker) ? 'rgba(255,255,255,0.10)' : 'transparent',
          border: 'none',
          color: (stripMenu || ownsWorkspaceSwapPicker) ? '#eee' : '#8f8f94',
          flexShrink: 0,
          pointerEvents: 'auto',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)';
          (e.currentTarget as HTMLElement).style.color = '#eee';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = (stripMenu || ownsWorkspaceSwapPicker) ? 'rgba(255,255,255,0.10)' : 'transparent';
          (e.currentTarget as HTMLElement).style.color = (stripMenu || ownsWorkspaceSwapPicker) ? '#eee' : '#8f8f94';
        }}
      >
        <MoreVertical size={13} />
      </button>
      </div>
      </div>

      {/* Строки пути здесь больше нет (2026-08-20): она занимала целую строку
          шапки под КАЖДЫМ окном ради подписи, которая нужна изредка. Путь
          показанной вкладки теперь стоит в боковой панели, под инструментами
          проекта (TabSidebar) — там же, откуда открываются файлы проекта. */}
      {/* Меню полосы вкладок. Портал по той же причине, что и у меню деления:
          шапка низкая и обрезает своё содержимое. */}
      {stripMenu && createPortal(
        <>
          <div
            data-split-strip-menu-backdrop
            onMouseDown={() => setStripMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setStripMenu(null); }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9998,
              // While the second level is pinned, workflow chips are part of
              // the picker itself. Let their real clicks pass through; the
              // picker's capture listener still closes both menus everywhere
              // except the workflow strip and the two menu panels.
              pointerEvents: ownsWorkspaceSwapPicker ? 'none' : 'auto',
            }}
          />
          <div
            ref={stripMenuRef}
            data-split-strip-menu
            role="menu"
            style={{
              position: 'fixed',
              top: stripMenuPos ? stripMenuPos.y : stripMenu.y + 4,
              left: stripMenuPos ? stripMenuPos.x : stripMenu.x,
              zIndex: 9999,
              minWidth: 168,
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
            {/* Click-pinned, unlike hover submenus: after opening, workflow
                chips become scope selectors and the user must be able to move
                the pointer through the rest of the application. The ellipsis
                suffix promises a second explicit choice instead of a hover
                chevron. */}
            <button
              ref={stripSwapMenuItemRef}
              type="button"
              data-split-strip-menu-item="swap-workspace-window"
              data-context-menu-row="ordinary"
              aria-haspopup="dialog"
              aria-expanded={ownsWorkspaceSwapPicker}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (ownsWorkspaceSwapPicker) return;
                beginWorkspaceWindowSwapPicker({
                  sourceSpaceId: activeSpaceId,
                  sourcePaneIndex: sourcePaneAddress,
                });
              }}
              style={{
                ...CONTEXT_MENU_ROW_STYLE,
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                border: 0,
                background: ownsWorkspaceSwapPicker ? STRIP_MENU_ACTIVE_BACKGROUND : 'transparent',
                boxShadow: ownsWorkspaceSwapPicker ? STRIP_MENU_ACTIVE_FRAME : 'none',
                color: '#ddd',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = ownsWorkspaceSwapPicker
                  ? STRIP_MENU_ACTIVE_HOVER_BACKGROUND
                  : 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = ownsWorkspaceSwapPicker
                  ? STRIP_MENU_ACTIVE_BACKGROUND
                  : 'transparent';
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={CONTEXT_MENU_ICON_SLOT_STYLE}>
                  <ArrowLeftRight size={13} style={{ color: '#9a9aa0' }} />
                </span>
                <span style={{ whiteSpace: 'nowrap' }}>Поменять местами</span>
              </span>
              <span aria-hidden style={{ color: '#777', paddingLeft: 8 }}>…</span>
            </button>
            <div
              data-split-strip-menu-item="wrap"
              role="menuitemcheckbox"
              aria-checked={stripWrap}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (ownsWorkspaceSwapPicker) endWorkspaceWindowSwapPicker();
                setStripWrap(!stripWrap);
                setStripMenu(null);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 12px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: stripWrap ? STRIP_MENU_ACTIVE_BACKGROUND : 'transparent',
                boxShadow: stripWrap ? STRIP_MENU_ACTIVE_FRAME : 'none',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = stripWrap
                  ? STRIP_MENU_ACTIVE_HOVER_BACKGROUND
                  : 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = stripWrap
                  ? STRIP_MENU_ACTIVE_BACKGROUND
                  : 'transparent';
              }}
            >
              <WrapText size={13} style={{ flexShrink: 0, color: '#9a9aa0' }} />
              Перенос вкладок
            </div>
            <div
              data-split-strip-menu-item="auto-reveal"
              role="menuitemcheckbox"
              aria-checked={stripAutoReveal}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (ownsWorkspaceSwapPicker) endWorkspaceWindowSwapPicker();
                setStripAutoReveal(!stripAutoReveal);
                setStripMenu(null);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 12px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: stripAutoReveal ? STRIP_MENU_ACTIVE_BACKGROUND : 'transparent',
                boxShadow: stripAutoReveal ? STRIP_MENU_ACTIVE_FRAME : 'none',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = stripAutoReveal
                  ? STRIP_MENU_ACTIVE_HOVER_BACKGROUND
                  : 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = stripAutoReveal
                  ? STRIP_MENU_ACTIVE_BACKGROUND
                  : 'transparent';
              }}
            >
              <LocateFixed size={13} style={{ flexShrink: 0, color: '#9a9aa0' }} />
              Показывать выбранную
            </div>
            <div
              data-split-strip-menu-item="timeline"
              role="menuitemcheckbox"
              aria-checked={timelineTreeMode}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const nextOpen = !timelineTreeMode;
                if (nextOpen && !historyPinned) setHistoryPanelOpen(tabId, false);
                setTimelineTreeMode(tabId, nextOpen);
                setStripMenu(null);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 12px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: timelineTreeMode ? STRIP_MENU_ACTIVE_BACKGROUND : 'transparent',
                boxShadow: timelineTreeMode ? STRIP_MENU_ACTIVE_FRAME : 'none',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = timelineTreeMode
                  ? STRIP_MENU_ACTIVE_HOVER_BACKGROUND
                  : 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = timelineTreeMode
                  ? STRIP_MENU_ACTIVE_BACKGROUND
                  : 'transparent';
              }}
            >
              {timelineTreeMode
                ? <PanelRightClose size={13} style={{ flexShrink: 0, color: '#9a9aa0' }} />
                : <PanelRightOpen size={13} style={{ flexShrink: 0, color: '#9a9aa0' }} />}
              Timeline
            </div>
          </div>
        </>,
        document.body,
      )}

      {ownsWorkspaceSwapPicker && (
        <WorkspaceWindowSwapPicker
          anchorRef={stripSwapMenuItemRef}
          parentRef={stripMenuRef}
          onDone={() => setStripMenu(null)}
        />
      )}

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
            data-context-menu-metrics={CONTEXT_MENU_METRICS_HOOK}
            style={{
              ...CONTEXT_MENU_PANEL_STYLE,
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
              padding: '4px 0',
              background: '#242427',
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              fontSize: 12,
              color: '#ddd',
              userSelect: 'none',
            }}
          >
            {/* «Поменять местами» uses the same complete row + hover flyout as
                “Move to window”. Only the selection action differs: whole
                window contents are swapped. */}
            {inSplit && paneIndex !== null && paneIndex !== undefined && (
              <MoveToWindowMenu
                mode="swap"
                sourcePaneIndex={paneIndex}
                onDone={() => setSplitMenu(null)}
              />
            )}
            {/* Icon + one word. The verb lives on the button that opened this
                menu; repeating it in both rows made the reader compare two long
                strings to find the single word that differs. The panel icons
                show the shape of the result, so the word only has to name the
                side. */}
            {([
              { side: 'left' as const, label: 'Слева', Icon: PanelLeft, enabled: splitCan.horizontal },
              { side: 'above' as const, label: 'Сверху', Icon: PanelTop, enabled: splitCan.vertical },
              { side: 'below' as const, label: 'Снизу', Icon: PanelBottom, enabled: splitCan.vertical },
            ]).map(({ side, label, Icon, enabled }) => (
              <button
                type="button"
                key={side}
                data-split-direction-item={side}
                data-context-menu-row="ordinary"
                onMouseDown={(e) => e.stopPropagation()}
                title={enabled ? undefined : 'Сначала выберите вкладку для пустой панели'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!enabled) return;
                  setSplitMenu(null);
                  if (side === 'left') {
                    useWorkspaceStore.getState().addEmptySplitPane(paneIndex ?? null, 'left');
                  } else {
                    useWorkspaceStore.getState().addVerticalSplitPane(paneIndex ?? null, side);
                  }
                }}
                style={{
                  ...CONTEXT_MENU_ROW_STYLE,
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  // Недоступное направление ГАСНЕТ, а не исчезает: пропавший
                  // пункт читается как поломка, погашенный — называет правило.
                  cursor: enabled ? 'pointer' : 'not-allowed',
                  color: enabled ? undefined : '#6a6a70',
                }}
                onMouseEnter={(e) => {
                  if (!enabled) return;
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)';
                }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={CONTEXT_MENU_ICON_SLOT_STYLE}>
                  <Icon size={13} style={{ color: enabled ? '#9a9aa0' : '#5f5f65' }} />
                </span>
                {label}
              </button>
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
 * Ярче двух боковых линий соседа (0.08) и заметно тише рамки фокуса (0.75):
 * достаточно, чтобы читаться рядом с ней на общем шве, и недостаточно, чтобы
 * спутать с самим фокусом. Было 0.20 — на шве с окном в фокусе такая линия
 * терялась (см. globals.css: рамки соседей лежат в РАЗНЫХ пиксельных колонках,
 * поэтому спор решается только яркостью).
 */
export const SPLIT_PANE_HOVER_RING = 'inset 0 0 0 1px rgba(255,255,255,0.42)';

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
        transition: 'none',
      }}
    />
  );
}

// ── Resizable dividers ────────────────────────────────────────────────────

/** 6px violet strip centred on the 1px boundary — same feel as the TabSidebar
 *  handle, and the same violet: violet already means "drag me" here. */
/**
 * ВСЕ слои одного окна, которые живут его прямоугольником.
 *
 * Окно нарисовано не одним узлом: отдельно поверхность вкладки (терминал,
 * переписка) и отдельно — СТАБИЛЬНАЯ шапка с рамкой фокуса. Их разделили
 * намеренно: шапка не должна перемонтироваться при смене показанного чипа.
 *
 * Но во время перетаскивания перегородки двигали только поверхность, и рамка с
 * шапкой оставались на СТАРОЙ границе. На экране это читалось как вторая,
 * призрачная перегородка: одна линия едет за курсором, другая стоит там, где
 * граница была до нажатия, — и обе нарисованы по-настоящему. Слоями это не
 * лечится: обе линии настоящие, просто описаны разными числами.
 *
 * Поэтому геометрия окна применяется ОДНИМ снимком ко всем его слоям сразу.
 */
const PANE_GEOMETRY_LAYER_SELECTOR = [
  '[data-terminal-pane-wrapper][data-pane-event-index]',
  '[data-terminal-pane-chrome-host][data-split-pane-index]',
].join(',');

type PaneResizeFreeze = {
  count: number;
  release: () => void;
};

/**
 * Freeze the heavy pane content at its grab-time pixel box.
 *
 * Moving the outer wrapper alone is not a cheap preview: width/height changes
 * still wake History/Virtuoso, composer measurements and xterm ResizeObserver
 * on every mousemove. The wrapper follows the pointer, but its heavy child
 * keeps the old containing block until the final store commit.
 *
 * All geometry reads finish before the first style write, so capture cannot
 * alternate forced layout and mutation across panes. Release restores only
 * properties owned here; presentation/focus and History styles keep their
 * existing owners.
 */
function freezePaneContentsForResize(host: HTMLElement): PaneResizeFreeze {
  const measurements = Array.from(host.querySelectorAll<HTMLElement>(
    '[data-terminal-pane-wrapper][data-pane-event-index]',
  )).map((wrapper) => {
    const content = wrapper.querySelector<HTMLElement>('[data-terminal-pane-content]');
    if (!content) return null;
    const wrapperRect = wrapper.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const box = paneResizeFreezeBox(wrapperRect, contentRect);
    if (!box) return null;
    return {
      wrapper,
      content,
      box,
      previous: {
        wrapperOverflow: wrapper.style.overflow,
        wrapperFrozen: wrapper.getAttribute('data-split-resize-frozen'),
        contentFrozen: content.getAttribute('data-split-resize-content-frozen'),
        left: content.style.left,
        top: content.style.top,
        right: content.style.right,
        bottom: content.style.bottom,
        width: content.style.width,
        height: content.style.height,
      },
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  measurements.forEach(({ wrapper, content, box }) => {
    wrapper.setAttribute('data-split-resize-frozen', '1');
    wrapper.style.overflow = 'clip';
    content.setAttribute('data-split-resize-content-frozen', '1');
    content.style.left = `${box.left}px`;
    content.style.top = `${box.top}px`;
    content.style.right = 'auto';
    content.style.bottom = 'auto';
    content.style.width = `${box.width}px`;
    content.style.height = `${box.height}px`;
  });

  let released = false;
  return {
    count: measurements.length,
    release: () => {
      if (released) return;
      released = true;
      measurements.forEach(({ wrapper, content, previous }) => {
        wrapper.style.overflow = previous.wrapperOverflow;
        if (previous.wrapperFrozen === null) wrapper.removeAttribute('data-split-resize-frozen');
        else wrapper.setAttribute('data-split-resize-frozen', previous.wrapperFrozen);
        if (previous.contentFrozen === null) content.removeAttribute('data-split-resize-content-frozen');
        else content.setAttribute('data-split-resize-content-frozen', previous.contentFrozen);
        content.style.left = previous.left;
        content.style.top = previous.top;
        content.style.right = previous.right;
        content.style.bottom = previous.bottom;
        content.style.width = previous.width;
        content.style.height = previous.height;
      });
    },
  };
}

function applyPaneGeometryToDom(
  host: HTMLElement,
  panes: Array<{ projectId: string; tabId: string; column?: number }>,
  sizes: { cols: number[]; rows: number[][] } | null,
) {
  const rects = paneGridRects(panes, sizes);
  host.querySelectorAll<HTMLElement>(PANE_GEOMETRY_LAYER_SELECTOR).forEach((el) => {
    const idx = Number(
      el.getAttribute('data-pane-event-index')
      ?? el.getAttribute('data-split-pane-index'),
    );
    const rect = rects[idx];
    if (!rect) return;
    el.style.left = `${rect.leftPct}%`;
    el.style.width = `${rect.widthPct}%`;
    el.style.top = `${rect.topPct}%`;
    el.style.height = `${rect.heightPct}%`;
  });
}

const SPLIT_DIVIDER_VISUAL_PX = 6;
/**
 * Насколько зона захвата ШИРЕ видимой полоски, с каждой стороны.
 *
 * Поймать границу мышью и увидеть её — разные задачи с разными правильными
 * размерами: полоска толщиной с прицел выглядит грубо, а прицел толщиной с
 * полоску заставляет целиться. Поэтому это два числа, и растёт только зона:
 * подсветка при наведении рисуется внутренней полоской прежней ширины, так что
 * на экране не меняется ничего. Юзер: *«визуально всё должно быть идентично, но
 * область срабатывания увеличь на пару пикселей»*.
 */
const SPLIT_DIVIDER_HIT_GROW_PX = 2;
const SPLIT_DIVIDER_HIT_PX = SPLIT_DIVIDER_VISUAL_PX + SPLIT_DIVIDER_HIT_GROW_PX * 2;
const SPLIT_DIVIDER_HOVER_BG = 'rgba(99,102,241,0.4)';

/** Подсветка живёт на ВНУТРЕННЕЙ полоске, а не на всей зоне захвата. */
const paintDivider = (strip: HTMLElement | null | undefined, on: boolean) => {
  const visual = strip?.firstElementChild as HTMLElement | null;
  if (visual) visual.style.background = on ? SPLIT_DIVIDER_HOVER_BG : '';
};

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
  // Уголки рисуются только у окна В ФОКУСЕ (см. splitCornerDescriptors — там
  // почему), поэтому слой следит и за фокусом.
  const focusedIndex = useWorkspaceStore((s) => s.splitFocusedIndex);
  const [liveSizes, setLiveSizes] = useState<LiveSizes | null>(null);
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const liveRef = React.useRef<LiveSizes | null>(null);
  // The strip's violet is managed by HAND (mouseenter/leave + drag), never by
  // the style prop: this layer re-renders on every drag move to keep the strip
  // under the pointer, and a React-managed background would be wiped by each
  // of those renders the moment the prop reads undefined.
  const draggingIdRef = React.useRef<string | null>(null);
  const cancelDragRef = React.useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDragRef.current?.(), []);

  // A pane write mid-drag (tab closed elsewhere, project closed — pane
  // HISTORY purges rewrite the array too) invalidates both the in-flight
  // fractions and the grab-time baseline: cancel, and put the wrappers back
  // on the COMMITTED geometry ourselves. The memo cannot be relied on for
  // that — a same-tabIds write (history purge) changes neither its key nor
  // the sizes fingerprint, so nothing else would ever repaint the wrappers
  // out of their mid-drag positions.
  useEffect(() => {
    if (!cancelDragRef.current && !liveRef.current) return;
    if (cancelDragRef.current) {
      cancelDragRef.current();
      return;
    }
    liveRef.current = null;
    setLiveSizes(null);
    const host = layerRef.current?.parentElement;
    if (!host || panes.length < 2) return;
    applyPaneGeometryToDom(host, panes, useWorkspaceStore.getState().splitSizes);
  }, [panes]);

  if (panes.length < 2) return null;
  const sizes = liveSizes ?? committedSizes;
  const dividers = splitDividerDescriptors(panes, sizes);
  if (dividers.length === 0) return null;
  const corners = splitCornerDescriptors(panes, focusedIndex, sizes);

  // Reposition the pane wrappers straight in the DOM — the exact styles the
  // memo would write, minus the memo. Wrapper lookup by the pane-index attr
  // works because the wrappers are SIBLINGS of this layer in the same host.
  const applyLiveGeometry = (next: LiveSizes) => {
    const host = layerRef.current?.parentElement;
    if (!host) return;
    applyPaneGeometryToDom(host, panes, next);
  };

  // Обе перегородки описываются парой (колоночная? какая строчная?), и уголок —
  // это просто divider с ДВУМЯ осями сразу: та же математика resizeFractions,
  // дважды за ход. Отдельного «диагонального» пути нет — иначе клампы минимума
  // разошлись бы с одиночными перегородками.
  type DragAxes = {
    id: string;
    col?: { dividerIndex: number };
    row?: { columnIndex: number; dividerIndex: number };
    cursor: string;
  };
  const startDrag = (e: React.MouseEvent, axes: DragAxes) => {
    if (e.button !== 0) return;
    e.preventDefault();
    cancelDragRef.current?.();
    const layer = layerRef.current;
    const strip = e.currentTarget as HTMLElement;
    if (!layer) return;
    const hostRect = layer.getBoundingClientRect();
    if (hostRect.width === 0 || hostRect.height === 0) return;
    const dragStartedAt = performance.now();
    const endActivityMark = markRendererActivity('split-resize:' + axes.id);
    const host = layer.parentElement;
    const freeze = host
      ? freezePaneContentsForResize(host)
      : { count: 0, release: () => {} };
    const captureMs = performance.now() - dragStartedAt;
    let activityEnded = false;
    const endActivity = () => {
      if (activityEnded) return;
      activityEnded = true;
      endActivityMark();
    };
    let moveCount = 0;
    const startX = e.clientX;
    const startY = e.clientY;
    // Drag math runs against the sizes AT GRAB TIME (normalized to the current
    // structure), so the min-size clamp never accumulates across moves.
    const base = normalizeSplitSizes(panes, sizes) as LiveSizes;
    draggingIdRef.current = axes.id;
    paintDivider(strip, true);
    console.warn('[Perf:SplitResize] phase=start id=' + axes.id
      + ' panes=' + panes.length
      + ' frozen=' + freeze.count
      + ' captureMs=' + captureMs.toFixed(1));
    const onMove = (ev: MouseEvent) => {
      const moveStartedAt = performance.now();
      let cols = base.cols;
      let rows = base.rows;
      if (axes.col) {
        const deltaFr = (ev.clientX - startX) / hostRect.width;
        cols = resizeFractions(base.cols, axes.col.dividerIndex, deltaFr);
      }
      if (axes.row) {
        // Columns are full height, so a row's fraction is of the host height.
        const deltaFr = (ev.clientY - startY) / hostRect.height;
        rows = base.rows.map((r, c) => (
          c === axes.row!.columnIndex ? resizeFractions(r, axes.row!.dividerIndex, deltaFr) : r
        ));
      }
      const next: LiveSizes = { cols, rows };
      liveRef.current = next;
      setLiveSizes(next); // repositions the strips (this thin layer only)
      applyLiveGeometry(next); // repositions the pane wrappers, no store write
      moveCount += 1;
      if (moveCount === 1) {
        console.warn('[Perf:SplitResize] phase=first-move id=' + axes.id
          + ' handlerMs=' + (performance.now() - moveStartedAt).toFixed(1)
          + ' frozen=' + freeze.count);
      }
    };
    const onWindowBlur = () => cancelDragRef.current?.();
    const stopListening = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onWindowBlur);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      draggingIdRef.current = null;
      cancelDragRef.current = null;
      if (!strip.matches(':hover')) paintDivider(strip, false);
    };
    const onUp = () => {
      stopListening();
      const releaseStartedAt = performance.now();
      const finalSizes = liveRef.current;
      liveRef.current = null;
      // ONE store write per finished drag. The memo then repaints the wrappers
      // from the same fractions the DOM already shows. Commit React's final
      // geometry WHILE the heavy content is still frozen; then release the
      // pixel box in the same task. The browser therefore sees one final
      // layout, not an imperative resize followed by a second React resize.
      try {
        flushSync(() => {
          setLiveSizes(null);
          // A clean click (no move) commits nothing, which is what lets
          // dblclick below mean "reset" without the two mousedowns fighting it.
          if (finalSizes) useWorkspaceStore.getState().commitSplitSizes(finalSizes);
        });
      } finally {
        freeze.release();
        endActivity();
      }
      console.warn('[Perf:SplitResize] phase=release id=' + axes.id
        + ' moves=' + moveCount
        + ' dragMs=' + (performance.now() - dragStartedAt).toFixed(1)
        + ' releaseMs=' + (performance.now() - releaseStartedAt).toFixed(1)
        + ' frozen=' + freeze.count
        + ' committed=' + (finalSizes ? '1' : '0'));
    };
    cancelDragRef.current = () => {
      stopListening();
      liveRef.current = null;
      setLiveSizes(null);
      const current = useWorkspaceStore.getState();
      const currentHost = layerRef.current?.parentElement;
      if (currentHost && current.splitPanes.length >= 2) {
        applyPaneGeometryToDom(currentHost, current.splitPanes, current.splitSizes);
      }
      freeze.release();
      endActivity();
      console.warn('[Perf:SplitResize] phase=cancel id=' + axes.id
        + ' moves=' + moveCount
        + ' frozen=' + freeze.count);
    };
    document.body.style.cursor = axes.cursor;
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onWindowBlur);
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
          onMouseDown={(e) => startDrag(e, d.kind === 'col'
            ? { id: d.id, col: { dividerIndex: d.dividerIndex }, cursor: 'col-resize' }
            : { id: d.id, row: { columnIndex: d.columnIndex, dividerIndex: d.dividerIndex }, cursor: 'row-resize' })}
          // Double-click = back to the equal split, all dividers at once.
          // (Micro-jitter between the two clicks is harmless: a near-equal
          // drag packs to null anyway — see EQUAL_EPS in the model.)
          onDoubleClick={() => useWorkspaceStore.getState().commitSplitSizes(null)}
          onMouseEnter={(e) => { paintDivider(e.currentTarget as HTMLElement, true); }}
          onMouseLeave={(e) => {
            if (draggingIdRef.current !== d.id) paintDivider(e.currentTarget as HTMLElement, false);
          }}
          style={{
            position: 'absolute',
            pointerEvents: 'auto',
            // Прозрачная зона захвата: она шире видимой полоски и сама ничего
            // не рисует.
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            ...(d.kind === 'col'
              ? {
                left: `calc(${d.xPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
                top: 0,
                bottom: 0,
                width: SPLIT_DIVIDER_HIT_PX,
                cursor: 'col-resize',
                flexDirection: 'row' as const,
              }
              : {
                top: `calc(${d.yPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
                left: `${d.leftPct}%`,
                width: `${d.widthPct}%`,
                height: SPLIT_DIVIDER_HIT_PX,
                cursor: 'row-resize',
                flexDirection: 'column' as const,
              }),
          }}
        >
          {/* Видимая полоска — прежних 6px по центру зоны. Первый ребёнок:
              подсветку красит `paintDivider`, который её так и находит. */}
          <span
            aria-hidden
            data-split-divider-visual
            style={{
              flexShrink: 0,
              ...(d.kind === 'col'
                ? { width: SPLIT_DIVIDER_VISUAL_PX, alignSelf: 'stretch' }
                : { height: SPLIT_DIVIDER_VISUAL_PX, alignSelf: 'stretch' }),
            }}
          />
        </div>
      ))}
      {/* Уголки фокусного окна: квадрат-зона на пересечении двух перегородок,
          тянет обе сразу. Лежит ПОСЛЕ перегородок — при наложении зон угол
          выигрывает, иначе он был бы недостижим: любой его пиксель принадлежит
          и вертикальной, и горизонтальной зоне. Ничего не рисует — курсор
          nwse/nesw и есть весь его язык, как у углов окон в ОС. */}
      {corners.map((corner) => (
        <div
          key={corner.id}
          data-split-corner={corner.id}
          onMouseDown={(e) => startDrag(e, {
            id: corner.id,
            col: { dividerIndex: corner.colDividerIndex },
            row: { columnIndex: corner.rowColumnIndex, dividerIndex: corner.rowDividerIndex },
            cursor: corner.cursor,
          })}
          style={{
            position: 'absolute',
            pointerEvents: 'auto',
            left: `calc(${corner.xPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
            top: `calc(${corner.yPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
            width: SPLIT_DIVIDER_HIT_PX,
            height: SPLIT_DIVIDER_HIT_PX,
            cursor: corner.cursor,
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
