'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CLAUDE_HISTORY_CONTEXT_ACK_TEXT,
  buildClaudeHistoryContextContent,
  buildCodexHistoryContextItem,
  splitHistoryContextPrompt,
  imageMediaType,
} = require('./agent-history-context-injection');

test('Claude history-only boundary is non-empty but has no visible glyph', () => {
  assert.equal(CLAUDE_HISTORY_CONTEXT_ACK_TEXT.length, 1);
  assert.equal(CLAUDE_HISTORY_CONTEXT_ACK_TEXT.codePointAt(0), 0x2063);
  assert.equal(CLAUDE_HISTORY_CONTEXT_ACK_TEXT.trim(), CLAUDE_HISTORY_CONTEXT_ACK_TEXT);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-context-'));
  const image = path.join(root, 'one.png');
  fs.writeFileSync(image, Buffer.from('image-bytes'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, image };
}

test('plain text stays byte-exact and does not become a synthetic image payload', async () => {
  const prompt = 'line one\n\nline two';
  assert.deepEqual(splitHistoryContextPrompt(prompt), [{ kind: 'text', text: prompt }]);
  assert.equal(await buildClaudeHistoryContextContent(prompt), prompt);
  assert.deepEqual(await buildCodexHistoryContextItem(prompt, 'msg_exact'), {
    type: 'message',
    id: 'msg_exact',
    role: 'user',
    content: [{ type: 'input_text', text: prompt }],
  });
});

test('image markers preserve their exact position for Claude and Codex model history', async (t) => {
  const { image } = fixture(t);
  const prompt = `before [imagePath: ${image}] after`;
  const imagePaths = [{ id: 1, path: image }];
  const claude = await buildClaudeHistoryContextContent(prompt, { imagePaths });
  assert.equal(claude[0].text, 'before ');
  assert.equal(claude[1].type, 'image');
  assert.equal(claude[1].source.media_type, 'image/png');
  assert.equal(claude[2].text, ' after');

  const codex = await buildCodexHistoryContextItem(prompt, 'msg_image', { imagePaths });
  assert.equal(codex.content[0].text, 'before ');
  assert.match(codex.content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(codex.content[2].text, ' after');
});

test('missing images fail before a provider history mutation can start', async () => {
  await assert.rejects(
    buildCodexHistoryContextItem(
      'x [imagePath: /definitely/missing.png]',
      'msg_missing',
      { imagePaths: [{ id: 1, path: '/definitely/missing.png' }] },
    ),
    /history_context_image_missing/,
  );
});

test('literal imagePath inside pasted content never becomes an attachment', async (t) => {
  const { image } = fixture(t);
  const prompt = `<pasted_content>literal [imagePath: ${image}]</pasted_content>\n[imagePath: ${image}]`;
  const parts = splitHistoryContextPrompt(prompt, { imagePaths: [{ id: 1, path: image }] });
  assert.equal(parts.filter((part) => part.kind === 'image').length, 1);
  assert.match(parts[0].text, /literal \[imagePath:/);
});

test('authoritative image cardinality mismatch fails before mutation', () => {
  assert.throws(
    () => splitHistoryContextPrompt('plain', { imagePaths: [{ id: 1, path: '/tmp/one.png' }] }),
    /history_context_image_marker_mismatch/,
  );
});

test('formats unsupported by both provider history APIs fail closed', () => {
  assert.equal(imageMediaType('/tmp/image.bmp'), null);
  assert.equal(imageMediaType('/tmp/image.tiff'), null);
});
