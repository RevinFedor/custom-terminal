import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveWorkflowIcon,
  workflowFallbackColor,
  workflowInitial,
} from './workflowVisuals.mjs';

test('explicit workflow icon wins, explicit null requests the color tile', () => {
  assert.equal(resolveWorkflowIcon({ icon: 'workflow.png', projectIds: ['p1'] }, () => 'project.png'), 'workflow.png');
  assert.equal(resolveWorkflowIcon({ icon: null, projectIds: ['p1'] }, () => 'project.png'), null);
});

test('legacy undefined workflow icon inherits the first project icon', () => {
  assert.equal(resolveWorkflowIcon({ icon: undefined, projectIds: ['p1'] }, () => 'project.png'), 'project.png');
  assert.equal(resolveWorkflowIcon({ projectIds: ['p1'] }, () => 'project.png'), 'project.png');
});

test('fallback tile identity is deterministic', () => {
  assert.equal(workflowFallbackColor('main'), workflowFallbackColor('main'));
  assert.equal(workflowInitial(' main '), 'M');
});
