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
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { paneTabs } from '../../utils/splitPanesModel.mjs';
import { openTabContextMenuAt, TAB_RENAME_REQUEST_EVENT } from './TabBar';
import type { SharedTabActivityMaps } from './TabSignals';
import { requestTaskPlanNavigation } from '../../utils/taskPlanNavigation';
import TabCard from './TabCard';
import {
  paneStripKey,
} from '../../utils/paneTabDragBridge';
import { bindPaneTabPointerDrag } from '../../utils/paneTabPointerGesture';
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
  const tabExists = useWorkspaceStore(s => !!s.openProjects.get(projectId)?.tabs.has(tabId));
  const activeSpaceId = useWorkspaceStore(s => s.activeSpaceId);
  const tabName = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.name || '');
  const tabType = useWorkspaceStore(s => s.openProjects.get(projectId)?.tabs.get(tabId)?.tabType);

  const chipRef = useRef<HTMLSpanElement | null>(null);
  // Immediate acknowledgement lives on the chip, independently of the heavy
  // surface switch. `shown` clears it only after the selected tab really owns
  // the pane, so the background never flashes off during the 80–120ms commit.
  const [pressed, setPressed] = useState(false);
  const [pointerHeld, setPointerHeld] = useState(false);
  const pressedFallbackRef = useRef<number | null>(null);
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
    if (!element || !paneDndEnabled || previewOnly || renaming) return undefined;
    const paneKey = paneStripKey(paneIndex);
    return bindPaneTabPointerDrag(element, () => ({
      owner: 'pane', entries: [{ projectId, tabId }], rootTabId: tabId,
      sourcePaneKey: paneKey, sourceSpaceId: activeSpaceId,
    }), () => { setPointerHeld(false); setPressed(false); });
  }, [activeSpaceId, paneDndEnabled, paneIndex, previewOnly, projectId, tabId, renaming]);


  if (!tabExists) return null;
  const removeFromWindow = (event: React.MouseEvent): boolean => {
    if (!inSplit) {
      event.preventDefault();
      event.stopPropagation();
      // The last chip still has an undo and leaves a vacant window. The store
      // also validates that this named tab really belongs to the centre.
      return useWorkspaceStore.getState().detachTabFromWindow(projectId, tabId);
    }
    const store = useWorkspaceStore.getState();
    const candidates = paneIndex !== null && paneIndex !== undefined
      ? [store.splitPanes[paneIndex]] : store.splitPanes;
    const paneOfThisTab = candidates.some(pane => paneTabs(pane)
      .some(entry => entry.projectId === projectId && entry.tabId === tabId));
    if (!paneOfThisTab) return false;
    event.preventDefault();
    event.stopPropagation();
    store.clearTabFromSplitPane(tabId);
    return true;
  };
  return (
    <TabCard
      ref={chipRef}
      projectId={projectId} tabId={tabId} shown={shown} active={shown && paneFocused}
      pressed={pressed} showShownStripe={inStrip} truncate={!inStrip}
      interactiveStatus sharedActivity={sharedActivity}
      onTaskClick={(taskId, event) => {
        event.stopPropagation();
        useWorkspaceStore.getState().activateCenterTab(projectId, tabId);
        requestTaskPlanNavigation({ tabId, taskId, view: 'active' });
      }}
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
      data-chip-active={shown && paneFocused ? '1' : '0'}
      data-chip-pressed={pressed ? '1' : '0'}
      data-chip-index={index}
      data-pane-chip-preview-only={previewOnly ? '1' : '0'}
      data-pane-chip-drag-placeholder={(dragPlaceholder || previewOnly) ? '1' : undefined}
      // Only a LEFT press may take focus. A right-click opens a menu about
      // this tab — inspecting a tab is not switching to it, and stealing
      // focus there moves the surface out from under the menu the user just
      // opened. (pointerdown fires for every button, hence the check.)
      onPointerDown={(e) => {
        e.stopPropagation();
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
        flexShrink: inStrip ? 0 : 1,
        transform: pointerHeld && !dragPlaceholder ? 'scale(0.985)' : undefined,
        transition: 'none',
        touchAction: 'none',
        userSelect: 'none',
        opacity: (dragPlaceholder || previewOnly) ? 0.12 : 1,
      }}
    >
      {renaming ? (
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
      ) : undefined}
    </TabCard>
  );
}
