import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRunningAutoCompacts } from './autoCompactActivityPresentation.mjs';

test('counts only compacts that are actually executing and groups known tabs by workflow', () => {
  const summary = summarizeRunningAutoCompacts({
    'tab-main-a': { phase: 'compacting', message: 'running' },
    'tab-main-b': { phase: 'compacting', message: 'running' },
    'tab-ios': { phase: 'compacting', message: 'running' },
    'tab-waiting': { phase: 'waiting', message: 'waiting' },
    'tab-checking': { phase: 'checking', message: 'checking' },
    'tab-resuming': { phase: 'resuming', message: 'resuming' },
    'tab-error': { phase: 'error', message: 'failed' },
  }, [
    { id: 'tab-main-a', workflowId: 'main' },
    { id: 'tab-main-b', workflowId: 'main' },
    { id: 'tab-ios', workflowId: 'ios' },
    { id: 'tab-waiting', workflowId: 'main' },
    { id: 'tab-resuming', workflowId: 'ios' },
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.workflowCounts.get('main'), 2);
  assert.equal(summary.workflowCounts.get('ios'), 1);
  assert.equal(summary.workflowCounts.has('missing'), false);
});

test('keeps the global running proof even before a tab appears in inventory', () => {
  const summary = summarizeRunningAutoCompacts({
    'restoring-tab': { phase: 'compacting', message: 'running' },
  }, []);

  assert.equal(summary.total, 1);
  assert.equal(summary.workflowCounts.size, 0);
});
