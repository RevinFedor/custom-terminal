import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import type { QueuedPrompt } from '../store/usePromptQueueStore';
import { createRewindLabelReader, rewindIteration } from '../utils/queuedRewindLabel.mjs';
import { readHistoryThroughIpc } from '../utils/historyReadTransport.mjs';

const readLabel = createRewindLabelReader(payload => readHistoryThroughIpc(
  window.require('electron').ipcRenderer.invoke.bind(window.require('electron').ipcRenderer),
  'agent-transcript:get-timeline', { ...payload, source: 'PromptQueue.rewind-label', reason: 'legacy-iteration-label', visible: false },
));

export function useQueuedRewindLabels(tabId: string, items: QueuedPrompt[], visible: boolean) {
  const [labels, setLabels] = useState<Record<string, number>>({});
  const cwd = useWorkspaceStore(state => {
    for (const workspace of state.openProjects.values()) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return tab.cwd || workspace.projectPath;
    }
    return undefined;
  });
  const key = JSON.stringify(items.filter(item => item.metaAction?.kind === 'rewind' && !rewindIteration(item.metaAction.targetIteration))
    .map(item => {
      const action = item.metaAction as Extract<NonNullable<QueuedPrompt['metaAction']>, { kind: 'rewind' }>;
      return [item.id, { targetUuid: action.targetUuid, sourceSessionId: action.sourceSessionId, toolType: action.toolType }];
    }));
  type LabelAction = { targetUuid: string; sourceSessionId: string; toolType: 'claude' | 'codex' };
  const requests = JSON.parse(key) as Array<[string, LabelAction]>;
  const identity = (action: LabelAction) => JSON.stringify([tabId, cwd, action]);
  useEffect(() => {
    const active = new Set(requests.map(([, action]) => identity(action)));
    setLabels(previous => Object.keys(previous).some(id => !active.has(id))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => active.has(id))) : previous);
    if (!visible) return;
    let disposed = false;
    for (const [, action] of requests) {
      const id = identity(action);
      void readLabel(action, { tabId, cwd }).then(iteration => {
        if (!disposed && iteration) setLabels(previous => previous[id] === iteration ? previous : { ...previous, [id]: iteration });
      }).catch(error => {
        if (!disposed) console.warn('[PromptQueue:RewindLabel] unavailable tab=' + tabId.slice(-12) + ' error=' + String(error?.code || error?.message || error));
      });
    }
    return () => { disposed = true; };
  }, [key, tabId, cwd, visible]);
  return Object.fromEntries(requests.map(([id, action]) => [id, labels[identity(action)]]));
}
