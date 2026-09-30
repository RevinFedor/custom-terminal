import { resolveTabTerminalPrimary, useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';
import { uiPerformancePhase } from './uiPerformanceDiagnostics.mjs';

function focusedEditableBelongsToUser(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return false;
  // The previous pane's xterm/History/SDK editor commonly still owns DOM
  // focus until this request runs. That is exactly the focus we are replacing,
  // not an external field the user expects us to preserve.
  if (active.closest('[data-terminal-pane-wrapper]')) return false;
  return active.tagName === 'INPUT'
    || active.tagName === 'TEXTAREA'
    || active.tagName === 'SELECT'
    || active.isContentEditable;
}

function activeElementSummary(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return 'none';
  const owner = active.closest<HTMLElement>('[data-terminal-pane-wrapper]');
  return active.tagName.toLowerCase()
    + (active.className ? '.' + String(active.className).split(/\s+/).slice(0, 2).join('.') : '')
    + (owner?.dataset?.terminalPaneWrapper
      ? '@' + owner.dataset.terminalPaneWrapper.slice(-12)
      : '');
}

function focusDiag(message: string): void {
  console.warn('[Focus:PrimaryInput] ' + message + ' active=' + activeElementSummary());
}

type PendingPrimaryInputFocus = {
  tabId: string;
  reason: string;
};

let pendingPrimaryInputFocus: PendingPrimaryInputFocus | null = null;
let pendingPresentationObserver: MutationObserver | null = null;

function tabPresentationReady(tabId: string): boolean {
  const wrappers = document.querySelectorAll<HTMLElement>('[data-terminal-pane-wrapper]');
  for (const wrapper of wrappers) {
    if (wrapper.dataset.terminalPaneWrapper !== tabId) continue;
    return wrapper.dataset.terminalSurfacePresented === '1'
      && wrapper.dataset.paneFocusIsolated !== '1'
      && wrapper.getAttribute('aria-hidden') !== 'true';
  }
  return false;
}

function clearPendingPresentationFocus(): void {
  pendingPrimaryInputFocus = null;
  pendingPresentationObserver?.disconnect();
  pendingPresentationObserver = null;
}

/**
 * Return keyboard input to the primary authoring surface of a tab after an
 * explicit navigation gesture. Pane surfaces are persistent, so the target
 * editor already exists when navigation commits. Focus therefore belongs to
 * that same commit: waiting for rAF/timer made a busy renderer turn one logical
 * action into two visibly separated states (white pane frame first, orange
 * composer frame hundreds of milliseconds later).
 */
function dispatchTabPrimaryInputFocus(tabId: string, reason: string): void {
  const state = useWorkspaceStore.getState();
  const ui = useUIStore.getState();
  if (state.view !== 'workspace' || ui.activeArea !== 'workspace') {
    focusDiag('phase=skip tab=' + tabId.slice(-12)
      + ' reason=owner-' + state.view + '-' + ui.activeArea);
    return;
  }

  let projectId = '';
  if (state.splitPanes.length > 0) {
    const focusedPane = state.splitPanes[state.splitFocusedIndex];
    if (!focusedPane || focusedPane.tabId !== tabId) {
      focusDiag('phase=skip tab=' + tabId.slice(-12) + ' reason=stale-pane-target');
      return;
    }
    projectId = focusedPane.projectId;
  } else {
    const activeProjectId = state.activeProjectId || state.focusedProjectId || '';
    const activeWorkspace = activeProjectId ? state.openProjects.get(activeProjectId) : null;
    if (!activeWorkspace || activeWorkspace.activeTabId !== tabId) {
      focusDiag('phase=skip tab=' + tabId.slice(-12) + ' reason=stale-centre-target');
      return;
    }
    projectId = activeProjectId;
  }

  const tab = state.openProjects.get(projectId)?.tabs.get(tabId);
  if (!tab || tab.tabType === 'file') {
    focusDiag('phase=skip tab=' + tabId.slice(-12) + ' reason=' + (!tab ? 'missing-tab' : 'file-tab'));
    return;
  }
  // Never steal an edit/search/settings field which survived the navigation
  // commit. Editors inside the old pane are intentionally replaceable.
  if (focusedEditableBelongsToUser()) {
    focusDiag('phase=skip tab=' + tabId.slice(-12) + ' reason=external-editable');
    return;
  }

  if (tab.tabType === 'claude-sdk') {
    window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', {
      detail: { tabId, reason, focusEnd: true },
    }));
    focusDiag('phase=dispatch tab=' + tabId.slice(-12) + ' target=sdk');
    focusDiag('phase=result tab=' + tabId.slice(-12) + ' target=sdk');
    return;
  }

  const isAgentTab = resolvePtyAgentOwner(tab) !== null;
  const historyOwnsInput = isAgentTab && (
    !resolveTabTerminalPrimary(ui, tabId)
    || ui.historyPanelOpenTabs[tabId] === true
  );
  if (historyOwnsInput) {
    const dispatchStartedAt = performance.now();
    uiPerformancePhase('primary-focus-dispatch-start', { tab: tabId, reason });
    focusDiag('phase=dispatch-start tab=' + tabId.slice(-12) + ' target=history'
      + ' startAbs=' + (performance.timeOrigin + dispatchStartedAt).toFixed(1));
    window.dispatchEvent(new CustomEvent('history-panel:focus-composer', {
      // History clamps these values to its current text length. Supplying an
      // explicit range makes navigation focus deterministic instead of
      // reviving whichever caret position this retained editor had last.
      detail: {
        tabId,
        reason,
        immediate: true,
        selectionStart: Number.MAX_SAFE_INTEGER,
        selectionEnd: Number.MAX_SAFE_INTEGER,
      },
    }));
    focusDiag('phase=dispatch tab=' + tabId.slice(-12) + ' target=history'
      + ' dispatchMs=' + (performance.now() - dispatchStartedAt).toFixed(1));
    focusDiag('phase=result tab=' + tabId.slice(-12) + ' target=history');
    return;
  }

  // Terminal listeners already prove that this tab is globally active and
  // that its xterm is actually visible before claiming DOM focus.
  window.dispatchEvent(new CustomEvent('nt:window-refocus-active', {
    detail: { tabId, reason },
  }));
  focusDiag('phase=dispatch tab=' + tabId.slice(-12) + ' target=terminal');
  focusDiag('phase=result tab=' + tabId.slice(-12) + ' target=terminal');
}

/**
 * Commit focus as soon as the exact retained wrapper is presented.
 *
 * A store switch can precede React's layout commit by part of the same task.
 * Focusing the still-hidden wrapper would be rejected by pane focus isolation.
 * A MutationObserver is an event-driven commit hook: it has no duration, no
 * animation frame and no timer. Rapid navigation replaces the single pending
 * intent, so a stale pane can never claim focus later.
 */
export function requestTabPrimaryInputFocus(tabId: string, reason: string): void {
  if (!tabId) return;
  focusDiag('phase=request tab=' + tabId.slice(-12)
    + ' reason=' + reason
    + ' area=' + useUIStore.getState().activeArea);
  clearPendingPresentationFocus();
  if (tabPresentationReady(tabId)) {
    dispatchTabPrimaryInputFocus(tabId, reason);
    return;
  }

  pendingPrimaryInputFocus = { tabId, reason };
  focusDiag('phase=armed tab=' + tabId.slice(-12) + ' reason=presentation-commit');
  pendingPresentationObserver = new MutationObserver(() => {
    const pending = pendingPrimaryInputFocus;
    if (!pending || !tabPresentationReady(pending.tabId)) return;
    clearPendingPresentationFocus();
    dispatchTabPrimaryInputFocus(pending.tabId, pending.reason);
  });
  pendingPresentationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'data-terminal-surface-presented',
      'data-pane-focus-isolated',
      'aria-hidden',
    ],
  });
  // Close the observe-after-check race without yielding to another task.
  if (tabPresentationReady(tabId)) {
    clearPendingPresentationFocus();
    dispatchTabPrimaryInputFocus(tabId, reason);
  }
}

export function requestFocusedWorkspacePrimaryInput(reason: string): void {
  const state = useWorkspaceStore.getState();
  const tabId = state.splitPanes.length > 0
    ? state.splitPanes[state.splitFocusedIndex]?.tabId || ''
    : state.activeProjectId
      ? state.openProjects.get(state.activeProjectId)?.activeTabId || ''
      : '';
  requestTabPrimaryInputFocus(tabId, reason);
}
