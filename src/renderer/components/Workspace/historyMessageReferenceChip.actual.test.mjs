import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeTerminalMessageSnapshot, terminalMessageLabel } from '../../../shared/terminal-message-reference.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const history = fs.readFileSync(new URL('./HistoryPanel.tsx', import.meta.url), 'utf8');
const from = history.indexOf('const HistoryComposerToken = (');
const to = history.indexOf('type HistoryInstructionAttachment =', from);
assert.ok(from > 0 && to > from, 'extract the production History token, not a duplicate component');
const bundle = buildSync({
  stdin: { contents: `
    import React, { useRef, useEffect } from 'react';
    import { ComposerChip } from './packages/claude-blocks/src/components/ComposerFrame.tsx';
    import { attachTerminalMessageChip } from './vendor/markdown-editor/src/terminalMessageReferenceChip.ts';
    const jumpToTerminalMessageReference = () => { throw Error('SSR must not navigate'); };
    const HistoryImageTokenThumbnail = () => null;
    ${history.slice(from, to)}
    export { HistoryComposerToken };
  `, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'], logLevel: 'silent',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const { HistoryComposerToken } = module.exports;
const details = 'Agent: Codex\nRole: user\nMessage ID: exact-user\nFull original body';
const snapshot = makeTerminalMessageSnapshot(details, {
  tabId: 'source-tab', sessionId: 'source-session', provider: 'codex', messageId: 'exact-user',
  tabName: 'flow-tab \\ портфолио', iteration: null,
  timeLabel: '16.10.2026, 13:33:34', messageTimestamp: '2026-10-16T06:33:34Z',
}, 'copied-message');
const token = reference => React.createElement(HistoryComposerToken, {
  kind: 'paste', label: terminalMessageLabel(reference), messageReference: reference,
  buttonRef() {}, onClick() { throw Error('SSR must not open the viewer'); },
});

test('the canonical visible label omits the generic word and seconds without rewriting its snapshot', () => {
  const before = JSON.stringify(snapshot);
  assert.equal(terminalMessageLabel(snapshot), 'flow-tab \\ портфолио · 16.10.2026, 13:33');
  assert.equal(terminalMessageLabel({ ...snapshot.source, iteration: 42 }),
    'flow-tab \\ портфолио · Итерация 42 · 16.10.2026, 13:33');
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(snapshot.source.timeLabel, '16.10.2026, 13:33:34');
  assert.equal(snapshot.source.messageTimestamp, '2026-10-16T06:33:34Z');
  assert.equal(snapshot.detailsText, details);
});

test('minute labels preserve the saved local clock and do not invent a date or iteration', () => {
  assert.equal(terminalMessageLabel({ tabName: 'Source', timeLabel: '16.10.2026, 13:33' }),
    'Source · 16.10.2026, 13:33');
  assert.equal(terminalMessageLabel({ tabName: 'Source', timeLabel: '16.10.2026, 13:33:34 UTC+7' }),
    'Source · 16.10.2026, 13:33 UTC+7');
  assert.equal(terminalMessageLabel({ tabName: 'Source', messageTimestamp: snapshot.source.messageTimestamp }), 'Source');
});

test('the actual sent token uses the existing bounded chip slot at the beginning, middle and end of text', () => {
  const reference = { ...snapshot, source: { ...snapshot.source,
    tabName: 'очень-длинное-имя-日本語-'.repeat(18) } };
  for (const [before, after] of [['', ' after'], ['before ', ' after'], ['before ', '']]) {
    const html = renderToStaticMarkup(React.createElement('div', { 'data-test-flow': true }, before, token(reference), after));
    assert.match(html, /<span[^>]*class="hp-history-user-prompt-chip-slot"[^>]*data-history-composer-token="paste"/);
    assert.match(html, /class="[^"]*hp-history-attachment-chip/);
    assert.match(html, /cb-composer-chip-hit/);
    assert.match(html, /cb-composer-chip-content/);
    assert.match(html, /cb-composer-chip-label/);
    assert.doesNotMatch(html, /Сообщение|13:33:34|Full original body/);
    if (before) assert.ok(html.indexOf(before) < html.indexOf('data-history-composer-token'));
    if (after) assert.ok(html.lastIndexOf(after) > html.indexOf('cb-composer-chip-label'));
  }
});

test('the local cap constrains slot, border box, hit/content and the ellipsized label, not the History scroller', () => {
  const css = history.slice(history.indexOf('.hp-history-user-prompt-chip-slot {'),
    history.indexOf('.hp-agent-prompt::-webkit-scrollbar-thumb:hover'));
  assert.doesNotThrow(() => transformSync(css, { loader: 'css' }));
  assert.match(css, /\.hp-history-user-prompt-chip-slot \{[^}]*max-width: min\(240px, 100%\);/);
  assert.match(css, /\.hp-history-user-prompt-chip-slot \.cb-composer-chip \{[^}]*box-sizing: border-box;/);
  assert.match(css, /\.cb-composer-chip-content \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;/);
  assert.match(css, /\.cb-composer-chip-label \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
});

test('changed wrapping rejects old user-row geometry without changing physical row IDs or assistant measurements', () => {
  const start = history.indexOf('const historyMeasuredUnitKey = (');
  const end = history.indexOf('interface FileAction', start);
  assert.ok(start > 0 && end > start);
  const compiled = transformSync(history.slice(start, end), { loader: 'ts' }).code;
  const measuredKey = new Function('isGroupUnit', 'historyVirtuosoUnitKey', compiled + '; return historyMeasuredUnitKey;')(
    () => false, unit => unit.entry.uuid,
  );
  for (const role of ['user', 'queued']) {
    const unit = { entry: { uuid: 'same-physical-row', role, content: 'x', promptChips: [{}] } };
    assert.equal(measuredKey(unit), 'entry:inline-chips:v3|same-physical-row|1||full|1|0||');
    assert.equal(unit.entry.uuid, 'same-physical-row');
  }
  assert.equal(measuredKey({ entry: { uuid: 'assistant', role: 'assistant', content: 'x' } }),
    'entry|assistant|1||full|0|0||');
});
