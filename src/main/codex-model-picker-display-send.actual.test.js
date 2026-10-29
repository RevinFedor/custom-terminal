'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, tick } = require('./fixtures/model-preparation.cjs');

test('actual settings+Send uses fresh catalog, selects spaced Terra label, and sends original prompt once', async t => {
  const h = fixture(t, { requested: { model: 'gpt-6.1-terra', effort: 'max' },
    modelCatalog: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }],
    displayModelRows: ['GPT-6.1-Sol (current)     Workhorse.', 'GPT-6-Astra               Frontier.',
      'GPT-6.1 Terra             GPT-6.1 Terra Codex model.'] });
  let settled = false;
  const pending = h.start().then(result => { settled = true; return result; });
  await tick(160); h.frame('/model'); await tick(160);
  // A frozen old consumer never recognizes this visible row. Advance only its
  // own controlled clock so the original timeout produces a semantic failure.
  if (!settled) { h.clock.advance(6500); await tick(160); }
  const result = await pending;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(h.serviceEnters, 1); assert.equal(h.promptCalls, 1);
  assert.equal(h.writes.filter(bytes => bytes === '\x1b[B').length, 2);
  assert.equal(h.events.filter(event => event.kind === 'publication').length, 1);
});

test('actual settings+Send retains its exact catalog through a multiword acknowledgement', async t => {
  const h = fixture(t, { requested: { model: 'gpt-7.2-artemis', effort: 'high' },
    modelCatalog: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-7.2-artemis', label: 'GPT-7.2 Artemis' }],
    displayModelRows: ['GPT-6.1-Sol (current)     Workhorse.', 'GPT-7.2 Artemis          Example model.'],
    displayAckModel: 'GPT-7.2 Artemis' });
  let settled = false;
  const pending = h.start().then(result => { settled = true; return result; });
  await tick(160); h.frame('/model'); await tick(160);
  if (!settled) { h.clock.advance(6500); await tick(160); }
  const result = await pending;
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(h.serviceEnters, 1); assert.equal(h.promptCalls, 1);
  assert.equal(h.writes.filter(bytes => bytes === '\x1b[B').length, 1);
});
