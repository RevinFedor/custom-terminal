import { resolveTabTerminalPrimary, useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';

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

/**
 * Return keyboard input to the primary authoring surface of a tab after an
 * explicit navigation gesture. The request is delayed one frame so a
 * workflow/pane placement commit becomes visible first; the stale-target
 * checks then prevent a rapid second gesture from focusing the old tab.
 */
export function requestTabPrimaryInputFocus(tabId: string, reason: string): void {
  if (!tabId) return;
  focusDiag('phase=request tab=' + tabId.slice(-12)
    + ' reason=' + reason
    + ' area=' + useUIStore.getState().activeArea);
  requestAnimationFrame(() => {
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
    // commit. A Ctrl+P input that was closed by the commit is already detached
    // by this frame and therefore does not trip the guard.
    if (focusedEditableBelongsToUser()) {
      focusDiag('phase=skip tab=' + tabId.slice(-12) + ' reason=external-editable');
      return;
    }

    if (tab.tabType === 'claude-sdk') {
      window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', {
        detail: { tabId, reason },
      }));
      focusDiag('phase=dispatch tab=' + tabId.slice(-12) + ' target=sdk');
      return;
    }

    const isAgentTab = resolvePtyAgentOwner(tab) !== null;
    const historyOwnsInput = isAgentTab && (
      !resolveTabTerminalPrimary(ui, tabId)
      || ui.historyPanelOpenTabs[tabId] === true
    );
    if (historyOwnsInput) {
      window.dispatchEvent(new CustomEvent('history-panel:focus-composer', {
        detail: { tabId, reason, immediate: true },
      }));
      focusDiag('phase=dispatch tab=' + tabId.slice(-12) + ' target=history');
      requestAnimationFrame(() => focusDiag(
        'phase=result tab=' + tabId.slice(-12) + ' target=history',
      ));
      return;
    }

    // Terminal listeners already prove that this tab is globally active and
    // that its xterm is actually visible before claiming DOM focus.
    window.dispatchEvent(new CustomEvent('nt:window-refocus-active', {
      detail: { tabId, reason },
    }));
    focusDiag('phase=dispatch tab=' + tabId.slice(-12) + ' target=terminal');
    requestAnimationFrame(() => focusDiag(
      'phase=result tab=' + tabId.slice(-12) + ' target=terminal',
    ));
  });
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
