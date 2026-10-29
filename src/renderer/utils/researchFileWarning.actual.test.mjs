import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { researchReplyFromProjection } from './researchResultPresentation.mjs';
import { resolveHistoryOrchestrationPromptPresentation, projectHistoryServicePromptBody } from './historyOrchestrationPromptPresentation.mjs';
import { buildResearchReplyClipboardPayload } from './researchReplyClipboard.mjs';
import { timelinePromptPreview } from './timelineEntryPreview.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { buildOrchestrationCompletionContent } = require('../../main/orchestration-completion-content');
const { normalizePromptPresentationSnapshot } = require('../../main/history-prompt-presentations');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const source = fs.readFileSync(path.join(root, 'src/main/web-server.js'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'orchestrationPresentationSnapshot');
assert(declaration);
const snapshotFor = vm.runInNewContext('(' + declaration.getText(ast) + ')', { crypto, path });
const bundled = buildSync({ stdin: { contents: 'export { ResearchResultContent } from "./src/renderer/components/Workspace/ResearchResultContent.tsx";', resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' }, loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent' });
const component = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, component, component.exports);

function fixture(errors = 8, saved = 13, body = '**Полный ответ.**\nПример `[imagePath: /synthetic/example.png]`.') {
  const run = { runId: 'owned', runKind: 'external-research', status: 'completed', outcome: 'success',
    externalResearchProvider: 'chatgpt', targetTabName: 'ChatGPT' };
  const externalResult = { artifacts: Array.from({ length: saved }, () => ({})), artifact_errors: Array.from({ length: errors }, () => ({})) };
  const content = buildOrchestrationCompletionContent(run, { success: true, assistantText: body, externalResult });
  const prompt = '<saved_prompt name="context">owned</saved_prompt>\n' + content.prompt;
  const snapshot = normalizePromptPresentationSnapshot(snapshotFor(run, 'completion', content, prompt));
  const entry = { role: 'user', type: 'user', content: prompt, semanticTags: snapshot.semanticTags };
  const service = resolveHistoryOrchestrationPromptPresentation(entry);
  const projected = projectHistoryServicePromptBody(entry, hash);
  return { body, content, prompt, snapshot, entry, service, projected, view: researchReplyFromProjection(entry, service, projected) };
}
function render(view, open) {
  return renderToStaticMarkup(React.createElement(component.exports.ResearchResultContent,
    { result: view, open, onToggle() {}, onCopy() {}, copied: false }));
}
test('actual stored tag → History/Timeline → SSR shows partial-file warning before answer without changing Copy or outcome', () => {
  const f = fixture();
  assert.deepEqual(f.content.artifactSummary, { missing: 8, total: 21 });
  assert.deepEqual(f.snapshot.semanticTags[0].artifactSummary, { missing: 8, total: 21 });
  assert.equal(f.view.fileWarning, 'Не скачаны 8 из 21 файла.');
  assert.equal(f.view.previewText, f.view.fileWarning); assert.equal(f.view.failed, false);
  assert.equal(f.view.parts.at(-1).text, f.body);
  const collapsed = render(f.view, false), expanded = render(f.view, true);
  assert.match(collapsed, /Не скачаны 8 из 21 файла/);
  assert(expanded.indexOf('Не скачаны 8 из 21 файла') < expanded.indexOf('Полный ответ'));
  assert.match(expanded, /\[imagePath: \/synthetic\/example\.png\]/);
  assert.equal(buildResearchReplyClipboardPayload(f.entry, f.service).text, f.prompt);
  assert.equal(timelinePromptPreview(f.entry, hash).text, f.view.fileWarning);
});
test('complete files, invalid metadata and stale text never create a file warning', () => {
  const complete = fixture(0); assert.equal(complete.view.fileWarning, undefined);
  assert.equal(complete.view.previewText, '**Полный ответ.**\nПример `[imagePath: /synthetic/example.png]`.');
  const f = fixture(), bad = { ...f.entry, content: f.entry.content + 'foreign' };
  assert.equal(researchReplyFromProjection(bad, resolveHistoryOrchestrationPromptPresentation(bad),
    projectHistoryServicePromptBody(bad, hash)), null);
  const forged = normalizePromptPresentationSnapshot({ semanticTags: [{ ...f.snapshot.semanticTags[0], artifactSummary: { missing: 8, total: 2 } }] });
  assert.equal(forged.semanticTags[0].artifactSummary, undefined);
});
