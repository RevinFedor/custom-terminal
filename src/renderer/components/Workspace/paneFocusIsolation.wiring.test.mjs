import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(workspaceDir, '..', '..');
const area = readFileSync(join(workspaceDir, 'TerminalArea.tsx'), 'utf8');
const isolation = readFileSync(join(rendererDir, 'utils/paneFocusIsolation.ts'), 'utf8');

test('persistent pane replaces outer inert with one app-owned focus boundary', () => {
  assert.match(area, /createPaneFocusIsolationManager/);
  assert.match(area, /data-pane-focus-isolated=\{inPane \? \(shownInPane \? '0' : '1'\) : undefined\}/);
  assert.match(area, /aria-hidden=\{inPane && !shownInPane \? true : undefined\}/);
  assert.doesNotMatch(area, /inert=\{inPane && !shownInPane\}/);
  assert.match(area, /requestFocusedWorkspacePrimaryInput\('hidden-pane-focus-guard'\)/);
});

test('hidden pane quarantines only focusable nodes and restores exact tabindex', () => {
  assert.match(isolation, /export const PANE_FOCUSABLE_SELECTOR/);
  assert.match(isolation, /originals: Map<HTMLElement, string \| null>/);
  assert.match(isolation, /element\.setAttribute\('tabindex', '-1'\)/);
  assert.match(isolation, /if \(original === null\) element\.removeAttribute\('tabindex'\)/);
  assert.match(isolation, /else element\.setAttribute\('tabindex', original\)/);
  assert.match(isolation, /new MutationObserver/);
  assert.match(isolation, /attributeFilter: FOCUSABILITY_ATTRIBUTES/);
});

test('programmatic hidden focus is rejected and inner inert owners remain untouched', () => {
  assert.match(isolation, /root\.addEventListener\('focusin', onFocusIn, true\)/);
  assert.match(isolation, /event\.target\.blur\(\)/);
  assert.match(isolation, /options\.onHiddenFocus\?\.\(tabId\)/);
  assert.doesNotMatch(area, /removeAttribute\('inert'\)|querySelectorAll\([^)]*inert/);
});
