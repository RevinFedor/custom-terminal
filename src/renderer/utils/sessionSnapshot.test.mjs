import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSessionSnapshot, SESSION_SNAPSHOT_FIELDS } from './sessionSnapshot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const storeSource = readFileSync(join(here, '..', 'store', 'useWorkspaceStore.ts'), 'utf8');

const workspace = (projectId, tabIds, activeTabId) => ({
  projectId,
  projectPath: '/p/' + projectId,
  tabs: new Map(tabIds.map((id) => [id, { id }])),
  activeTabId,
});

const state = (over = {}) => ({
  openProjects: new Map([
    ['p1', workspace('p1', ['a', 'b', 'c'], 'b')],
    ['p2', workspace('p2', ['d'], 'd')],
  ]),
  activeProjectId: 'p1',
  focusedProjectId: 'p2',
  view: 'workspace',
  projectHistory: ['p2', 'p1'],
  globalTabMru: [{ projectId: 'p1', tabId: 'b' }],
  splitPanes: [
    { projectId: 'p1', tabId: 'a' },
    { projectId: 'p1', tabId: 'b' },
  ],
  splitFocusedIndex: 1,
  ...over,
});

test('snapshot keeps the split layout and which pane is focused', () => {
  const snap = buildSessionSnapshot(state());
  assert.equal(snap.splitPanes.length, 2);
  assert.equal(snap.splitPanes[1].tabId, 'b');
  assert.equal(snap.splitFocusedIndex, 1);
});

test('snapshot records each project with its active tab position', () => {
  const snap = buildSessionSnapshot(state());
  assert.deepEqual(snap.openProjects, [
    { projectId: 'p1', projectPath: '/p/p1', activeTabIndex: 1 },
    { projectId: 'p2', projectPath: '/p/p2', activeTabIndex: 0 },
  ]);
});

test('a project with no active tab falls back to the first one, never to -1', () => {
  const s = state();
  s.openProjects.get('p1').activeTabId = 'gone';
  assert.equal(buildSessionSnapshot(s).openProjects[0].activeTabIndex, 0);
});

test('missing optional parts degrade to empty, not to undefined', () => {
  const snap = buildSessionSnapshot({
    openProjects: new Map(),
    view: 'dashboard',
  });
  assert.deepEqual(snap.splitPanes, []);
  assert.equal(snap.splitFocusedIndex, 0);
  assert.deepEqual(snap.projectHistory, []);
  assert.deepEqual(snap.globalTabMru, []);
  assert.equal(snap.activeProjectId, null);
  assert.equal(snap.focusedProjectId, null);
});

test('the snapshot carries every field the session is supposed to have', () => {
  assert.deepEqual(Object.keys(buildSessionSnapshot(state())).sort(), [...SESSION_SNAPSHOT_FIELDS].sort());
});

// The actual bug: closing the app wrote a SHORTER record than normal saving,
// and since it wrote last it erased everything the shorter one did not mention
// — the split layout among it. Two panes before a reinstall, one pane after.
//
// Asserting on the store source rather than on a value, because the defect was
// never in what either function computed — it was in there being two of them.
test('both writers build the session through the one shared snapshot', () => {
  const callers = storeSource.match(/buildSessionSnapshot\(/g) || [];
  assert.ok(callers.length >= 2, 'expected saveSession and saveSessionImmediate to share the snapshot builder');

  // The trailing brace matters: `saveSessionImmediate: (...) => void;` is the type
  // declaration, and slicing from there reads a completely unrelated function.
  const immediate = storeSource.slice(storeSource.indexOf('saveSessionImmediate: (options) => {'));
  const body = immediate.slice(0, immediate.indexOf('\n  },'));
  assert.match(body, /if \(state\.isRestoring\)/,
    'shutdown must preserve the previous durable workspace during partial restore');
  assert.match(body, /Session immediate save skipped: restore-in-progress/);
  assert.match(body, /buildSessionSnapshot\(state\)/);
  // A hand-rolled object literal here is what caused the loss.
  assert.ok(
    !/openProjects:\s*Array\.from/.test(body),
    'the shutdown save must not assemble its own session shape',
  );
});
