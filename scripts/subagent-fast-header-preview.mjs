#!/usr/bin/env node
// Presentation-only Electron check: actual Inspector header JSX + actual launch
// component, fed by the real incremental reader of synthetic private histories.
// No provider, user state, clipboard, shared CDP connection or system input.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const reader = require('../src/main/subagent-transcript.js');
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-subagent-fast-header-'));
const componentPath = 'src/renderer/components/Workspace/HistoryAgentLaunchParameters.tsx';
const panelPath = 'src/renderer/components/Workspace/HistoryPanel.tsx';
const componentSource = await fs.readFile(path.join(repo, componentPath), 'utf8');
const panelSource = await fs.readFile(path.join(repo, panelPath), 'utf8');
const componentAst = ts.createSourceFile(componentPath, componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = componentAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'HistoryAgentLaunchParameters');
assert.ok(declaration);
const transpile = source => ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022,
} }).outputText;
const Header = vm.runInNewContext(transpile(declaration.getText(componentAst).replace(/^export default /, ''))
  + '\nHistoryAgentLaunchParameters;', { React, Zap: icons.Zap });
const panelAst = ts.createSourceFile(panelPath, panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const candidates = [];
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(panelAst) === 'div'
    && node.getText(panelAst).includes('<HistoryAgentLaunchParameters')) candidates.push(node);
  ts.forEachChild(node, visit);
}
visit(panelAst);
const headerNode = candidates.sort((a, b) => a.getWidth(panelAst) - b.getWidth(panelAst))[0];
assert.ok(headerNode, 'actual outer Inspector header JSX');
const renderHeader = vm.runInNewContext(transpile('function ActualInspectorHeader(props) {\n'
  + 'const { chip, creationLaunchSettings, ownLaunchSettings, launchServiceTier } = props;\n'
  + 'const running=true, interrupted=false, statusColor="#d97706", statusLabel="Working", toolType="codex";\n'
  + 'const fullAgentAnswer="Synthetic", answerCopied=false, durationMs=52000;\n'
  + 'const copyAgentAnswer=()=>{}, onJumpToCard=()=>{}, onClose=()=>{};\n'
  + 'return (' + headerNode.getText(panelAst) + ');\n}\n') + '\nActualInspectorHeader;', {
  React, ...icons, HistoryAgentLaunchParameters: Header,
  HistoryBackgroundDot: () => React.createElement('span', { style: { width: 6, height: 6, background: '#d97706', borderRadius: 3, flexShrink: 0 } }),
  formatBackgroundElapsed: () => '52s', formatSubagentDuration: () => '52s',
});
const cases = [];
for (const [name, tier] of [['on', 'priority'], ['off', 'default'], ['unknown', undefined]]) {
  const records = [{ type: 'session_meta', payload: { id: 'synthetic-child' } },
    ...(tier === undefined ? [] : [{ type: 'event_msg', payload: { type: 'thread_settings_applied',
      thread_id: 'synthetic-child', thread_settings: { service_tier: tier } } }]),
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'max' } }];
  const filePath = path.join(artifact, name + '.synthetic.jsonl');
  await fs.writeFile(filePath, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await reader.readAgentStepsAsync({ toolType: 'codex', filePath, sessionId: 'synthetic-child',
    projectionState: reader.createSubagentStepProjectionState({ codexSessionId: 'synthetic-child' }) });
  cases.push({ name, result });
}
const gallery = [350, 500, 1000].map(width => '<section style="width:' + width + 'px"><h2>' + width + ' px</h2>'
  + cases.map(({ name, result }) => '<article data-case="' + width + '-' + name + '">'
    + renderToStaticMarkup(React.createElement(renderHeader, {
      chip: { kind: 'subagent', label: 'synthetic-task-' + name, entryUuid: 'synthetic-entry', startedAt: 1 },
      creationLaunchSettings: { ...result.launchSettings, source: 'subagent-started' },
      ownLaunchSettings: result.launchSettings, launchServiceTier: result.launchServiceTier,
    })) + '</article>').join('') + '</section>').join('');
const html = '<!doctype html><meta charset="utf-8"><style>'
  + '*{box-sizing:border-box}body{margin:0;padding:12px;background:#111;color:#bbb;font:14px system-ui}'
  + 'h1{font-size:14px;margin:0 0 8px}h2{font-size:12px;margin:8px 0 3px;color:#888}'
  + 'article{border:1px solid #333;margin:3px 0}.truncate{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}'
  + '</style><h1>Inspector: launch model · effort · Fast — synthetic reader / actual header</h1>' + gallery;
await fs.writeFile(path.join(artifact, 'index.html'), html);
await fs.writeFile(path.join(artifact, 'main.cjs'), 'const {app,BrowserWindow}=require("electron");'
  + 'app.setPath("userData",' + JSON.stringify(path.join(artifact, 'profile')) + ');'
  + 'app.setName("Noted Fast header preview");app.setActivationPolicy?.("accessory");'
  + 'app.whenReady().then(()=>{app.dock?.hide();global.win=new BrowserWindow({width:1040,height:600,show:false,'
  + 'focusable:false,frame:false,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});'
  + 'win.webContents.on("paint",()=>{});win.webContents.setFrameRate(30);win.loadFile('
  + JSON.stringify(path.join(artifact, 'index.html')) + ')});app.on("window-all-closed",()=>app.quit());');
const result = { status: 'RUNNING', mode: 'presentation-only', artifact,
  hashes: { [componentPath]: createHash('sha256').update(componentSource).digest('hex'),
    [panelPath]: createHash('sha256').update(panelSource).digest('hex') }, cleanup: {} };
let app;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  result.pid = app.process().pid;
  const page = await app.firstWindow();
  await page.screenshot({ path: path.join(artifact, 'full-header.png') });
  result.engine = await app.evaluate(() => ({ electron: process.versions.electron, visible: win.isVisible(), focused: win.isFocused() }));
  assert.equal(result.engine.visible, false); assert.equal(result.engine.focused, false);
  result.geometry = await page.evaluate(() => [...document.querySelectorAll('[data-case]')].map(row => {
    const fast = row.querySelector('[data-history-agent-launch-fast]'), effort = row.querySelector('[data-history-agent-launch-effort]');
    const model = row.querySelector('[data-history-agent-launch-model]');
    const status = [...row.querySelectorAll('span')].find(node => node.textContent === 'Working');
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width }; };
    return { name: row.dataset.case, tier: fast?.dataset.historyAgentLaunchFast, text: fast?.textContent,
      row: rect(row), fast: rect(fast), effort: rect(effort), status: rect(status),
      model: { scrollWidth: model.scrollWidth, clientWidth: model.clientWidth } };
  }));
  assert.equal(result.geometry.length, 9);
  for (const entry of result.geometry) {
    const expected = entry.name.endsWith('-on') ? 'priority' : entry.name.endsWith('-off') ? 'default' : 'unknown';
    assert.equal(entry.tier, expected);
    assert.ok(entry.model.scrollWidth <= entry.model.clientWidth, 'ordinary model name remains fully readable ' + entry.name);
    assert.ok(entry.fast.x >= entry.row.x && entry.fast.right <= entry.row.right, 'Fast stays inside ' + entry.name);
    assert.ok(entry.effort.right <= entry.fast.x, 'Fast follows effort ' + entry.name);
    const verticalOverlap = Math.min(entry.fast.bottom, entry.status.bottom) - Math.max(entry.fast.y, entry.status.y);
    assert.ok(verticalOverlap <= 0 || entry.fast.right <= entry.status.x, 'Fast does not overlap Working ' + entry.name);
  }
  const colors = await page.locator('[data-history-agent-launch-fast]').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
  assert.equal(new Set(colors).size, 3, 'on/off/unknown have distinct visible colors');
  result.status = 'PASS';
} catch (error) { result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1; }
finally {
  if (app) await app.close();
  try { process.kill(result.pid, 0); result.cleanup.pidGone = false; } catch { result.cleanup.pidGone = true; }
  for (const entry of await fs.readdir(artifact, { withFileTypes: true })) {
    if (entry.name === 'profile' && entry.isDirectory() && !entry.isSymbolicLink()) {
      await fs.rm(path.join(artifact, 'profile'), { recursive: true, force: true }); result.cleanup.profileRemoved = true;
    }
  }
  await fs.writeFile(path.join(artifact, 'RESULT.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, cleanup: result.cleanup, error: result.error }));
}
