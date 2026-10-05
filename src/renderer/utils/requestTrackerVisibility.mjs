export const REQUEST_SUCCESS_VISIBLE_MS = 4000;

export function nextRequestSuccessExpiry(timestamps, now) {
  let nearest = null;
  for (const timestamp of timestamps) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const expiry = timestamp + REQUEST_SUCCESS_VISIBLE_MS;
    if (expiry > now && (nearest === null || expiry < nearest)) nearest = expiry;
  }
  return nearest;
}
