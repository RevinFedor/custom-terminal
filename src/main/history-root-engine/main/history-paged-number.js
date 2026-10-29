'use strict';

const { createJsonNumber, SIGNIFICANT_DIGITS } = require('./history-json-number');

// Number(String) without a token-sized primitive. Grammar validation consumes
// the entire value even after overflow/underflow; an invalid late suffix is
// NaN, not Infinity. Decimal rounding reuses the ingestion converter.
function numericValue(value, text) {
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
  while (start < end && /\s/u.test(r.at(start))) start++;
  while (end > start && /\s/u.test(r.at(end - 1))) end--;
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
    for (; at < end; at++) {
      const code = r.at(at).charCodeAt(0);
      const digit = code >= 48 && code <= 57 ? code - 48
        : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
      if (digit < 0 || digit >= radix) return NaN;
      for (let shift = bitsPerDigit - 1; shift >= 0; shift--) {
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
  while (at < end && /[0-9]/.test(r.at(at))) number.write(r.at(at++));
  const integerDigits = at - integer;
  let fractionDigits = 0;
  if (r.at(at) === '.') {
    if (!integerDigits) number.write('0');
    number.write('.'); at++;
    const fraction = at;
    while (at < end && /[0-9]/.test(r.at(at))) number.write(r.at(at++));
    fractionDigits = at - fraction;
  }
  if (!integerDigits && !fractionDigits) return NaN;
  if (r.at(at) === 'e' || r.at(at) === 'E') {
    number.write('e'); at++;
    if (r.at(at) === '+' || r.at(at) === '-') number.write(r.at(at++));
    const exponent = at;
    while (at < end && /[0-9]/.test(r.at(at))) number.write(r.at(at++));
    if (at === exponent) return NaN;
  }
  return at === end ? number.finish() : NaN;
}

module.exports = { numericValue };
