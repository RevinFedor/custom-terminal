import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowUpRight, Globe } from 'lucide-react';

const source = fs.readFileSync(new URL('./TabMessageSourceChip.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ResearchSourceAction');
const code = ts.transpileModule(declaration.getText(ast).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

function harness(invoke) {
  const calls = [], errors = [], phases = [];
  const Component = vm.runInNewContext(code + '\nResearchSourceAction', { React, ArrowUpRight, Globe,
    performance, useRef: value => ({ current: value }), useState: value => [value, () => {}],
    currentUIActionId: () => 'action-one', cancelTabMessageSourceJump() {},
    uiPerformancePhaseForAction: (_id, phase, values) => phases.push([phase, values.stage]),
    useUIStore: { getState: () => ({ showToast: message => errors.push(message) }) },
    ipcRenderer: { invoke: async (channel, args) => { calls.push([channel, args]); return invoke(channel, args); } },
  });
  return { Component, calls, errors, phases };
}
const event = () => ({ stopPropagation() {} });
test('arrow and browser icons invoke separate exact-run channels without disclosure', async () => {
  const h = harness(() => ({ success: true, jobId: 'job', tabId: 7 }));
  const desktop = h.Component({ runId: 'run', iconOnly: true });
  const browser = h.Component({ runId: 'run', iconOnly: true, destination: 'browser' });
  assert.match(renderToStaticMarkup(desktop), /lucide-arrow-up-right/);
  assert.match(renderToStaticMarkup(browser), /lucide-globe/);
  assert.equal(browser.props.title, 'Открыть разговор в браузере');
  desktop.props.onClick(event()); browser.props.onClick(event());
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.map(([channel]) => channel), ['orchestration:open-research-job', 'orchestration:open-research-browser']);
  assert.equal(h.calls[1][1].runId, 'run'); assert.equal(h.calls[1][1].actionId, 'action-one');
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.phases.map(p => p[1]), ['begin', 'begin', 'opened', 'opened']);
});
test('held browser action coalesces clicks before await; unknown ACK becomes an error', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const button = h.Component({ runId: 'run', iconOnly: true, destination: 'browser' });
  button.props.onClick(event()); button.props.onClick(event());
  assert.equal(h.calls.length, 1);
  release({ success: true, jobId: 'job' });
  await new Promise(setImmediate);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.phases.at(-1), ['history-research-browser-open', 'failed']);
});
test('History binds browser action only to proven research run metadata', () => {
  const hp = fs.readFileSync(new URL('./HistoryPanel.tsx', import.meta.url), 'utf8');
  assert.match(hp, /browserAction=\{source\?\.researchRunId \? <ResearchSourceAction runId=\{source\.researchRunId\}[\s\S]*?iconOnly destination="browser"/);
});
