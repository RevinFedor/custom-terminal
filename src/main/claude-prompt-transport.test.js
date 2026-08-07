'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { performance } = require('node:perf_hooks');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const {
  CLAUDE_PROMPT_TAB_REPLACEMENT,
  CLAUDE_PROMPT_TRANSPORT_PROFILE,
  CLAUDE_PROMPT_TRANSPORT_VERSION,
  ClaudePromptTransportError,
  prepareClaudePromptTransport,
} = require('./claude-prompt-transport');

test('claude-pty-v1 replaces every TAB with exactly four ASCII spaces', () => {
  const prepared = prepareClaudePromptTransport('\talpha\t\tbeta\t');

  assert.equal(CLAUDE_PROMPT_TAB_REPLACEMENT, '    ');
  assert.equal(prepared.transport.text, '    alpha        beta    ');
  assert.equal(prepared.raw.utf16Length, 13);
  assert.equal(prepared.transport.utf16Length, 25);
});

test('literal spaces stay distinct in raw identity while matching exact transport text', () => {
  const tab = prepareClaudePromptTransport('left\tright');
  const spaces = prepareClaudePromptTransport('left    right');

  assert.notEqual(tab.raw.auditHash, spaces.raw.auditHash);
  assert.notEqual(tab.raw.text, spaces.raw.text);
  assert.equal(tab.transport.text, spaces.transport.text);
  assert.equal(tab.transport.auditHash, spaces.transport.auditHash);
});

test('CRLF and lone CR become LF without changing existing LF', () => {
  const prepared = prepareClaudePromptTransport('one\r\ntwo\rthree\nfour\r');
  const crlf = prepareClaudePromptTransport('same\r\nline');
  const cr = prepareClaudePromptTransport('same\rline');
  const lf = prepareClaudePromptTransport('same\nline');

  assert.equal(prepared.transport.text, 'one\ntwo\nthree\nfour\n');
  assert.equal(prepared.raw.utf16Length, 20);
  assert.equal(prepared.transport.utf16Length, 19);
  assert.notEqual(crlf.raw.auditHash, cr.raw.auditHash);
  assert.notEqual(cr.raw.auditHash, lf.raw.auditHash);
  assert.equal(crlf.transport.auditHash, lf.transport.auditHash);
  assert.equal(cr.transport.auditHash, lf.transport.auditHash);
});

test('Unicode scalars, BOM, ZWJ sequences, and normalization forms are preserved exactly', () => {
  const nfc = '\u00e9';
  const nfd = 'e\u0301';
  const family = '\ud83d\udc69\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66';
  const text = `\ufeffКириллица 中文 😀 ${family} ${nfc} ${nfd}\u2028\u0000`;
  const prepared = prepareClaudePromptTransport(text);

  assert.equal(prepared.transport.text, text);
  assert.equal(prepared.raw, prepared.transport);
  assert.equal(prepared.raw.utf16Length, text.length);
  assert.equal(prepared.raw.utf8ByteLength, Buffer.byteLength(text, 'utf8'));
  assert.equal(prepared.raw.auditHash, promptAuditFingerprint(text));
  assert.notEqual(
    prepareClaudePromptTransport(nfc).transport.auditHash,
    prepareClaudePromptTransport(nfd).transport.auditHash,
  );
  assert.equal(prepared.transport.text.charCodeAt(0), 0xfeff);
});

test('prepared metadata is deeply immutable and the transport transform is idempotent', () => {
  const first = prepareClaudePromptTransport('a\t\r\nb\rc');
  const second = prepareClaudePromptTransport(first.transport.text);

  assert.equal(first.version, CLAUDE_PROMPT_TRANSPORT_VERSION);
  assert.equal(first.profile, CLAUDE_PROMPT_TRANSPORT_PROFILE);
  assert.equal(first.profile, 'claude-pty-v1');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.raw), true);
  assert.equal(Object.isFrozen(first.transport), true);
  assert.deepEqual(second.transport, first.transport);
  assert.equal(second.raw, second.transport);
  assert.throws(() => {
    first.transport.text = 'mutated';
  }, TypeError);
});

test('malformed UTF-16 is rejected with its exact code-unit position', () => {
  const malformed = [
    { text: '\ud800', index: 0, codeUnit: 0xd800 },
    { text: '\udc00', index: 0, codeUnit: 0xdc00 },
    { text: `ok\ud800x`, index: 2, codeUnit: 0xd800 },
    { text: `ok\udc00x`, index: 2, codeUnit: 0xdc00 },
  ];

  for (const sample of malformed) {
    assert.throws(
      () => prepareClaudePromptTransport(sample.text),
      (error) => {
        assert.equal(error instanceof ClaudePromptTransportError, true);
        assert.equal(error.code, 'claude_prompt_malformed_utf16');
        assert.equal(error.index, sample.index);
        assert.equal(error.codeUnit, sample.codeUnit);
        return true;
      },
    );
  }

  assert.equal(prepareClaudePromptTransport('\ud83d\ude00').transport.text, '😀');
  assert.throws(
    () => prepareClaudePromptTransport(Buffer.from('not a string')),
    { code: 'claude_prompt_transport_text_required' },
  );
});

test('production regression: 70,337 UTF-16 units become 70,343 with two TABs', () => {
  const raw = 'a'.repeat(35_000) + '\t' + 'б'.repeat(35_335) + '\t';
  assert.equal(raw.length, 70_337);

  const prepared = prepareClaudePromptTransport(raw);

  assert.equal(prepared.raw.utf16Length, 70_337);
  assert.equal(prepared.transport.utf16Length, 70_343);
  assert.equal(prepared.raw.utf8ByteLength, Buffer.byteLength(raw, 'utf8'));
  assert.equal(
    prepared.transport.utf8ByteLength,
    Buffer.byteLength(prepared.transport.text, 'utf8'),
  );
  assert.equal(prepared.transport.auditHash, promptAuditFingerprint(prepared.transport.text));
});

test('one-megabyte prompt preparation stays bounded and preserves exact accounting', () => {
  const block = `абв中文😀${'x'.repeat(1000)}\tline\r\n`;
  const repeats = Math.ceil((1024 * 1024) / block.length);
  const raw = block.repeat(repeats).slice(0, 1024 * 1024);

  const startedAt = performance.now();
  const prepared = prepareClaudePromptTransport(raw);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(prepared.raw.utf16Length, 1024 * 1024);
  assert.equal(prepared.transport.text.includes('\t'), false);
  assert.equal(prepared.transport.text.includes('\r'), false);
  assert.equal(
    prepared.transport.utf8ByteLength,
    Buffer.byteLength(prepared.transport.text, 'utf8'),
  );
  // A generous ceiling catches accidental quadratic behavior without turning
  // normal shared-runner load into a timing flake.
  assert.ok(elapsedMs < 5000, `1 MiB preparation took ${elapsedMs.toFixed(1)}ms`);
});
