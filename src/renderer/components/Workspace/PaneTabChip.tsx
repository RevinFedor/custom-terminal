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
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { centerUnderPointer } from '@atlaskit/pragmatic-drag-and-drop/element/center-under-pointer';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
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
  resolveTabCompletionNotificationShadow,
  TabCompletionNotificationAlert,
  TabProcessBar,
  TabSessionAvailabilityMarker,
  TabStatusMarkerButton,
  TabTopLeftSignals,
  TabTaskMarker,
  TASK_MARKER_GAP_PX,
  TASK_MARKER_LANE_HEIGHT_PX,
  TASK_MARKER_DEFAULT_COLOR,
  useTabActivitySignals,
  useTabCompletionNotificationDismissing,
  useTabContextUsage,
  type SharedTabActivityMaps,
} from './TabSignals';
import {
  resolveTabSessionDescriptor,
  useSessionAvailability,
} from '../../utils/sessionAvailabilityTracker';
import {
  sessionAvailabilityBackgroundImage,
  sessionAvailabilityRailShadow,
  sessionDerivedSignalsStale,
} from '../../utils/sessionAvailabilityVisual.mjs';
import { requestTaskPlanNavigation } from '../../utils/taskPlanNavigation';
import { isEmptyTab } from '../../utils/emptyTab.mjs';
import { isErrorToast } from '../../utils/toastPlacement.mjs';
import { resolveCodexFastModeState } from '../../utils/codexFastMode.mjs';
import {
  beginPaneTabDrag,
  paneStripKey,
  PANE_TAB_DND_TYPE,
} from '../../utils/paneTabDragBridge';
import TabPendingOperation, { resolveTabPendingOperationLabel } from './TabPendingOperation';
import { useInlineRenameInputRef } from '../../hooks/useInlineRenameInput';
import { requestTabPrimaryInputFocus } from '../../utils/tabPrimaryInputFocus';

export interface PaneTabChipProps {
  projectId: string;
  tabId: string;
  /** Is this the chip whose tab fills the window right now? */
  shown: boolean;
  /** Is this the one pane that owns window focus? */
  paneFocused: boolean;
  /** Pane index, or null in single mode. Decides which gestures are available. */
  paneIndex: number | null;
  /** True when the workspace is split — middle-click semantics depend on it. */
  inSplit: boolean;
  /** Position in the strip; used by the drag to compute the drop target. */
  index?: number;
  /** The strip has more than one chip — enables reordering and per-chip close. */
  inStrip?: boolean;
  /** App-wide status snapshot; avoids one process lookup per chip on workflow switch. */
  sharedActivity?: SharedTabActivityMaps | null;
  /** A target-strip preview clone; it must not register a second draggable. */
  previewOnly?: boolean;
  /** Keep this chip's slot visible while its full preview follows the pointer. */
  dragPlaceholder?: boolean;
}

export default function PaneTabChip({
  projectId, tabId, shown, paneFocused, paneIndex, inSplit, index = 0, inStrip = false, sharedActivity = null,
  previewOnly = false, dragPlaceholder = false,
}: PaneTabChipProps) {
  // Subscribe to the PRIMITIVE fields, never to the tab object: rename mutates
  // `tab.name` in place and only swaps the openProjects Map, so the object
  // reference stays equal and an object-returning selector never re-renders —
  // the header kept the stale name until some unrelated update repainted it.
  // (Same Fingerprint-Pattern rule as fix-performance-lags.md.)
  const tabExists = useWorkspaceStore((s) => !!s.openProjects.get(projectId)?.tabs.get(tabId));
  const activeSpaceId = useWorkspaceStore((s) => s.activeSpaceId);
  const tabName = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.name || '');
  const tabColor = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.color);
  const tabType = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.tabType);
  const tabCommandType = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.commandType);
  const tabCwd = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || '');
  const claudeSessionId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.claudeSessionId || '');
  const geminiSessionId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.geminiSessionId || '');
  const aiClosing = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.aiClosing === true);
  const sdkProcessAlive = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.sdkProcessAlive === true);
  const pendingOperation = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.pendingOperation);
  const tabSessionStatus = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.sessionStatus);
  const completionNotificationArmed = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationArmed === true
  ));
  const completionNotificationFired = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.tabs.get(tabId)?.completionNotificationFired === true
  ));
  const codexSessionId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexSessionId || '');
  const codexLiveServiceTier = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveServiceTier);
  const codexLiveServiceTierSessionId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveServiceTierSessionId);
  const codexLiveSettingsSessionId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.codexLiveSettingsSessionId);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMeta = tabSessionStatus
    ? sessionStatuses.find((s) => s.id === tabSessionStatus)
    : undefined;
  const { hasProcess, busy, inheritedBusy } = useTabActivitySignals(tabId, sharedActivity);
  const sessionAvailability = useSessionAvailability(resolveTabSessionDescriptor({
    id: tabId,
    cwd: tabCwd,
    commandType: tabCommandType,
    tabType,
    claudeSessionId,
    codexSessionId,
    geminiSessionId,
  }));
  const sessionSignalsMuted = sessionDerivedSignalsStale(
    sessionAvailability,
    sdkProcessAlive || (
      hasProcess && (tabCommandType === 'claude' || tabCommandType === 'codex' || tabCommandType === 'gemini')
    ),
  );
  const completionNotificationDismissing = useTabCompletionNotificationDismissing(completionNotificationFired);
  const tabContextPct = useTabContextUsage(tabId);
  const codexFastActive = resolveCodexFastModeState({
    currentSessionId: codexLiveSettingsSessionId || codexLiveServiceTierSessionId || codexSessionId,
    serviceTierSessionId: codexLiveServiceTierSessionId,
    serviceTier: codexLiveServiceTier,
  }).active;
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

  // Ошибки, которые СЕЙЧАС некому показать: их вкладка лежит в этом окне, но
  // показана не она. Уведомление такой вкладки намеренно не всплывает в углу
  // приложения — про него говорит этот чип, а полный текст возвращается в
  // правый верх её окна, когда вкладку покажут (см. toastPlacement.mjs).
  //
  // Селектор возвращает ЧИСЛО, а не список: подписка на массив уведомлений
  // перерисовывала бы каждый чип на любое всплывающее сообщение приложения.
  const hiddenErrorCount = useUIStore((s) => (
    shown ? 0 : s.toasts.reduce(
      (sum, toast) => sum + (toast.tabId === tabId && isErrorToast(toast) ? 1 : 0),
      0,
    )
  ));

  const chipRef = useRef<HTMLSpanElement | null>(null);
  const [hovered, setHovered] = useState(false);
  // Immediate acknowledgement lives on the chip, independently of the heavy
  // surface switch. `shown` clears it only after the selected tab really owns
  // the pane, so the background never flashes off during the 80–120ms commit.
  const [pressed, setPressed] = useState(false);
  const [pointerHeld, setPointerHeld] = useState(false);
  const pointerIdRef = useRef(1);
  const pressedFallbackRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // Rename in place: same action as double-click in the sidebar list, so a tab
  // can be renamed from whichever surface the user is already looking at.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInput = useInlineRenameInputRef(renaming);

  useEffect(() => {
    if (!shown) return;
    setPressed(false);
    setPointerHeld(false);
    if (pressedFallbackRef.current !== null) {
      window.clearTimeout(pressedFallbackRef.current);
      pressedFallbackRef.current = null;
    }
  }, [shown]);

  useEffect(() => () => {
    if (pressedFallbackRef.current !== null) window.clearTimeout(pressedFallbackRef.current);
  }, []);

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

  // Horizontal pane-tab transport. One drag source may reorder its own strip,
  // move into an exact slot of another header, or land on the pane body (end).
  // The store commits the whole source/target snapshot atomically, so moving a
  // shown chip never leaves one pane temporarily blank or duplicates a live
  // terminal between two windows.
  const paneDndEnabled = inSplit || inStrip;
  useEffect(() => {
    const element = chipRef.current;
    if (!element || !paneDndEnabled || previewOnly) return undefined;
    const paneKey = paneStripKey(paneIndex);
    return draggable({
        element,
        getInitialData: () => ({
          type: PANE_TAB_DND_TYPE,
          tabId,
          projectId,
          index,
          paneKey,
          spaceId: activeSpaceId,
          pointerId: pointerIdRef.current,
        }),
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          const rect = element.getBoundingClientRect();
          // The dragged chip is a floating object whose CENTER is the pointer.
          // The row keeps only a quiet placeholder at the future slot. Keeping
          // the original grab offset made the same neighbour require a
          // different crossing point depending on where the user pressed.
          setCustomNativeDragPreview({
            nativeSetDragImage,
            getOffset: centerUnderPointer,
            render({ container }) {
              const clone = element.cloneNode(true) as HTMLElement;
              clone.setAttribute('data-pane-tab-native-drag-preview', '1');
              clone.removeAttribute('data-pane-chip-drag-placeholder');
              Object.assign(container.style, {
                display: 'inline-flex',
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                pointerEvents: 'none',
              });
              Object.assign(clone.style, {
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                maxWidth: 'none',
                margin: '0',
                opacity: '1',
                transform: 'none',
                pointerEvents: 'none',
              });
              container.appendChild(clone);
              return () => clone.remove();
            },
          });
        },
        onDragStart: () => {
          setPointerHeld(false);
          setPressed(false);
          setDragging(true);
          beginPaneTabDrag({
            owner: 'pane',
            entries: [{ projectId, tabId }],
            rootTabId: tabId,
            sourcePaneKey: paneKey,
            sourceSpaceId: activeSpaceId,
            pointerId: pointerIdRef.current,
          });
          console.log('[PaneTabDnd:start] tab=' + tabId.slice(-12) + ' pane=' + paneKey);
        },
        onDrop: () => {
          setDragging(false);
          // The global release barrier owns cleanup. Ending here used to erase
          // the painted target before a drop on empty strip space reached the
          // monitor, so the preview snapped back without a commit.
        },
      });
  }, [activeSpaceId, paneDndEnabled, paneIndex, previewOnly, projectId, tabId]);

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
  // `active` = this chip's tab fills THE FOCUSED window. `shown` alone is not
  // enough: every pane has one shown tab, so it lit one background per pane and
  // visually claimed several active tabs at once. A lone chip still lights up
  // as soon as its pane owns focus — the single-tab bug remains fixed.
  const visuallyActive = shown && paneFocused;
  const pendingOperationLabel = resolveTabPendingOperationLabel({ aiClosing, pendingOperation });
  const completionNotificationWaiting = completionNotificationArmed && !completionNotificationFired;
  const completionNotificationShadow = resolveTabCompletionNotificationShadow({
    armed: completionNotificationWaiting,
    fired: completionNotificationFired,
  });
  const activeStripeShadow = inStrip && (shown || pressed)
    ? 'inset 0 2px 0 0 rgba(255,255,255,0.75)'
    : null;
  const chipBoxShadow = [
    completionNotificationShadow,
    activeStripeShadow,
    sessionAvailabilityRailShadow(sessionAvailability),
  ]
    .filter(Boolean)
    .join(', ') || undefined;
  const chipBg = flattenRgbaOnTabbarPanel(resolveTabCardBackground(
    { bgColor: chrome.bgColor, hasColor, active: visuallyActive || pressed, hovered },
    adjustRgbaAlpha,
  ));
  const removeFromWindow = (event: React.MouseEvent): boolean => {
    if (!inSplit) {
      // Single mode: only a real strip has another chip to leave behind.
      if (!inStrip) return false;
      event.preventDefault();
      event.stopPropagation();
      useWorkspaceStore.getState().removeTabFromCenterStrip(projectId, tabId);
      return true;
    }
    const store = useWorkspaceStore.getState();
    const paneOfThisTab = store.splitPanes
      .some((pane) => pane.projectId === projectId && pane.tabId === tabId);
    if (!paneOfThisTab && !inStrip) return false;
    event.preventDefault();
    event.stopPropagation();
    store.clearTabFromSplitPane(tabId);
    return true;
  };
  return (
    <span
      ref={chipRef}
      // Named so a test can ask "does the chip FOR THIS TAB carry the
      // loader" — the question the process-bar bugs kept getting wrong,
      // and one that is unanswerable without knowing which tab a chip is.
      data-split-pane-tab-chip
      data-tab-id={tabId}
      data-chip-shown={shown ? '1' : '0'}
      // `shown` answers what every window displays; `active` answers which
      // displayed tab belongs to the focused window. Keep both facts in the
      // DOM: sidebar keyboard ownership may quiet the other windows, but must
      // never erase the active marker from the tab it just placed.
      data-chip-active={visuallyActive ? '1' : '0'}
      data-chip-pressed={pressed ? '1' : '0'}
      data-chip-index={index}
      data-tab-session-availability={sessionAvailability.state === 'none' ? undefined : sessionAvailability.state}
      data-pane-chip-preview-only={previewOnly ? '1' : '0'}
      data-pane-chip-drag-placeholder={(dragging || dragPlaceholder || previewOnly) ? '1' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Only a LEFT press may take focus. A right-click opens a menu about
      // this tab — inspecting a tab is not switching to it, and stealing
      // focus there moves the surface out from under the menu the user just
      // opened. (pointerdown fires for every button, hence the check.)
      onPointerDown={(e) => {
        e.stopPropagation();
        pointerIdRef.current = e.pointerId;
        if (e.button !== 0) {
          e.preventDefault();
          return;
        }
        if (!renaming) setPressed(true);
        if (!renaming) setPointerHeld(true);
      }}
      onPointerUp={() => setPointerHeld(false)}
      onPointerCancel={() => { setPointerHeld(false); setPressed(false); }}
      onPointerLeave={(e) => {
        if (e.buttons !== 0) return;
        setPointerHeld(false);
        setPressed(false);
      }}
      // Перетаскивание показывает будущий порядок самими чипами. Отдельная
      // белая линия дублировала уже нарисованный preview и после появления
      // inline FLIP больше не несла информации.
      onClick={(e) => {
        // "Show this tab here". Activation itself brings the sidebar to the
        // tab's project now (one-pointer model), so the chip needs no
        // special project-following path anymore.
        e.stopPropagation();
        if (renaming) return;
        // Bare Cmd+click removes exactly this chip, like middle-click. Keep
        // combined shortcuts available to the pane-focus gesture below.
        if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          const removed = removeFromWindow(e);
          setPointerHeld(false);
          setPressed(false);
          if (pressedFallbackRef.current !== null) window.clearTimeout(pressedFallbackRef.current);
          pressedFallbackRef.current = null;
          if (removed) return;
        }
        // Комбинированное ⌘-сочетание по чипу сохраняет старый фокус-only путь:
        // оно выбирает это окно, не съезжая из чужого проекта. Bare Cmd-click
        // уже удалил чип выше, как и middle-click.
        if (e.metaKey && paneIndex !== null && paneIndex !== undefined) {
          setPointerHeld(false);
          setPressed(false);
          useWorkspaceStore.getState().focusSplitPane(paneIndex, { keepSidebar: true });
          return;
        }
        useWorkspaceStore.getState().activateCenterTab(projectId, tabId);
        requestTabPrimaryInputFocus(tabId, 'pane-tab-chip-click');
        if (shown) setPressed(false);
        else {
          if (pressedFallbackRef.current !== null) window.clearTimeout(pressedFallbackRef.current);
          pressedFallbackRef.current = window.setTimeout(() => {
            pressedFallbackRef.current = null;
            setPressed(false);
          }, 600);
        }
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
        // Middle-click takes this tab OUT OF THE WINDOW: its chip goes and the
        // tab keeps living in the sidebar. If it was shown, the body becomes
        // vacant; parked neighbours wait for an explicit click. The window
        // itself survives, so the gesture cannot destroy its layout.
        //
        // It acts on the tab NAMED IN THIS CHIP and on nothing else. The guard
        // below is not defensive noise: the header is also rendered in single
        // mode from the CENTER tab, so a stale/foreign tabId here would silently
        // empty a pane the user is not even looking at.
        if (e.button !== 1) return;
        // This gesture names the CHIP under the cursor, so it always removes
        // exactly that chip. Pane history is used by Cmd+W / explicit detach,
        // but must not turn a middle-click into a different command («go back»)
        // while leaving the clicked chip parked invisibly in the same window.
        removeFromWindow(e);
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
        // NO width cap in a strip. A cap turns a name into «terminal mcp -> …»
        // — an ellipsis where the answer was, on the very surface whose job is
        // to say which tab is which. The strip scrolls instead, and what
        // scrolls off the edge is named by the badges there. Юзер: *«нет
        // ограничений по ширине… если вкладок слишком много — писать справа»*.
        // A LONE chip still shrinks: it is not a strip, and its long name must
        // not push the split button out of a narrow window.
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
        color: (!inStrip || shown || pressed) ? '#e8e8e8' : '#9b9ba1',
        cursor: 'pointer',
        // Hover brightens the tab's OWN colour (shared rule), it does not
        // paint over it.
        background: chipBg,
        backgroundImage: sessionAvailabilityBackgroundImage(sessionAvailability),
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
        boxShadow: chipBoxShadow,
        // Красная рамка = «в этой вкладке ошибка, а показать её текстом сейчас
        // негде». Рамка, а не значок: она обводит ИМЕННО эту вкладку, тогда как
        // значок в узком чипе спорил бы за место с меткой статуса и с полосой
        // квадратов задач. Цвет плотный, а не полупрозрачный, — по правилу
        // AI-Optimized UI (полупрозрачное на тёмном съедают кодеки видео).
        border: hiddenErrorCount > 0
          ? '1px solid #f87171'
          : `1px solid ${chrome.borderColor}55`,
        borderRadius: cardMetrics.borderRadius,
        // Left padding clears the status marker when one is shown, so the
        // name never sits under it — same rule as the sidebar card.
        padding: cardMetrics.padding,
        transform: pointerHeld && !dragging ? 'scale(0.985)' : undefined,
        // Selection is state, not a progress animation. A symmetric 120ms
        // background/color transition kept the OLD chip visibly active after
        // the pane had already switched; one long frame turned that fade into
        // two obvious steps. Commit the truthful active/inactive appearance
        // immediately and keep only the short release-scale as click feedback.
        transition: pointerHeld
          ? 'none'
          : 'transform 70ms ease-out',
        // The full chip follows the pointer as a native preview. This quiet
        // shell is the future slot, so the row can animate without drawing a
        // second competing «dragged tab» under a different coordinate.
        opacity: (dragging || dragPlaceholder || previewOnly) ? 0.12 : 1,
      }}
    >
      <TabCompletionNotificationAlert
        fired={completionNotificationFired}
        dismissing={completionNotificationDismissing}
        borderRadius={cardMetrics.borderRadius}
      />
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
      {/* Same lane as the sidebar, above the active white top stripe. In a
          dense pane strip context is useful only from 50%; Fast is always
          shown when its writer proof is exact. */}
      <TabTopLeftSignals
        tabId={tabId}
        fastActive={codexFastActive}
        contextPct={tabContextPct}
        minContextPct={50}
        zIndex={8}
        muted={sessionSignalsMuted}
      />
      {/* Кликабельный маркер: смена статуса на месте, без активации вкладки
          и без смены фокуса окна — тот же компонент, что на карточке списка. */}
      <TabStatusMarkerButton projectId={projectId} tabId={tabId} color={statusMeta?.color} title={statusMeta?.label} />
      {tabType === 'file' && <FileText size={10} style={{ color: '#a78bfa', flexShrink: 0 }} />}
      {/* Пустая вкладка — серая папка на месте цвета агента. A tab with an agent
          carries that agent's colour, which is how the strip is read at a
          glance; a tab with nothing started has no colour to carry, and an
          unmarked grey chip is indistinguishable from a tab whose colour was
          simply never set. The folder says what it is instead. */}
      {isEmpty && <Folder size={10} style={{ color: '#8a8a92', flexShrink: 0 }} />}
      {pendingOperationLabel ? (
        <TabPendingOperation label={pendingOperationLabel} tabName={tabName} />
      ) : renaming ? (
        // Переименование выглядит и ведёт себя ТАК ЖЕ, как в боковом списке:
        // жест один, и разное поведение читалось бы как разные функции.
        //
        // Весь текст выделен (`select()`, а не просто фокус): переименовывают,
        // чтобы НАЗВАТЬ заново, поэтому первая же буква должна заменить
        // старое имя. Курсор, поставленный в текст, заставляет сначала стирать
        // — а куда он встанет, зависит от того, куда попал клик, то есть
        // результат жеста был бы разным от раза к разу.
        //
        // Рамка тенью, а не border'ом: тень не занимает места в раскладке, и
        // чип не раздувается на время правки, сдвигая соседей по полосе.
        // Шрифт наследуется целиком — поле повторяет коробку подписи.
        <input
          ref={renameInput.ref}
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') {
              setRenaming(false);
            }
          }}
          style={{
            width: Math.max(60, renameDraft.length * 6.5 + 12),
            minWidth: 60,
            padding: '0 4px',
            border: 'none',
            outline: 'none',
            background: '#333',
            borderRadius: 3,
            boxShadow: 'inset 0 0 0 1px var(--color-accent)',
            color: '#fff',
            font: 'inherit',
          }}
        />
      ) : (
        // В полосе имя показывается целиком: полоса прокручивается, и обрезать
        // здесь нечего. Вне полосы чип делит одну строку с кнопками окна и
        // сжимается — там многоточие честнее, чем выдавленная за край кнопка.
        <span style={inStrip
          ? { whiteSpace: 'nowrap' }
          : { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {tabName}
        </span>
      )}
      <TabSessionAvailabilityMarker availability={sessionAvailability} size={10} />
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
