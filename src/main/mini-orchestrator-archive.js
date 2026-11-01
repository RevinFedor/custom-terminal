'use strict';

// Presentation only. Never restores enabled/job/pendingSend/ledger, never
// grants an archived source a current Main writer or automatic input right.
function normalizeOneRound(source, rawEntries, tabId) {
  if (!source || typeof source.sessionId !== 'string' || !source.sessionId
    || typeof source.turnId !== 'string' || !source.turnId
    || !['codex', 'claude'].includes(source.provider)
    || !Array.isArray(rawEntries) || rawEntries.length > 24) throw Error('mini_archive_invalid');
  let total = 0;
  const entries = rawEntries.map(entry => {
    if (!entry || !['instruction', 'request', 'answer', 'review', 'tool'].includes(entry.type)
      || typeof entry.id !== 'string' || typeof entry.text !== 'string'
      || entry.text.length > 250000 || (total += entry.text.length) > 750000) throw Error('mini_archive_invalid');
    if (entry.type === 'tool' && (entry.name !== 'read_review_iteration' || entry.status !== 'read')) throw Error('mini_archive_write_tool_forbidden');
    return JSON.parse(JSON.stringify(entry));
  });
  if (!entries.some(e => e.type === 'instruction') || !entries.some(e => e.type === 'request')
    || !entries.some(e => e.type === 'answer') || !entries.some(e => e.type === 'review')) throw Error('mini_archive_incomplete');
  const reviewSource = Object.fromEntries(['provider', 'sessionId', 'turnId', 'generation', 'answerId', 'jobId']
    .filter(key => typeof source[key] === 'string').map(key => [key, source[key].slice(0, 240)]));
  reviewSource.requestIds = Array.isArray(source.requestIds) ? source.requestIds.filter(x => typeof x === 'string').slice(0, 16).map(x => x.slice(0, 240)) : [];
  if (Object.hasOwn(source, 'navigationRequestId')) {
    if (typeof source.navigationRequestId !== 'string' || source.navigationRequestId && !reviewSource.requestIds.includes(source.navigationRequestId)) throw Error('mini_archive_navigation_invalid');
    reviewSource.navigationRequestId = source.navigationRequestId;
  }
  reviewSource.verificationNotes = Array.isArray(source.verificationNotes) ? source.verificationNotes.filter(x => typeof x === 'string').slice(0, 8).map(x => x.slice(0, 240)) : [];
  return { entries, reviewSource: { ...reviewSource, archived: true } };
}
function normalizeMiniReviewArchive(value, tabId) {
  if (value == null) return null;
  if (!value || value.version !== 1 || value.tabId !== tabId || value.completed !== true) throw Error('mini_archive_invalid');
  // Multiple genuinely completed rounds of the same archived chat (request →
  // answer → Gemini critique → corrected answer → re-review) can be shown
  // together; each round keeps its own source identity and entries.
  if (Array.isArray(value.rounds)) {
    if (!value.rounds.length || value.rounds.length > 4) throw Error('mini_archive_invalid');
    const rounds = value.rounds.map((round, index) => ({ round: index + 1, ...normalizeOneRound(round.source, round.entries, tabId) }));
    const entries = rounds.flatMap(r => r.entries.map(e => ({ ...e, round: r.round })));
    const roundSources = Object.fromEntries(rounds.map(r => [r.round, r.reviewSource]));
    return { entries, reviewSource: rounds.at(-1).reviewSource, roundSources };
  }
  const single = normalizeOneRound(value.source, value.entries, tabId);
  return { entries: single.entries, reviewSource: single.reviewSource, roundSources: { 1: single.reviewSource } };
}

module.exports = { normalizeMiniReviewArchive };
