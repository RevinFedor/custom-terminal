// Persistent Terminal/History trees are STRUCTURE. Workflow visibility is a
// tiny PRESENTATION projection over those trees. Keeping the identities here
// separate prevents a workflow click from rebuilding every tab-owned React
// subtree merely to change six wrapper attributes.

export const PANE_LAYER_PRESENTATION_EVENT = 'noted:pane-layer-presentation';

export function paneLayerStructuralKey(model = {}) {
  const retainedTerminalPresentation = model.retainedTerminalPresentation === true;
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
    // A pane terminal is kept renderer-presented and its outer boundary owns
    // compositor visibility. The global single-center floating-terminal flag
    // must not invalidate dormant pane structure.
    retainedTerminalPresentation
      ? 'retained-terminal-presentation'
      : model.inPane
      ? 'pane-terminal-presented'
      : (model.terminalPresented ? 'terminal-presented' : 'terminal-hidden'),
    model.promptQueuePortalHostId || '',
    model.promptQueueInputSurface || '',
    model.hidePromptQueueHistoryToggle ? 'hide-history-toggle' : '',
    // Single-centre tabs still use React ownership for active/project state.
    // Pane tabs move those volatile facts to the presentation manager below.
    model.inPane || retainedTerminalPresentation ? '' : (model.active ? 'active' : 'inactive'),
    model.inPane || retainedTerminalPresentation ? '' : (model.projectActive ? 'project-active' : 'project-inactive'),
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
