import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFocusedTerminalSelection } from './focusedTerminalContext.mjs';

const tab = (id, extra = {}) => ({ tabId: id, name: id, ...extra });
const workspace = ({ activeTabId = 'a', currentView = 'terminal', viewingSubAgentTabId = null, tabs } = {}) => ({
  activeTabId,
  currentView,
  viewingSubAgentTabId,
  tabs: new Map(tabs || [['a', tab('a')]]),
});

test('single-pane context follows the active project tab', () => {
  const state = {
    view: 'workspace',
    activeProjectId: 'p1',
    splitPanes: [],
    splitFocusedIndex: 0,
    openProjects: new Map([['p1', workspace()]]),
  };
  assert.deepEqual(resolveFocusedTerminalSelection(state), {
    selection: { projectId: 'p1', tabId: 'a' },
    reason: null,
  });
});

test('split context follows the focused pane, including another project', () => {
  const state = {
    view: 'workspace',
    activeProjectId: 'p1',
    splitPanes: [
      { projectId: 'p1', tabId: 'a' },
      { projectId: 'p2', tabId: 'b' },
    ],
    splitFocusedIndex: 1,
    openProjects: new Map([
      ['p1', workspace()],
      ['p2', workspace({ activeTabId: 'b', tabs: [['b', tab('b')]] })],
    ]),
  };
  assert.deepEqual(resolveFocusedTerminalSelection(state).selection, { projectId: 'p2', tabId: 'b' });
});

test('visible child session replaces its parent as the captured surface', () => {
  const state = {
    view: 'workspace',
    activeProjectId: 'p1',
    splitPanes: [],
    splitFocusedIndex: 0,
    openProjects: new Map([['p1', workspace({
      viewingSubAgentTabId: 'child',
      tabs: [
        ['a', tab('a')],
        ['child', tab('child', { parentTabId: 'a' })],
      ],
    })]]),
  };
  assert.deepEqual(resolveFocusedTerminalSelection(state).selection, { projectId: 'p1', tabId: 'child' });
});

test('non-terminal surfaces and empty split panes do not guess a tab', () => {
  const base = {
    view: 'workspace',
    activeProjectId: 'p1',
    splitPanes: [],
    splitFocusedIndex: 0,
    openProjects: new Map([['p1', workspace({ currentView: 'home' })]]),
  };
  assert.equal(resolveFocusedTerminalSelection(base).reason, 'terminal-view-not-visible');
  assert.equal(resolveFocusedTerminalSelection({
    ...base,
    splitPanes: [{ projectId: null, tabId: null }],
  }).reason, 'focused-pane-empty');
  assert.equal(resolveFocusedTerminalSelection({ ...base, view: 'dashboard' }).reason, 'workspace-not-visible');
});
