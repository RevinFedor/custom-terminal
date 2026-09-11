import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const previewPath = new URL(
  '../components/Workspace/AIConversation/PastedContentPreview.tsx',
  import.meta.url,
);
const surfacePath = new URL(
  '../components/Workspace/AIConversation/AIComposerSurface.tsx',
  import.meta.url,
);
const globalStylesPath = new URL('../styles/globals.css', import.meta.url);

const output = buildSync({
  entryPoints: [previewPath.pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
}).outputFiles[0].text;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', output)(require, compiled, compiled.exports);
const { AttachmentPreviewNavigation, AttachmentPreviewToolbar } = compiled.exports;

const findButtons = (node, result = []) => {
  if (!node || typeof node !== 'object') return result;
  if (node.type === 'button') result.push(node);
  React.Children.forEach(node.props?.children, (child) => findButtons(child, result));
  return result;
};

test('the real preview header keeps both arrows stable and disables only the missing neighbour', () => {
  let nextCalls = 0;
  const tree = AttachmentPreviewNavigation({ onNext: () => { nextCalls += 1; } });
  const [previous, next] = findButtons(tree);

  assert.equal(previous.props['aria-label'], 'Предыдущий промпт');
  assert.equal(previous.props.disabled, true);
  assert.equal(next.props['aria-label'], 'Следующий промпт');
  assert.equal(next.props.disabled, false);

  let prevented = 0;
  let stopped = 0;
  next.props.onClick({
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  });
  assert.equal(nextCalls, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);

  const previewSource = fs.readFileSync(previewPath, 'utf8');
  assert.match(previewSource, /bodyRef\.current\.scrollTop = 0/,
    'changing the viewed prompt must start the new body at the top');
  const globalStyles = fs.readFileSync(globalStylesPath, 'utf8');
  assert.match(globalStyles, /\.attachment-preview-nav-button:hover:not\(:disabled\)/,
    'each arrow needs its own visible hover affordance');
});

test('AIComposerSurface wires the resolved neighbour IDs into the text preview', () => {
  const source = fs.readFileSync(surfacePath, 'utf8');
  assert.match(source, /resolveComposerPromptPreviewNavigation\(\s*\[\.\.\.chips, \.\.\.externalExpandableChips\],\s*expandedChipId,/);
  assert.match(source, /onExpandedChipChange\(resolvedPromptPreviewNavigation\.previousId\)/);
  assert.match(source, /onExpandedChipChange\(resolvedPromptPreviewNavigation\.nextId\)/);
  assert.match(source, /navigation=\{attachmentPreviewNavigation\}/);
  assert.match(source, /onMoveToInput=\{expandedChip\.kind === 'prompt' \? expandedChip\.onRestore : undefined\}/);
  assert.match(source, /onClose=\{expandedChip\.kind === 'prompt'/);
  assert.match(source, /trailing=\{chip\.kind !== 'prompt'/,
    'prompt chips must not keep duplicate restore/delete buttons');
  assert.match(source, /onAuxClick=\{\(event\) => \{/,
    'SDK prompt chips keep middle-click deletion after removing the cross');
});

test('the shared prompt navbar contains move, copy and close actions', () => {
  const html = renderToStaticMarkup(React.createElement(AttachmentPreviewToolbar, {
    text: 'prompt body',
    navigation: { onNext() {} },
    onMoveToInput() {},
    onClose() {},
  }));
  assert.match(html, /data-attachment-preview-navigation/);
  assert.match(html, /data-attachment-preview-move-to-input/);
  assert.match(html, /data-attachment-preview-copy/);
  assert.match(html, /data-attachment-preview-close/);
  assert.match(html, />В input</);
  assert.match(html, />Копировать</);
});
