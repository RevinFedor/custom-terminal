'use strict';

// JSON binary64 conversion without retaining an arbitrarily long token.
// Grammar is validated by createJsonProjection. Every rounding boundary of
// binary64 has a terminating decimal expansion with <= 768 significant
// digits (the smallest midpoint is 2^-1075). Keep 800 digits and one sticky
// digit: no boundary lies strictly between this representative and the input.
// The final, bounded Number conversion retains V8's exact rounding, including
// halfway-even, negative zero, overflow and underflow. This is not a running
// floating-point approximation of the mantissa.
const SIGNIFICANT_DIGITS = 800;
const EXPONENT_CAP = BigInt(Number.MAX_SAFE_INTEGER) + 10000n;

function createJsonNumber() {
  let negative = false, fractional = false, exponent = false, exponentNegative = false;
  let fractionDigits = 0, significantDigits = 0, exponentMagnitude = 0n;
  let digits = '', sticky = false, word = '', seen = false, chars = 0;
  return {
    write(text) {
      for (const char of text) {
        chars++;
        if (!seen) {
          seen = true;
          if (char === 't' || char === 'f' || char === 'n') word = char;
          else if (char === '-') negative = true;
          else if (char !== '0') { digits = char; significantDigits = 1; }
          continue;
        }
        if (word) { if (word.length < 5) word += char; continue; }
        if (char === '.' && !exponent) { fractional = true; continue; }
        if (char === 'e' || char === 'E') { exponent = true; continue; }
        if (exponent) {
          if (char === '-') exponentNegative = true;
          else if (char !== '+' && exponentMagnitude < EXPONENT_CAP) {
            exponentMagnitude = exponentMagnitude * 10n + BigInt(char);
            if (exponentMagnitude > EXPONENT_CAP) exponentMagnitude = EXPONENT_CAP;
          }
          continue;
        }
        if (fractional) fractionDigits++;
        if (!significantDigits && char === '0') continue;
        significantDigits++;
        if (digits.length < SIGNIFICANT_DIGITS) digits += char;
        else if (char !== '0') sticky = true;
      }
    },
    finish() {
      if (word) return word === 'true' ? true : word === 'false' ? false : null;
      if (!significantDigits) return negative ? -0 : 0;
      const power = (exponentNegative ? -exponentMagnitude : exponentMagnitude) - BigInt(fractionDigits) + BigInt(significantDigits) - 1n;
      if (power > 400n) return negative ? -Infinity : Infinity;
      if (power < -400n) return negative ? -0 : 0;
      const representative = (negative ? '-' : '') + digits[0] + '.' + digits.slice(1) + (sticky ? '1' : '') + 'e' + power;
      return Number(representative);
    },
    stats: () => ({ tokenChars: chars, retainedSignificantChars: digits.length,
      maxConversionChars: SIGNIFICANT_DIGITS + 32, numericRounding: 'binary64-exact-boundary' }),
  };
}

module.exports = { createJsonNumber, SIGNIFICANT_DIGITS };
