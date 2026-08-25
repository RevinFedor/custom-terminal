import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const area = readFileSync(join(workspaceDir, 'TerminalArea.tsx'), 'utf8');

test('plan=move absence keeps the same tab-owned SplitPaneSurface parent', () => {
  assert.match(area, /const retainedTabPanePlacements = new Map<string, any>\(\)/);
  assert.match(area, /const livePanePlacement = resolveTabPanePlacement\(/);
  assert.match(area, /const panePlacement = resolveTabSurfacePanePlacement\([\s\S]{0,180}centerPresented/);
  assert.doesNotMatch(area, /resolveTabSurfacePanePlacement\([\s\S]{0,180}splitActive/);
  assert.match(area, /const inPane = panePlacement !== null/);
  assert.match(area, /key=\{`pane:\$\{tab\.id\}`\}/);
  assert.match(area, /\{inPane && tab\.tabType !== 'file' \? \([\s\S]{0,180}<SplitPaneSurface/);
});

test('single-center suppresses only its active tab and never disables dormant pane identity globally', () => {
  assert.match(area, /const centerPresented = !splitActive && isActiveTerminalLayer\(projId, tab\.id\)/);
  assert.match(area, /resolveTabPanePlacement\([\s\S]{0,160}activeSpaceLayout,[\s\S]{0,80}hiddenSpaceLayouts/);
  assert.match(area, /resolveTabSurfacePanePlacement\([\s\S]{0,180}centerPresented/);
  assert.match(area, /zIndex: shownInPane[\s\S]{0,100}: \(inPane \? 0 : 1\)/);
  assert.match(area, /const terminalPresentationForTab = inPane \? true : terminalPresented/);
  assert.match(area, /presented=\{terminalPresentationForTab\}/);
});

test('retained geometry is pruned only when the durable tab closes', () => {
  assert.match(area, /const liveTabIds = new Set<string>\(\)/);
  assert.match(area, /workspace\.tabs\.forEach\(\(tab\) => liveTabIds\.add\(tab\.id\)\)/);
  assert.match(area, /pruneRetainedTabPanePlacements\(retainedTabPanePlacements, liveTabIds\)/);
});
