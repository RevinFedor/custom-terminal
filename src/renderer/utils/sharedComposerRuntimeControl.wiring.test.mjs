import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageComponent = readFileSync(
  new URL('../../../packages/claude-blocks/src/components/ComposerFrame.tsx', import.meta.url),
  'utf8',
);
const packageCss = readFileSync(
  new URL('../../../packages/claude-blocks/src/blocks.css', import.meta.url),
  'utf8',
);
const packageIndex = readFileSync(
  new URL('../../../packages/claude-blocks/src/index.ts', import.meta.url),
  'utf8',
);
const history = readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);

test('shared composer package owns stable controls and state-versus-action hover', () => {
  assert.match(packageComponent, /export const ComposerControlButton/);
  assert.match(packageComponent, /export const ComposerRuntimeControl/);
  assert.match(packageComponent, /data-agent-status-hover-glyph/);
  assert.match(packageComponent, /data-agent-status-idle-glyph/);
  assert.match(packageCss, /data-agent-status-action='stop'/);
  assert.match(packageCss, /data-agent-status-action='start'/);
  assert.match(packageIndex, /ComposerRuntimeControl/);
});

test('Custom Terminal History consumes the shared runtime control without moving lifecycle ownership', () => {
  assert.match(history, /<ComposerRuntimeControl/);
  assert.match(history, /action=\{statusPrimaryAction\}/);
  assert.match(history, /onClick=\{activateUnifiedStatus\}/);
  assert.match(history, /onContextMenu=\{\(event\) => \{/);
  assert.match(history, /<HistoryTerminalActivityIcon/);
});
