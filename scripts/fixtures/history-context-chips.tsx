// Controlled context transport over the real HistoryPanel fixture. No AI is
// started and no production record is read or changed by these UI checks.
import { flushSync } from 'react-dom';
import { mountHistoryPreviewFixture } from './history-preview-reading';
import { useUIStore } from '../../src/renderer/store/useUIStore';

export function mountHistoryContextChipsFixture() {
  const previousFontSize = useUIStore.getState().historyFontSize;
  const fixture = mountHistoryPreviewFixture({ composer: true });
  const { ipcRenderer } = window.require('electron');
  const originalInvoke = ipcRenderer.invoke;
  const label = 'History сохраняет читаемую запись при замене preview';
  const body = 'Полный текст обновления остаётся доступен по клику. Ничего не отправляем агенту.';
  let context = {
    tabId: fixture.tabId, responsibility: '', revision: 100, files: [],
    updates: [] as any[], pendingCount: 0,
  };
  const publish = () => {
    context = { ...context, revision: context.revision + 1, pendingCount: context.updates.length };
    ipcRenderer.emit('tab-work-context:changed', {}, context);
  };
  ipcRenderer.invoke = async (channel: string, payload: any, ...rest: any[]) => {
    if (payload?.tabId === fixture.tabId) {
      if (channel === 'tab-work-context:get') return { success: true, context };
      if (channel === 'tab-work-context:dismiss') {
        context = { ...context, updates: context.updates.filter((item) => item.id !== payload.updateId) };
        publish();
        return { success: true, context };
      }
    }
    return originalInvoke(channel, payload, ...rest);
  };
  const caption = document.createElement('div');
  caption.textContent = `DEV: чипы рабочего контекста · ${fixture.tabId}`;
  Object.assign(caption.style, { position: 'fixed', top: '36px', left: '12px',
    zIndex: '1001', color: '#fff', background: '#191919', fontSize: '12px' });
  document.body.appendChild(caption);
  // Above the app, but below shipping popover portals (z-index 30000).
  Object.assign(fixture.host.style, { zIndex: '1000', left: '12px', top: '60px', height: 'calc(100vh - 72px)',
    maxWidth: 'calc(100vw - 24px)' });
  fixture.host.dataset.historyContextFixture = fixture.id;
  const reset = ({ width = 620, prompts = 1, updates = 1, fontSize = 24 } = {}) => {
    fixture.host.style.width = `${width}px`;
    context = { ...context, updates: Array.from({ length: updates }, (_, index) => ({
      id: `${fixture.id}-update-${index}`, title: index ? `Второе обновление: ${label}` : label,
      text: `${body} Пакет ${index + 1}.`, kind: 'message', status: 'pending', createdAt: index + 1,
    })) };
    flushSync(() => {
      useUIStore.setState({ historyFontSize: fontSize });
      useUIStore.getState().setHistoryPromptDraft(fixture.tabId, 'Черновик пользователя', {
        chips: Array.from({ length: prompts }, (_, index) => ({
          id: `${fixture.id}-prompt-${index}`, kind: 'prompt', text: `Обычный промпт ${index + 1}`,
          label: index ? 'Ещё один обычный промпт' : 'e2e делегирование on 5.6-luna',
        })),
      });
      publish();
    });
  };
  reset();
  return {
    id: fixture.id, tabId: fixture.tabId, host: fixture.host, label, body, reset,
    appendUpdate() {
      const index = context.updates.length;
      context = { ...context, updates: [...context.updates, {
        id: `${fixture.id}-update-${index}`, title: 'Позднее обновление', text: body,
        kind: 'message', status: 'pending', createdAt: index + 1,
      }] };
      flushSync(publish);
    },
    destroy() {
      fixture.destroy();
      caption.remove();
      ipcRenderer.invoke = originalInvoke;
      useUIStore.getState().setHistoryPromptDraft(fixture.tabId, '');
      useUIStore.setState({ historyFontSize: previousFontSize });
    },
  };
}
