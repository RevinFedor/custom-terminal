// Persistent Terminal/History trees are STRUCTURE. Workflow visibility is a
// tiny PRESENTATION projection over those trees. Keeping the identities here
// separate prevents a workflow click from rebuilding every tab-owned React
// subtree merely to change six wrapper attributes.

export const PANE_LAYER_PRESENTATION_EVENT = 'noted:pane-layer-presentation';

export function paneLayerStructuralKey(model = {}) {
  return [
    model.projectId || '',
    model.tabId || '',
    model.tabType || 'terminal',
    model.cwd || '',
    model.restoreErrorKey || '',
    model.inPane ? 'pane' : 'centre',
    model.layoutPaneIndex ?? -1,
    model.geometryKey || '',
    model.stacked ? 'stacked' : 'single',
    model.headerHeight ?? '',
    model.terminalPresented ? 'terminal-presented' : 'terminal-hidden',
    model.promptQueuePortalHostId || '',
    model.promptQueueInputSurface || '',
    model.hidePromptQueueHistoryToggle ? 'hide-history-toggle' : '',
    // Single-centre tabs still use React ownership for active/project state.
    // Pane tabs move those volatile facts to the presentation manager below.
    model.inPane ? '' : (model.active ? 'active' : 'inactive'),
    model.inPane ? '' : (model.projectActive ? 'project-active' : 'project-inactive'),
  ].join('|');
}

export function paneLayerPresentationKey(model = {}) {
  return [
    model.inPane ? 'pane' : 'centre',
    model.presented ? 'presented' : 'hidden',
    model.focused ? 'focused' : 'unfocused',
    model.visiblePaneIndex ?? -1,
    model.geometryKey || '',
    model.overlayOpen ? 'overlay' : 'plain',
    model.mainHistoryPresented ? 'history-main' : '',
    model.sideHistoryPresented ? 'history-side' : '',
  ].join('|');
}

export function diffPaneLayerPresentations(previous = new Map(), next = new Map()) {
  const changed = [];
  for (const [tabId, model] of next) {
    if (previous.get(tabId) !== paneLayerPresentationKey(model)) changed.push(tabId);
  }
  return changed;
}
