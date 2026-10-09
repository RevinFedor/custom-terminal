import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function declaration(file, name) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(ast).replace(/^export default /, ''), {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const Header = vm.runInNewContext(declaration('./HistoryAgentLaunchParameters.tsx', 'HistoryAgentLaunchParameters')
  + '\nHistoryAgentLaunchParameters;', { React });
const settings = sid => ({ version: 1, provider: 'codex', sessionId: sid,
  source: 'own-turn-context', model: 'gpt-6-luna', effort: 'max', timestamp: '2026-10-09T07:00:00Z' });

test('actual navbar renders launch model/effort, not the generic agent title', () => {
  const html = renderToStaticMarkup(React.createElement(Header, { settings: settings('child-A'), taskLabel: 'Task A' }));
  assert.match(html, /data-history-agent-launch-model/);
  assert.match(html, /gpt-6-luna/); assert.match(html, />max</);
  assert.doesNotMatch(html, />Task A</); assert.doesNotMatch(html, />Subagent</);
});

test('unknown launch fields remain explicitly unknown without invented defaults', () => {
  const html = renderToStaticMarkup(React.createElement(Header, { settings: null, taskLabel: 'Task A' }));
  assert.match(html, /Модель —/); assert.match(html, /effort —/);
  assert.doesNotMatch(html, /gpt-|>max</);
});

test('Claude model without a proven effort is rendered partially, not as parent max', () => {
  const html = renderToStaticMarkup(React.createElement(Header, { settings: {
    ...settings('claude-A'), provider: 'claude', model: 'claude-haiku', effort: null }, taskLabel: 'Task A' }));
  assert.match(html, /claude-haiku/); assert.match(html, /effort —/); assert.doesNotMatch(html, />max</);
});

test('actual selected-reader hook rejects stale A→B metadata and does not reread on model state update', async () => {
  const states = [], refs = [], pendingEffects = [], readRequests = [], releases = [];
  let stateIndex = 0, refIndex = 0, lastDeps = null, cleanup = null, nextTimer = 0;
  const set = (index, value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; };
  const scope = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial;
      return [states[index], value => set(index, value)]; },
    useRef(initial) { const index = refIndex++; if (!(index in refs)) refs[index] = { current: initial }; return refs[index]; },
    useEffect(effect, deps) { if (!lastDeps || deps.some((value, index) => value !== lastDeps[index])) {
      if (cleanup) cleanup(); lastDeps = deps; pendingEffects.push(effect); } },
    ipcRenderer: { invoke(channel, request) {
      assert.equal(channel, 'subagent:read-steps');
      return new Promise(resolve => readRequests.push({ request, resolve }));
    }, send(channel, request) { releases.push({ channel, request }); } },
    window: { setInterval() { return ++nextTimer; }, clearInterval() {}, setTimeout() { return ++nextTimer; }, clearTimeout() {} },
    mergeHistoryTranscriptSteps: (before, next) => [...before, ...next],
    Date, Math,
  };
  const useReader = vm.runInNewContext(declaration('./HistoryPanel.tsx', 'useSubagentSteps') + '\nuseSubagentSteps;', scope);
  const chip = sid => ({ key: 'task:' + sid, kind: 'subagent', agentSessionId: sid, label: sid, startedAt: 100, status: 'running' });
  const render = sid => { stateIndex = 0; refIndex = 0;
    const value = useReader(chip(sid), 'tab-A', 'codex', '/private-fixture', 'parent-A');
    for (const effect of pendingEffects.splice(0)) cleanup = effect(); return value; };
  render('child-A'); assert.equal(readRequests.length, 1);
  assert.equal(render('child-B').launchSettings, null); assert.equal(readRequests.length, 2);
  readRequests[0].resolve({ success: true, steps: [], offset: 80, pending: false, launchSettings: settings('child-A') });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(render('child-B').launchSettings, null);
  readRequests[1].resolve({ success: true, steps: [], offset: 90, pending: false, launchSettings: settings('child-B') });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(render('child-B').launchSettings.sessionId, 'child-B');
  assert.equal(readRequests.length, 2, 'metadata changes do not create a new reader or invoke');
  assert.equal(refs[0].current, 90, 'same read offset remains authoritative');
  assert.equal(releases.length, 1, 'only replaced A reader was released');
  cleanup(); assert.equal(releases.length, 2);
});
