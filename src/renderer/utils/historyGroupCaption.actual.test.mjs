import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the production header and its production presentation dependencies.
// This checks the visible markup, not a copied predicate or source spelling.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = buildSync({
  stdin: { contents: 'export { HistoryCollapsedGroupRow } from "./src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx";', resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' },
  loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { HistoryCollapsedGroupRow } = loaded.exports;
const render = (count, expanded = false) => renderToStaticMarkup(React.createElement(HistoryCollapsedGroupRow, {
  group: { key: 'caption-check', familyKey: 'run', entries: [], errorCount: 0,
    facts: [{ toolName: 'Bash', family: 'run' }],
    captionEntries: Array.from({ length: count }, (_, i) => ({ uuid: `caption-${i}`, role: 'assistant', textPhase: 'commentary', content: `Comment ${i + 1}` })),
  }, expanded, onToggle() {},
}));

test('one caption stays readable without an inert number or its tooltip', () => {
  const html = render(1);
  assert.match(html, /Comment 1/);
  assert.doesNotMatch(html, /hp-history-caption-number|Text 1 of 1/);
});

test('multiple captions retain the latest clickable index and English total', () => {
  const html = render(2);
  assert.match(html, /hp-history-caption-number/);
  assert.match(html, /Text 2 of 2 · Click for previous text/);
  assert.match(html, /Comment 2/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('no caption and an expanded group do not expose caption navigation', () => {
  assert.doesNotMatch(render(0), /hp-history-caption-number/);
  assert.doesNotMatch(render(2, true), /hp-history-caption-number/);
});
