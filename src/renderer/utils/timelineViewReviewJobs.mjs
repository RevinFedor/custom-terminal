// Explicit review documents are BodyOPEN authoring jobs, not Timeline cache.
// One reviewed range per tab/session survives presentation unmount. Replacing
// or explicitly closing that review releases only its own independent pin.
const reviews = new Map();
const keyFor = owner => JSON.stringify([owner.tabId, owner.sessionId, owner.cwd || '']);
export function readTimelineViewReview(owner) { return reviews.get(keyFor(owner))?.value || null; }
export function saveTimelineViewReview(owner, value) {
  const key = keyFor(owner), previous = reviews.get(key);
  if (previous?.value === value) return;
  const release = value.client.retain();
  reviews.set(key, { value, release }); void previous?.release();
}
export function clearTimelineViewReview(owner) {
  const key = keyFor(owner), previous = reviews.get(key);
  reviews.delete(key); void previous?.release();
}
