import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { filterTimelineGoalPresentation } from './codexGoalPresentation.mjs';
import { mergeTimelineEntriesWithSentHandoffs } from './timelineTranscriptRefresh.mjs';
import { projectTimelineNoteAnchors } from './timelineNoteIdentity.mjs';
import { projectTimelineWorkingFileMarkers } from './timelineWorkingFileMarkers.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('Timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
const walk = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'entries'
    && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(tree) === 'useMemo'
    && node.initializer.arguments[0].getText(tree).includes('mergeTimelineEntriesWithSentHandoffs'))
    callback = node.initializer.arguments[0].getText(tree);
  ts.forEachChild(node, walk);
}; walk(tree);
assert.ok(callback, 'the actual final rail boundary, not a test-only filter');
const code = transformSync('globalThis.project = ' + callback, { loader: 'tsx', format: 'cjs' }).code;

test('actual Timeline final boundary filters durable/live/handoff Goal after all projections without renumbering', () => {
  const real = { uuid: 'codex-user-s-3', type: 'user', content: 'real prompt', turnIndex: 17 };
  const status = { uuid: 'codex-user-s-1', type: 'user', content: '<codex_internal_context source="user_goal">\nUser set goal status: "paused".\n</codex_internal_context>', turnIndex: 15 };
  const goal = { uuid: 'codex-user-s-2', type: 'user', content: 'Goal continued', isGoalContinuation: true, turnIndex: 16 };
  for (const placement of ['durable', 'live', 'handoff']) {
    const scope = { filterTimelineGoalPresentation, mergeTimelineEntriesWithSentHandoffs,
      projectTimelineNoteAnchors, projectTimelineWorkingFileMarkers,
      durableEntries: [real], liveUserEntries: [], sentHandoffEntries: [],
      noteAnchorSnapshot: { ownerKey: 'owner', entries: [] }, timelineOwnerKey: 'owner',
      workingFiles: [], cwd: '/repo', timelinePathApi: path, toolType: 'codex' };
    scope[placement === 'durable' ? 'durableEntries' : placement === 'live' ? 'liveUserEntries' : 'sentHandoffEntries']
      .push(status, goal);
    const before = structuredClone([scope.durableEntries, scope.liveUserEntries, scope.sentHandoffEntries]);
    vm.runInNewContext(code, scope);
    const visible = scope.project();
    assert.equal(visible.length, 1); assert.equal(visible[0], real); assert.equal(visible[0].turnIndex, 17);
    assert.deepEqual([scope.durableEntries, scope.liveUserEntries, scope.sentHandoffEntries], before);
  }
});

test('History uses the shared Goal class before ordinary user rendering and keeps the raw entry', () => {
  const history = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  assert.ok(history.includes('const goalPresentation = codexGoalPresentation(entry, toolType);'));
  assert.ok(history.includes('<HistoryGoalRow entry={entry} presentation={goalPresentation} />'));
  const goalIndex = history.indexOf('const goalPresentation = codexGoalPresentation(entry, toolType);');
  assert.ok(goalIndex < history.indexOf("if (entry.role === 'user')", goalIndex));
  assert.ok(!history.includes("entry.role = 'goal'"));
});

test('dormant Goal preview uses violet, never the orange ordinary-user chip', () => {
  const css = fs.readFileSync(new URL('../components/Workspace/TimelineEntryPreview.css', import.meta.url), 'utf8');
  assert.match(css, /\.timeline-preview-kind--goal, \.timeline-preview-kind--goal-status \{ color: #a78bfa; background: #a78bfa18; \}/);
});
