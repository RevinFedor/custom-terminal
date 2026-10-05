import { runAfterWorkflowTabIds } from './runAfterTabScope.mjs';

export function isAiLaunchCommand(command) {
  const text = command.trim();
  return /(^|[;&|]\s*)(?:command\s+)?(?:codex|claude|gemini)(?=\s|$)/i.test(text)
    || /(^|[;&|]\s*)(?:npx|pnpm\s+dlx|bunx)\s+@openai\/codex(?=\s|$)/i.test(text);
}
export function isDevRestartCommand(command) {
  const text = command.trim();
  const npm = text.match(/\bnpm\s+run\s+([^\s;&|]+)/i);
  if (npm) return /^(dev|start|serve|watch)/i.test(npm[1]);
  const sh = text.match(/(?:^|\s)\.\/([^/\s;&|]+)$/);
  return !!sh && /^(dev|start|serve|watch)/i.test(sh[1]);
}
export function getRestartAfterWorkflowIds(tab) {
  return [...new Set((Array.isArray(tab?.restartAfterWorkflowIds) ? tab.restartAfterWorkflowIds : [])
    .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
}
export function getRestartAfterTriggerIds(tab, state) {
  const workflowIds = getRestartAfterWorkflowIds(tab);
  const liveIds = state && workflowIds.length ? runAfterWorkflowTabIds(state, workflowIds, tab?.id) : [];
  return [...new Set([...(Array.isArray(tab?.restartAfterTabIds) ? tab.restartAfterTabIds : []), tab?.restartAfterTabId, ...liveIds]
    .filter(id => typeof id === 'string' && id.trim() && id.trim() !== tab?.id).map(id => id.trim()))];
}
export function hasRestartAfterSubscription(tab) {
  return getRestartAfterWorkflowIds(tab).length > 0 || getRestartAfterTriggerIds(tab).length > 0;
}
