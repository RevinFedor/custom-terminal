import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../..');
const panel = fs.readFileSync(
  path.join(repoRoot, 'renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const sharedControl = fs.readFileSync(
  path.join(repoRoot, '../packages/claude-blocks/src/components/ComposerFrame.tsx'),
  'utf8',
);
const sharedCss = fs.readFileSync(
  path.join(repoRoot, '../packages/claude-blocks/src/blocks.css'),
  'utf8',
);

/** The shared component owns the button markup; History only injects lifecycle
 * state, callbacks and its proven activity icon. */
const buttonMarkup = () => {
  const marker = sharedControl.indexOf('data-agent-status-row');
  assert.ok(marker > 0, 'shared runtime button must exist');
  const start = sharedControl.lastIndexOf('<button', marker);
  const end = sharedControl.indexOf('</button>', marker);
  assert.ok(start >= 0 && end > marker);
  return sharedControl.slice(start, end);
};

test('hover is browser-owned instead of remembered React state', () => {
  assert.doesNotMatch(sharedControl, /statusHover/);
  const button = buttonMarkup();
  assert.doesNotMatch(button, /onMouseEnter/);
  assert.doesNotMatch(button, /onMouseLeave/);
  assert.match(panel, /<ComposerRuntimeControl/);
});

test('background and both glyphs switch through one CSS hover contract', () => {
  assert.match(sharedCss, /data-agent-status-action='stop'[^\{]*:hover[^\{]*\{[\s\S]{0,100}background: rgba\(220, 38, 38, 0\.20\)/);
  assert.match(sharedCss, /data-agent-status-action='start'[^\{]*:hover[^\{]*\{[\s\S]{0,100}background: rgba\(255, 255, 255, 0\.08\)/);
  assert.match(sharedCss, /> \[data-agent-status-hover-glyph\] \{ display: none; \}/);
  assert.match(sharedCss, /:hover:not\(:disabled\) > \[data-agent-status-hover-glyph\] \{ display: inline-flex; \}/);
});

test('pending action keeps the state glyph instead of leaving an empty button', () => {
  assert.match(
    sharedCss,
    /data-agent-status-action='stop'[^\{]*:hover[^\{]*> \[data-agent-status-idle-glyph\],[\s\S]{0,180}data-agent-status-action='start'[^\{]*:hover[^\{]*> \[data-agent-status-idle-glyph\][^\{]*\{\s*display: none;/,
  );
  assert.match(sharedControl, /action === 'pending' \|\| action === 'none'/);
});

test('inline styles cannot override the shared hover background or glyph display', () => {
  const button = buttonMarkup();
  assert.doesNotMatch(button, /background(?:Color)?:/);
  const idleStart = button.indexOf('data-agent-status-idle-glyph');
  assert.ok(idleStart > 0);
  const idleTag = button.slice(idleStart, button.indexOf('>', idleStart));
  assert.doesNotMatch(idleTag, /display/);
});

test('action and idle glyphs are mounted together and CSS chooses exactly one', () => {
  assert.match(sharedControl, /data-agent-status-hover-glyph/);
  assert.match(sharedControl, /data-agent-status-idle-glyph/);
  assert.match(sharedCss, /> \[data-agent-status-idle-glyph\] \{ display: inline-flex; \}/);
});
