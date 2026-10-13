import { useEffect, useRef, useState } from 'react';
import { subscribeOrchestrationRunChanges } from '../store/useOrchestrationStore';
import { createResearchModelCatalog } from './researchModelCatalog.mjs';
import { uiPerformancePhase } from './uiPerformanceDiagnostics.mjs';

export type SavedResearchModels = Record<string, { model: string | null; mode: string | null; effort: string | null; label: string | null }>;
const catalog = createResearchModelCatalog();
const { ipcRenderer } = window.require('electron');

export function useResearchRunModels(tabId: string, sessionId: string | null | undefined, enabled: boolean, requiredRunIds: readonly string[] = []) {
  const owner = JSON.stringify([tabId, sessionId || '']);
  const requiredKey = JSON.stringify(requiredRunIds);
  const [snapshot, setSnapshot] = useState<{ owner: string; values: SavedResearchModels } | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const started = performance.now();
    const required = JSON.parse(requiredKey) as string[];
    void catalog.read(owner, tabId, (id: string) => ipcRenderer.invoke('orchestration:list-for-tab', id), required)
      .then((values: SavedResearchModels) => {
        uiPerformancePhase('history-research-models', { tab: tabId, ms: performance.now() - started,
          requested: required.length, known: required.filter(id => values[id]?.model).length, cancelled });
        if (!cancelled) setSnapshot({ owner, values });
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn('[Research:Presentation] saved model catalog unavailable',
          { tabId, owner, reason: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
  }, [enabled, owner, tabId, requiredKey]);
  useEffect(() => subscribeOrchestrationRunChanges(({ run }) => {
    const values = catalog.publish(owner, tabId, run);
    if (values && enabledRef.current) setSnapshot(previous => previous?.owner === owner && previous.values === values
      ? previous : { owner, values });
  }), [owner, tabId]);
  return snapshot?.owner === owner ? snapshot.values : null;
}
