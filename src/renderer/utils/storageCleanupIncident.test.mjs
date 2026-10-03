import assert from 'node:assert/strict';
import test from 'node:test';
import { storageCleanupIncident } from './storageCleanupIncident.mjs';

test('stale deletion report explains the rejected scope and carries physical target plus revisions for Copy', () => {
  const incident = storageCleanupIncident({
    phase: 'prepare-delete', generation: 'shown-revision',
    result: { error: 'storage_scan_stale', scope: 'selected-items', currentGeneration: 'new-revision', changedItems: [{ itemId: 'build-1', reason: 'item-changed' }] },
    items: [{ id: 'build-1', title: 'Codex release build', path: '/fixture/target/release', sizeBytes: 7344394076 }],
  });
  assert.match(incident.message, /Selected storage items changed\. Nothing was deleted/);
  assert.equal(incident.type, 'warning');
  assert.match(incident.report, /Shown generation: shown-revision/);
  assert.match(incident.report, /Current generation: new-revision/);
  assert.match(incident.report, /Codex release build.*\/fixture\/target\/release/);
  assert.match(incident.report, /item-changed/);
});

test('partial cleanup failure reports successful scope separately from the failure, without claiming zero deletion', () => {
  const incident = storageCleanupIncident({ phase: 'delete-items', operationId: 'operation-1', result: { removed: ['a'], failures: [{ itemId: 'b', detail: 'File is protected' }] } });
  assert.equal(incident.message, 'File is protected');
  assert.match(incident.report, /Operation ID: operation-1/);
  assert.match(incident.report, /File is protected/);
  assert.doesNotMatch(incident.message, /Nothing was deleted/);
});
