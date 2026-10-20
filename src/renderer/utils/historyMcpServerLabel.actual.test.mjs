import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Real presentation components, in-memory bundling and SSR. No MCP invocation,
// Electron/browser, effects, clipboard or physical layout claim.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const bundle = buildSync({
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    export { ToolCallPart } from './packages/claude-blocks/src/components/ToolCards.tsx';
    export { HistoryCollapsedGroupRow } from './src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx';
  ` }, bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + 'packages/claude-blocks/src/index.ts' },
  loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { ToolCallPart, HistoryCollapsedGroupRow } = loaded.exports;
const args = { summary: 'cua_repl · js', code: 'await cua.getState();', title: 'Проверить доступные поверхности Computer Use' };
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test('raw and normalized Computer Use calls have a stable friendly server name, not a changing title', () => {
  for (const identity of [{ toolName: 'mcp__cua_repl__js' },
    { toolName: 'MCP', family: 'mcp', mcpServer: 'cua_repl', mcpMethod: 'js' }]) {
    const props = { ...identity, args, result: 'surface inventory' }, before = JSON.stringify(props);
    const html = render(ToolCallPart, props);
    assert.match(html, /Computer Use · js/);
    assert.doesNotMatch(html, /cua_repl|Проверить доступные поверхности|await cua/);
    assert.equal(JSON.stringify(props), before);
    const otherTitle = render(ToolCallPart, { ...props, args: { ...args, title: 'Read another window' } });
    assert.match(otherTitle, /Computer Use · js/);
    assert.doesNotMatch(otherTitle, /Read another window/);
  }
});

test('the real Codex normalizer supplies the same raw MCP identity and original invocation fields', () => {
  const { _api } = require(root + 'src/main/ipc/codex-data.js');
  const history = _api.buildCodexFullHistory([
    { __line: 1, type: 'event_msg', payload: { type: 'user_message', message: 'fixture' } },
    { __line: 2, type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__cua_repl',
      name: 'js', call_id: 'exact-computer-use-call', arguments: JSON.stringify(args) } },
  ], 'fixture-session');
  const action = history.flatMap(entry => entry.actions || []).map(action => action.rawTool)
    .find(action => action?.toolUseId === 'exact-computer-use-call:canonical:0');
  assert.ok(action);
  assert.equal(action.toolName, 'MCP');
  assert.equal(action.mcpServer, 'cua_repl');
  assert.equal(action.mcpMethod, 'js');
  assert.equal(action.args.code, args.code); assert.equal(action.args.title, args.title);
  const html = render(ToolCallPart, action);
  assert.match(html, /Computer Use · js/);
  assert.doesNotMatch(html, /cua_repl|Проверить доступные поверхности/);
});

test('expanded invocation stays raw while its header uses the friendly name', () => {
  const props = { toolName: 'mcp__cua_repl__js', args, result: 'surface inventory', collapse: { open: true, onToggle() {} } };
  const before = JSON.stringify(props);
  const html = render(ToolCallPart, props);
  assert.match(html, /Computer Use · js/);
  assert.match(html, /cua_repl · js/);
  assert.match(html, /await cua.getState\(\);/);
  assert.match(html, /Проверить доступные поверхности Computer Use/);
  assert.equal(JSON.stringify(props), before);
});

test('other MCP servers keep their own identity even when payload mentions Computer Use', () => {
  for (const server of ['terminal', 'knowledge', 'other_server']) {
    const html = render(ToolCallPart, { toolName: 'MCP', family: 'mcp', mcpServer: server, mcpMethod: 'read',
      args: { title: 'Computer Use' }, result: 'done' });
    assert.match(html, new RegExp(server + ' · read'));
    assert.doesNotMatch(html, /Computer Use/);
  }
});

test('outer and nested MCP group qualifiers use the same label without rewriting facts', () => {
  for (const level of [1, 2]) {
    const group = { key: 'g', level, familyKey: 'mcp', entries: [], errorCount: 0,
      facts: [{ toolName: 'MCP', family: 'mcp', mcpServer: 'cua_repl', mcpMethod: 'js', toolUseId: 'exact-call' }] };
    const before = JSON.stringify(group);
    const html = render(HistoryCollapsedGroupRow, { group, expanded: false, onToggle() {} });
    assert.match(html, /Computer Use/);
    assert.match(html, /hp-history-group-token-label">MCP/);
    assert.doesNotMatch(html, /cua[ _]repl/);
    assert.equal(JSON.stringify(group), before);
  }
});

test('friendly names invalidate old measured geometry while preserving the existing inset and MCP style variants', () => {
  const source = readFileSync(root + 'src/renderer/components/Workspace/HistoryPanel.tsx', 'utf8');
  const start = source.indexOf('const displayUnitLayoutKeys = useMemo(');
  const end = source.indexOf('const displayUnitLayoutKeysRef =', start);
  assert.ok(start > 0 && end > start);
  const code = transformSync(source.slice(start, end), { loader: 'tsx' }).code;
  const evaluate = new Function('useMemo', 'displayUnits', 'topChromeInset', 'historyMcpAsUser', 'historyMeasuredUnitKey',
    code + ';return displayUnitLayoutKeys;');
  for (const inset of [0, 32]) for (const asUser of [false, true]) {
    const unit = { key: 'same-physical-row' };
    const keys = evaluate(f => f(), [unit], inset, asUser, value => value.key);
    assert.deepEqual(keys, [(inset ? `chrome:${inset}|` : '') + (asUser ? 'mcp-as-user|' : '') + 'mcp-display:v1|same-physical-row']);
    assert.equal(unit.key, 'same-physical-row');
  }
});
