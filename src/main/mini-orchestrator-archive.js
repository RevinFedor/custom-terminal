'use strict';

// Presentation only. Never restores enabled/job/pendingSend/ledger, never
// grants an archived source a current Main writer or automatic input right.
function normalizeMiniReviewArchive(value, tabId) {
  if (value == null) return null;
  if (!value || value.version !== 1 || value.tabId !== tabId || value.completed !== true
    || !value.source || typeof value.source.sessionId !== 'string' || !value.source.sessionId
    || typeof value.source.turnId !== 'string' || !value.source.turnId
    || !['codex', 'claude'].includes(value.source.provider)
    || !Array.isArray(value.entries) || value.entries.length > 24) throw Error('mini_archive_invalid');
  let total = 0;
  const entries = value.entries.map(entry => {
    if (!entry || !['instruction', 'request', 'answer', 'review', 'tool'].includes(entry.type)
      || typeof entry.id !== 'string' || typeof entry.text !== 'string'
      || entry.text.length > 250000 || (total += entry.text.length) > 750000) throw Error('mini_archive_invalid');
    if (entry.type === 'tool' && (entry.name !== 'read_review_iteration' || entry.status !== 'read')) throw Error('mini_archive_write_tool_forbidden');
    return JSON.parse(JSON.stringify(entry));
  });
  if (!entries.some(e => e.type === 'instruction') || !entries.some(e => e.type === 'request')
    || !entries.some(e => e.type === 'answer') || !entries.some(e => e.type === 'review')) throw Error('mini_archive_incomplete');
  const source = value.source;
  const reviewSource = Object.fromEntries(['provider', 'sessionId', 'turnId', 'generation', 'answerId', 'jobId']
    .filter(key => typeof source[key] === 'string').map(key => [key, source[key].slice(0, 240)]));
  reviewSource.requestIds = Array.isArray(source.requestIds) ? source.requestIds.filter(x => typeof x === 'string').slice(0, 16).map(x => x.slice(0, 240)) : [];
  reviewSource.verificationNotes = Array.isArray(source.verificationNotes) ? source.verificationNotes.filter(x => typeof x === 'string').slice(0, 8).map(x => x.slice(0, 240)) : [];
  return { entries, reviewSource: { ...reviewSource, archived: true } };
}

module.exports = { normalizeMiniReviewArchive };
