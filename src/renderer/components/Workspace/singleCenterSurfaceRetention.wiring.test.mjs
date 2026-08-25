import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'Workspace.tsx'), 'utf8');

test('pane visits hide single-center owners without unmounting their heavy surfaces', () => {
  assert.match(source, /const PersistentSingleAttachRow = React\.memo\(SplitPaneAttachRow\)/);
  assert.match(source, /const singleCenterOwnerRef = useRef/);
  assert.match(source, /if \(!splitActiveLayout/);
  assert.match(source, /singleCenterOwnerRef\.current = \{ tabId: effectiveTab\.id, projectId: activeProjectId \}/);
  assert.match(source, /data-single-center-history-retained/);
  assert.match(source, /data-single-center-focus-boundary/);
  assert.match(source, /data-pane-focus-isolated=\{singleCenterAgentPresented \? '0' : '1'\}/);
  assert.match(source, /data-single-center-control-bar-retained/);
  assert.match(source, /data-single-center-task-plan-retained/);
  assert.match(source, /position: 'absolute',[\s\S]{0,220}opacity: 0/);
  assert.doesNotMatch(source, /!splitActiveLayout && effectiveTab && currentView === 'terminal' && \(\s*<ClaudeControlBar/);
});

test('single-center History and Timeline ownership survive split presentation', () => {
  assert.match(source, /const singleHistoryIsPrimary = singleCenterAgentSurfacePairAvailable[\s\S]{0,80}!singleCenterTerminalIsPrimary/);
  assert.match(source, /const singleHistoryIsAgentSidePanel = singleCenterAgentSurfacePairAvailable[\s\S]{0,80}singleCenterTerminalIsPrimary/);
  const historyGate = source.slice(
    source.indexOf('const shouldRenderHistoryPanel ='),
    source.indexOf('// Two-frame tab switch.', source.indexOf('const shouldRenderHistoryPanel =')),
  );
  assert.doesNotMatch(historyGate, /!splitActiveLayout/);
  assert.match(source, /actualPresented=\{singleCenterAgentPresented[\s\S]{0,160}historyOwnerIsCurrent/);
  assert.match(source, /const showTimeline = !!singleCenterTab[\s\S]{0,100}!!timelineToolType/);
  assert.match(source, /tabId: singleCenterTab\.id/);
  assert.match(source, /data-single-center-timeline-retained[\s\S]{0,220}data-pane-focus-isolated/);
  assert.match(source, /PersistentSingleCenterHistory/);
  assert.match(source, /presentationExternallyManaged/);
});
