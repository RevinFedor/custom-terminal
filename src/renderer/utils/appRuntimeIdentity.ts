type AppRuntimeIdentity = {
  instanceId: string;
  startedAt: number;
  pid: number;
};

let identityPromise: Promise<AppRuntimeIdentity> | null = null;

export function getAppRuntimeIdentity(): Promise<AppRuntimeIdentity> {
  if (identityPromise) return identityPromise;
  const { ipcRenderer } = window.require('electron');
  identityPromise = ipcRenderer.invoke('app:get-runtime-identity').then((value: unknown) => {
    const raw = value as Partial<AppRuntimeIdentity> | null;
    const instanceId = typeof raw?.instanceId === 'string' ? raw.instanceId.trim() : '';
    const startedAt = Number(raw?.startedAt);
    const pid = Number(raw?.pid);
    if (!instanceId || !Number.isFinite(startedAt) || !Number.isFinite(pid)) {
      throw new Error('app_runtime_identity_unavailable');
    }
    return { instanceId, startedAt, pid };
  }).catch((error: unknown) => {
    identityPromise = null;
    throw error;
  });
  return identityPromise;
}
