// «Пустая вкладка» — an ordinary live-shell tab with no agent started in it.
//
// It is NOT a new kind of tab. It is an ordinary terminal tab with a live shell,
// exactly what Ctrl+T has always made; what is new is that the interface says so
// out loud, because a window can now hold several tabs and "which of these has
// nothing running" became a question you ask at a glance.
//
// Inventing a process-less tab type would have been the other reading of the
// same request, and it would have cost a second lifecycle (a tab that can be
// "not started"), a second restore path, and a second answer to every "is this
// tab alive" check in the app — all so that a shell prompt does not appear for a
// few seconds. The shell is not in the way; it is the thing under the buttons.
//
// So "empty" is a DESCRIPTION, not a state: a tab is empty while it has no agent
// session and no agent has been launched into it. Nothing stores it, nothing has
// to keep it in sync, and it stops being true the moment an agent starts —
// including when the agent is started from outside the app.
//
// Последний пользовательский контракт отменил старое имя «Терминал»: оно
// звучит как тип поверхности, хотя человек создал именно ещё не заполненную
// вкладку окна. Пустое ОКНО по-прежнему говорит «Нет вкладки» — состояния
// различаются существованием строки/чипа, а не попыткой запретить слово.

/** The name a tab gets when it is created with nothing running in it. */
export const EMPTY_TAB_NAME = 'Пустая вкладка';

/** Nothing is running here and nothing has been asked to run. */
export function isEmptyTab(tab) {
  if (!tab) return false;
  // Only plain terminal tabs can be empty: a file tab shows a file, a browser
  // tab shows a page, an SDK tab IS a conversation. None of them is waiting to
  // be filled.
  const type = tab.tabType || 'terminal';
  if (type !== 'terminal') return false;
  if (tab.claudeSessionId || tab.codexSessionId || tab.geminiSessionId) return false;
  // A launch already on its way — the tab is about to stop being empty, and the
  // buttons that would start a second one must go now, not when the process
  // reports in. (A shell command is not an agent, so it does not count.)
  const pending = tab.pendingAction?.type;
  if (pending && pending !== 'shell-command') return false;
  if (tab.commandType) return false;
  return true;
}
