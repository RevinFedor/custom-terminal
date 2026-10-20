import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { historySendTimerState } from './historySendTiming.mjs';
import { HistoryPromptHandoffStore, reconcileHistoryPromptHandoffRows } from './historyPromptHandoffs.ts';
import { readHistorySendRecovery, saveHistorySendRecovery } from './historySendRecovery.mjs';
import { createRequire } from 'node:module';

const input = { tabId: 'T', handoffId: 'H', toolType: 'codex', text: 'original', submittedAt: 1000, initialStatus: 'preparing' };
test('seconds include app queue; first Enter freezes even while confirming or provider-queued', () => {
  for (const status of ['preparing', 'application-queued', 'sending'])
    assert.deepEqual(historySendTimerState({ startedAt: 1000, status }, 66000), { running: true, seconds: 65 });
  for (const status of ['audit-pending', 'queued', 'sent'])
    assert.deepEqual(historySendTimerState({ startedAt: 1000, enterAttemptAt: 13000, status }, 90000), { running: false, seconds: 12 });
  assert.equal(historySendTimerState({ startedAt: 1000, status: 'audit-pending', changedAt: 15000 }, 90000), null);
  assert.deepEqual(historySendTimerState({ startedAt: 1000, status: 'queued', reason: 'send-ready-queued' }, 66000), { running: true, seconds: 65 });
  assert.equal(historySendTimerState({ startedAt: 1000, status: 'queued', reason: 'provider-queue-accepted' }, 66000), null);
  assert.deepEqual(historySendTimerState({ startedAt: 1000, status: 'cancelled', changedAt: 5000 }, 90000), { running: false, seconds: 4 });
});
test('first exact Enter time survives null→A binding, phase changes and remount projection; old A cannot change B', () => {
  const store = new HistoryPromptHandoffStore(); store.begin(input);
  store.begin({ ...input, sendAttemptId: 'A', sendOperationKey: 'O', submittedAt: 6000 });
  assert.equal(store.getSnapshot('T')[0].submittedAt, 1000);
  store.recordEnterAttempt('T', 'H', { sendAttemptId: 'old', sendOperationKey: 'O', enterAttemptAt: 7000 });
  assert.equal(store.getSnapshot('T')[0].enterAttemptAt, undefined);
  store.recordEnterAttempt('T', 'H', { sendAttemptId: 'A', sendOperationKey: 'O', enterAttemptAt: 8000 });
  store.recordEnterAttempt('T', 'H', { sendAttemptId: 'A', sendOperationKey: 'O', enterAttemptAt: 10000 });
  store.advanceTransportPhase('T', 'H', 'confirming');
  assert.equal(store.getSnapshot('T')[0].enterAttemptAt, 8000);
  const row = reconcileHistoryPromptHandoffRows({ rows: [], handoffs: store.getSnapshot('T'), createRow: () => ({}) }).rows[0];
  assert.equal(row.enterAttemptAt, 8000); assert.equal(row.optimisticAt, 1000);
  store.begin({ ...input, sendAttemptId: 'B', sendOperationKey: 'O', submittedAt: 20000 });
  store.recordEnterAttempt('T', 'H', { sendAttemptId: 'A', sendOperationKey: 'O', enterAttemptAt: 21000 });
  assert.equal(store.getSnapshot('T')[0].enterAttemptAt, undefined);
});
test('recovery retains text/assets/authoring and phase without executing or manufacturing Main receipt', () => {
  const map = new Map(), storage = { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v) };
  const saved = { ...input, authoringText: 'raw [Image #1]', authoringImagePaths: [{ id: 1, path: '/same.png' }], authoringChips: [{ id: 'chip', text: 'body' }] };
  saveHistorySendRecovery(saved, 'preparing', storage);
  assert.deepEqual(readHistorySendRecovery(storage), [{ input: saved, phase: 'preparing' }]);
  saveHistorySendRecovery({ ...saved, text: 'context\noriginal' }, 'dispatched', storage);
  assert.equal(readHistorySendRecovery(storage).length, 1);
  assert.equal(readHistorySendRecovery(storage)[0].phase, 'dispatched');
  assert.equal(readHistorySendRecovery(storage)[0].input.sendAttemptId, undefined);
});
test('actual timer JSX freezes to static seconds while its adjacent status can keep loading', () => {
  const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let timer;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'HistorySendTimer') timer = node.getText(ast); ts.forEachChild(node, visit); };
  visit(ast); assert.ok(timer);
  const code = ts.transpileModule(`const ${timer}; globalThis.Component = HistorySendTimer;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const ctx = vm.createContext({ React, memo: React.memo, useState: React.useState, useEffect: React.useEffect,
    historySendTimerState });
  vm.runInContext(code, ctx);
  const html = renderToStaticMarkup(React.createElement(ctx.Component, { startedAt: 1000, enterAttemptAt: 66000, status: 'audit-pending' }));
  assert.match(html, /65s<\/span>/); assert.match(html, /data-running="false"/); assert.doesNotMatch(html, /0:|aria-live/);
  assert.match(html, /Счёт остановлен/);
  assert.doesNotMatch(html, /noted-text-shimmer/, 'confirmation does not keep the frozen duration animated');
  const runningHtml = renderToStaticMarkup(React.createElement(ctx.Component, { startedAt: Date.now(), status: 'preparing' }));
  assert.match(runningHtml, /data-running="true"/);
  assert.doesNotMatch(runningHtml, /noted-text-shimmer|<svg/, 'the running duration has no animation');
  assert.match(runningHtml, /Счёт идёт/);
  assert.match(source, /\.hp-history-send-timer\[data-running="true"\]\s*\{\s*color: var\(--cb-message-info, #60a5fa\);/);
  assert.match(source, /\.hp-history-send-timer\s*\{\s*color: var\(--cb-text, #e0e0e0\);/);
  assert.match(source, /\.hp-user-message-status > \.cb-message-status,\s*\.hp-history-send-timer\s*\{[^}]*font-size: 10px;[^}]*font-weight: 600;/,
    'the duration and status share their font size and weight');
  const start = source.indexOf('{queueStatusPresentation && <HistorySendTimer');
  assert.ok(start > 0 && start < source.indexOf('{canDismissPromptPresentation && (', start));
});

test('actual App bridge retains click time through the actual Main presentation normalizer', () => {
  const source = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'sendAgentPromptScenario'
      && ts.isObjectLiteralExpression(node.arguments[0])) {
      const prop = node.arguments[0].properties.find(p => p.name?.getText(ast) === 'presentationSnapshot');
      if (prop && ts.isObjectLiteralExpression(prop.initializer)) expression = prop.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(expression);
  const ctx = vm.createContext({ sessionId: 'S', presentationSnapshot: { historySendStartedAt: 1000 } });
  const projected = vm.runInContext('(' + expression + ')', ctx);
  const { normalizePromptPresentationSnapshot } = createRequire(import.meta.url)('../../main/history-prompt-presentations.js');
  assert.equal(normalizePromptPresentationSnapshot(projected)?.historySendStartedAt, 1000);
});
