import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Actual common History/claude-blocks renderer. Memory-only SSR, not GUI/pixels.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const built = buildSync({ stdin: { contents: `export { HistoryTranscriptPresentation } from './src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx';`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' }, loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { HistoryTranscriptPresentation } = module.exports;
test('same actual History renderer provides the user bubble, Markdown, Copy and immutable Worked footer', () => {
  const html = renderToStaticMarkup(React.createElement(HistoryTranscriptPresentation, { onCopy() {}, steps: [
    { id: 'own-q', kind: 'message', role: 'user', text: 'Own original question', contextLabel: 'Объект проверки · запрос' },
    { id: 'own-a', kind: 'message', role: 'assistant', text: 'A **bold** result.', contextLabel: 'Объект проверки · ответ' },
    { id: 'own-r', kind: 'message', role: 'assistant', text: 'Review **OK**.', footerText: 'Worked · 00:03 / gemini-3.8-flash / high' },
  ] }));
  assert.match(html, /cb-user-bubble/); assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /Объект проверки · запрос/); assert.match(html, /Worked · 00:03/);
  assert.match(html, /data-history-transcript-footer/); assert.match(html, /Copy|Копировать|Скопировать/);
  assert.doesNotMatch(html, /<textarea|contenteditable="true"/);
});
