import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Production components/parser, in-memory bundling and SSR only. No Electron,
// browser, native input, effects, History RPC, clipboard or geometry assertion.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const panel = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryPanel.tsx', 'utf8');
const start = panel.indexOf('const HistoryCollapsiblePrompt = (');
const end = panel.indexOf('const HistoryChipPopover = (', start);
assert.ok(start > 0 && end > start);
const mixedStart = panel.indexOf('const HistoryUserPromptContent = (');
const mixedEnd = panel.indexOf('const HistoryResearchModelsContext =', mixedStart);
assert.ok(mixedStart > 0 && mixedEnd > mixedStart);
const collapseConstants = ['HISTORY_USER_TEXT_COLLAPSE_THRESHOLD', 'HISTORY_USER_TEXT_COLLAPSED_CHARS']
  .map(name => panel.match(new RegExp(`const ${name} = \\d+;`))?.[0]);
assert.ok(collapseConstants.every(Boolean));
const bundle = await build({
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
    import { Markdown as CBMarkdown } from './packages/claude-blocks/src/components/Markdown.tsx';
    import { ComposerChip } from './packages/claude-blocks/src/components/ComposerFrame.tsx';
    import { buildHistoryComposerPresentationParts, promptChipDisplayLabel } from './src/renderer/utils/composerChips.mjs';
    import { mixedMessageNeedsCollapse, truncateMixedMessageParts } from './src/renderer/utils/historyMixedMessageCollapse.mjs';
    import { historyImageRuns } from './src/renderer/utils/historyImageRuns.mjs';
    ${collapseConstants.join('\n')}
    const useHistoryRevealToggle = () => () => { throw Error('SSR must not toggle'); };
    const renderSentHistoryPromptHighlight = text => text;
    // Unrelated image loaders and context-chip attrs are controlled here. The
    // actual parts/collapse/Markdown renderer and chip component stay real.
    const useComposerImagePreviews = () => new Map();
    const useComposerImagePreview = () => ({ error: null });
    const historyContextFileChipProps = () => ({});
    const HistoryInlineTextPart = ({ text }) => text;
    ${panel.slice(start, end)}
    ${panel.slice(mixedStart, mixedEnd)}
    export { HistoryCollapsiblePrompt, HistoryUserPromptContent, CBMarkdown as Markdown };
    export { HistoryCollapsedGroupRow } from './src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx';
    export { TimelineEntryPreview } from './src/renderer/components/Workspace/TimelineEntryPreview.tsx';
    export { ResearchResultContent } from './src/renderer/components/Workspace/ResearchResultContent.tsx';
  ` }, bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + 'packages/claude-blocks/src/index.ts' },
  // The unrelated source-navigation badge imports the app stores/IPC at module
  // load. It is not part of Markdown rendering and must not boot the host.
  plugins: [{ name: 'no-host-source-badge', setup(build) {
    build.onResolve({ filter: /^\.\/TabMessageSourceChip$/ }, () => ({ path: 'source-badge', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const HistoryPromptSource = () => null;' }));
  } }],
  loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'text' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { Markdown, HistoryCollapsedGroupRow, TimelineEntryPreview, HistoryCollapsiblePrompt, HistoryUserPromptContent, ResearchResultContent } = loaded.exports;
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
// Exact 443-character past commentary read through Terminal MCP, turn45/block0
// of SID912d3cc0… on 16 Oct. Not a fabricated final or a provider request.
const incident = 'Добавлю отдельный переключатель. Повторное обновление не должно снова присылать ту же ошибку; включение настройки тоже не должно рассылать старые проблемы.\n\nДля формы сохраню различие:\n```text\nНе удалось прочитать → ошибка у чата, отправка не начиналась\nПрочитана, но отправка заблокирована → ответы остаются сохранены\nОтправка могла произойти → неизвестный результат, без повтора\n```\nВход в Google или Яндекс автоматически выполнять не буду.\n';
const formatted = '# Решение\n\n**Готово** и *выделение*, `input`.\n\n- первый\n- второй\n\n> цитата\n\n| A | B |\n| - | - |\n| x | y |\n\n```text\n## literal code\n**literal stars**\n```';
const captionGroup = (content, extra = {}) => ({ key: 'caption-md', familyKey: 'run',
  entries: [], errorCount: 0, facts: [{ toolName: 'Bash', family: 'run' }],
  captionEntries: [{ uuid: 'exact-caption', role: 'assistant', content }], ...extra });

test('the actual closed caption renders the reported fence as code, not visible Markdown syntax', () => {
  assert.equal(incident.length, 443);
  const group = captionGroup(incident), before = JSON.stringify(group);
  const html = render(HistoryCollapsedGroupRow, { group, expanded: false, onToggle() {} });
  assert.match(html, /data-history-caption-uuid="exact-caption"/);
  assert.match(html, /<pre[^>]*><code[^>]*>Не удалось прочитать/);
  assert.doesNotMatch(html, /```|cb-code-copy|cb-code-scroll/);
  assert.match(html, /<p>Вход в Google или Яндекс/);
  assert.equal(JSON.stringify(group), before, 'the selected raw message is unchanged');
});

test('caption Markdown keeps significant leading code indentation and the original timing owner', () => {
  const group = captionGroup('    **literal indented code**\n');
  group.captionEntries[0].recordTime = { version: 1, timestamp: '2026-10-16T07:45:16.874Z', scope: 'record', kind: 'message' };
  const html = render(HistoryCollapsedGroupRow, { group, expanded: false, onToggle() {} });
  assert.match(html, /<pre[^>]*><code>\*\*literal indented code\*\*<\/code><\/pre>/);
  assert.doesNotMatch(html, /<strong>/);
  assert.match(html, /data-history-time-key="exact-caption:caption"/);
  assert.match(html, /data-history-time-at="2026-10-16T07:45:16.874Z"/);
});

test('outer and nested captions share headings, emphasis, lists, quotes, tables and literal code', () => {
  for (const level of [1, 2]) {
    const html = render(HistoryCollapsedGroupRow, { group: captionGroup(formatted, { level }), expanded: false, onToggle() {} });
    for (const expression of [/<h1>Решение<\/h1>/, /<strong>Готово<\/strong>/,
      /<em>выделение<\/em>/, /<code[^>]*>input<\/code>/, /<ul>/, /<blockquote>/, /<table>/,
      /## literal code\n\*\*literal stars\*\*/]) assert.match(html, expression);
    assert.doesNotMatch(html, /hp-history-caption-number|<h2>literal code/);
  }
});

test('an exact selected caption changes formatted body, number and time together, not by matching text', () => {
  const time = timestamp => ({ version: 1, timestamp, scope: 'record', kind: 'message' });
  const group = captionGroup('', { captionEntries: [
    { uuid: 'older', role: 'assistant', content: '**Older**', recordTime: time('2026-10-16T07:44:00Z') },
    { uuid: 'newer', role: 'assistant', content: '**Newer**', recordTime: time('2026-10-16T07:45:00Z') },
  ] });
  const html = render(HistoryCollapsedGroupRow, { group, expanded: false, captionIdentity: 'older', onToggle() {} });
  assert.match(html, /<strong>Older<\/strong>/);
  assert.match(html, /Text 1 of 2/);
  assert.match(html, /data-history-time-key="older:caption"/);
  assert.match(html, /data-history-time-at="2026-10-16T07:44:00Z"/);
  assert.doesNotMatch(html, /Newer|07:45:00Z/);
});

test('preview mode remains passive and cheap: no media fetch, link target, copy button or syntax highlighter', () => {
  const html = render(Markdown, { text: '[link](https://example.test) ![diagram](https://example.test/private.png)\n\n```js\nconst n = 1;\n```', preview: true });
  assert.match(html, /cb-prose-preview/);
  assert.match(html, /diagram/);
  assert.match(html, /const n = 1;/);
  assert.doesNotMatch(html, /<a\b|<img\b|<button\b|cb-code-head|cb-code-scroll|token/);
});

test('default expanded Markdown retains its existing code header, Copy and links', () => {
  const html = render(Markdown, { text: '[link](https://example.test)\n\n```js\nconst n = 1;\n```' });
  assert.match(html, /href="https:\/\/example.test"/);
  assert.match(html, /cb-code-head/);
  assert.match(html, /cb-code-copy/);
  assert.doesNotMatch(html, /cb-prose-preview/);
});

test('pending captions, literal tool digests and expanded groups do not become Markdown bodies', () => {
  const pending = render(HistoryCollapsedGroupRow, { group: captionGroup('', { captionEntries: [
    { uuid: 'pending', role: 'assistant', rowStub: true, content: '' },
  ] }), expanded: false, onToggle() {} });
  assert.match(pending, /Loading text…/);
  assert.doesNotMatch(pending, /cb-prose/);
  assert.doesNotMatch(render(HistoryCollapsedGroupRow, {
    group: captionGroup(incident), expanded: true, onToggle() {},
  }), /hp-history-caption-text|cb-prose/);
});

const timelineProps = (entry, extra = {}) => ({ entry, toolType: 'codex', expanded: false,
  responseLines: 3, fontSize: 13, onExpand() {}, onNavigatePrompt() {}, onNavigateAnswer() {},
  onSourceNavigate() {}, onCopy() { throw Error('SSR must not copy'); },
  loadResponse() { throw Error('SSR must not read History'); },
  loadImages() { throw Error('SSR must not read images'); }, ...extra });
test('the actual collapsed Timeline answer uses Markdown while retaining its exact navigation identity and line cap', () => {
  const entry = { type: 'user', uuid: 'exact-user', content: '**literal user**',
    responsePreview: { version: 1, uuid: 'exact-final', content: formatted, contentLength: formatted.length, truncated: false } };
  const before = JSON.stringify(entry);
  const html = render(TimelineEntryPreview, timelineProps(entry));
  assert.match(html, /data-timeline-preview-final="exact-final"/);
  assert.match(html, /-webkit-line-clamp:3/);
  assert.match(html, /<strong>Готово<\/strong>/);
  assert.match(html, /\*\*literal user\*\*/);
  assert.doesNotMatch(html, /<strong>literal user/);
  assert.equal(JSON.stringify(entry), before);
});

test('collapsed compact summaries use inline Markdown instead of raw hashes and stars', () => {
  const html = render(TimelineEntryPreview, timelineProps({ type: 'compact', uuid: 'compact', content: '' },
    { compact: { text: '# Summary\n\n**kept** `input`', loading: false, encrypted: false } }));
  assert.match(html, /<h1>Summary<\/h1>/);
  assert.match(html, /<strong>kept<\/strong>/);
  assert.doesNotMatch(html, /# Summary|\*\*kept\*\*/);
});

test('the actual Timeline Research excerpt formats prose but does not reinterpret Markdown inside JSON fields', () => {
  const previousWindow = globalThis.window;
  // The only invoked host dependency is the projection's SHA256 function.
  // This is a controlled Node shim, not a renderer or an Electron connection.
  globalThis.window = { require };
  try {
    for (const [body, formatted] of [['# Решение\n\n**Готово**', true], ['{"summary":"**literal JSON**"}', false]]) {
      const envelope = '[exact saved completion]\n', content = envelope + body;
      const entry = { type: 'user', role: 'user', uuid: 'research', content, semanticTags: [{ kind: 'orchestration',
        runId: 'run', runKind: 'external-research', phase: 'completion', envelopeStart: 0, envelopeText: envelope,
        bodyStart: envelope.length, bodyEnd: content.length,
        bodyProjectionHash: require('node:crypto').createHash('sha256').update(content).digest('hex') }] };
      const html = render(TimelineEntryPreview, timelineProps(entry));
      if (formatted) assert.match(html, /<strong>Готово<\/strong>/);
      else { assert.match(html, /\*\*literal JSON\*\*/); assert.doesNotMatch(html, /<strong>literal JSON/); }
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('an explicit Markdown service body stays formatted when long and collapsed; ordinary user input stays literal', () => {
  const text = '**Service**\n\n```text\n' + 'literal line\n'.repeat(70) + '```';
  const html = render(HistoryCollapsiblePrompt, { text, markdown: true });
  assert.match(html, /<strong>Service<\/strong>/);
  assert.match(html, /<pre[^>]*><code/);
  assert.doesNotMatch(html, /```text|cb-code-copy/);
  const literal = render(HistoryCollapsiblePrompt, { text, markdown: false });
  assert.match(literal, /\*\*Service\*\*/);
  assert.doesNotMatch(literal, /cb-prose/);
  assert.match(html, /Раскрыть полностью/);
});

test('the actual mixed service body keeps its leading chip and Markdown even when the whole message is collapsed', () => {
  const text = '**Service**\n\n```text\n' + 'literal line\n'.repeat(70) + '```';
  const parts = [{ kind: 'prompt', chip: { id: 'fixture-chip', label: 'context.md', text: 'private attachment body' } },
    { kind: 'text', text }];
  const before = JSON.stringify(parts);
  const html = render(HistoryUserPromptContent, { text, tabId: 'owner', markdown: true, presentationParts: parts });
  assert.match(html, /cb-composer-chip/);
  assert.match(html, /<strong>Service<\/strong>/);
  assert.match(html, /<pre[^>]*><code/);
  assert.match(html, /cb-collapse-bottom/);
  assert.doesNotMatch(html, /private attachment body|```text/);
  assert.equal(JSON.stringify(parts), before);
});

test('Research prose already uses the shared parser; literal JSON summaries remain literal', () => {
  const props = { open: false, onToggle() {}, onCopy() {}, copied: false };
  const prose = render(ResearchResultContent, { ...props, result: { displayText: formatted, previewText: formatted, summary: null, code: null } });
  assert.match(prose, /<strong>Готово<\/strong>/);
  const json = render(ResearchResultContent, { ...props, result: { displayText: '{}', previewText: 'JSON · 2 lines', summary: 'JSON · 2 lines', code: '{}' } });
  assert.match(json, /JSON · 2 lines/);
  assert.doesNotMatch(json, /cb-prose/);
});

test('new caption geometry rejects the old closed-group measurement without changing physical group keys', () => {
  const a = panel.indexOf('const historyMeasuredUnitKey = (');
  const b = panel.indexOf('interface FileAction', a);
  const compiled = transformSync(panel.slice(a, b), { loader: 'ts' }).code;
  const key = new Function('isGroupUnit', 'historyVirtuosoUnitKey', compiled + ';return historyMeasuredUnitKey;')(
    () => true, unit => unit.key,
  );
  const unit = { key: 'same-group', familyKey: 'run', entries: [], expanded: false };
  assert.match(key(unit), /closed:caption-markdown:v2/);
  assert.match(key(unit), /same-group/);
  assert.equal(key({ ...unit, expanded: true }), 'group|same-group|open|0||');
  assert.equal(key({ ...unit, familyKey: 'research' }), 'group|same-group|closed|0||');
});

test('compact Markdown CSS inherits caption typography, wraps code and preserves the host-owned caps', () => {
  const css = fs.readFileSync(root + 'packages/claude-blocks/src/blocks.css', 'utf8');
  const timeline = fs.readFileSync(root + 'src/renderer/components/Workspace/TimelineEntryPreview.css', 'utf8');
  for (const value of [css, timeline]) assert.doesNotThrow(() => transformSync(value, { loader: 'css' }));
  assert.match(css, /\.cb-prose\.cb-prose-preview\s*\{[^}]*font: inherit;/);
  assert.match(css, /\.cb-prose-preview p, \.cb-prose-preview li \{ white-space: pre-wrap; \}/);
  const pre = css.match(/\.cb-prose-preview pre\.cb-prose-preview-code\s*\{([^}]+)\}/)?.[1];
  assert.ok(pre);
  assert.match(pre, /max-width: 100%/);
  assert.match(pre, /white-space: pre-wrap/);
  assert.match(pre, /overflow-wrap: anywhere/);
  assert.doesNotMatch(pre, /max-height:|overflow-[xy]:|overflow: auto/);
  assert.match(timeline, /\.timeline-preview-markdown-line[^}]*white-space: nowrap/s);
});
