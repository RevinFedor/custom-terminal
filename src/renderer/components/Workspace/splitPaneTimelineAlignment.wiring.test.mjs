import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const chrome = readFileSync(join(workspaceDir, 'SplitPaneChrome.tsx'), 'utf8');

test('strip menu button inherits the collapsed Timeline rail width', () => {
  assert.match(
    chrome,
    /import \{ TIMELINE_COLLAPSED_SLOT_WIDTH \} from '\.\.\/\.\.\/utils\/surfaceInsets\.mjs'/,
  );
  const buttonStart = chrome.indexOf('data-split-strip-menu-button');
  const buttonEnd = chrome.indexOf('</button>', buttonStart);
  const button = chrome.slice(buttonStart, buttonEnd);
  assert.match(button, /width: TIMELINE_COLLAPSED_SLOT_WIDTH/);
  assert.doesNotMatch(button, /width: chipH/);
});
