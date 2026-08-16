import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptTabBackgroundWorkRecord } from './tabBackgroundWorkState.mjs';

test('an unrelated tab event cannot stale this tab startup snapshot', () => {
  const revisions = new Map();
  assert.deepEqual(
    acceptTabBackgroundWorkRecord(revisions, { tabId: 'tab-b', count: 1, revision: 10 }),
    { tabId: 'tab-b', active: true },
  );
  assert.deepEqual(
    acceptTabBackgroundWorkRecord(revisions, { tabId: 'tab-a', count: 1, revision: 5 }),
    { tabId: 'tab-a', active: true },
  );
});

test('a delayed snapshot cannot roll back a newer event for the same tab', () => {
  const revisions = new Map();
  assert.deepEqual(
    acceptTabBackgroundWorkRecord(revisions, { tabId: 'tab-a', count: 0, revision: 8 }),
    { tabId: 'tab-a', active: false },
  );
  assert.equal(
    acceptTabBackgroundWorkRecord(revisions, { tabId: 'tab-a', count: 1, revision: 7 }),
    null,
  );
});

test('an unversioned snapshot is accepted only before a versioned record', () => {
  const revisions = new Map();
  assert.deepEqual(
    acceptTabBackgroundWorkRecord(revisions, { tabId: 'tab-a', count: 1 }),
    { tabId: 'tab-a', active: true },
  );
  acceptTabBackgroundWorkRecord(revisions, { tabId: 'tab-a', count: 0, revision: 2 });
  assert.equal(
    acceptTabBackgroundWorkRecord(revisions, { tabId: 'tab-a', count: 1 }),
    null,
  );
});
