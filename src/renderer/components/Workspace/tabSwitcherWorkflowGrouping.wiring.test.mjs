import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const overlay = readFileSync(join(here, 'TabSwitcherOverlay.tsx'), 'utf8');
const rows = readFileSync(join(here, 'TabListRows.tsx'), 'utf8');
const spaces = readFileSync(join(here, '../../utils/workspaceSpacesModel.mjs'), 'utf8');
const selector = readFileSync(join(here, '../../utils/tabSwitcherSelector.mjs'), 'utf8');

test('one placement index covers split, center strips and the single center', () => {
  assert.match(spaces, /spaceTabIds\(list\[index\], tabIdsOfPanes\)/);
  assert.match(spaces, /preferredSpaceId/);
  assert.match(overlay, /spacesWithLiveLayout\(ws\.spaces, ws\.activeSpaceId, ws\)/);
  assert.match(selector, /tabSpaceIndexMap\(spaces, allPaneTabIds, ws\.activeSpaceId\)/);
  assert.match(overlay, /return sharedSwitcherWorkflowLookup\(ws, useProjectsStore\.getState\(\)\.projects\)/);
  assert.match(overlay, /selectSwitcherRows\(input, \{ query, hideOnScreen \}\)/);
});

test('Ctrl+Tab and Cmd+P group by colored workflow, project stays secondary', () => {
  assert.match(overlay, /<TabListWorkflowHeader/);
  assert.doesNotMatch(overlay, /<TabListProjectHeader/);
  assert.match(overlay, /projectName=\{row\.projectName\}/);
  assert.match(overlay, /projectIcon=\{row\.projectIcon\}/);
  assert.match(rows, /data-workflow-icon=\{workflowId\}/);
  assert.match(rows, /data-project-icon="true"/);
});

test('unplaced tabs remain rows and iteration scope filters exact workflow tabs', () => {
  assert.match(overlay, /UNPLACED_WORKFLOW_ID/);
  assert.match(overlay, /UNPLACED_WORKFLOW_NAME/);
  assert.match(overlay, /tabFilter: selectedTabIds/);
  assert.match(overlay, /data-switcher-iteration-workflow=\{chip\.id\}/);
  assert.doesNotMatch(overlay, /data-switcher-iteration-project/);
});
