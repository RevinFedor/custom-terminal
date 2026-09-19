export function applyHistoryPresenceProjection({
  presence,
  setStatus,
  publishRuntimeSnapshot,
  onProjectionError,
}) {
  const status = presence?.status || 'unknown';
  setStatus(status);
  try {
    publishRuntimeSnapshot?.(presence?.runtimeSnapshot || null);
    return { status, projectionError: null };
  } catch (error) {
    onProjectionError?.(error);
    // A secondary presentation projection is not lifecycle evidence. Keep the
    // successful main-owned status instead of turning it into `unknown`.
    return { status, projectionError: error };
  }
}
