import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const area = readFileSync(join(workspaceDir, 'TerminalArea.tsx'), 'utf8');

test('plan=move absence keeps the same tab-owned SplitPaneSurface parent', () => {
  assert.match(area, /const retainedTabPanePlacements = new Map<string, any>\(\)/);
  assert.match(area, /const livePanePlacement = splitActive[\s\S]{0,180}resolveTabPanePlacement/);
  assert.match(area, /const panePlacement = resolveRetainedTabPanePlacement\([\s\S]{0,180}livePanePlacement,[\s\S]{0,80}splitActive/);
  assert.match(area, /const inPane = panePlacement !== null/);
  assert.match(area, /key=\{`pane:\$\{tab\.id\}`\}/);
  assert.match(area, /\{inPane && tab\.tabType !== 'file' \? \([\s\S]{0,180}<SplitPaneSurface/);
});

test('retained geometry is pruned only when the durable tab closes', () => {
  assert.match(area, /const liveTabIds = new Set<string>\(\)/);
  assert.match(area, /workspace\.tabs\.forEach\(\(tab\) => liveTabIds\.add\(tab\.id\)\)/);
  assert.match(area, /pruneRetainedTabPanePlacements\(retainedTabPanePlacements, liveTabIds\)/);
});
