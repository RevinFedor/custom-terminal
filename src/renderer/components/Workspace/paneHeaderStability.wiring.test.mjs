import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const area = fs.readFileSync(path.join(here, 'TerminalArea.tsx'), 'utf8');
const chrome = fs.readFileSync(path.join(here, 'SplitPaneChrome.tsx'), 'utf8');

test('split header is keyed by workflow pane and lives outside per-tab wrappers', () => {
  const tabWrapper = area.slice(
    area.indexOf('key={`pane:${tab.id}`}'),
    area.indexOf('// One chrome tree per WORKFLOW WINDOW'),
  );
  assert.doesNotMatch(tabWrapper, /<SplitPaneAttachRow/);
  assert.doesNotMatch(tabWrapper, /<SplitPaneFocusFrame/);
  assert.match(area, /const ownerKey = `\${layout\.id}:\${paneIndex}`/);
  assert.match(area, /key={`pane:chrome:\${ownerKey}`}/);
  assert.match(area, /data-terminal-pane-chrome-host=\{ownerKey\}/);
  assert.match(area, /<SplitPaneAttachRow[\s\S]{0,220}tabId=\{pane\.tabId\}/);
});

test('each stable pane publishes its measured header height through a pane-scoped CSS variable', () => {
  assert.match(area, /data-terminal-area-root/);
  assert.match(chrome, /splitPaneHeaderHeightVar\(paneIndex\)/);
  assert.match(chrome, /closest\('\[data-terminal-pane-chrome-host\]'\)/);
  assert.match(area, /var\(\${TAB_SURFACE_HEADER_HEIGHT_VAR}, var\(\${splitPaneHeaderHeightVar\(layoutPaneIndex\)}/);
});

test('unfocused Git+split hides paint, preserves wrap width, and keeps ellipsis mounted', () => {
  assert.match(chrome, /const focusActionsInFlow = stripWrap \|\| focusActionsVisible/);
  assert.match(chrome, /position: focusActionsInFlow \? 'relative' : 'absolute'/);
  assert.match(chrome, /visibility: focusActionsVisible \? 'visible' : 'hidden'/);
  assert.match(chrome, /data-wrap-reserved=\{stripWrap \? '1' : undefined\}/);
  assert.match(chrome, /endInsetPx=\{hiddenFocusReservePx\}/);
  assert.match(chrome, /data-split-strip-menu-button/);
  assert.match(chrome, /autoReveal=\{stripAutoReveal\}/);
});
