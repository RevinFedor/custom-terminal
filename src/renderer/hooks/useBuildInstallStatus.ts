import { useEffect, useState, useCallback } from 'react';
import { mergeBuildInstallJobs } from '../utils/buildInstallPresentation.mjs';
const { ipcRenderer } = window.require('electron');

export type BuildInstallJob = {
  id: string; requestId: string; revision?: number; startedAt: number; phase: string; stage?: string;
  force?: boolean; running: boolean; ok: boolean | null; cancelled?: boolean; error?: string | null;
  installOutcomeUnknown?: boolean; returnTo?: { tabId: string; sessionId?: string };
  callback?: { status: string; error?: string }; wait?: { blockers?: { tabId: string; name?: string; kind?: string }[]; preservedExternalWaits?: unknown[] };
  interruptionReport?: { tabs: unknown[]; mcp: unknown[]; unknown: string[] };
  continuation?: { requestId: string; jobId: string; fingerprint: string; state: string;
    inheritedActive?: boolean; canCancelContinuation?: boolean } | null;
};
export function useBuildInstallStatus(tabId: string) {
  const [state, setState] = useState<{ jobs: BuildInstallJob[]; stale: boolean; error: string | null }>({ jobs: [], stale: true, error: null });
  useEffect(() => {
    let alive = true, epoch: string | null = null, publication = -1;
    let projectionEpoch: string | null = null, projectionRevision = -1;
    setState({ jobs: [], stale: true, error: null });
    const apply = (snapshot: any) => {
      if (!alive || snapshot?.version !== 1) return;
      if (snapshot.projection) {
        if (projectionEpoch === snapshot.projection.epoch && snapshot.projection.revision < projectionRevision) return;
        projectionEpoch = snapshot.projection.epoch; projectionRevision = snapshot.projection.revision;
      } else if (projectionEpoch) return;
      if (epoch === snapshot.epoch && snapshot.publication < publication) return;
      epoch = snapshot.epoch; publication = snapshot.publication;
      setState(previous => {
        const jobs = mergeBuildInstallJobs(previous.jobs, snapshot.jobs || [], tabId);
        const stale = snapshot.stale !== false, error = snapshot.error || null;
        return jobs === previous.jobs && stale === previous.stale && error === previous.error ? previous : { jobs, stale, error };
      });
    };
    const changed = (_event: unknown, snapshot: any) => apply(snapshot);
    ipcRenderer.on('build-install:status', changed);
    void ipcRenderer.invoke('build-install:status-for-tab', tabId).then(apply)
      .catch((error: Error) => { if (alive) setState(previous => ({ ...previous, stale: true, error: error.message })); });
    return () => { alive = false; ipcRenderer.removeListener('build-install:status', changed); };
  }, [tabId]);
  const cancel = useCallback(async (job: BuildInstallJob) => {
    try { await ipcRenderer.invoke('build-install:cancel', { tabId, id: job.id, requestId: job.requestId,
      ...(!job.running && job.continuation?.canCancelContinuation ? {
        action: 'cancel-continuation', fingerprint: job.continuation.fingerprint } : {}) }); }
    catch (error) { setState(previous => ({ ...previous, error: String((error as Error).message) })); }
  }, [tabId]);
  return { ...state, cancel };
}
