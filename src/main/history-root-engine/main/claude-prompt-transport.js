'use strict';

const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const CLAUDE_PROMPT_TRANSPORT_VERSION = 1;
const CLAUDE_PROMPT_TRANSPORT_PROFILE = 'claude-pty-v1';
const CLAUDE_PROMPT_TAB_REPLACEMENT = '    ';

class ClaudePromptTransportError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClaudePromptTransportError';
    this.code = code;
    Object.assign(this, details);
  }
}

function malformedUtf16Error(index, codeUnit) {
  return new ClaudePromptTransportError(
    'claude_prompt_malformed_utf16',
    `Claude prompt contains malformed UTF-16 at code-unit index ${index}`,
    { index, codeUnit },
  );
}

/**
 * Validate and prepare the exact text that may be written to a Claude PTY.
 *
 * claude-pty-v1 intentionally has only two presentation transforms:
 * - CRLF and lone CR become LF;
 * - TAB becomes exactly four ASCII spaces.
 *
 * All other Unicode scalars remain byte-for-byte equivalent after UTF-8
 * encoding. In particular, this does not trim, collapse whitespace, remove a
 * BOM, or apply Unicode normalization. Lone UTF-16 surrogates are rejected so
 * Node cannot silently encode them as U+FFFD and make the audit identity lie.
 */
function prepareClaudePromptTransport(text) {
  if (typeof text !== 'string') {
    throw new ClaudePromptTransportError(
      'claude_prompt_transport_text_required',
      'Claude prompt transport requires a string',
      { receivedType: typeof text },
    );
  }

  let changed = false;
  let segmentStart = 0;
  const segments = [];

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = index + 1 < text.length
        ? text.charCodeAt(index + 1)
        : Number.NaN;
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        throw malformedUtf16Error(index, codeUnit);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw malformedUtf16Error(index, codeUnit);
    }

    if (codeUnit === 0x09) {
      if (segmentStart < index) segments.push(text.slice(segmentStart, index));
      segments.push(CLAUDE_PROMPT_TAB_REPLACEMENT);
      segmentStart = index + 1;
      changed = true;
      continue;
    }

    if (codeUnit === 0x0d) {
      if (segmentStart < index) segments.push(text.slice(segmentStart, index));
      segments.push('\n');
      if (text.charCodeAt(index + 1) === 0x0a) index += 1;
      segmentStart = index + 1;
      changed = true;
    }
  }

  if (changed && segmentStart < text.length) segments.push(text.slice(segmentStart));
  const transportText = changed ? segments.join('') : text;

  const createIdentity = (identityText) => Object.freeze({
    text: identityText,
    utf16Length: identityText.length,
    utf8ByteLength: Buffer.byteLength(identityText, 'utf8'),
    auditHash: promptAuditFingerprint(identityText),
  });

  const raw = createIdentity(text);
  const transport = transportText === text ? raw : createIdentity(transportText);

  return Object.freeze({
    version: CLAUDE_PROMPT_TRANSPORT_VERSION,
    profile: CLAUDE_PROMPT_TRANSPORT_PROFILE,
    raw,
    transport,
  });
}

module.exports = {
  CLAUDE_PROMPT_TAB_REPLACEMENT,
  CLAUDE_PROMPT_TRANSPORT_PROFILE,
  CLAUDE_PROMPT_TRANSPORT_VERSION,
  ClaudePromptTransportError,
  prepareClaudePromptTransport,
};
