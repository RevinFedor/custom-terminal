import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build, transformSync } from 'esbuild';
import ts from 'typescript';
import * as codec from '../../shared/terminal-message-reference.mjs';
import { createTabMessageSourceNavigation } from './tabMessageSourceNavigation.mjs';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../../', import.meta.url));
const calls = [], warnings = [];
let jump = async (...args) => { calls.push(args); return false; };
const bundle = await build({
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    export { Markdown } from './packages/claude-blocks/src/components/Markdown.tsx';
    export { renderHistoryIterationLink } from './src/renderer/components/Workspace/HistoryIterationLink.tsx';
  ` }, bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'test-jump', 'test-ui'],
  plugins: [{ name: 'controlled-host-ports', setup(build) {
    build.onResolve({ filter: /\/tabMessageSourceJump$/ }, () => ({ path: 'test-jump', external: true }));
    build.onResolve({ filter: /\/useUIStore$/ }, () => ({ path: 'test-ui', external: true }));
  } }], loader: { '.css': 'empty' }, logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(name => {
  if (name === 'test-jump') return { jumpToTerminalMessageTarget: (...args) => jump(...args) };
  if (name === 'test-ui') return { useUIStore: { getState: () => ({ showToast: (...args) => warnings.push(args) }) } };
  return require(name);
}, module, module.exports);
const { Markdown, renderHistoryIterationLink } = module.exports;
const target = { tabId: 'own-tab', provider: 'codex', sessionId: 'physical', messageId: 'public-user',
  viewOwnerSessionId: 'read-view', physicalSessionId: 'physical', rawUuid: 'raw-user', transcriptSegmentId: 'seg:2', sourceIdentity: 'exact-source' };
const href = codec.terminalMessageLink(target);
const text = '[Итерация42 · Запрос о деплое](' + href + ')';
const render = props => renderToStaticMarkup(React.createElement(Markdown, props));

test('actual assistant Markdown renders a blue-link hook, preserving the exact hidden address and ordinary links', () => {
  const html = render({ text: text + '\n\n[Web](https://example.test) [File](file:///finite/result.md)', renderLink: renderHistoryIterationLink });
  assert.match(html, /data-history-iteration-link="public-user"/);
  assert.match(html, /Итерация42 · Запрос о деплое/); assert.doesNotMatch(html, />public-user</);
  assert.match(html, /href="https:\/\/example.test"/); assert.match(html, /href="file:\/\/\/finite\/result.md"/);
  const css = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryIterationLink.css', 'utf8');
  assert.match(css, /color: #78b7ff/); assert.match(css, /text-decoration: underline/);
  assert.equal(calls.length, 0, 'rendering never navigates or reads History');
});
test('preview, fenced/inline code and hosts without an assistant adapter do not become new navigators', () => {
  for (const props of [{ text, preview: true, renderLink: renderHistoryIterationLink },
    { text: '```text\n' + text + '\n```', renderLink: renderHistoryIterationLink },
    { text: '`' + text + '`', renderLink: renderHistoryIterationLink }, { text }]) {
    assert.doesNotMatch(render(props), /data-history-iteration-link|class="history-iteration-link"/);
  }
  const malformed = render({ text: '[Bad](#noted-message?iteration=42)', renderLink: renderHistoryIterationLink });
  assert.match(malformed, /Неполный или некорректный адрес/); assert.doesNotMatch(malformed, /<a/);
  // Same treatment for a TRUNCATED address, which used to render clickable and
  // then fail at the end of the jump (02.11). See terminalMessageLinkTruncation.
  const truncated = render({ text: '[Итерация 2](#noted-message?tabId=T&provider=claude&sessionId=S&messageId=dd6da706)',
    renderLink: renderHistoryIterationLink });
  assert.doesNotMatch(truncated, /<a/); assert.match(truncated, /Неполный или некорректный адрес/);
  assert.equal(calls.length, 0);
});
test('click uses the existing target port once, suppresses fragment navigation, and handles cancellation/failure honestly', async () => {
  calls.length = 0; warnings.length = 0;
  const anchor = renderHistoryIterationLink({ href, children: 'До деплоя' });
  const events = [], event = { preventDefault: () => events.push('prevent'), stopPropagation: () => events.push('stop') };
  anchor.props.onClick(event); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['prevent', 'stop']); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], codec.normalizeTerminalMessageTarget(target)); assert.equal(warnings.length, 0, 'cancelled jump is not an error');
  jump = async () => { throw Object.assign(Error('source-session-changed'), { code: 'source-session-changed' }); };
  anchor.props.onClick(event); await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.length, 1); assert.equal(warnings[0][1], 'warning');
});
test('actual host target wrapper and shared navigator preserve read-view and physical identity until the exact scroll receipt', async () => {
  const events = [], dom = new EventTarget(), listeners = new Set(); let generation = 0;
  const ui = { setTabTerminalIsPrimary: (...args) => events.push(['terminal-primary', ...args]),
    setHistoryPanelOpen: (...args) => events.push(['history-open', ...args]),
    setSideTerminalOpen: (...args) => events.push(['side-terminal', ...args]),
    setHistoryScrollToUuid(uuid, tabId, request) {
      events.push(['scroll', uuid, tabId, request]); generation++;
      queueMicrotask(() => dom.dispatchEvent(new CustomEvent('history-panel:scrolled-to', { detail: { requestId: request.requestId, found: true } })));
    }, get historyScrollRequestGeneration() { return generation; }, cancelHistoryScrollRequest: () => assert.fail('settled jump cannot cancel'),
  };
  const workspace = { openTabById: async tabId => { events.push(['open-tab', tabId]); return true; } };
  const source = fs.readFileSync(root + 'src/renderer/utils/tabMessageSourceJump.ts', 'utf8'), loaded = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module: loaded, exports: loaded.exports, crypto, setTimeout, clearTimeout, console,
    window: { require: () => ({ ipcRenderer: { invoke: () => assert.fail('direct target jump must not call a locator/read API') } }),
      addEventListener: dom.addEventListener.bind(dom), removeEventListener: dom.removeEventListener.bind(dom) },
    require: name => {
      if (name.endsWith('/useWorkspaceStore')) return { useWorkspaceStore: { getState: () => workspace, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } } };
      if (name.endsWith('/useUIStore')) return { useUIStore: { getState: () => ui } };
      if (name.endsWith('/tabNavigationLocation.mjs')) return { tabNavigationLocation: () => 'same-placement' };
      if (name.endsWith('/tabMessageSourceNavigation.mjs')) return { createTabMessageSourceNavigation };
      if (name.endsWith('/terminal-message-reference.mjs')) return codec;
      assert.fail('Unexpected import ' + name);
    },
  });
  const previous = jump;
  try {
    jump = loaded.exports.jumpToTerminalMessageTarget;
    renderHistoryIterationLink({ href, children: 'Итерация' }).props.onClick({ preventDefault() {}, stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    const scroll = events.find(row => row[0] === 'scroll');
    assert.equal(scroll[1], target.messageId); assert.equal(scroll[2], target.tabId);
    assert.equal(scroll[3].readSessionId, 'read-view');
    assert.deepEqual(JSON.parse(JSON.stringify(scroll[3].messageReference)), codec.normalizeTerminalMessageTarget(target));
    assert.equal(events.filter(row => row[0] === 'open-tab').length, 1); assert.equal(listeners.size, 0);
  } finally { jump = previous; }
});
test('only durable/live assistant Markdown call sites opt in; Timeline and user prompt content are not replaced', () => {
  const source = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryPanel.tsx', 'utf8');
  const ast = ts.createSourceFile('panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), enabled = [];
  const walk = node => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === 'CBMarkdown') {
      const attrs = node.attributes.properties;
      if (attrs.some(attr => attr.name?.getText(ast) === 'renderLink')) enabled.push(node.getText(ast));
    }
    ts.forEachChild(node, walk);
  }; walk(ast);
  assert.equal(enabled.length, 2); assert.ok(enabled.some(item => item.includes('entry.content')));
  assert.ok(enabled.some(item => item.includes('segment.text')));
});
