import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
const source = fs.readFileSync(new URL('./TabMessageSourceChip.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('TabMessageSourceChip.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'HistoryPromptSource');
assert.ok(node);
const code = ts.transpileModule(node.getText(ast).replace(/^export /, ''), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const Header = vm.runInNewContext(code + '\nHistoryPromptSource', { React, ArrowDownLeft, ArrowUpRight,
  useState: React.useState,
  useRef: React.useRef,
  TabMessageSourceChip: ({ source }) => React.createElement('button', { 'data-source-id': source.sourceTabId }, source.sourceTabName) });

test('actual source header uses the request/response arrows, one sender name and no phase caption', () => {
  const sender = { sourceTabId: 'exact-tab', sourceTabName: 'Fork / Rewind' };
  for (const phase of ['question', 'request', 'reply', 'completion', 'failure']) {
    const html = renderToStaticMarkup(React.createElement(Header, { source: sender, phase }));
    assert.match(html, /data-source-id="exact-tab"/);
    assert.equal(html.split('Fork / Rewind').length - 1, 1);
    assert.match(html, new RegExp('data-history-source-direction="' + (['question', 'request'].includes(phase) ? 'incoming-request' : 'response') + '"'));
    assert.match(html, new RegExp('lucide-arrow-' + (['question', 'request'].includes(phase) ? 'down-left' : 'up-right')));
    assert.doesNotMatch(html, /<span[^>]*>(Вопрос|Ответ|Запрос)<\/span>/);
  }
});

test('addressed messages have a separate arrow button; only their name opens without a seek', () => {
  for (const phase of ['question', 'reply']) {
    const html = renderToStaticMarkup(React.createElement(Header, {
      source: { messageId: 'exact-message', sourceTabId: 'exact-tab', sourceTabName: 'Source' }, phase,
    }));
    assert.match(html, /<button[^>]+data-tab-message-source-jump="exact-message"/);
    assert.equal((html.match(/<button/g) || []).length, 2);
    assert.equal((html.match(/data-source-id="exact-tab"/g) || []).length, 1);
    assert.doesNotMatch(html, /<button[^>]*>[^<]*<button/);
  }
  const native = renderToStaticMarkup(React.createElement(Header, {
    source: { sourceTabId: 'worker', sourceTabName: 'Worker' }, phase: 'completion',
  }));
  assert.doesNotMatch(native, /data-tab-message-source-jump/);
});

test('unknown relationship does not invent an arrow; browser source retains its label', () => {
  const html = renderToStaticMarkup(React.createElement(Header, { source: { label: 'ChatGPT - Astra' }, phase: 'unknown' }));
  assert.match(html, /ChatGPT - Astra/);
  assert.doesNotMatch(html, /data-history-source-direction|data-source-id/);
});

test('external research completion has a job-navigation button, not a guessed terminal source or browser URL', () => {
  const html=renderToStaticMarkup(React.createElement(Header,{source:{label:'ChatGPT · 6-astra',researchRunId:'exact-run'},phase:'completion'}));
  assert.match(html,/<button[^>]+data-external-research-source="exact-run"/);
  assert.match(html,/Открыть задачу в SC Desktop/);assert.match(html,/ChatGPT · 6-astra/);
  assert.doesNotMatch(html,/data-source-id|href=|chatgpt\.com/);
});
