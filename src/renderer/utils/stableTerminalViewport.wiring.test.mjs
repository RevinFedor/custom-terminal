import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => fs.readFileSync(path.join(dirname, relativePath), 'utf8');
const frame = read('../components/Workspace/FloatingTerminalFrame.tsx');
const workspace = read('../components/Workspace/Workspace.tsx');
const split = read('../components/Workspace/SplitPaneSurface.tsx');

test('inline terminal translates without changing its top/bottom layout extent', () => {
  assert.match(frame, /resolveStableTerminalViewportOffsets\(\{ floating, bottomInset \}\)/);
  assert.match(frame, /bottom:\s*stageOffsets\.bottom/);
  assert.match(frame, /transform:\s*stageOffsets\.translateY/);
});

test('single workspace composer overlays the fixed viewport and reports its height', () => {
  assert.match(
    workspace,
    /historyPlacementForRender\.isPrimary \|\| historyPlacementForRender\.sidePanel[\s\S]{0,120}handleHistoryControlsHeight/,
  );
  assert.match(
    workspace,
    /data-workspace-docked-composer-host[\s\S]{0,220}position:\s*'absolute'[\s\S]{0,220}bottom:\s*0/,
  );
  assert.doesNotMatch(
    workspace,
    /data-workspace-docked-composer-host[\s\S]{0,120}className="shrink-0"/,
  );
});

test('split pane uses the same stable viewport contract', () => {
  assert.match(split, /bottomInset=\{historyControlsHeight\}/);
  assert.match(
    split,
    /agentSidePanel[\s\S]{0,420}onControlsHeightChange=\{handleControlsHeight\}/,
  );
  assert.match(
    split,
    /data-split-pane-composer-host[\s\S]{0,220}position:\s*'absolute'[\s\S]{0,220}bottom:\s*0/,
  );
});
