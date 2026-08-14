import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunAfterTabStatus } from './runAfterTabStatus.mjs';

const ask = (over = {}) => resolveRunAfterTabStatus({
  tabId: 'T',
  queueBusy: new Map(),
  storeBusy: new Set(),
  inheritedBusy: new Set(),
  waiting: null,
  selected: new Set(),
  ...over,
});

test('a tab nobody reports on is idle', () => {
  assert.equal(ask(), 'idle');
});

test('the queue runner alone is enough to call it working', () => {
  assert.equal(ask({ queueBusy: new Map([['T', true]]) }), 'busy');
});

// THE BUG. The runner drops spinner frames and local slash-commands on purpose
// — they are not turn boundaries and must not fire a queued prompt. A tab whose
// activity was made of exactly those signals never entered the runner's map, so
// this menu called it idle while the sidebar drew a loader on it.
test('a tab the queue runner never heard of is still working if the app says so', () => {
  assert.equal(ask({ storeBusy: new Set(['T']) }), 'busy');
});

test('the runner knowing the tab as idle does not veto the app-wide flag', () => {
  assert.equal(ask({ queueBusy: new Map([['T', false]]), storeBusy: new Set(['T']) }), 'busy');
});

test('working outranks inherited, waiting and selected', () => {
  assert.equal(ask({
    storeBusy: new Set(['T']),
    inheritedBusy: new Set(['T']),
    waiting: new Set(['T']),
    selected: new Set(['T']),
  }), 'busy');
});

test('busy through a linked tab is reported as inherited, not as its own work', () => {
  assert.equal(ask({ inheritedBusy: new Set(['T']) }), 'inherited');
});

test('an armed tab waiting for its trigger reads as waiting', () => {
  assert.equal(ask({ waiting: new Set(['T']) }), 'waiting');
});

test('a chosen trigger nobody reports on is waiting for its turn', () => {
  assert.equal(ask({ waiting: new Set(), selected: new Set(['T']) }), 'waiting');
});

test('a chosen trigger that IS working shows as working, not waiting', () => {
  assert.equal(ask({ waiting: new Set(), selected: new Set(['T']), storeBusy: new Set(['T']) }), 'busy');
});

test('outside an armed queue, being selected says nothing about activity', () => {
  assert.equal(ask({ waiting: null, selected: new Set(['T']) }), 'idle');
});

test('missing collections degrade to idle instead of throwing', () => {
  assert.equal(resolveRunAfterTabStatus({ tabId: 'T' }), 'idle');
});

test('one tab working does not colour another', () => {
  assert.equal(ask({ tabId: 'OTHER', storeBusy: new Set(['T']) }), 'idle');
});
