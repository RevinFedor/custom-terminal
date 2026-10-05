const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalCommandAdmission } = require('./terminal-command-admission');
const fixture = () => { const terminals = new Map([['target', {}]]); return { terminals, gate: createTerminalCommandAdmission(id => terminals.get(id)) }; };
test('main rejects prepared command after Stop, without relying on renderer acknowledgement', () => {
  const { gate } = fixture(); gate.begin('target', 'op'); gate.cancel('target');
  assert.equal(gate.commit('target', 'op'), false); assert.equal(gate.committed('target', 'op'), false);
});
test('one operation can write only once; success is recorded only after the actual write returns', () => {
  const { gate } = fixture(); gate.begin('target', 'op'); assert.equal(gate.commit('target', 'op'), true);
  assert.equal(gate.committed('target', 'op'), false); gate.confirm('target', 'op');
  assert.equal(gate.committed('target', 'op'), true); assert.equal(gate.commit('target', 'op'), false);
  assert.equal(gate.begin('target', 'op'), false, 'same operation cannot regain permission after consumption');
});
test('a late cancellation of one attempt never revokes a newer command', () => {
  const { gate } = fixture(); gate.begin('target', 'old'); gate.begin('target', 'new'); gate.cancel('target', 'old');
  assert.equal(gate.commit('target', 'old'), false); assert.equal(gate.commit('target', 'new'), true);
});
test('replacement PTY invalidates prepared writes and prior receipts', () => {
  const { gate, terminals } = fixture(); gate.begin('target', 'old'); gate.commit('target', 'old'); gate.confirm('target', 'old');
  gate.begin('target', 'pending'); terminals.set('target', {});
  assert.equal(gate.commit('target', 'pending'), false); assert.equal(gate.committed('target', 'old'), false);
});
test('exact command generation owns its finished event', () => {
  const { gate } = fixture(); gate.begin('target', 'op'); gate.commit('target', 'op'); gate.confirm('target', 'op');
  assert.equal(gate.started('target', 12), 'op'); assert.equal(gate.finished('target', 11), null);
  assert.equal(gate.finished('target', 12), 'op'); assert.equal(gate.finished('target', 12), null);
});

test('a foreign shell generation is never relabelled as the prior automatic command', () => {
  const { gate } = fixture(); gate.begin('target', 'op'); gate.commit('target', 'op'); gate.confirm('target', 'op');
  gate.started('target', 1); assert.equal(gate.started('target', 2), null);
  assert.equal(gate.running('target'), null); assert.equal(gate.running('missing'), null);
});
