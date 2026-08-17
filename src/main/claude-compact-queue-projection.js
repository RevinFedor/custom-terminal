'use strict';

function normalizeQueuedCompactText(value) {
  return String(value || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\[200~/g, '')
    .replace(/~\]/g, '')
    .trim();
}

function isExactQueuedCompact(value) {
  return normalizeQueuedCompactText(value) === '/compact';
}

function promoteQueuedCompactEntry(pendingEntries, entry, options = {}) {
  if (!Array.isArray(pendingEntries) || !entry || !isExactQueuedCompact(entry.content)) return null;
  const index = pendingEntries.indexOf(entry);
  if (index < 0) return null;
  pendingEntries.splice(index, 1);
  entry.role = 'slash';
  entry.content = '/compact';
  delete entry.queueStatus;
  entry.compactDeliverySettled = true;
  entry.compactDeliveryReason = String(options.reason || 'accepted');
  return entry;
}

function promotePendingCompactEntry(pendingEntries, options = {}) {
  if (!Array.isArray(pendingEntries) || pendingEntries.length === 0) return null;
  const sessionId = String(options.sessionId || '');
  const direction = options.direction === 'last' ? -1 : 1;
  let index = direction > 0 ? 0 : pendingEntries.length - 1;
  for (; index >= 0 && index < pendingEntries.length; index += direction) {
    const entry = pendingEntries[index];
    if (!entry || !isExactQueuedCompact(entry.content)) continue;
    if (entry.queueStatus === 'cancelled') continue;
    if (sessionId && entry.sessionId && entry.sessionId !== sessionId) continue;
    return promoteQueuedCompactEntry(pendingEntries, entry, options);
  }
  return null;
}

function promoteAllPendingCompactEntries(pendingEntries, options = {}) {
  const promoted = [];
  while (true) {
    const entry = promotePendingCompactEntry(pendingEntries, options);
    if (!entry) return promoted;
    promoted.push(entry);
  }
}

module.exports = {
  isExactQueuedCompact,
  normalizeQueuedCompactText,
  promoteAllPendingCompactEntries,
  promotePendingCompactEntry,
  promoteQueuedCompactEntry,
};
