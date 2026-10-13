import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { isRequestSuccessPresentation } from './requestTrackerVisibility.mjs';
import { isOrchestrationResultProofPending } from './orchestrationRunProjection.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/OrchestrationStatusChip.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('chip.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['ACTIVE', 'NOTIFICATION_ERRORS', 'STATUS_LABEL', 'statusColor',
  'hasSourceNotificationError', 'hasPendingSourceHandoff', 'isPaused',
  'attentionDismissedForTab', 'runPresentation', 'runVisibleInTracker']);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  ? names.has(node.name?.text) : ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => names.has(d.name.getText(ast))));
assert.equal(declarations.length, names.size);
const ctx = vm.createContext({ isRequestSuccessPresentation, isOrchestrationResultProofPending });
vm.runInContext(ts.transpileModule(declarations.map(node => node.getText(ast)).join('\n')
  + '\nglobalThis.visible = runVisibleInTracker;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, ctx);

const completed = { status: 'completed', resultComplete: true, sourceTabId: 'source',
  targetTabId: 'target', completedAt: Date.now(), notificationStatus: 'sent' };
const cases = [
  ['fresh success', completed, false],
  ['old success', { ...completed, completedAt: 1 }, false],
  ['success without date', { ...completed, completedAt: null }, false],
  ['SC success', { ...completed, runKind: 'external-research' }, false],
  ['observer success', { ...completed, runKind: 'response-observation' }, false],
  ['green handoff still pending', { ...completed, sourceFollowupPending: true }, false],
  ['green delivered pre-busy request', { status: 'sent', targetPromptProofAt: 1 }, false],
  ['unknown target delivery', { status: 'sent', requiresTargetPromptProof: true }, true],
  ['unfinished result proof', { ...completed, resultComplete: false }, true],
  ['unconfirmed result delivery', { ...completed, notificationStatus: 'unconfirmed', attentionRequiredAt: 1 }, true],
  ['failed result delivery', { ...completed, notificationStatus: 'failed', attentionRequiredAt: 1 }, true],
  ['pending handoff', { ...completed, notificationStatus: 'pending', sourceFollowupPending: true }, true],
  ['sending handoff', { ...completed, notificationStatus: 'sending', sourceFollowupPending: true }, true],
  ['paused request', { status: 'waiting_recovery', outcome: 'paused' }, true],
  ['interrupted request', { status: 'waiting_recovery', outcome: 'interrupted' }, true],
  ['unacknowledged failure', { status: 'failed', attentionRequiredAt: 1 }, true],
  ['dismissed failure', { status: 'failed', sourceTabId: 'source', attentionRequiredAt: 1, sourceAttentionDismissedAt: 1 }, false],
  ['cancelled request', { status: 'cancelled' }, false],
  ...['creating', 'starting', 'sending', 'queued', 'running', 'waiting_descendants']
    .map(status => [status, { status }, true]),
];
for (const [label, run, expected] of cases) {
  test(`actual compact selector: ${label}`, () => {
    const before = structuredClone(run);
    assert.equal(ctx.visible(run, 'source'), expected);
    assert.deepEqual(run, before, 'visibility must not acknowledge, cancel or settle work');
  });
}

test('History remains unfiltered and success expiry no longer schedules updates', () => {
  assert.match(source, /orderedRuns\.map\(run => \(\{ kind: 'run'/);
  assert.match(source, /messages\.threads\.map\(thread => \(\{ kind: 'message'/);
  assert.match(source, /orderedRuns\.filter\(run => runVisibleInTracker\(run, tabId\)\)/);
  assert.doesNotMatch(source, /nextSuccessExpiry|REQUEST_SUCCESS_VISIBLE_MS|successVisibleAt/);
});
