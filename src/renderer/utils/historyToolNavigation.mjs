import { resolveHistoryNavigationTarget } from './historyPromptPresentation.mjs';

export const HISTORY_NAVIGATION_FLASH_MS = 500;
export const HISTORY_NAVIGATION_FLASH_CSS = '@keyframes hp-flash {0% { background-color: transparent; } 20% { background-color: rgba(91,156,245,0.2); } 100% { background-color: transparent; }}';

export function resolveHistoryToolNavigationTarget(entries, identity, tool) {
  const exact = resolveHistoryNavigationTarget(entries, identity);
  if (!tool) return exact;
  // A header stub has no actions yet. Hydrate its exact row before checking the
  // call ID; live fusion may later re-key that row, but never match body text.
  if (exact && entries[exact.index]?.rowStub) return exact;
  const matches = entries.filter(entry => entry.role === 'assistant'
    && entry.actions?.some(action => action.rawTool?.toolUseId === tool.toolUseId));
  if (matches.length !== 1) return null;
  return matches[0];
}

export function historyToolNavigationNode(row, toolUseId) {
  if (!row || !toolUseId) return null;
  const tool = [...row.querySelectorAll('[data-history-tool-use-id]')]
    .find(node => node.getAttribute('data-history-tool-use-id') === toolUseId);
  return tool?.querySelector('.cb-tool-head') || null;
}

export function flashHistoryNavigationNode(node, requestId) {
  if (!node?.isConnected) return null;
  const animation = node.animate([
    { backgroundColor: 'transparent', offset: 0 },
    { backgroundColor: 'rgba(91,156,245,0.2)', offset: 0.2 },
    { backgroundColor: 'transparent', offset: 1 },
  ], { duration: HISTORY_NAVIGATION_FLASH_MS, iterations: 1, easing: 'ease-in-out' });
  animation.id = 'history-source:' + requestId;
  return animation;
}
