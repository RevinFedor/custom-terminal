import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHistoryPreparationStatus, historyPreparationLabel } from './historyPreparationStatus.mjs';
import { createDormantSurfaceAdmissionQueue } from './dormantSurfaceAdmission.mjs';

function fixture() {
  const ipc = new EventEmitter(), replies = [], calls = [];
  ipc.invoke = channel => {
    calls.push(channel);
    return channel.endsWith(':subscribe') ? new Promise(resolve => replies.push(resolve)) : Promise.resolve();
  };
  return { ipc, replies, calls, store: createHistoryPreparationStatus(ipc) };
}
const snapshot = (revision, operations = []) => ({ epoch: 'process-A', revision, operations });
const operation = { id: 'A', tabId: 'tab-A', kind: 'resume' };

test('late initial snapshot cannot relight an operation that already finished', async () => {
  const f = fixture(); const unsubscribe = f.store.subscribe(() => {});
  f.ipc.emit('history-preparation:changed', {}, snapshot(2));
  f.replies[0](snapshot(1, [operation])); await Promise.resolve();
  assert.equal(f.store.getSnapshot().active, false);
  unsubscribe(); assert.equal(f.ipc.listenerCount('history-preparation:changed'), 0);
});

test('subscriber remount ignores old reply and hydrates current work without polling', async () => {
  const f = fixture(); const first = f.store.subscribe(() => {}); first();
  const second = f.store.subscribe(() => {});
  f.replies[1](snapshot(3)); await Promise.resolve();
  f.replies[0](snapshot(4, [operation])); await Promise.resolve();
  assert.equal(f.store.getSnapshot().active, false);
  assert.equal(f.calls.filter(c => c.endsWith(':subscribe')).length, 2);
  f.ipc.emit('history-preparation:changed', {}, snapshot(5, [operation]));
  assert.equal(f.store.getSnapshot().active, true);
  second();
});

test('prewarm queue stays active between jobs and a stale completion cannot clear Resume', async () => {
  const f = fixture(), callbacks = [], leases = [];
  const queue = createDormantSurfaceAdmissionQueue({ schedule: callback => { callbacks.push(callback); return () => {}; },
    setTimer: () => 1, clearTimer() {}, onTransition: event => f.store.setPrewarm(event.remaining) });
  const unsubscribe = f.store.subscribe(() => {});
  queue.enqueue('A', lease => leases.push(lease)); queue.enqueue('B', lease => leases.push(lease));
  callbacks.shift()();
  assert.equal(f.store.getSnapshot().prewarm, true);
  leases[0].complete();
  assert.equal(f.store.getSnapshot().active, true, 'idle gap before queued B is still preparation');
  callbacks.shift()();
  f.ipc.emit('history-preparation:changed', {}, snapshot(1, [operation]));
  leases[1].complete('load-failed'); leases[0].complete('late');
  assert.equal(f.store.getSnapshot().prewarm, false);
  assert.equal(f.store.getSnapshot().active, true, 'another real operation still owns its lease');
  f.ipc.emit('history-preparation:changed', {}, snapshot(2));
  assert.equal(f.store.getSnapshot().active, false);
  unsubscribe();
});

test('tooltip explains preparation using existing title metadata, not CPU or AI busy', () => {
  const f = fixture(), names = new Map([['tab-A', { title: 'Resume test' }]]);
  assert.match(historyPreparationLabel(f.store.getSnapshot(), names), /Потребление ресурсов/);
  f.store.setPrewarm(2); assert.equal(historyPreparationLabel(f.store.getSnapshot(), names), 'Подготовка историй');
  assert.equal(historyPreparationLabel({ active: true, prewarm: false, operations: [operation] }, names),
    'Загрузка истории: Resume test');
});
