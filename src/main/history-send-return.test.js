'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { historySendReturnControl } = require('./history-send-return');
const input = { tabId: 'T', handoffId: 'H', token: 'return-H', provider: 'codex' };
function fixture(t, records = []) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = { db, list: () => records };
  return { db, store, control: historySendReturnControl(store) };
}
test('return wins before write, survives reopening controller; no write/launch/Stop effects', t => {
  const { db, control } = fixture(t);
  assert.equal(control.register(input).success, true);
  assert.equal(control.request(input).returned, true);
  assert.throws(() => control.beforeWrite('T', 'H'), { code: 'history_send_returned' });
  const reopened = historySendReturnControl({ db, list: () => [] });
  assert.equal(reopened.request(input).returned, true);
  assert.equal(reopened.acknowledge(input).success, true);
  assert.equal(reopened.request(input).restored, true);
  assert.throws(() => reopened.beforeWrite('T', 'H'), { code: 'history_send_returned' });
});
test('first payload write wins, even if endpoint throws; repeated chunks remain allowed', t => {
  const { control } = fixture(t); control.register(input);
  const first = control.beforeWrite('T', 'H');
  assert.equal(first.state, 'writing');
  assert.equal(control.request(input).returned, false);
  assert.equal(control.beforeWrite('T', 'H').inputStartedAt, first.inputStartedAt);
  assert.equal(control.acknowledge(input).success, false);
});
test('foreign token/tab/handoff cannot return another input; old sends cannot be upgraded', t => {
  const { control } = fixture(t); control.register(input);
  for (const patch of [{ token: 'other' }, { tabId: 'other' }, { handoffId: 'other' }]) {
    assert.equal(control.request({ ...input, ...patch }).returned, false);
  }
  assert.equal(control.register({ ...input, token: 'other' }).success, false);
  assert.equal(control.read('T', 'H').state, 'available');
  const old = fixture(t, [{ handoffId: 'H' }]).control;
  assert.equal(old.register(input).success, false);
});
test('separate follower and legacy sends keep their independent behavior', t => {
  const { control } = fixture(t); control.register(input);
  control.register({ ...input, handoffId: 'B', token: 'return-B' });
  control.request(input);
  assert.equal(control.beforeWrite('T', 'B').state, 'writing');
  assert.equal(control.beforeWrite('T', 'legacy'), null);
});
