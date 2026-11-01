import { useCallback, useEffect, useRef, useState } from 'react';
const { ipcRenderer } = window.require('electron');

export type BuildContinueTarget = {
  operationId: string; capturedAt: number; tabId: string; phase: string; state: string;
  active: boolean; reason: string | null; handoffId: string; operationKey: string;
  source?: { tabId: string; name?: string | null; projectId?: string | null; sessionId?: string | null };
  taskId?: string | null;
  relatedRequests?: { runId: string; runKind: string; externalResearchJobId?: string | null }[];
  proofWait?: { stage: string; reason: string }; route: { kind: string; runId?: string };
  cancellation?: { requestId: string; acknowledgedAt?: number } | null;
};
export type BuildContinueCaptureIssue = {
  version: 1; kind: 'capture-unresolved'; operationId: string; tabId: string; issueId: string;
  capturedAt: number; phase: string; stage: 'capture'; reason: string;
  active: false; inputCreated: false;
  source?: BuildContinueTarget['source'];
  observation?: { taskGeneration?: number; taskTurnId?: string; watcherTurnId?: string; lifecycleGeneration?: string; writerState?: string };
  presentationDismissal?: { version: 1; kind: 'capture-unresolved'; operationId: string; tabId: string;
    issueId: string; requestId: string; acknowledgedAt: number } | null;
};
type Snapshot = { version: number; epoch: string; revision: number; tabId: string; targets: BuildContinueTarget[];
  captureIssues?: { version: number; items: BuildContinueCaptureIssue[] } };
export function useBuildContinueStatus(tabId: string) {
  const [state, setState] = useState<{ targets: BuildContinueTarget[]; captureIssues: BuildContinueCaptureIssue[];
    error: string | null; known: boolean }>({ targets: [], captureIssues: [], error: null, known: false });
  const ownerRef = useRef<object | null>(null);
  const requests = useRef(new Map<string, string>());
  const applyRef = useRef<((snapshot: Snapshot) => void) | null>(null);
  useEffect(() => {
    const owner = {}; ownerRef.current = owner;
    let latest: Snapshot | null = null;
    const retiredEpochs = new Set<string>();
    setState({ targets: [], captureIssues: [], error: null, known: false });
    const apply = (snapshot: Snapshot) => {
      if (ownerRef.current !== owner || snapshot?.version !== 1 || snapshot.tabId !== tabId || !Array.isArray(snapshot.targets)) return;
      if (retiredEpochs.has(snapshot.epoch)) return;
      if (latest && latest.epoch === snapshot.epoch && latest.revision > snapshot.revision) return;
      if (latest && latest.epoch !== snapshot.epoch) retiredEpochs.add(latest.epoch);
      const captureIssues = snapshot.captureIssues?.version === 1 && Array.isArray(snapshot.captureIssues.items)
        ? snapshot.captureIssues.items.filter(issue => issue?.version === 1 && issue.kind === 'capture-unresolved'
          && issue.tabId === tabId && issue.active === false && issue.inputCreated === false
          && typeof issue.operationId === 'string' && /^[a-f0-9]{64}$/.test(issue.issueId)) : [];
      latest = snapshot; setState({ targets: snapshot.targets, captureIssues, error: null, known: true });
    };
    applyRef.current = apply;
    const changed = (_event: unknown, snapshot: Snapshot) => apply(snapshot);
    ipcRenderer.on('build-continue:status', changed);
    void ipcRenderer.invoke('build-continue:status-for-tab', tabId).then((snapshot: Snapshot) => {
      // A live event that arrived while GET was pending owns the newer view.
      if (!latest) apply(snapshot);
    }).catch((error: Error) => { if (ownerRef.current === owner && !latest) setState(previous => ({ ...previous, error: error.message })); });
    return () => { if (ownerRef.current === owner) { ownerRef.current = null; applyRef.current = null; } ipcRenderer.removeListener('build-continue:status', changed); };
  }, [tabId]);
  const dismissCapture = useCallback(async (issue: BuildContinueCaptureIssue) => {
    const owner = ownerRef.current;
    if (!owner || issue.tabId !== tabId || issue.kind !== 'capture-unresolved') return;
    const key = 'capture:' + JSON.stringify([issue.operationId, tabId, issue.issueId]);
    const requestId = requests.current.get(key) || crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const result = await ipcRenderer.invoke('build-continue:dismiss-capture', { version: 1,
        operationId: issue.operationId, tabId, issueId: issue.issueId, requestId });
      const ack = result?.acknowledgement;
      if (result?.ok !== true || ack?.version !== 1 || ack.kind !== 'capture-unresolved'
        || ack.operationId !== issue.operationId || ack.tabId !== tabId || ack.issueId !== issue.issueId
        || ack.requestId !== requestId || !Number.isFinite(ack.acknowledgedAt) || ack.acknowledgedAt <= 0
        || result.snapshot?.version !== 1 || result.snapshot.tabId !== tabId
        || result.snapshot.captureIssues?.version !== 1 || !Array.isArray(result.snapshot.captureIssues.items)
        || result.snapshot.captureIssues.items.some((entry: BuildContinueCaptureIssue) => entry.operationId === issue.operationId
          && entry.tabId === tabId && entry.issueId === issue.issueId && !entry.presentationDismissal)) {
        throw Error(result?.error || 'Закрытие уведомления не подтверждено');
      }
      if (ownerRef.current === owner) applyRef.current?.(result.snapshot);
    } catch (error) { if (ownerRef.current === owner) setState(previous => ({ ...previous, error: String((error as Error).message) })); }
  }, [tabId]);
  const cancel = useCallback(async (target: BuildContinueTarget) => {
    const owner = ownerRef.current, key = target.operationId + ':' + target.handoffId;
    const requestId = requests.current.get(key) || target.cancellation?.requestId || crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const result = await ipcRenderer.invoke('build-continue:cancel-target', { operationId: target.operationId,
        requestId, tabId, handoffId: target.handoffId, operationKey: target.operationKey });
      if (result?.ok !== true) throw Error(result?.error || 'Отмена продолжения не подтверждена');
      const saved = result.snapshot?.targets?.find((entry: BuildContinueTarget) => entry.operationId === target.operationId
        && entry.tabId === tabId && entry.handoffId === target.handoffId && entry.operationKey === target.operationKey);
      if (result.snapshot?.tabId !== tabId || saved?.cancellation?.requestId !== requestId
        || !saved.cancellation.acknowledgedAt) throw Error('Отмена продолжения не подтверждена');
      if (ownerRef.current === owner && result.snapshot?.tabId === tabId) applyRef.current?.(result.snapshot);
    } catch (error) { if (ownerRef.current === owner) setState(previous => ({ ...previous, error: String((error as Error).message) })); }
  }, [tabId]);
  return { ...state, cancel, dismissCapture };
}
