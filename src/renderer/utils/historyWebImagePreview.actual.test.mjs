import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectPromptWebImageReferences } from './promptImageAttachments.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { rendererSharedCjsIds } from '../../../scripts/lib/renderer-shared-cjs.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['HistoryInlineTextPart', 'HistoryWebImageReference', 'HistoryImageTokenThumbnail', 'HistoryComposerToken'];
const code = names.map(name => {
  const node = ast.statements.find(n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
  assert.ok(node, name); return node.getText(ast);
}).join('\n');
function fixture() {
  let cursor = 0; const states = [], copied = [], requests = [];
  const context = vm.createContext({ React, collectPromptWebImageReferences,
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef: () => ({ current: null }), useCallback: fn => fn, useEffect() {},
    renderSentHistoryPromptHighlight: text => text,
    ComposerChip: props => React.createElement('button', { className: props.className }, props.leading, props.label),
    HistoryChipPopover: props => React.createElement('div', { 'data-controlled-portal': true }, props.children),
    PastedContentPreview: props => React.createElement('div', { 'data-controlled-preview': true }, props.body),
    fetch: (...args) => { requests.push(args); throw Error('remote image fetch forbidden'); },
  });
  vm.runInContext(ts.transpileModule(code + '\nglobalThis.Reference = HistoryWebImageReference; globalThis.Inline = HistoryInlineTextPart; globalThis.Token = HistoryComposerToken;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
  return { requests, copied, context,
    render(props) { cursor = 0; return context.Reference(props); } };
}

test('actual web-image History token is red, and its actual click reveals exact source without download/IPC', () => {
  const h = fixture(), link = '[image](https://www.google.com/s2/favicons?domain=example.test "[Image #1]")';
  const props = { source: link, url: 'https://www.google.com/s2/favicons?domain=example.test' };
  const closed = h.render(props), token = closed.props.children[0];
  assert.equal(token.props.kind, 'image'); assert.equal(token.props.error, true);
  const html = renderToStaticMarkup(token);
  assert.match(html, /color:#f87171/); assert.doesNotMatch(html, /<img|https:/);
  let blurred = 0;
  token.props.onClick({ blur() { blurred++; } });
  const open = h.render(props), preview = open.props.children[1].props.children;
  assert.equal(preview.props.text, link, 'existing popup Copy receives full original Markdown');
  assert.match(renderToStaticMarkup(preview), /Веб-изображение не загружено/);
  assert.match(renderToStaticMarkup(preview), /google.com/);
  open.props.children[0].props.onClick({ blur() { blurred++; } });
  assert.equal(h.render(props).props.children[1], false); assert.equal(blurred, 1);
  assert.deepEqual(h.requests, []);
});

test('actual plain/mixed History inline text retains neighboring text and ordinary links', () => {
  const h = fixture();
  const ordinary = '[guide](https://example.test) ordinary text';
  assert.equal(h.context.Inline({ text: ordinary }).props.children, ordinary);
  const link = '![icon](https://example.test/icon.png)';
  const mixed = h.context.Inline({ text: 'before ' + link + ' after' });
  assert.equal(mixed.props.children[0], 'before ');
  assert.equal(mixed.props.children[1].props.source, link);
  assert.equal(mixed.props.children.at(-1), ' after');
  assert.deepEqual(h.requests, []);
});

test('the same pure web-image grammar is included in actual DEV CJS routing and browser production transform', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  assert.ok(rendererSharedCjsIds(root).includes('@noted/shared-cjs/prompt-web-images.cjs'));
  const link = '[image](https://example.test/icon "[Image #1]")';
  const result = await build({ stdin: { resolveDir: root, loader: 'js', contents:
    `import { buildPromptImagePayload, inspectPromptImageAttachments } from './src/shared/prompt-image-attachments.mjs';
     globalThis.actualBrowserResult = [buildPromptImagePayload(${JSON.stringify(link)}, []), inspectPromptImageAttachments(${JSON.stringify(link)}, []).blocking];` },
    bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' });
  const context = vm.createContext({}); vm.runInContext(result.outputFiles[0].text, context);
  assert.equal(context.actualBrowserResult[0], link); assert.equal(context.actualBrowserResult[1], false);
  assert.doesNotMatch(result.outputFiles[0].text, /node:fs|node:child_process/);
});
