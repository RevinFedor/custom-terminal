'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalShellReadinessTracker } = require(process.env.CLOSE_B_TRACKER_SOURCE || './terminal-shell-readiness.cjs');

function fixture() {
  const tracker = createTerminalShellReadinessTracker(), term = {};
  tracker.reset('T', term, 101);
  tracker.markAgentLaunchWrite('T', term, 'codex', 'launch');
  return { tracker, term };
}

test('owned Stop retires the captured launch without granting a shell prompt', () => {
  const { tracker, term } = fixture(), before = tracker.launchSnapshot('T', term);
  tracker.markAgentLaunchStarted('T', term);
  assert.equal(tracker.finishAgentLaunch('T', term, true, before), true);
  const after = tracker.launchSnapshot('T', term);
  assert.equal(after.epoch, before.epoch); assert.equal(after.writeId, before.writeId);
  assert.equal(after.pendingWriteId, null); assert.equal(after.retiredWriteId, before.writeId);
  assert.equal(tracker.snapshot('T', term).ready, false);
});

test('a newer write with the same launch label survives an old Stop completion', () => {
  const { tracker, term } = fixture(), old = tracker.launchSnapshot('T', term);
  tracker.markAgentLaunchWrite('T', term, 'codex', 'launch');
  const next = tracker.launchSnapshot('T', term);
  assert.notEqual(next.writeId, old.writeId);
  assert.equal(tracker.finishAgentLaunch('T', term, true, old), false);
  assert.equal(tracker.snapshot('T', term).pendingAgentLaunch.writeId, next.writeId);
  assert.equal(tracker.launchSnapshot('T', term).retiredWriteId, null);
});

test('a completed foreign write remains distinguishable from the original final null', () => {
  const { tracker, term } = fixture(), own = tracker.launchSnapshot('T', term);
  assert.equal(tracker.finishAgentLaunch('T', term, true, own), true);
  tracker.markAgentLaunchWrite('T', term, 'codex', 'foreign');
  tracker.markAgentLaunchStarted('T', term);
  assert.equal(tracker.finishAgentLaunch('T', term), true);
  const foreign = tracker.launchSnapshot('T', term);
  assert.equal(foreign.pendingWriteId, null); assert.notEqual(foreign.writeId, own.writeId);
  assert.equal(foreign.retiredWriteId, foreign.writeId);
});

test('resetting even the same terminal invalidates the former tracker generation', () => {
  const { tracker, term } = fixture(), old = tracker.launchSnapshot('T', term);
  tracker.reset('T', term, 101); tracker.markAgentLaunchWrite('T', term, 'codex', 'launch');
  assert.notEqual(tracker.launchSnapshot('T', term).epoch, old.epoch);
  assert.equal(tracker.finishAgentLaunch('T', term, true, old), false);
  assert.equal(tracker.launchSnapshot('T', {}), null);
});

test('natural command completion records retirement while an unstarted write stays pending', () => {
  const { tracker, term } = fixture(), own = tracker.launchSnapshot('T', term);
  assert.equal(tracker.finishAgentLaunch('T', term), false);
  tracker.markAgentLaunchStarted('T', term);
  assert.equal(tracker.finishAgentLaunch('T', term), true);
  assert.equal(tracker.launchSnapshot('T', term).retiredWriteId, own.writeId);
});

test('snapshot edits and a missing owner cannot retire the current launch', () => {
  const { tracker, term } = fixture(), before = tracker.launchSnapshot('T', term);
  const changed = { ...before, epoch: before.epoch + 1 };
  assert.equal(tracker.finishAgentLaunch('T', term, true, changed), false);
  assert.equal(tracker.finishAgentLaunch('T', term, true, null), false);
  assert.equal(tracker.launchSnapshot('T', term).pendingWriteId, before.writeId);
  tracker.remove('T', term); assert.equal(tracker.launchSnapshot('T', term), null);
});
