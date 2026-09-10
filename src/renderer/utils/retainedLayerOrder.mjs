/**
 * Navigation order must never become the DOM order of retained scroll owners.
 * React can move a keyed node without unmounting it; Chromium then resets its
 * descendant scrollTop without a scroll event. Sort globally by immutable tab
 * identity, including when a tab moves between projects. New/deleted IDs leave
 * the relative order of all surviving layers unchanged.
 */
export function retainedTabLayers(openProjects) {
  const layers = [];
  openProjects.forEach((workspace, projectId) => {
    workspace.tabs.forEach((tab) => layers.push({ projectId, workspace, tab }));
  });
  return layers.sort((left, right) => compareRetainedLayerIds(left.tab.id, right.tab.id));
}

export function compareRetainedLayerIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
