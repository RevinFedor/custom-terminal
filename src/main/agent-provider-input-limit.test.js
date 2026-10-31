'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { CODEX_MAX_MESSAGE_SCALARS: MAX, unicodeScalarCount, codexProviderScalarCount,
  providerInputLimitFailure: check, earlyProviderInputLimitFailure: early } = require('./agent-provider-input-limit');
for (const [name, scalar] of [['ascii', 'x'], ['cyrillic', '\u044f'], ['emoji', '\ud83d\ude00']]) {
  for (const delta of [-1, 0, 1]) test(name + ' max' + (delta >= 0 ? '+' : '') + delta + ' counts Unicode scalars', () => {
    const text = scalar.repeat(MAX + delta), result = check('codex', text);
    assert.equal(unicodeScalarCount(text), MAX + delta);
    if (delta > 0) {
      assert.equal(result.code, 'codex_message_too_large'); assert.equal(result.inputLimit.actual, MAX + 1);
      assert.equal(result.inputLimit.max, MAX); assert.equal(result.inputLimit.unit, 'unicode-scalars');
      assert.equal(result.submitted, false); assert.equal(result.pasteWritten, false); assert.equal(result.enterWritten, false);
      assert.match(result.error, /1048577.*1048576/); assert.match(result.recommendation, /file paths/);
    } else assert.equal(result, null);
    assert.equal(check('claude', text), null, 'Codex policy must not become a Claude cap');
  });
}
test('scalar count is neither bytes, UTF-16 units nor grapheme count', () => {
  assert.equal(unicodeScalarCount('\u044f\ud83d\ude00a\u0301\ud83d\udc68\u200d\ud83d\udc69'), 7);
  assert.equal(unicodeScalarCount('\ud800'), 1, 'UTF-8 transport replaces an unpaired surrogate with one scalar');
});
test('Codex native trimming is count-only and does not collapse internal whitespace or strip a BOM', () => {
  const text = '\u0085  ' + 'x'.repeat(MAX) + '\n\u3000';
  assert.equal(check('codex', text), null);
  assert.equal(codexProviderScalarCount(' x  y '), 4);
  assert.equal(codexProviderScalarCount('\ufeffx\ufeff'), 3);
  assert(text.startsWith('\u0085  ')); assert(text.endsWith('\n\u3000'));
});
test('final native image labels can shorten or expand the pasted path representation', () => {
  const text = 'x'.repeat(MAX - 5), short = [{ kind: 'text', text }, { kind: 'image', text: '/x' }];
  assert.equal(check('codex', text + '/x'), null);
  assert.equal(check('codex', text + '/x', short).inputLimit.actual, MAX + 5);
  const body = 'x'.repeat(MAX - 15), long = [{ kind: 'image', text: '/very/long/path/'.repeat(50) }, { kind: 'text', text: body }];
  assert.equal(check('codex', long.map(part => part.text).join(''), long), null);
  const authored = '[imagePath: /long/source/path.png] ' + body;
  assert.equal(early('codex', authored), null, 'projectable text must reach the final counter');
  assert.equal(early('codex', 'x'.repeat(MAX + 1), { ownedAttachments: {} }), null);
});
test('native CRLF and control sanitization must not falsely reject an admissible final input', () => {
  for (const text of ['x'.repeat(MAX - 2) + '\r\nx', 'x'.repeat(MAX) + '\u001b[31m',
    'x'.repeat(MAX - 1) + '\u0085x']) assert.equal(check('codex', text), null);
  assert.equal(codexProviderScalarCount('a\rb\r\nc'), 5);
});
test('native image-paste separator and blockquote continuation participate in the final count', () => {
  const segments = [{ kind: 'image', text: '/x' }, { kind: 'text', text: 'x'.repeat(MAX - 10) }];
  assert.equal(check('codex', '/x' + segments[1].text, segments)?.inputLimit.actual, MAX + 1);
  const quote = [{ kind: 'text', text: '> ' }, { kind: 'image', text: '/x' }, { kind: 'text', text: 'a\nb' }];
  assert.equal(codexProviderScalarCount('', quote), '> [Image #1] a\n> b'.length);
});
