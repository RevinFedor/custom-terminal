import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryPresenceProjection } from './historyPresenceProjection.mjs';

test('secondary projection failure cannot turn canonical active presence into unknown', () => {
  let status = 'unknown';
  let reported = null;
  const result = applyHistoryPresenceProjection({
    presence: { status: 'active', inputReady: true, runtimeSnapshot: null },
    setStatus: next => { status = next; },
    publishRuntimeSnapshot: snapshot => snapshot.liveSettings,
    onProjectionError: error => { reported = error; },
  });

  assert.equal(status, 'active');
  assert.equal(result.status, 'active');
  assert.match(result.projectionError.message, /liveSettings/);
  assert.equal(reported, result.projectionError);
});

test('normal runtime projection remains unchanged', () => {
  const snapshots = [];
  const result = applyHistoryPresenceProjection({
    presence: { status: 'busy', runtimeSnapshot: { liveSettings: { model: 'astra' } } },
    setStatus: () => {},
    publishRuntimeSnapshot: snapshot => snapshots.push(snapshot),
  });

  assert.equal(result.projectionError, null);
  assert.equal(snapshots[0].liveSettings.model, 'astra');
});
