import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { historyEntryMessageReference } from './historyEntryMessageReference.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const panel = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryPanel.tsx', 'utf8');
const bundle = buildSync({
  stdin: { contents: 'export { HistoryCollapsedGroupRow, HistoryTranscriptPresentation } from "./src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx";', resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' },
  loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'text' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { HistoryCollapsedGroupRow, HistoryTranscriptPresentation } = loaded.exports;
const old = { uuid: 'caption-old', sourceIdentity: 'old-source', sessionId: 'session', role: 'assistant', content: 'Первый текст', timestamp: '2026-10-29T02:00:00Z' };
const latest = { ...old, uuid: 'caption-latest', sourceIdentity: 'latest-source', content: 'Последний текст' };
const group = { key: 'grp:first-call', familyKey: 'work', entries: [{ uuid: 'first-call' }, old, latest],
  facts: [{ family: 'read', toolName: 'Read' }], errorCount: 0, captionEntries: [old, latest] };
function find(node, className) {
  if (!React.isValidElement(node)) return null;
  if (node.props.className === className) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const result = find(child, className); if (result) return result;
  }
  return null;
}
function capture(props = {}) {
  let node;
  function Capture() {
    node = HistoryCollapsedGroupRow.type({ group, expanded: false, onToggle() {}, ...props });
    return node;
  }
  renderToStaticMarkup(React.createElement(Capture));
  return node;
}
const event = (x, y, extra = {}) => ({ clientX: x, clientY: y, defaultPrevented: false,
  target: { closest: () => null }, currentTarget: { contains: () => false },
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

test('actual caption handler owns left/right whitespace and the last-line remainder, not the header or vertical neighbours', () => {
  const calls = []; let reads = 0;
  const node = capture({ onCaptionContextMenu: (e, entry) => calls.push([e.clientX, e.clientY, entry.uuid]) });
  find(node, 'hp-history-group-detail').props.ref.current = { getBoundingClientRect() { reads++; return { top: 100, bottom: 180 }; } };
  assert.equal(reads, 0, 'no layout read while rendering or scrolling');
  for (const [x, y] of [[2, 120], [798, 120], [700, 170], [2, 100]]) node.props.onContextMenu(event(x, y));
  assert.deepEqual(calls.map(call => call[2]), Array(4).fill('caption-latest'));
  for (const y of [80, 99, 180, 200]) node.props.onContextMenu(event(700, y));
  assert.equal(calls.length, 4);
  assert.equal(reads, 8, 'one current caption rectangle per eligible context-menu event');
  node.props.onContextMenu(event(700, 120, { defaultPrevented: true }));
  assert.equal(reads, 8, 'an already handled child action is not hijacked');
});

test('caption selection, pending body and changed geometry retain the exact source message', () => {
  const calls = []; let rect = { top: 100, bottom: 180 };
  const node = capture({ captionIdentity: 'old-source', onCaptionContextMenu: (e, entry) => calls.push(entry) });
  find(node, 'hp-history-group-detail').props.ref.current = { getBoundingClientRect: () => rect };
  node.props.onContextMenu(event(2, 150));
  rect = { top: 300, bottom: 380 };
  node.props.onContextMenu(event(2, 150)); node.props.onContextMenu(event(798, 350));
  assert.deepEqual(calls, [old, old]);
  const stub = { ...latest, content: '', rowStub: true, hasContent: true };
  const pending = capture({ group: { ...group, captionEntries: [stub] }, onCaptionContextMenu: (e, entry) => calls.push(entry) });
  find(pending, 'hp-history-group-detail').props.ref.current = { getBoundingClientRect: () => rect };
  pending.props.onContextMenu(event(798, 350)); assert.equal(calls.at(-1), stub);
});

test('expanded, unmounted, missing and unidentified captions never borrow the first tool ID', () => {
  let calls = 0; const callback = () => calls++;
  for (const props of [{ expanded: true }, { group: { ...group, captionEntries: [] } },
    { group: { ...group, captionEntries: [{ content: 'no ID' }] } }]) {
    assert.equal(capture({ ...props, onCaptionContextMenu: callback }).props.onContextMenu, undefined);
  }
  capture({ onCaptionContextMenu: callback }).props.onContextMenu(event(2, 150));
  assert.equal(calls, 0, 'a detached caption ref cannot resolve a message');
});

test('nested transcript forwards the selected caption to its existing exact-step menu', () => {
  const step = { id: 'child-message', messageId: 'raw-child-message', sessionId: 'child-session',
    kind: 'message', role: 'assistant', phase: 'commentary', text: 'Комментарий субагента' };
  const steps = [step, { id: 'child-call', kind: 'tool', tool: 'Read', args: { file_path: '/finite/example' }, text: '' }];
  const calls = []; let node;
  function Capture() {
    node = HistoryTranscriptPresentation.type({ steps, onMessageContextMenu: (e, value) => calls.push(value) });
    return node;
  }
  renderToStaticMarkup(React.createElement(Capture));
  const findHeader = value => {
    if (!React.isValidElement(value)) return null;
    if (value.type === HistoryCollapsedGroupRow) return value;
    return React.Children.toArray(value.props.children).map(findHeader).find(Boolean);
  };
  const header = findHeader(node); assert.ok(header);
  header.props.onCaptionContextMenu(event(2, 150), header.props.group.captionEntries[0]);
  assert.deepEqual(calls, [step]);
});

// Execute the actual Panel callback and existing menu serializer. DOM hit-test,
// selection, iteration lookup and IPC are controlled leaves; no native menu or
// clipboard is opened. The source identity and details formatter are real.
const sourceBetween = (a, b) => {
  const start = panel.indexOf(a), end = panel.indexOf(b, start);
  assert.ok(start >= 0 && end > start); return panel.slice(start, end);
};
const detailsCode = transformSync(sourceBetween('const historyEntryDetailsText = (', 'const pointTouchesHistoryText = ('), { loader: 'ts' }).code;
const menuCode = transformSync(sourceBetween('const openHistoryEntryContextMenu = async (', 'const HistoryCollapsiblePrompt = ('), { loader: 'ts' }).code;
const callbackExpression = panel.match(/onCaptionContextMenu=\{([\s\S]*?)\}\n\s+expanded=/)?.[1];
assert.ok(callbackExpression, 'actual primary/legacy Panel caption binding');
const callbackCode = transformSync('const callback = ' + callbackExpression, { loader: 'ts' }).code;
function menuFixture({ selection = null, touchesText = false } = {}) {
  const sent = [], iterations = [];
  const open = new Function('window', 'pointTouchesHistoryText', 'ipcRenderer', 'historyEntryCopyDiagnostic',
    'historyEntryMessageReference', 'useWorkspaceStore', 'crypto', detailsCode + menuCode + ';return openHistoryEntryContextMenu;')(
    { getSelection: () => selection }, () => touchesText, { send: (...args) => sent.push(args) }, () => null,
    historyEntryMessageReference, { getState: () => ({ openProjects: new Map() }) }, { randomUUID: () => 'owned-reference' });
  const callback = new Function('openHistoryEntryContextMenu', 'copiedHistoryMessageIteration', 'entries', 'toolType',
    'tabId', 'sessionId', 'cwd', 'isEligibleTabTitleEntry', callbackCode + ';return callback;')(
    open, (rows, entry, owner) => { iterations.push({ entry, owner }); return Promise.resolve(4); }, [], 'codex', 'owner-tab', 'read-session', '/finite', () => true);
  return { sent, iterations, callback };
}

test('caption whitespace reaches the original menu with its own ID/session/reference, not the group carrier', async () => {
  const fixture = menuFixture();
  const node = capture({ captionIdentity: 'old-source', onCaptionContextMenu: fixture.callback });
  find(node, 'hp-history-group-detail').props.ref.current = { getBoundingClientRect: () => ({ top: 100, bottom: 180 }) };
  const e = event(798, 170); await node.props.onContextMenu(e);
  assert.equal(e.defaultPrevented, true); assert.equal(e.stopped, true);
  assert.equal(fixture.sent.length, 1);
  const [channel, payload] = fixture.sent[0];
  assert.equal(channel, 'show-history-entry-context-menu');
  assert.match(payload.copyText, /Agent: Codex\nRole: assistant/);
  assert.match(payload.copyText, /Message ID: caption-old\nSession ID: session/);
  assert.doesNotMatch(payload.copyText, /first-call|caption-latest/);
  assert.equal(payload.messageReference.source.messageId, old.uuid);
  assert.equal(payload.messageReference.source.viewOwnerSessionId, 'read-session');
  assert.equal(payload.messageReference.source.iteration, 4);
  assert.equal(fixture.iterations[0].entry, old);
});

test('existing text-selection, glyph and interactive-control context menus are not replaced', async () => {
  for (const [options, extra] of [
    [{ selection: { isCollapsed: false, anchorNode: {} } }, { currentTarget: { contains: () => true } }],
    [{ touchesText: true }, {}],
    [{}, { target: { closest: () => ({ tagName: 'BUTTON' }) } }],
  ]) {
    const fixture = menuFixture(options), e = event(700, 150, extra);
    await fixture.callback(e, latest);
    assert.equal(fixture.sent.length, 0); assert.equal(e.defaultPrevented, false);
  }
});
