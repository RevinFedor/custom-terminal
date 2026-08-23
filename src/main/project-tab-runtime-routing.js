'use strict';

function partitionProjectRuntimeTabs(tabs, resolveOwner) {
  const rendererTabIds = [];
  const mainCodexTabs = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    const owner = typeof resolveOwner === 'function' ? resolveOwner(tab) : null;
    if (owner === 'claude') rendererTabIds.push(tab.tabId);
    else if (owner === 'codex') mainCodexTabs.push(tab);
  }
  return { rendererTabIds, mainCodexTabs };
}

module.exports = { partitionProjectRuntimeTabs };
