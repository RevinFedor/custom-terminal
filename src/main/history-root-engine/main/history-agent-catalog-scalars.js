// Catalog-local cooperative copies of the existing numeric/date grammars.
// Global canonical reader helpers are deliberately unchanged. Date grammar
// attribution/license: history-paged-date.LICENSE.
'use strict';

const { createJsonNumber, SIGNIFICANT_DIGITS } = require('./history-json-number');
const text = require('./history-paged-text');

// Number(String) without a token-sized primitive. Grammar validation consumes
// the entire value even after overflow/underflow; an invalid late suffix is
// NaN, not Infinity. Decimal rounding reuses the ingestion converter.
function* numericValue(value) {
  const work=this.work.bind(this);
  if (!text.isPagedText(value)) {
    // Native DTOs retain native ToPrimitive. Rooted owners perform the same
    // valueOf-before-toString ordering without crossing the String façade.
    if (!require('./history-projection-arena').projectionArenaOf(value)) return Number(value);
    const converted = text.primitive(value, 'number');
    if (!text.isPagedText(converted)) return Number(converted);
    value = converted;
  }
  const arena = text.info(value).arena;
  const r = text.reader(value);
  let start = 0, end = value.length;
  while (start < end && /\s/u.test(r.at(start))) {yield* work('scalar-step');start++;}
  while (end > start && /\s/u.test(r.at(end - 1))) {yield* work('scalar-step');end--;}
  arena.metrics.maxNumericScratchChars = Math.max(arena.metrics.maxNumericScratchChars || 0, SIGNIFICANT_DIGITS + 32);
  arena.metrics.numericTextUnits = (arena.metrics.numericTextUnits || 0) + value.length;
  if (start === end) return 0;
  let at = start, negative = false, signed = false;
  if (r.at(at) === '+' || r.at(at) === '-') { signed = true; negative = r.at(at++) === '-'; }
  if (end - at === 8 && value.startsWith('Infinity', at)) return negative ? -Infinity : Infinity;
  if (!signed && r.at(at) === '0' && /[xXoObB]/.test(r.at(at + 1) || '')) {
    const base = r.at(at + 1).toLowerCase(), bitsPerDigit = base === 'x' ? 4 : base === 'o' ? 3 : 1;
    const radix = 1 << bitsPerDigit;
    at += 2;
    if (at === end) return NaN;
    // A binary64 integer needs 53 significant bits, a guard bit, and sticky.
    // No BigInt proportional to the token is ever constructed.
    let head = 0n, bits = 0, sticky = false;
    for (; at < end; at++) {yield* work('scalar-step');
      const code = r.at(at).charCodeAt(0);
      const digit = code >= 48 && code <= 57 ? code - 48
        : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
      if (digit < 0 || digit >= radix) return NaN;
      for (let shift = bitsPerDigit - 1; shift >= 0; shift--) {yield* work('scalar-step');
        const bit = digit >> shift & 1;
        if (!bits && !bit) continue;
        if (++bits <= 54) head = head * 2n + BigInt(bit);
        else if (bit) sticky = true;
      }
    }
    if (bits <= 53) return Number(head);
    let rounded = head >> 1n;
    if ((head & 1n) && (sticky || (rounded & 1n))) rounded++;
    return bits > 1024 ? Infinity : Number(rounded) * 2 ** (bits - 53);
  }
  const number = createJsonNumber();
  if (negative) number.write('-');
  const integer = at;
  while (at < end && /[0-9]/.test(r.at(at))) {yield* work('scalar-step');number.write(r.at(at++));}
  const integerDigits = at - integer;
  let fractionDigits = 0;
  if (r.at(at) === '.') {
    if (!integerDigits) number.write('0');
    number.write('.'); at++;
    const fraction = at;
    while (at < end && /[0-9]/.test(r.at(at))) {yield* work('scalar-step');number.write(r.at(at++));}
    fractionDigits = at - fraction;
  }
  if (!integerDigits && !fractionDigits) return NaN;
  if (r.at(at) === 'e' || r.at(at) === 'E') {
    number.write('e'); at++;
    if (r.at(at) === '+' || r.at(at) === '-') number.write(r.at(at++));
    const exponent = at;
    while (at < end && /[0-9]/.test(r.at(at))) {yield* work('scalar-step');number.write(r.at(at++));}
    if (at === exponent) return NaN;
  }
  return at === end ? number.finish() : NaN;
}

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
function* scanner(value,work) {
  const r = text.reader(value); let at = 0;
  const char = () => r.at(at) || '\0';
  const scan = function* () {
    let c = char(), begin = at;
    if (c === '\0') return token(END);
    if (digit(c)) {
      let n = 0, significant = 0;
      while (char() === '0') {yield* work('scalar-step');at++;}
      while (digit(char())) {yield* work('scalar-step'); if (significant++ < 9) n = n * 10 + char().charCodeAt(0) - 48; at++; }
      return token(NUMBER, n, at - begin);
    }
    if (':-+.)'.includes(c)) { at++; return token(SYMBOL, c, 1); }
    if (c >= 'A' && !space(c)) {
      let prefix = '';
      while ((c = char()) >= 'A' && !space(c)) {yield* work('scalar-step');
        if (prefix.length < 3) prefix += c >= 'A' && c <= 'Z' ? c.toLowerCase() : c;
        at++;
      }
      const length = at - begin;
      for (const [name, kind, n] of words) {yield* work('scalar-step');if (prefix === name && (length <= 3 || kind === MONTH)) return token(kind, n, length);}
      return token(0, 0, length);
    }
    if (/\s/u.test(c)) { at++; return token(SPACE, -1, 1); }
    if (c === '(') {
      let balance = 0;
      do {yield* work('scalar-step'); c = char(); if (c === ')') balance--; else if (c === '(') balance++; at++; }
      while (balance > 0 && char() !== '\0');
      return token(UNKNOWN);
    }
    at++; return token(UNKNOWN);
  };
  let next = yield* scan();
  return { peek: () => next, *next() { const out = next; next = yield* scan(); return out; },
    *skip(c) { if (next.kind !== SYMBOL || next.value !== c) return false; next = yield* scan(); return true; } };
}
const sign = t => t.kind === SYMBOL && (t.value === '+' || t.value === '-');
const zulu = t => t.kind === ZONE && t.length === 1 && t.value === 0;
function milliseconds(t) {
  if (t.length < 3) return t.value * (t.length === 1 ? 100 : 10);
  return Math.trunc(t.value / 10 ** (Math.min(9, t.length) - 3));
}
function* parsePagedDate(value) {
  const work=this.work.bind(this);
  const arena = text.info(value)?.arena;
  if (arena) {
    arena.metrics.dateParses = (arena.metrics.dateParses || 0) + 1;
    arena.metrics.maxDateTokenChars = 3;
    arena.metrics.maxDateNativeSlots = 7;
  }
  const s = yield* scanner(value,work), day = [], time = [];
  let namedMonth = NONE, iso = false, hourOffset = NONE;
  let tzSign = NONE, tzHour = NONE, tzMinute = NONE;
  const addDay = n => day.length < 3 ? (day.push(n), true) : false;
  const addTime = n => time.length < 4 ? (time.push(n), true) : false;
  const finalTime = n => { if (!addTime(n)) return false; while (time.length < 4) time.push(0); return true; };
  const expectsTime = n => time.length === 1 || time.length === 2 ? between(n, 0, 59) : time.length === 3 && between(n, 0, 999);
  const setZone = n => { tzSign = n < 0 ? -1 : 1; tzHour = n * tzSign; tzMinute = 0; };
  const fixed = n => s.peek().kind === NUMBER && s.peek().length === n;
  const invalid = () => token(INVALID);
  function* es5() {
    if (sign(s.peek())) {
      const t = (yield* s.next());
      if (!fixed(6)) return t;
      const year = (yield* s.next()).value;
      if (t.value === '-' && year === 0) return t;
      addDay((t.value === '-' ? -1 : 1) * year);
    } else if (fixed(4)) addDay((yield* s.next()).value);
    else return (yield* s.next());
    if ((yield* s.skip('-'))) {
      if (!fixed(2) || !between(s.peek().value, 1, 12)) return (yield* s.next());
      addDay((yield* s.next()).value);
      if ((yield* s.skip('-'))) {
        if (!fixed(2) || !between(s.peek().value, 1, 31)) return (yield* s.next());
        addDay((yield* s.next()).value);
      }
    }
    if (s.peek().kind !== TIME) { if (s.peek().kind !== END) return (yield* s.next()); }
    else {
      (yield* s.next());
      if (!fixed(2) || !between(s.peek().value, 0, 24)) return invalid();
      const h24 = s.peek().value === 24;
      addTime((yield* s.next()).value);
      if (!(yield* s.skip(':')) || !fixed(2) || !between(s.peek().value, 0, 59) || h24 && s.peek().value > 0) return invalid();
      addTime((yield* s.next()).value);
      if ((yield* s.skip(':'))) {
        if (!fixed(2) || !between(s.peek().value, 0, 59) || h24 && s.peek().value > 0) return invalid();
        addTime((yield* s.next()).value);
        if ((yield* s.skip('.'))) {
          if (s.peek().kind !== NUMBER || h24 && s.peek().value > 0) return invalid();
          addTime(milliseconds((yield* s.next())));
        }
      }
      if (zulu(s.peek())) { (yield* s.next()); setZone(0); }
      else if (sign(s.peek())) {
        tzSign = (yield* s.next()).value === '+' ? 1 : -1;
        if (fixed(4)) {
          const n = (yield* s.next()).value, h = Math.trunc(n / 100), m = n % 100;
          if (!between(h, 0, 23) || !between(m, 0, 59)) return invalid();
          tzHour = h; tzMinute = m;
        } else {
          if (!fixed(2) || !between(s.peek().value, 0, 23)) return invalid();
          tzHour = (yield* s.next()).value;
          if (!(yield* s.skip(':')) || !fixed(2) || !between(s.peek().value, 0, 59)) return invalid();
          tzMinute = (yield* s.next()).value;
        }
      }
      if (s.peek().kind !== END) return invalid();
    }
    if (tzHour === NONE && time.length === 0) setZone(0);
    iso = true; return token(END);
  }
  let t = yield* es5(), hasNumber = day.length > 0;
  if (t.kind === INVALID) return NaN;
  for (; t.kind !== END; t = (yield* s.next())) {yield* work('scalar-step');
    if (t.kind === NUMBER) {
      hasNumber = true; const n = t.value;
      if ((yield* s.skip(':'))) {
        if ((yield* s.skip(':'))) { if (time.length) return NaN; addTime(n); addTime(0); }
        else { if (!addTime(n)) return NaN; (yield* s.skip('.')); }
      } else if ((yield* s.skip('.')) && expectsTime(n)) {
        addTime(n); if (s.peek().kind !== NUMBER) return NaN;
        const ms = milliseconds((yield* s.next())); if (ms < 0) return NaN; finalTime(ms);
      } else if (tzHour !== NONE && tzMinute === NONE && between(n, 0, 59)) tzMinute = n;
      else if (expectsTime(n)) {
        finalTime(n); const p = s.peek();
        if (p.kind !== END && p.kind !== SPACE && !zulu(p) && !sign(p)) return NaN;
      } else { if (!addDay(n)) return NaN; (yield* s.skip('-')); }
    } else if (t.kind >= 0) {
      if (t.kind === AMPM && time.length) hourOffset = t.value;
      else if (t.kind === MONTH) { namedMonth = t.value; (yield* s.skip('-')); }
      else if (t.kind === ZONE && hasNumber) setZone(t.value);
      else if (hasNumber || s.peek().kind === NUMBER) return NaN;
    } else if (sign(t) && (tzHour === 0 && tzMinute === 0 || time.length)) {
      tzSign = t.value === '+' ? 1 : -1;
      let n = 0, length = 0;
      if (s.peek().kind === NUMBER) { const next = (yield* s.next()); n = next.value; length = next.length; }
      hasNumber = true;
      if (s.peek().kind === SYMBOL && s.peek().value === ':') { tzHour = n; tzMinute = NONE; }
      else if (length === 1 || length === 2) { tzHour = n; tzMinute = 0; }
      else if (length === 3 || length === 4) { tzHour = Math.trunc(n / 100); tzMinute = n % 100; }
      else return NaN;
    } else if ((sign(t) || t.kind === SYMBOL && t.value === ')') && hasNumber) return NaN;
  }
  if (!day.length) return NaN;
  while (day.length < 3) {yield* work('scalar-step');day.push(1);}
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
  while (time.length < 4) {yield* work('scalar-step');time.push(0);}
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

module.exports={numericValue,parsePagedDate};
