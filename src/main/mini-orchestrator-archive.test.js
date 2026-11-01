'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMiniOrchestrator } = require('./mini-orchestrator');
const archive = () => ({ version: 1, tabId: 'own', completed: true,
  source: { provider: 'codex', sessionId: 'private', turnId: 'native-turn', generation: 'headless-run', jobId: 'review', requestIds: ['user'] },
  entries: ['instruction', 'request', 'answer', 'review'].map((type, i) => ({ id: String(i), type, text: type })) });
test('genuine completed archive restores only presentation, never runtime/write authority', () => {
  const a = archive(); Object.assign(a, { enabled: true, job: { attempted: true }, pendingSend: {}, ledger: [{ attempted: true }] });
  const c = createMiniOrchestrator({ loadPresentation: () => a });
  const s = c.snapshot('own'); assert.equal(s.enabled, false); assert.equal(s.phase, 'complete');
  assert.equal(s.entries.length, 4); assert.equal(s.reviewSource.archived, true);
  assert.equal(c.validateSend({ tabId: 'own', handoffId: 'mini-orchestrator:review' }), false);
  s.entries[0].text = 'edited'; assert.equal(c.snapshot('own').entries[0].text, 'instruction');
  assert.equal(c.clear('own'), true); assert.equal(c.snapshot('own').entries.length, 0); c.dispose();
});
test('foreign or write-tool archives are rejected and cannot become active', () => {
  for (const change of [a => a.tabId = 'foreign', a => a.completed = false,
    a => a.entries.push({ id: 'bad', type: 'tool', name: 'send_prompt', text: 'send', status: 'sent' })]) {
    const a = archive(); change(a); const c = createMiniOrchestrator({ loadPresentation: () => a });
    assert.equal(c.snapshot('own').phase, 'error'); assert.equal(c.snapshot('own').enabled, false);
    assert.equal(c.snapshot('own').entries.length, 0); c.dispose();
  }
});
test('two genuinely completed rounds of the same archived chat show their full request-answer-critique-correction-reverdict chain', () => {
  const roundEntries = (label) => ['instruction', 'request', 'answer', 'review'].map((type, i) => ({ id: label + i, type, text: label + '-' + type }));
  const a = { version: 1, tabId: 'own', completed: true, rounds: [
    { source: { provider: 'codex', sessionId: 'sid-1', turnId: 'turn-1', generation: 'g1', requestIds: ['sid-1_user'] }, entries: roundEntries('r1') },
    { source: { provider: 'codex', sessionId: 'sid-2', turnId: 'turn-2', generation: 'g2', requestIds: ['sid-2_user'] }, entries: roundEntries('r2') },
  ] };
  const c = createMiniOrchestrator({ loadPresentation: () => a });
  const s = c.snapshot('own');
  assert.equal(s.phase, 'complete'); assert.equal(s.entries.length, 8);
  assert.deepEqual(s.entries.map(e => e.round), [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal(s.entries.find(e => e.round === 1 && e.type === 'review').text, 'r1-review');
  assert.equal(s.entries.find(e => e.round === 2 && e.type === 'review').text, 'r2-review');
  assert.equal(Object.keys(s.roundSources).length, 2);
  assert.equal(s.roundSources['1'].sessionId, 'sid-1'); assert.equal(s.roundSources['2'].sessionId, 'sid-2');
  assert.equal(s.reviewSource.sessionId, 'sid-2', 'the top-level reviewSource is the latest round, for legacy readers');
  c.dispose();
});
