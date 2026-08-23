import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const area = fs.readFileSync(path.join(here, 'TerminalArea.tsx'), 'utf8');
const chrome = fs.readFileSync(path.join(here, 'SplitPaneChrome.tsx'), 'utf8');

test('split header is keyed by pane and lives outside per-tab wrappers', () => {
  const tabWrapper = area.slice(
    area.indexOf('key={`pane:${tab.id}`}'),
    area.indexOf('// One chrome tree per WINDOW'),
  );
  assert.doesNotMatch(tabWrapper, /<SplitPaneAttachRow/);
  assert.doesNotMatch(tabWrapper, /<SplitPaneFocusFrame/);
  assert.match(area, /key={`pane:chrome:\${paneIndex}`}/);
  assert.match(area, /data-terminal-pane-chrome-host=\{paneIndex\}/);
  assert.match(area, /<SplitPaneAttachRow[\s\S]{0,220}tabId=\{pane\.tabId\}/);
});

test('each stable pane publishes its measured header height through a pane-scoped CSS variable', () => {
  assert.match(area, /data-terminal-area-root/);
  assert.match(chrome, /splitPaneHeaderHeightVar\(paneIndex\)/);
  assert.match(chrome, /closest\('\[data-terminal-area-root\]'\)/);
  assert.match(area, /var\(\${TAB_SURFACE_HEADER_HEIGHT_VAR}, var\(\${splitPaneHeaderHeightVar\(layoutPaneIndex\)}/);
});

test('unfocused Git+split leaves no black spacer while the ellipsis stays mounted', () => {
  assert.match(chrome, /display: focusActionsVisible \? 'flex' : 'none'/);
  assert.match(chrome, /data-split-strip-menu-button/);
  assert.match(chrome, /autoReveal=\{stripAutoReveal\}/);
  assert.doesNotMatch(chrome, /opacity: focusActionsVisible \? 1 : 0/);
});
