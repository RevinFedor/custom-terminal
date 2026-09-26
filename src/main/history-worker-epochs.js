'use strict';
// A writer can invalidate while the worker is in synchronous JSON/SQLite/V8
// work. A queued postMessage alone cannot revoke that read before publication.
// Sources get distinct slots: two unrelated active sessions must not revoke
// one another just because their paths hash into the same bucket. Slot zero
// is a conservative global fallback only beyond 65K sources in one app boot.
const SLOTS = 65536;
function registerSourceEpochSlot(slots, filePath) {
  if (slots.has(filePath)) return slots.get(filePath);
  if (slots.size >= SLOTS - 1) return 0;
  const slot = slots.size + 1; slots.set(filePath, slot); return slot;
}
module.exports = { SLOTS, registerSourceEpochSlot };
