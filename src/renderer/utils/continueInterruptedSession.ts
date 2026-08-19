// «Продолжить прерванную сессию» — сама операция, отдельно от плашки, которая
// её зовёт.
//
// Она жила внутри `TerminalArea` и была доступна только оттуда: одиночному
// центру проекта. Как только та же плашка понадобилась в КАЖДОМ окне разделённой
// области, выбор был из двух — написать возобновление второй раз или вынести.
// Вторая копия разошлась бы с первой на первом же изменении: тут и защита от
// повторного запуска, и разные каналы для Claude и Codex, и 15-секундный сторож
// от чужого bridge-файла, и порядок «сначала запрос, только потом снимаем
// пометку о прерывании».
//
// Что осталось у плашки: как она выглядит, где показывается и что делает с
// кнопкой на время ожидания. Что здесь: кого и чем запускать.

import { terminalRegistry } from './terminalRegistry';
import { clearPendingResume, markPendingResume } from './pendingResume';
import { buildCodexRunPayload } from './codexLaunch';

const { ipcRenderer } = window.require('electron');

export type InterruptedEngine = 'claude' | 'codex';

// Защита от повторного запуска — на ВСЁ приложение, по вкладке.
//
// Раньше это был ref внутри компонента, и его хватало: плашка была одна. Теперь
// её рисует и центр, и каждое окно, а вкладка у них может быть одна и та же —
// значит и счёт «уже запускается» должен быть один, а не по экземпляру плашки.
const resumeInflight = new Set<string>();

/**
 * Запустить продолжение сохранённого разговора в этой вкладке.
 *
 * Пометка о прерывании снимается ТОЛЬКО после того, как запрос принят: пока
 * запуск не подтверждён, предложение продолжить должно оставаться на экране —
 * иначе отказ оставил бы вкладку без сессии и без способа её вернуть.
 */
export async function continueInterruptedSession({
  tabId,
  projectId,
  sessionId,
  engine,
  clearInterruptedState,
}: {
  tabId: string | null;
  projectId: string;
  sessionId: string | null;
  engine: InterruptedEngine | null;
  clearInterruptedState: (tabId: string) => void;
}): Promise<void> {
  if (!tabId || !sessionId || !engine) {
    console.log('[ResumeInterrupted] missing tab, engine or sessionId');
    return;
  }
  if (resumeInflight.has(tabId)) {
    console.warn('[ResumeInterrupted] already in flight for tab:', tabId);
    return;
  }
  resumeInflight.add(tabId);
  console.log('[ResumeInterrupted] sending resume tab=' + tabId.slice(-12)
    + ' engine=' + engine + ' session=' + sessionId.slice(0, 8));

  const { useWorkspaceStore } = await import('../store/useWorkspaceStore');
  useWorkspaceStore.getState().setTabCommandType(tabId, engine);

  terminalRegistry.get(tabId)?.scrollToBottom();
  terminalRegistry.get(tabId)?.focus();
  requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());

  try {
    let runResult: any;
    if (engine === 'codex') {
      const ws = useWorkspaceStore.getState().openProjects.get(projectId);
      const cwd = ws?.tabs.get(tabId)?.cwd;
      runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
        tabId,
        command: 'codex-c',
        sessionId,
        cwd,
      }));
    } else {
      // Сторож от чужого bridge-файла взводится вплотную перед подтверждённым
      // запросом и снимается, если main его отверг.
      markPendingResume(tabId, sessionId);
      const tabCwd = useWorkspaceStore.getState().openProjects.get(projectId)?.tabs.get(tabId)?.cwd;
      runResult = await ipcRenderer.invoke('claude:run-command', {
        tabId,
        command: 'claude-c',
        sessionId,
        ...(tabCwd ? { cdTo: tabCwd } : {}),
      });
    }
    if (runResult?.success === false || runResult?.accepted === false) {
      if (engine === 'claude') clearPendingResume(tabId);
      console.warn('[ResumeInterrupted] rejected tab=' + tabId.slice(-12)
        + ' engine=' + engine
        + ' error=' + (runResult?.error || runResult?.reason || 'unknown'));
      return;
    }
    clearInterruptedState(tabId);
  } catch (error: any) {
    if (engine === 'claude') clearPendingResume(tabId);
    console.warn('[ResumeInterrupted] failed tab=' + tabId.slice(-12)
      + ' engine=' + engine
      + ' error=' + (error?.message || String(error)));
  } finally {
    resumeInflight.delete(tabId);
  }
}
