import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import manualActionContract from '../../shared/agent-manual-action.cjs';
import { syncSessionStartingWithPresence } from './sessionStartingState.mjs';
import { buildHistorySendIncidentReport } from './historySendIncidentReport.mjs';

const require = createRequire(import.meta.url);
const read = name => fs.readFileSync(new URL('../components/Workspace/' + name, import.meta.url), 'utf8');
const parse = name => ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const variable = (ast, name) => ast.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [])
  .find(n => n.name.getText(ast) === name).initializer.getText(ast);
const evaluate = (code, context) => vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);

const hookAst = parse('useAgentLifecycle.ts');
let summary;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(hookAst) === 'useMemo'
    && node.arguments[0]?.getText(hookAst).includes('const isInfo =')) summary = node.arguments[0].getText(hookAst);
  ts.forEachChild(node, visit);
}
visit(hookAst); assert.ok(summary);

test('actual lifecycle projection renders a static blue-info summary with no retry or error', () => {
  const info = { tabId: 'T', engine: 'codex', sessionId: 'S' };
  const state = syncSessionStartingWithPresence(null, info, { status: 'active', inputReady: false,
    manualActionRequired: true, runtimePolicy: { type: 'resume-goal', phase: 'manual' },
    lastNotReady: { reason: 'codex_resume_goal_action_required', blockers: ['resume-goal'],
      message: 'Завершите выбор для Goal в терминале.' } });
  const ctx = { sessionStarting: state, enabled: true, tabId: 'T', agentStopping: null,
    handleDismiss() {}, handleRetry() {} };
  const result = evaluate('const getSessionStartingPresentation = ' + variable(hookAst, 'getSessionStartingPresentation')
    + '; (' + summary + ')()', ctx);
  assert.equal(result.kind, 'info'); assert.equal(result.spinner, false);
  assert.match(result.description, /Goal/); assert.ok(result.onDismiss);
  assert.equal(result.onRetry, undefined);
  assert.doesNotMatch(result.detail, /повторная отправка не нужна/);
  assert.equal(syncSessionStartingWithPresence(state, info, { status: 'active', inputReady: true }), null);

  const module = { exports: {} };
  vm.runInNewContext(transformSync(read('AgentLifecycleActions.tsx'), { loader: 'tsx', format: 'cjs' }).code,
    { module, exports: module.exports, require });
  const html = renderToStaticMarkup(React.createElement(module.exports.default, { lifecycle: result }));
  assert.match(html, /#60a5fa/); assert.match(html, /data-agent-lifecycle-dismiss/);
  assert.doesNotMatch(html, /data-agent-lifecycle-retry|#ef4444|#fbbf24/);
});

test('actual History reporter uses information only for a proven unwritten manual-choice cancellation', () => {
  const panelAst = parse('HistoryPanel.tsx');
  const calls = [];
  const report = evaluate('(' + variable(panelAst, 'showHistoryIncidentToast') + ')', {
    manualActionContract, buildHistorySendIncidentReport,
    useUIStore: { getState: () => ({ showToast: (...args) => calls.push(args) }) },
  });
  const failure = { code: 'codex_resume_goal_action_required', manualActionRequired: true,
    message: 'Завершите выбор для Goal в терминале.',
    sendReceipt: { submitted: false, pasteWritten: false, enterWritten: false } };
  report('T', failure, { action: 'send' });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'info');
  assert.match(calls[0][0], /возвращено в поле/); assert.equal(calls[0][4], undefined);
  assert.equal(calls[0][7], 'T');
  for (const different of [
    { ...failure, manualActionRequired: false },
    { ...failure, sendReceipt: { ...failure.sendReceipt, submitted: true } },
    { ...failure, sendReceipt: { ...failure.sendReceipt, pasteWritten: true } },
    { ...failure, sendReceipt: undefined },
    { ...failure, code: 'unknown_failure' },
  ]) { report('T', different, { action: 'send' }); assert.equal(calls.at(-1)[1], 'error'); }
});

test('handled Goal with unknown process proof no longer renders the old Goal info summary', () => {
  const info = { tabId: 'T', engine: 'codex', sessionId: 'S' };
  const old = syncSessionStartingWithPresence(null, info, { status: 'active', inputReady: false,
    manualActionRequired: true, lastNotReady: { reason: 'codex_resume_goal_action_required',
      message: 'Завершите выбор для Goal в терминале.' } });
  const state = syncSessionStartingWithPresence(old, info, { status: 'unknown', inputReady: false,
    manualActionRequired: false, runtimePolicy: { type: 'resume-goal', phase: 'handled' },
    lastNotReady: { reason: 'process_lookup_unknown', message: 'Process proof unavailable' } });
  const result = evaluate('const getSessionStartingPresentation = ' + variable(hookAst, 'getSessionStartingPresentation')
    + '; (' + summary + ')()', { sessionStarting: state, enabled: true, tabId: 'T',
      agentStopping: null, handleDismiss() {}, handleRetry() {} });
  assert.notEqual(result.kind, 'info');
  assert.doesNotMatch(JSON.stringify(result), /Завершите выбор для Goal|Codex ждёт выбора/);
  assert.equal(state.lastNotReady.reason, 'process_lookup_unknown');
  assert.equal(state.inputReady, undefined);
});
