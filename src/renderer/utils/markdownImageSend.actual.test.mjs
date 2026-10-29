import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as images from './promptImageAttachments.mjs';
import { buildHistoryComposerPresentationParts } from './composerChips.mjs';
import { buildComposerClipboardText, buildHistoryMessageClipboardPayload,
  collectPortableImagePathMarkers, buildPortableImageImportSnapshot,
  collapsePortableImageImportSnapshot } from './composerClipboard.mjs';
import { expireReloadedHistoryImageImports } from './historyImageImportOwnership.mjs';

const require = createRequire(import.meta.url);
const { prepareStructuredAuthoring } = require('../../main/structured-authoring.js');
const panel = fs.readFileSync(process.env.MARKDOWN_HISTORY_PANEL_SOURCE || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const noticeStart = panel.indexOf('const historyDraftImageNotice = (');
const noticeEnd = panel.indexOf('\nconst historyDraftImagePreflightKey =', noticeStart);
const prepareStart = panel.indexOf('  const prepareHistoryPromptForSend = useCallback');
const prepareEnd = panel.indexOf('\n  const runAction = useCallback', prepareStart);
assert.ok(noticeStart > 0 && noticeEnd > noticeStart && prepareStart > 0 && prepareEnd > prepareStart);
const source = ts.transpileModule(panel.slice(noticeStart, noticeEnd) + '\n'
  + panel.slice(prepareStart, prepareEnd) + '\nglobalThis.prepare = prepareHistoryPromptForSend;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function preparation() {
  const calls = [];
  const context = {
    ...images, console, HISTORY_IMAGE_PENDING_MARKER: '[Image saving…]',
    retainHistoryDraftImages: images.retainPromptImageRefsForText,
    runtime: { logPrefix: 'MarkdownImagePrivate' }, tabId: 'private-synthetic',
    useCallback: fn => fn,
    ipcRenderer: { invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      assert.equal(channel, 'prompt-queue:materialize-image-refs');
      return { success: true, refs: payload.refs };
    } },
  };
  vm.runInNewContext(source, context);
  return { prepare: context.prepare, calls };
}
const favicon = '[image](https://www.google.com/s2/favicons?domain=example.test&sz=32)';
const prompt = `Инструкция ускорения любого кодинга.&#x20; ${favicon}\nСледующая строка.`;

test('causal: a copied ChatGPT Markdown favicon is not a damaged attachment', () => {
  const inspected = images.inspectPromptImageAttachments(prompt, []);
  assert.equal(inspected.blocking, false, inspected.firstBlocking?.excerpt);
  assert.equal(images.hasMalformedPromptImageMarker(prompt, []), false);
  assert.equal(images.buildPromptImagePayload(prompt, []), prompt, 'transport keeps the complete original URL and label');
});

test('causal: the actual History send preparation admits web-image text without image IPC', async () => {
  const h = preparation();
  const result = await h.prepare(prompt, []);
  assert.equal(result.success, true, result.warning);
  assert.equal(result.payload, prompt);
  assert.equal(result.images.length, 0);
  assert.deepEqual(h.calls, []);
});

test('causal: the real shared Main authoring consumer accepts the same source bytes', async () => {
  const result = await prepareStructuredAuthoring({ version: 1, text: prompt, chips: [], imagePaths: [] });
  assert.equal(result.prompt, prompt);
  assert.equal(result.presentationSnapshot.imagePaths.length, 0);
  assert.equal(result.presentationSnapshot.authoringTransport.imageRanges.length, 0);
});

test('a real attachment next to a favicon keeps exact file binding and source text', async () => {
  const text = prompt + '\nФото [Image #1]';
  const refs = [{ id: 1, path: '/synthetic/exact.png', availability: 'available' }];
  const h = preparation(), result = await h.prepare(text, refs);
  assert.equal(result.success, true, result.warning);
  assert.equal(result.payload, prompt + '\nФото [imagePath: /synthetic/exact.png]');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.refs[0].path, refs[0].path);
});

test('real unbound, damaged, pending and unavailable attachments keep their distinct outcomes', async () => {
  const refs = [{ id: 1, path: '/synthetic/exact.png', availability: 'available' }];
  for (const text of ['[Image #2]', '[Image #1', '[Image saving…]']) {
    const h = preparation(), result = await h.prepare(prompt + '\n' + text, refs);
    assert.equal(result.success, false, text);
    assert.deepEqual(h.calls, []);
  }
  const h = preparation();
  const result = await h.prepare(prompt + '\n[Image #1]', [{ ...refs[0], availability: 'missing' }]);
  assert.equal(result.success, true, result.warning);
  assert.equal(result.degraded, true);
  assert.equal(result.payload, prompt + '\n[imageError: history_image_path_unavailable #1]');
});

for (const title of ['[Image #1]', '[Image saving…]', '[imagePath: /synthetic/not-an-attachment.png]',
  '[imageError: codex_image_path_unavailable #1]']) test('one web-reference grammar owns Send/History/Copy/Paste: ' + title, async () => {
  const link = `[image](https://example.test/icon "${title}")`;
  const h = preparation(), prepared = await h.prepare(link, []);
  assert.equal(prepared.success, true, prepared.warning);
  assert.equal(prepared.payload, link); assert.equal(h.calls.length, 0);
  assert.equal(images.getPromptImageAttachmentState({ text: link }), 'ready');
  assert.deepEqual(images.getPromptImageStatusTokenRanges(link), []);
  assert.deepEqual([...images.collectPromptImageRefIds(link)], []);
  assert.deepEqual(collectPortableImagePathMarkers(link), []);
  assert.equal(buildPortableImageImportSnapshot(link, []).text, link);
  const parts = buildHistoryComposerPresentationParts({ text: link }).parts;
  assert.equal(parts.length, 1); assert.equal(parts[0].kind, 'text'); assert.equal(parts[0].text, link);
  const copied = buildHistoryMessageClipboardPayload({ text: link });
  assert.equal(copied.text, link); assert.equal(copied.snapshot.text, link);
  const selection = buildComposerClipboardText({ text: link, selectionStart: 0, selectionEnd: link.length });
  assert.equal(selection.text, link);
  assert.equal(selection.imageMissing, 0); assert.equal(selection.imageResolved, 0);
  assert.equal(images.insertPromptImageAttachments({ insertedText: link }).text, link);
  assert.equal(expireReloadedHistoryImageImports({ T: link }).T, link);
});

test('web references keep offsets, titles, URL parentheses and a real neighboring slot in every route', () => {
  for (const link of ['![icon](https://example.test/a_(b).png "title")', '[image](<https://example.test/a_(b).png> \'title\')',
    '[image](https://example.test/a\\(b\\).png)', '![Image #1](https://example.test/a.png)',
    '[image](https://example.test/a.png "[imageError: x]")']) {
    const text = 'before ' + link + ' after [Image #1]';
    const refs = [{ id: 1, path: '/synthetic/real.png', availability: 'available' }];
    const ranges = images.collectPromptWebImageReferences(text);
    assert.equal(ranges.length, 1, link); assert.equal(text.slice(ranges[0].start, ranges[0].end), link);
    assert.deepEqual([...images.collectPromptImageRefIds(text)], [1]);
    assert.equal(images.buildPromptImagePayload(text, refs), 'before ' + link + ' after [imagePath: /synthetic/real.png]');
    const copied = buildComposerClipboardText({ text, imagePaths: refs, selectionStart: 0, selectionEnd: text.length });
    assert.equal(copied.text, 'before ' + link + ' after [imagePath: /synthetic/real.png]');
    assert.equal(copied.imageResolved, 1);
    assert.equal(images.inspectPromptImageAttachments(text, refs).blocking, false);
  }
});

test('a broken URL never masks the next local image or its pending/error proof', () => {
  for (const text of ['[image](https://example.test/a\n[Image #1]', '[image](https://example.test/a "unclosed title\n[Image #1]',
    '[image](https://example.test/(unclosed\n[Image #1]']) {
    assert.equal(images.collectPromptWebImageReferences(text).length, 0);
    assert.equal(images.inspectPromptImageAttachments(text, []).blocking, true);
    assert.deepEqual([...images.collectPromptImageRefIds(text)], [1]);
  }
  assert.equal(images.hasPromptPendingImageMarker('[image](https://example.test/icon "[Image saving…]") [Image saving…]'), true);
  assert.equal(collectPortableImagePathMarkers('[image](https://example.test/icon "[imagePath: /hidden.png]") [imagePath: /real.png]')[0].path, '/real.png');
});

test('opaque pasted-content owns its image-looking bytes and whole clipboard keeps the source', () => {
  const text = '<pasted_content>\n[image](https://example.test/icon "[Image #1]")\n</pasted_content>';
  const parts = buildHistoryComposerPresentationParts({ text }).parts;
  assert.equal(parts.length, 1); assert.equal(parts[0].kind, 'paste');
  assert.equal(parts[0].text, '[image](https://example.test/icon "[Image #1]")');
  const collapsed = collapsePortableImageImportSnapshot({ text: parts[0].text, threshold: 100 });
  assert.equal(collapsed.text, parts[0].text);
});
