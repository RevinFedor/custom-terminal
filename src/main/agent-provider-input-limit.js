'use strict';

const CODEX_MAX_MESSAGE_SCALARS = 1048576;
const INPUT_LIMIT_CODE = 'codex_message_too_large';

function unicodeScalarCount(text, start = 0, end = text.length) {
  let count = 0;
  for (let i = start; i < end; i++, count++) {
    const first = text.charCodeAt(i);
    if (first >= 0xd800 && first <= 0xdbff && i + 1 < end) {
      const second = text.charCodeAt(i + 1);
      if (second >= 0xdc00 && second <= 0xdfff) i++;
    }
  }
  return count;
}

const whitespace = /\p{White_Space}/u;
function* pastedScalars(text) {
  // Codex 0.165 apply_paste normalizes CRLF/CR, then sanitize_user_text
  // drops CSI and C0/C1 controls except LF/TAB. Project, never rewrite input.
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code === 13) { if (text.charCodeAt(i + 1) === 10) i++; yield 10; continue; }
    if (code === 27) {
      if (text.charCodeAt(i + 1) === 91) {
        i += 2;
        while (i < text.length && !(text.charCodeAt(i) >= 64 && text.charCodeAt(i) <= 126)) i++;
      }
      continue;
    }
    if (code < 32 && code !== 9 && code !== 10 || code >= 127 && code <= 159) continue;
    if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      code = text.codePointAt(i++);
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    yield code;
  }
}
function codexProviderScalarCount(text, segments = null) {
  if (!segments?.length && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) {
    let start = 0, end = text.length;
    while (start < end && whitespace.test(text[start])) start++;
    while (end > start && whitespace.test(text[end - 1])) end--;
    return unicodeScalarCount(text, start, end);
  }
  let count = 0, pendingWhitespace = 0, image = 0, linePrefix = '';
  const emit = code => {
    if (code === 32 || code === 9 || code === 10 || code > 127 && whitespace.test(String.fromCodePoint(code))) {
      if (count > 0) pendingWhitespace++;
    } else { count += pendingWhitespace + 1; pendingWhitespace = 0; }
    if (code === 10) linePrefix = '';
    else if (linePrefix.length < 2) linePrefix += String.fromCodePoint(code);
  };
  for (const part of segments?.length ? segments : [{ kind: 'text', text }]) {
    if (part.kind === 'image') {
      for (const char of '[Image #' + (++image) + '] ') emit(char.charCodeAt(0));
      continue;
    }
    let quote = false;
    if (linePrefix === '> ') for (const code of pastedScalars(part.text)) {
      if (code === 10) { quote = true; break; }
    }
    if (!quote) { for (const code of pastedScalars(part.text)) emit(code); continue; }
    // A later paste group continues an existing quote; only one pending scalar
    // is needed to omit its trailing LF before Codex adds the two final LFs.
    let previous = null;
    for (const code of pastedScalars(part.text)) {
      if (previous !== null) {
        emit(previous);
        if (previous === 10) { emit(62); emit(32); }
      }
      previous = code;
    }
    if (previous !== null && previous !== 10) emit(previous);
    emit(10); emit(10);
  }
  return count;
}

function codexInputLimitReceipt(actual) {
  const inputLimit = { provider: 'codex', actual, max: CODEX_MAX_MESSAGE_SCALARS, unit: 'unicode-scalars' };
  const recommendation = 'Reduce the transmitted text or provide file paths for the agent to read separately.';
  return { success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false,
    status: 'not-submitted', code: INPUT_LIMIT_CODE, provider: 'codex', inputLimit,
    httpStatus: 413, recommendation,
    error: 'Codex message is too large: ' + actual + ' Unicode characters; maximum '
      + CODEX_MAX_MESSAGE_SCALARS + '. ' + recommendation };
}

function providerInputLimitFailure(provider, text, segments = null) {
  if (provider !== 'codex' || typeof text !== 'string'
    || !segments?.length && text.length <= CODEX_MAX_MESSAGE_SCALARS) return null;
  const actual = codexProviderScalarCount(text, segments);
  return actual > CODEX_MAX_MESSAGE_SCALARS ? codexInputLimitReceipt(actual) : null;
}

function earlyProviderInputLimitFailure(provider, text, request = {}) {
  // Image/upload projection can shorten OR expand the authored representation.
  // Only unchanged text can be rejected here; Main always checks final transport.
  if (request.ownedAttachments) return null;
  const plan = request.presentationSnapshot?.authoringTransport;
  if (plan ? plan.imageRanges?.length : /\[imagePath\s*:/i.test(String(text || ''))) return null;
  return providerInputLimitFailure(provider, text);
}

function publicInputLimitFailure(receipt) {
  const limit = receipt?.inputLimit;
  if (receipt?.code !== INPUT_LIMIT_CODE || limit?.provider !== 'codex'
    || limit.unit !== 'unicode-scalars' || limit.max !== CODEX_MAX_MESSAGE_SCALARS
    || !Number.isSafeInteger(limit.actual) || limit.actual <= limit.max) return null;
  return { code: INPUT_LIMIT_CODE, provider: 'codex', inputLimit: { ...limit },
    recommendation: codexInputLimitReceipt(limit.actual).recommendation };
}

module.exports = { CODEX_MAX_MESSAGE_SCALARS, INPUT_LIMIT_CODE, unicodeScalarCount, codexProviderScalarCount,
  codexInputLimitReceipt, providerInputLimitFailure, earlyProviderInputLimitFailure, publicInputLimitFailure };
