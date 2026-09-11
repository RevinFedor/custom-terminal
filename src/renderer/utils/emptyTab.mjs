// «Пустая вкладка» — an ordinary live-shell tab with no agent started in it.
//
// It is NOT a new kind of tab. It is an ordinary terminal tab with a live shell,
// used by existing Blank tabs and sidebar-owned creation. Window-owned Cmd+T
// now opens a chooser slot with no tab record; that slot does not enter this
// resolver until a real tab has been created for the user's choice.
//
// Inventing a process-less tab type would have been the other reading of the
// same request, and it would have cost a second lifecycle (a tab that can be
// "not started"), a second restore path, and a second answer to every "is this
// tab alive" check in the app — all so that a shell prompt does not appear for a
// few seconds. The shell is not in the way; it is the thing under the buttons.
//
// So "empty" is a derived DESCRIPTION, not a second tab type: a tab is empty
// while no durable execution role has been chosen. A one-off shell command does
// not choose a role; explicit Terminal, terminal automation, or an accepted AI
// launch does. The chosen role uses fields the tab already persists.
//
// Это имя существующего пустого shell. «Новая вкладка» оконного chooser —
// другое состояние: до выбора у него нет записи/PTY. «Нет вкладки» означает,
// что окно не показывает ни рабочую вкладку, ни выбранный chooser.

/** The name a tab gets when it is created with nothing running in it. */
export const EMPTY_TAB_NAME = 'Пустая вкладка';

const AI_COMMAND_TYPES = new Set(['claude', 'codex', 'gemini']);
const AI_PENDING_ACTIONS = new Map([
  ['claude-new', 'claude'],
  ['claude-continue', 'claude'],
  ['claude-fork', 'claude'],
  ['claude-compact-fork', 'claude'],
  ['codex-new', 'codex'],
  ['codex-continue', 'codex'],
  ['codex-fork', 'codex'],
  ['codex-compact-fork', 'codex'],
  ['gemini-new', 'gemini'],
  ['gemini-continue', 'gemini'],
  ['gemini-fork', 'gemini'],
]);

/**
 * Durable execution role. Process liveness is deliberately not part of this
 * answer: a one-off shell command temporarily occupies Blank without choosing
 * Terminal, while Stop does not turn an accepted AI tab back into Blank.
 */
export function resolveTabExecutionRole(tab) {
  if (!tab) return 'none';
  const tabType = tab.tabType || 'terminal';
  if (tabType === 'file') return 'file';
  if (tabType === 'claude-sdk') return 'claude-sdk';

  const boundOwners = [];
  if (tab.claudeSessionId) boundOwners.push('claude');
  if (tab.codexSessionId) boundOwners.push('codex');
  if (tab.geminiSessionId) boundOwners.push('gemini');
  if (boundOwners.length > 1) return 'ai-conflict';
  if (boundOwners.length === 1) return boundOwners[0];

  if (AI_COMMAND_TYPES.has(tab.commandType)) return tab.commandType;
  const pendingOwner = AI_PENDING_ACTIONS.get(tab.pendingAction?.type);
  if (pendingOwner) return pendingOwner;

  const hasRestartAfter = !!tab.restartAfterTabId
    || (Array.isArray(tab.restartAfterTabIds) && tab.restartAfterTabIds.some(Boolean))
    || !!tab.restartAfterCommand;
  if (tab.commandType === 'generic' || tab.commandType === 'devServer' || hasRestartAfter) {
    return 'terminal';
  }
  return 'blank';
}

export function isAiExecutionRole(role) {
  return role === 'claude'
    || role === 'codex'
    || role === 'gemini'
    || role === 'claude-sdk'
    || role === 'ai-conflict';
}

export function tabHasCommittedAiRole(tab) {
  return isAiExecutionRole(resolveTabExecutionRole(tab));
}

export function tabAllowsShellActions(tab) {
  const role = resolveTabExecutionRole(tab);
  return role === 'blank' || role === 'terminal';
}

export function tabAllowsAiLaunch(tab, isCommandRunning = false) {
  return resolveTabExecutionRole(tab) === 'blank' && isCommandRunning !== true;
}

/** No durable Terminal or AI role has been chosen for this live shell yet. */
export function isEmptyTab(tab) {
  return resolveTabExecutionRole(tab) === 'blank';
}
