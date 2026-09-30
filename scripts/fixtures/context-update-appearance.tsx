import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import TabBar from '../../src/renderer/components/Workspace/TabBar';
import PaneTabChip from '../../src/renderer/components/Workspace/PaneTabChip';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { buildPromptChipWrapper } from '../../src/renderer/utils/composerChips.mjs';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';

const { ipcRenderer } = window.require('electron');
const tabId = 'context-appearance-tab', projectId = 'context-appearance-project';
const sessionId = 'context-appearance-session', cwd = '/synthetic';
const update = {
  id: 'context-appearance-update', title: 'Рабочее состояние · 2 участка · 31 строка',
  text: 'Точный текст обновления. Файл уже изменён другой вкладкой.',
  kind: 'message', status: 'pending', createdAt: 1,
};
const ordinary = { id: 'ordinary-prompt', kind: 'prompt', label: 'Обычный промпт', text: 'Обычный промпт.' };
const wrapper = buildPromptChipWrapper({ label: update.title, text: update.text, contextUpdateId: update.id });
let context = { tabId, responsibility: '', revision: 1, files: [], updates: [update], pendingCount: 1 };
const entries = [{ uuid: 'sent-context', role: 'user', sessionId,
  timestamp: new Date(1700000000000).toISOString(),
  content: wrapper + '\n\n' + buildPromptChipWrapper(ordinary) + '\n\nПроверь текущую реализацию.' },
{ uuid: 'answer', role: 'assistant', sessionId, timestamp: new Date(1700000001000).toISOString(),
  content: 'Рабочее состояние принято. Проверяю изменения.' }];
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
const publish = () => {
  context = { ...context, revision: context.revision + 1, pendingCount: context.updates.length };
  ipcRenderer.emit('tab-work-context:changed', {}, context);
};
ipcRenderer.invoke = async (channel: string, payload: any, ...rest: any[]) => {
  if (channel === 'tab-work-context:get') return { success: true, context };
  if (channel === 'tab-work-context:delivered-update') return { success: true, update };
  if (channel === 'tab-work-context:dismiss' || channel === 'tab-work-context:delete') {
    context = { ...context, updates: [] }; publish(); return { success: true, context };
  }
  if (channel === 'tab-work-context:restore-dismissed') {
    context = { ...context, updates: [update] }; publish(); return { success: true, context };
  }
  if (channel === 'agent-transcript:get-history') return { success: true, entries,
    revision: { sources: [{ sessionId, fileIdentity: 'fixture', linkKind: 'end' }] } };
  if (channel === 'agent-transcript:subscribe' || channel === 'agent-transcript:unsubscribe') return { success: true };
  if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
  if (channel === 'agent-activity:get-tab-timing') return { success: true, timing: null };
  if (channel === 'agent-session:get-availability-batch') return { success: true,
    results: (payload.sessions || []).map((s: any) => ({ ...s, state: 'available', historyState: 'available', checkedAt: Date.now() })) };
  return invoke(channel, payload, ...rest);
};
const geometry = { ...useUIStore.getState().tabGeometry, gap: 4, paddingY: 3, paddingX: 6, paddingLeft: 16 };
useUIStore.setState({ terminalHistoryStreamingEnabled: false, historyFontSize: 16, tabsFontSize: 14,
  tabGeometry: geometry, promptSummaryGlobalAuto: false } as any);
useWorkspaceStore.setState({ activeProjectId: projectId, focusedProjectId: projectId,
  openProjects: new Map([[projectId, { projectId, projectPath: cwd,
    tabs: new Map([[tabId, { id: tabId, name: 'Рабочая вкладка', cwd, color: 'codex', commandType: 'codex',
      tabType: 'terminal', codexSessionId: sessionId, sessionStatus: 'working', aiBusy: false,
      codexLiveSettingsSessionId: sessionId, codexLiveServiceTierSessionId: sessionId, codexLiveServiceTier: 'fast',
      taskPlan: { items: [{ id: 'task-1', title: 'Проверка задачи' }, { id: 'task-2', title: 'Следующая задача' }], archivedItems: [] },
    }]]), activeTabId: tabId, currentView: 'terminal', selectedTabIds: [], tabGroups: [],
  }]]) } as any);
const reset = () => flushSync(() => {
  context = { ...context, updates: [update] }; publish();
  useUIStore.getState().setHistoryPromptDraft(tabId, 'Черновик пользователя', { chips: [ordinary] as any });
});
reset();
(window as any).fixture = { ready: false, tabId, reset, wrapper,
  geometry(gap: number, fontSize: number, paddingY = 3) {
    flushSync(() => useUIStore.setState({ tabsFontSize: fontSize, tabGeometry: { ...geometry, gap, paddingY } }));
  },
  processSide(position: 'left' | 'right') {
    flushSync(() => useUIStore.setState({ processBar: { ...useUIStore.getState().processBar, position } }));
  },
  seedContextMeter() {
    ipcRenderer.emit('codex:context-update', {}, { tabId, sessionId, contextPct: 84 });
  },
  restored() {
    flushSync(() => {
      context = { ...context, updates: [] }; publish();
      useUIStore.getState().setHistoryPromptDraft(tabId, 'Восстановленный черновик', { chips: [
        { id: 'restored-update', kind: 'prompt', label: update.title, text: update.text, contextUpdateId: update.id }, ordinary,
      ] as any });
    });
  },
};
createRoot(document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
  <div data-fixture-pane style={{ padding: '12px 18px', minHeight: 54 }}>
    <PaneTabChip projectId={projectId} tabId={tabId} shown paneFocused paneIndex={null} inSplit={false}
      sharedActivity={{ processStatus: new Map([[tabId, true]]), busyTabs: new Map(), pasteBusyTabs: new Map() }} />
  </div>
  <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
    <div data-fixture-sidebar style={{ width: 235, flexShrink: 0, background: '#252526' }}>
      <TabBar projectId={projectId} layout="vertical" sharedProcessStatus={new Map([[tabId, true]])}
        sharedBusyTabs={new Map()} sharedPasteBusyTabs={new Map()} />
    </div>
    <div data-fixture-history style={{ position: 'relative', minWidth: 0, flex: 1 }}>
      <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={620} notesPanelWidth={0}
        isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType="codex" presented preservePresentationGeometry
        onInitialSourceSignal={d => { if (d.phase === 'load' && d.status === 'success') (window as any).fixture.ready = true; }} />
    </div>
  </div>
</div>);
