import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const begin = source.indexOf('const HistoryComposerToken = (');
const end = source.indexOf('\ntype HistoryInstructionAttachment', begin);
const code = ts.transpileModule(source.slice(begin, end) + '\nglobalThis.Token = HistoryComposerToken;', {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = { React, require, HistoryImageTokenThumbnail: () => null,
  ComposerChip: props => React.createElement('button', { className: props.className }, props.label) };
vm.runInNewContext(code, context);

test('the actual History token keeps the chip and marks an unavailable image red', () => {
  const html = renderToStaticMarkup(React.createElement(context.Token, {
    kind: 'image', label: 'image #1', error: true, onClick() {}, buttonRef() {},
  }));
  assert.match(html, /hp-history-attachment-chip/);
  assert.match(html, /color:#f87171/);
  assert.match(html, /image #1/);
  const imageBranch = source.slice(source.indexOf('const partKey = `image:${index}:${part.id}`'));
  assert.match(imageBranch, /AIComposerImageAttachmentPreview[\s\S]*?error=\{expandedImagePart === part[\s\S]*?imageError/);
});
