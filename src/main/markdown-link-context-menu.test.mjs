import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { historyFileMenuHarness } from '../../scripts/lib/history-file-menu-harness.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const file = path.join(root, 'docs/tmp/хранилище-и-очистка-диска.md');
const labels = menu => Array.from(menu.template, row => row.label || row.type);

test('History file actions put GT Editor and Sublime first; ordinary Markdown keeps its menu', () => {
  const h = historyFileMenuHarness(source);
  assert.deepEqual(labels(h.show({ href: pathToFileURL(file).href, editorFirst: true })), [
    'Открыть в GT Editor', 'Открыть в Sublime Text', 'Открыть в Finder', 'separator', 'Копировать путь',
  ]);
  for (const editorFirst of [undefined, false, 'true']) assert.deepEqual(labels(h.show({ href: file, editorFirst })), [
    'Открыть в Finder', 'Открыть в GT Editor', 'Открыть в Sublime Text', 'separator', 'Копировать путь',
  ]);
});

test('GT uses the existing directory+file trampoline, Sublime receives that same full path', async () => {
  const h = historyFileMenuHarness(source);
  const menu = h.show({ href: pathToFileURL(file).href, editorFirst: true });
  menu.template[0].click(); menu.template[1].click();
  await Promise.resolve();
  const url = new URL(h.calls[0].url);
  assert.equal(url.protocol, 'gteditor:'); assert.equal(url.hostname, 'open');
  assert.equal(url.searchParams.get('folder'), path.dirname(file));
  assert.equal(url.searchParams.get('file'), path.basename(file));
  assert.deepEqual(h.calls[1], { kind: 'sublime', file });
});

test('directories, missing files and web links retain the existing honest menu', () => {
  const h = historyFileMenuHarness(source);
  assert.deepEqual(labels(h.show({ href: root, editorFirst: true })), ['Открыть в Finder', 'Открыть в GT Editor', 'separator', 'Копировать путь']);
  assert.deepEqual(labels(h.show({ href: pathToFileURL(root + '/not-present-file.md').href, editorFirst: true })), ['Копировать путь']);
  assert.deepEqual(labels(h.show({ href: 'https://example.com/file.md', editorFirst: true })), ['Копировать ссылку']);
  assert.equal(h.show({ href: '' }), null);
  assert.equal(h.calls.length, 0);
});

test('showing a menu cannot launch an editor or copy, and records its kind/order', () => {
  const h = historyFileMenuHarness(source);
  const menu = h.show({ href: pathToFileURL(file).href, editorFirst: true });
  assert.equal(h.calls.length, 0);
  assert.ok(menu.options.window);
  assert.ok(h.logs.some(row => row.args[0] === '[MarkdownLink] MENU kind=file editorFirst=1'));
});
