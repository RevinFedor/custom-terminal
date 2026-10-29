'use strict';

// The V8 12.0 DateParser grammar, consumed from the immutable UTF-16 leaf.
// Adapted from V8 dateparser{,-inl}.{h,cc}; see history-paged-date.LICENSE.
// The scanner owns one text window and one three-scalar lookahead token. The
// composers have exactly 3 date / 4 time slots. Neither a word, a comment nor
// a numeral is accumulated. Numeric token length and the first NINE significant
// digits are deliberately separate, including V8's legacy millisecond rule.
const text = require('./history-paged-text');
const NONE = 0x7fffffff;
const SMI_MAX = process.config.variables.v8_enable_pointer_compression || ['ia32', 'arm'].includes(process.arch)
  ? 0x3fffffff : 0x7fffffff;
const END = -1, SYMBOL = -2, NUMBER = -3, SPACE = -4, UNKNOWN = -5, INVALID = -6;
const MONTH = 1, ZONE = 2, TIME = 3, AMPM = 4;
const between = (n, a, b) => n >= a && n <= b;
const digit = c => c >= '0' && c <= '9';
const space = c => /[\t\v\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/u.test(c || '');
const words = [
  ['jan', MONTH, 1], ['feb', MONTH, 2], ['mar', MONTH, 3], ['apr', MONTH, 4],
  ['may', MONTH, 5], ['jun', MONTH, 6], ['jul', MONTH, 7], ['aug', MONTH, 8],
  ['sep', MONTH, 9], ['oct', MONTH, 10], ['nov', MONTH, 11], ['dec', MONTH, 12],
  ['am', AMPM, 0], ['pm', AMPM, 12], ['ut', ZONE, 0], ['utc', ZONE, 0],
  ['z', ZONE, 0], ['gmt', ZONE, 0], ['cdt', ZONE, -5], ['cst', ZONE, -6],
  ['edt', ZONE, -4], ['est', ZONE, -5], ['mdt', ZONE, -6], ['mst', ZONE, -7],
  ['pdt', ZONE, -7], ['pst', ZONE, -8], ['t', TIME, 0],
];
const token = (kind, value = -1, length = 0) => ({ kind, value, length });
function scanner(value) {
  const r = text.reader(value); let at = 0;
  const char = () => r.at(at) || '\0';
  const scan = () => {
    let c = char(), begin = at;
    if (c === '\0') return token(END);
    if (digit(c)) {
      let n = 0, significant = 0;
      while (char() === '0') at++;
      while (digit(char())) { if (significant++ < 9) n = n * 10 + char().charCodeAt(0) - 48; at++; }
      return token(NUMBER, n, at - begin);
    }
    if (':-+.)'.includes(c)) { at++; return token(SYMBOL, c, 1); }
    if (c >= 'A' && !space(c)) {
      let prefix = '';
      while ((c = char()) >= 'A' && !space(c)) {
        if (prefix.length < 3) prefix += c >= 'A' && c <= 'Z' ? c.toLowerCase() : c;
        at++;
      }
      const length = at - begin;
      for (const [name, kind, n] of words) if (prefix === name && (length <= 3 || kind === MONTH)) return token(kind, n, length);
      return token(0, 0, length);
    }
    if (/\s/u.test(c)) { at++; return token(SPACE, -1, 1); }
    if (c === '(') {
      let balance = 0;
      do { c = char(); if (c === ')') balance--; else if (c === '(') balance++; at++; }
      while (balance > 0 && char() !== '\0');
      return token(UNKNOWN);
    }
    at++; return token(UNKNOWN);
  };
  let next = scan();
  return { peek: () => next, next() { const out = next; next = scan(); return out; },
    skip(c) { if (next.kind !== SYMBOL || next.value !== c) return false; next = scan(); return true; } };
}
const sign = t => t.kind === SYMBOL && (t.value === '+' || t.value === '-');
const zulu = t => t.kind === ZONE && t.length === 1 && t.value === 0;
function milliseconds(t) {
  if (t.length < 3) return t.value * (t.length === 1 ? 100 : 10);
  return Math.trunc(t.value / 10 ** (Math.min(9, t.length) - 3));
}
function parsePagedDate(value) {
  const arena = text.info(value)?.arena;
  if (arena) {
    arena.metrics.dateParses = (arena.metrics.dateParses || 0) + 1;
    arena.metrics.maxDateTokenChars = 3;
    arena.metrics.maxDateNativeSlots = 7;
  }
  const s = scanner(value), day = [], time = [];
  let namedMonth = NONE, iso = false, hourOffset = NONE;
  let tzSign = NONE, tzHour = NONE, tzMinute = NONE;
  const addDay = n => day.length < 3 ? (day.push(n), true) : false;
  const addTime = n => time.length < 4 ? (time.push(n), true) : false;
  const finalTime = n => { if (!addTime(n)) return false; while (time.length < 4) time.push(0); return true; };
  const expectsTime = n => time.length === 1 || time.length === 2 ? between(n, 0, 59) : time.length === 3 && between(n, 0, 999);
  const setZone = n => { tzSign = n < 0 ? -1 : 1; tzHour = n * tzSign; tzMinute = 0; };
  const fixed = n => s.peek().kind === NUMBER && s.peek().length === n;
  const invalid = () => token(INVALID);
  function es5() {
    if (sign(s.peek())) {
      const t = s.next();
      if (!fixed(6)) return t;
      const year = s.next().value;
      if (t.value === '-' && year === 0) return t;
      addDay((t.value === '-' ? -1 : 1) * year);
    } else if (fixed(4)) addDay(s.next().value);
    else return s.next();
    if (s.skip('-')) {
      if (!fixed(2) || !between(s.peek().value, 1, 12)) return s.next();
      addDay(s.next().value);
      if (s.skip('-')) {
        if (!fixed(2) || !between(s.peek().value, 1, 31)) return s.next();
        addDay(s.next().value);
      }
    }
    if (s.peek().kind !== TIME) { if (s.peek().kind !== END) return s.next(); }
    else {
      s.next();
      if (!fixed(2) || !between(s.peek().value, 0, 24)) return invalid();
      const h24 = s.peek().value === 24;
      addTime(s.next().value);
      if (!s.skip(':') || !fixed(2) || !between(s.peek().value, 0, 59) || h24 && s.peek().value > 0) return invalid();
      addTime(s.next().value);
      if (s.skip(':')) {
        if (!fixed(2) || !between(s.peek().value, 0, 59) || h24 && s.peek().value > 0) return invalid();
        addTime(s.next().value);
        if (s.skip('.')) {
          if (s.peek().kind !== NUMBER || h24 && s.peek().value > 0) return invalid();
          addTime(milliseconds(s.next()));
        }
      }
      if (zulu(s.peek())) { s.next(); setZone(0); }
      else if (sign(s.peek())) {
        tzSign = s.next().value === '+' ? 1 : -1;
        if (fixed(4)) {
          const n = s.next().value, h = Math.trunc(n / 100), m = n % 100;
          if (!between(h, 0, 23) || !between(m, 0, 59)) return invalid();
          tzHour = h; tzMinute = m;
        } else {
          if (!fixed(2) || !between(s.peek().value, 0, 23)) return invalid();
          tzHour = s.next().value;
          if (!s.skip(':') || !fixed(2) || !between(s.peek().value, 0, 59)) return invalid();
          tzMinute = s.next().value;
        }
      }
      if (s.peek().kind !== END) return invalid();
    }
    if (tzHour === NONE && time.length === 0) setZone(0);
    iso = true; return token(END);
  }
  let t = es5(), hasNumber = day.length > 0;
  if (t.kind === INVALID) return NaN;
  for (; t.kind !== END; t = s.next()) {
    if (t.kind === NUMBER) {
      hasNumber = true; const n = t.value;
      if (s.skip(':')) {
        if (s.skip(':')) { if (time.length) return NaN; addTime(n); addTime(0); }
        else { if (!addTime(n)) return NaN; s.skip('.'); }
      } else if (s.skip('.') && expectsTime(n)) {
        addTime(n); if (s.peek().kind !== NUMBER) return NaN;
        const ms = milliseconds(s.next()); if (ms < 0) return NaN; finalTime(ms);
      } else if (tzHour !== NONE && tzMinute === NONE && between(n, 0, 59)) tzMinute = n;
      else if (expectsTime(n)) {
        finalTime(n); const p = s.peek();
        if (p.kind !== END && p.kind !== SPACE && !zulu(p) && !sign(p)) return NaN;
      } else { if (!addDay(n)) return NaN; s.skip('-'); }
    } else if (t.kind >= 0) {
      if (t.kind === AMPM && time.length) hourOffset = t.value;
      else if (t.kind === MONTH) { namedMonth = t.value; s.skip('-'); }
      else if (t.kind === ZONE && hasNumber) setZone(t.value);
      else if (hasNumber || s.peek().kind === NUMBER) return NaN;
    } else if (sign(t) && (tzHour === 0 && tzMinute === 0 || time.length)) {
      tzSign = t.value === '+' ? 1 : -1;
      let n = 0, length = 0;
      if (s.peek().kind === NUMBER) { const next = s.next(); n = next.value; length = next.length; }
      hasNumber = true;
      if (s.peek().kind === SYMBOL && s.peek().value === ':') { tzHour = n; tzMinute = NONE; }
      else if (length === 1 || length === 2) { tzHour = n; tzMinute = 0; }
      else if (length === 3 || length === 4) { tzHour = Math.trunc(n / 100); tzMinute = n % 100; }
      else return NaN;
    } else if ((sign(t) || t.kind === SYMBOL && t.value === ')') && hasNumber) return NaN;
  }
  if (!day.length) return NaN;
  while (day.length < 3) day.push(1);
  let year = 0, month, date;
  if (namedMonth === NONE) {
    if (iso || !between(day[0], 1, 31)) [year, month, date] = day;
    else [month, date, year] = day;
  } else {
    month = namedMonth;
    if (!between(day[0], 1, 31)) { year = day[0]; date = day[1]; }
    else { date = day[0]; year = day[1]; }
  }
  if (!iso) { if (between(year, 0, 49)) year += 2000; else if (between(year, 50, 99)) year += 1900; }
  if (!between(year, -SMI_MAX - 1, SMI_MAX) || !between(month, 1, 12) || !between(date, 1, 31)) return NaN;
  while (time.length < 4) time.push(0);
  let [h, m, sec, ms] = time;
  if (hourOffset !== NONE) { if (!between(h, 0, 12)) return NaN; h = h % 12 + hourOffset; }
  if ((!between(h, 0, 23) || !between(m, 0, 59) || !between(sec, 0, 59) || !between(ms, 0, 999))
    && !(h === 24 && m === 0 && sec === 0 && ms === 0)) return NaN;
  if (tzSign === NONE) {
    // The runtime still owns local timezone/DST rules. A canonical constant-
    // size spelling carries the parsed fields, never the original History.
    if (Math.abs(year) > 999999) return NaN;
    const y = year >= 0 && year <= 9999 ? String(year).padStart(4, '0')
      : (year < 0 ? '-' : '+') + String(Math.abs(year)).padStart(6, '0');
    const two = n => String(n).padStart(2, '0');
    const canonical = y + '-' + two(month) + '-' + two(date) + 'T' + two(h) + ':' + two(m) + ':' + two(sec) + '.' + String(ms).padStart(3, '0');
    if (arena) arena.metrics.maxDateNativeInputChars = Math.max(arena.metrics.maxDateNativeInputChars || 0, canonical.length);
    return Date.parse(canonical);
  }
  const offset = (((tzHour === NONE ? 0 : tzHour) * 3600 + (tzMinute === NONE ? 0 : tzMinute) * 60) >>> 0);
  if (offset > SMI_MAX) return NaN;
  // Gregorian civil day -> Unix day, without Date.UTC's 0..99-year adjustment
  // or an intermediate TimeClip before subtracting the zone offset.
  const y = year - (month <= 2 ? 1 : 0), era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + date - 1;
  const days = era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  const result = days * 86400000 + ((h * 60 + m) * 60 + sec - tzSign * offset) * 1000 + ms;
  return Math.abs(result) <= 8640000000000000 ? result + 0 : NaN;
}
function parseDate(value) {
  if (text.isPagedText(value)) return parsePagedDate(value);
  const arena = require('./history-projection-arena').projectionArenaOf(value);
  if (arena) { const string = text.coerce(value); return text.isPagedText(string) ? parsePagedDate(string) : Date.parse(string); }
  return Date.parse(value);
}
module.exports = { parseDate, parsePagedDate };
