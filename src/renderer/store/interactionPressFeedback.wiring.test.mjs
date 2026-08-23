import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, '..', 'components', 'Workspace');
const spaces = fs.readFileSync(path.join(workspace, 'SpaceStrip.tsx'), 'utf8');
const chip = fs.readFileSync(path.join(workspace, 'PaneTabChip.tsx'), 'utf8');

test('workflow acknowledges pointerdown before committing its heavy switch', () => {
  assert.match(spaces, /data-space-pending=\{pending \? '1' : '0'\}/);
  assert.match(spaces, /onPointerDown=\{\(e\) => \{[\s\S]{0,500}setPending\(true\)/);
  assert.match(spaces, /onPointerUp=\{\(\) => setPointerHeld\(false\)\}/);
  assert.match(spaces, /transform: pointerHeld \? 'scale\(0\.985\)' : undefined/);
  assert.match(spaces, /performance\.now\(\) - pendingStartedAtRef\.current >= 20/);
  assert.match(spaces, /else requestAnimationFrame\(\(\) => requestAnimationFrame\(commitSwitch\)\)/);
  assert.doesNotMatch(spaces, /if \(renaming \|\| active \|\| pending\) return/);
});

test('pane chip keeps pressed feedback until the selected tab really owns the pane', () => {
  assert.match(chip, /data-chip-pressed=\{pressed \? '1' : '0'\}/);
  assert.match(chip, /onPointerDown=\{\(e\) => \{[\s\S]{0,260}setPressed\(true\)/);
  assert.match(chip, /\{ bgColor: chrome\.bgColor, hasColor, active: \(shown && paneFocused\) \|\| pressed, hovered \}/);
  assert.match(chip, /useEffect\(\(\) => \{[\s\S]{0,240}if \(!shown\) return;[\s\S]{0,120}setPressed\(false\)/);
  assert.match(chip, /onPointerUp=\{\(\) => setPointerHeld\(false\)\}/);
  assert.match(chip, /transform: pointerHeld && !dragging \? 'scale\(0\.985\)' : undefined/);
  assert.match(chip, /transition: pointerHeld\s*\? 'none'/);
});
