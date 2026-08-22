import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveKeyboardFocusTarget } from './keyboardFocusOwner.mjs';

const base = {
  activeProjectId: 'p-active',
  sidebarProjectId: 'p-sidebar',
  sidebarTabId: 'sidebar-tab',
  effectiveProjectId: 'p-effective',
  effectiveTabId: 'effective-tab',
  splitPanes: [
    { projectId: 'p-left', tabId: 'left-tab' },
    { projectId: 'p-right', tabId: 'right-tab' },
  ],
  splitFocusedIndex: 1,
};

test('sidebar owns both create/close scope even while another pane is focused', () => {
  assert.deepEqual(resolveKeyboardFocusTarget({ ...base, activeArea: 'sidebar' }), {
    kind: 'sidebar', projectId: 'p-sidebar', tabId: 'sidebar-tab', paneIndex: -1,
  });
});

test('workspace owns the exact focused cross-project pane', () => {
  assert.deepEqual(resolveKeyboardFocusTarget({ ...base, activeArea: 'workspace' }), {
    kind: 'pane', projectId: 'p-right', tabId: 'right-tab', paneIndex: 1,
  });
});

test('an empty focused pane stays the target and never falls through to sidebar', () => {
  const target = resolveKeyboardFocusTarget({
    ...base,
    activeArea: 'workspace',
    splitPanes: [base.splitPanes[0], { projectId: '', tabId: '' }],
  });
  assert.deepEqual(target, {
    kind: 'pane', projectId: 'p-sidebar', tabId: null, paneIndex: 1,
  });
});

test('single mode uses the effective visible tab rather than the sidebar row', () => {
  assert.deepEqual(resolveKeyboardFocusTarget({
    ...base,
    activeArea: 'workspace',
    splitPanes: [],
  }), {
    kind: 'pane', projectId: 'p-effective', tabId: 'effective-tab', paneIndex: -1,
  });
});

test('top project rail remains a different shortcut scope', () => {
  assert.equal(resolveKeyboardFocusTarget({ ...base, activeArea: 'projects' }).kind, 'project-rail');
});
