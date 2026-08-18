'use strict';

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(value) {
  return Array.from(new Set(normalizeSearchText(value)
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)));
}

function scoreSessionTurnMatch({ query, title, userText, assistantText }) {
  const phrase = normalizeSearchText(query);
  if (!phrase) return { matched: true, score: 0, matchedIn: [] };
  const titleText = normalizeSearchText(title);
  const user = normalizeSearchText(userText);
  const assistant = normalizeSearchText(assistantText);
  const tokens = queryTokens(phrase);
  const fields = [titleText, user, assistant];
  const tokenHits = tokens.map((token) => fields.some((field) => field.includes(token)));
  if (tokens.length > 0 && !tokenHits.every(Boolean)) {
    return { matched: false, score: 0, matchedIn: [] };
  }
  const matchedIn = [];
  if (titleText.includes(phrase) || tokens.some((token) => titleText.includes(token))) matchedIn.push('title');
  if (user.includes(phrase) || tokens.some((token) => user.includes(token))) matchedIn.push('user');
  if (assistant.includes(phrase) || tokens.some((token) => assistant.includes(token))) matchedIn.push('assistant');
  const phraseScore = (titleText.includes(phrase) ? 12 : 0)
    + (user.includes(phrase) ? 10 : 0)
    + (assistant.includes(phrase) ? 6 : 0);
  const tokenScore = tokens.reduce((score, token) => (
    score
      + (titleText.includes(token) ? 4 : 0)
      + (user.includes(token) ? 3 : 0)
      + (assistant.includes(token) ? 2 : 0)
  ), 0);
  return {
    matched: matchedIn.length > 0,
    score: phraseScore + tokenScore,
    matchedIn,
  };
}

function startOfLocalDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function resolveSearchDateWindow({ period, dateFrom, dateTo, now = new Date() } = {}) {
  const named = String(period || '').trim().toLowerCase();
  if (named === 'today' || named === 'yesterday') {
    const start = startOfLocalDay(now);
    if (named === 'yesterday') start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { fromMs: start.getTime(), toMs: end.getTime(), period: named };
  }
  const parse = (value) => {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    fromMs: parse(dateFrom),
    toMs: parse(dateTo),
    period: null,
  };
}

function sessionMatchesDate(candidate, {
  dateField = 'activity',
  fromMs = null,
  toMs = null,
} = {}) {
  if (!Number.isFinite(fromMs) && !Number.isFinite(toMs)) return true;
  const createdMs = Number(candidate?.createdAt || 0) * 1000;
  const closedMs = Number(candidate?.closedAt || 0) * 1000;
  const field = dateField === 'created' || dateField === 'closed' ? dateField : 'activity';
  const value = field === 'created'
    ? createdMs
    : field === 'closed'
      ? closedMs
      : (closedMs || createdMs);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (Number.isFinite(fromMs) && value < fromMs) return false;
  if (Number.isFinite(toMs) && value >= toMs) return false;
  return true;
}

module.exports = {
  normalizeSearchText,
  queryTokens,
  resolveSearchDateWindow,
  scoreSessionTurnMatch,
  sessionMatchesDate,
};
