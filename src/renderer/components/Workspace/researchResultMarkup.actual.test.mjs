import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { researchResultPresentation } from '../../utils/researchResultPresentation.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const bundle = buildSync({
  stdin: { contents: 'export { ResearchResultContent } from "./src/renderer/components/Workspace/ResearchResultContent.tsx";', resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' },
  loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const { ResearchResultContent } = module.exports;
const markdown = '## Решение\n\n**Подтверждён Main V8 OOM** во время `JSON.parse`.\n\nСледующий абзац.';
const title = 'Main OOM 10:57 — exact evidence and preserving repair';
const render = (body = markdown, open = false) => renderToStaticMarkup(React.createElement(ResearchResultContent, {
  result: researchResultPresentation(body), title, model: '6-astra · Pro', open,
  onToggle() {}, onCopy() {}, copied: false,
}));
const headerText = html => html.slice(html.indexOf('class="hp-research-result-header"'),
  html.indexOf(openBodyMarker(html))).replace(/<[^>]*>/g, '');
const openBodyMarker = html => html.includes('data-research-full') ? '<div class="hp-research-result-body"' : '<div class="hp-history-group-detail';

test('actual closed Research renders headings, emphasis and inline code as Markdown', () => {
  const html = render();
  assert.match(html, /<h2>Решение<\/h2>/);
  assert.match(html, /<strong>Подтверждён Main V8 OOM<\/strong>/);
  assert.match(html, /<code\b[^>]*>JSON\.parse<\/code>/);
  assert.doesNotMatch(html, /## Решение|\*\*Подтверждён|`JSON\.parse`/);
});
test('actual closed and open headers show the source/model rather than the technical job label', () => {
  for (const html of [render(), render(markdown, true)]) {
    const text = headerText(html);
    assert.match(text, /Research/);
    assert.match(text, /6-astra · Pro/);
    assert.doesNotMatch(text, /Main OOM|exact evidence/);
    assert.match(html, /aria-label="(?:Expand|Collapse) Research answer: Main OOM/);
  }
});
test('actual expanded prose retains the same semantic formatting and all paragraphs', () => {
  const html = render(markdown, true);
  assert.match(html, /data-research-full/);
  assert.match(html, /<h2>Решение<\/h2>/);
  assert.match(html, /<strong>Подтверждён Main V8 OOM<\/strong>/);
  assert.match(html, /Следующий абзац\./);
});
test('JSON excerpts remain literal text while the complete JSON stays exact', () => {
  const body = JSON.stringify({ reason: '**literal JSON value**', items: [{ id: 17 }] });
  assert.match(render(body), /\*\*literal JSON value\*\*/);
  assert.doesNotMatch(render(body), /<strong>literal JSON value/);
  assert.equal(researchResultPresentation(body).code, body);
  assert.match(render(body, true), /hp-research-result-code/);
});

test('Research action order is SC arrow, browser, raw Copy, disclosure', () => {
  const html = renderToStaticMarkup(React.createElement(ResearchResultContent, {
    result: researchResultPresentation(markdown), open: false, onToggle() {}, onCopy() {}, copied: false,
    sourceAction: React.createElement('button', { 'data-sc-action': true }, 'SC'),
    browserAction: React.createElement('button', { 'data-browser-action': true }, 'Browser'),
  }));
  assert.ok(html.indexOf('data-sc-action') < html.indexOf('data-browser-action'));
  assert.ok(html.indexOf('data-browser-action') < html.indexOf('Copy original answer'));
  assert.ok(html.indexOf('Copy original answer') < html.indexOf('data-research-disclosure'));
});
