import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = fs.readFileSync(new URL('./HistoryAgentLaunchTimestamp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryAgentLaunchTimestamp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'HistoryAgentLaunchTimestamp');
assert.ok(fn);
const js = ts.transpileModule(fn.getText(ast).replace(/^export default /, ''), {
  compilerOptions: {jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022},
}).outputText;
class NoCurrentTime extends Date { static now() { assert.fail('launch display must not invent current time'); } }
const Timestamp = vm.runInNewContext(js + '\nHistoryAgentLaunchTimestamp;', {React, Date: NoCurrentTime});
const render = startedAt => renderToStaticMarkup(React.createElement(Timestamp, {startedAt}));

test('actual launch timestamp visibly shows absolute local date/year/minute and preserves canonical UTC datetime', () => {
  const started = new Date(2026, 9, 25, 10, 7, 33);
  const html = render(started.getTime());
  assert.match(html, /Старт 25\.10\.2026 10:07/);
  assert.ok(html.includes(`dateTime="${started.toISOString()}"`));
  assert.match(html, /местное время/);
  assert.doesNotMatch(html, /сегодня|вчера|1970/);
});

test('actual launch timestamp does not borrow open/completion time and is stable on reopen', () => {
  const started = new Date(2025, 11, 31, 23, 58).getTime();
  assert.match(render(started), /Старт 31\.12\.2025 23:58/);
  assert.equal(render(started), render(started));
  const next = render(new Date(2026, 0, 1, 0, 1).getTime());
  assert.match(next, /Старт 01\.01\.2026 00:01/);
  assert.doesNotMatch(next, /31\.12\.2025/);
});

test('actual launch timestamp explicitly keeps missing, invalid and out-of-range values unknown', () => {
  for (const value of [0, undefined, null, NaN, Infinity, -1, 9e15, '2026-10-25']) {
    const html = render(value);
    assert.match(html, /Старт —/);
    assert.match(html, /Время запуска неизвестно/);
    assert.doesNotMatch(html, /<time|dateTime|1970/);
  }
});

test('actual launch timestamp remains one compact noninteractive unit without state/timer/subscription', () => {
  assert.doesNotMatch(source, /useState|useEffect|useWorkspaceStore|setInterval|setTimeout|ipcRenderer|Date\.now/);
  assert.match(source, /export default React\.memo\(HistoryAgentLaunchTimestamp\)/);
  const html = render(new Date(2026, 9, 25, 10, 7).getTime());
  assert.match(html, /white-space:nowrap/);
  assert.match(html, /flex-shrink:0/);
  assert.doesNotMatch(html, /<button|tabindex|cursor:wait/);
});

test('actual Inspector header uses the selected chip start, only for subagents, and keeps existing wrap/actions', () => {
  const panel = fs.readFileSync(new URL('./HistoryPanel.tsx', import.meta.url), 'utf8');
  const start = panel.indexOf('<div data-history-agent-detail-header');
  const end = panel.indexOf('aria-label="Close agent pane"', start);
  assert.ok(start > 0 && end > start);
  const header = panel.slice(start, end);
  assert.match(header, /chip\.kind === 'subagent' && <HistoryAgentLaunchTimestamp startedAt=\{chip\.startedAt}/);
  assert.match(header, /flexWrap: chip\.kind === 'subagent' \? 'wrap'/);
  assert.ok(header.indexOf('HistoryAgentLaunchTimestamp') < header.indexOf('{statusLabel}'));
  assert.match(header, /formatBackgroundElapsed\(chip\.startedAt\)/);
  assert.match(panel, /import HistoryAgentLaunchTimestamp from '\.\/HistoryAgentLaunchTimestamp'/);
});
