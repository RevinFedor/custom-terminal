'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { causal } = require('../src/main/perf-causal-context');
const { PreparedPromptCatalog } = require('../src/main/prompt-catalog-preparation');
const { createCatalogControl } = require('../src/main/prompt-catalog-cooperative');

test('catalog diagnostics correlate with real nested async causal spans without copying request data', async () => {
  const spans = [], logs = [], original = console.log;
  const counters = { diagnosticLoss: 0, notificationLoss: 0, watchLoss: 0 };
  causal.configure({ enabled: true, sink: record => { spans.push(record); return true; } });
  console.log = text => logs.push(text);
  try {
    await causal.run('http.prompt-usage', { actionId: 'action:52', readId: 'read:52', requestId: 'request:52',
      fileIdentity: '/private/fixture/body.prompt.md', secret: 'unlogged-body' }, async () => {
      await new Promise(resolve => setImmediate(resolve));
      return causal.run('catalog.usageForRoot', {}, async () => {
        const control = createCatalogControl();
        await control.step('map', () => 1);
        PreparedPromptCatalog.prototype.diagnostic.call({ counters }, 'read', control, { authorityPasses: 1 });
      });
    });
    assert.equal(logs.length, 1);
    const record = JSON.parse(logs[0].slice('[PromptCatalog] '.length));
    const child = spans.find(row => row.phase === 'enter' && row.name === 'catalog.usageForRoot');
    const parent = spans.find(row => row.phase === 'enter' && row.name === 'http.prompt-usage');
    assert.equal(record.spanId, child.spanId);
    assert.equal(record.parentSpanId, parent.spanId);
    assert.equal(record.actionId, 'action:52');
    assert.equal(record.readId, 'read:52');
    assert.equal(record.requestId, 'request:52');
    assert.equal(record.authorityPasses, 1);
    assert.equal(record.scanUs, 0);
    assert.equal(logs[0].includes('/private/fixture'), false);
    assert.equal(logs[0].includes('unlogged-body'), false);
    assert.equal(Object.values(record).some(value => value !== null && typeof value === 'object'), false);
  } finally { console.log = original; causal.configure({ enabled: false }); }
});

test('a failing diagnostic observer retains the result and increments only diagnostic loss', async () => {
  const original = console.log, value = { complete: true }, counters = { diagnosticLoss: 0, notificationLoss: 0, watchLoss: 0 };
  causal.configure({ enabled: true, sink: () => true });
  console.log = () => { throw Error('observer failure'); };
  try {
    const returned = await causal.run('catalog.listTab', { readId: 'read:53' }, async () => {
      await new Promise(resolve => setImmediate(resolve));
      PreparedPromptCatalog.prototype.diagnostic.call({ counters }, 'read', createCatalogControl());
      return value;
    });
    assert.equal(returned, value);
    assert.deepEqual(counters, { diagnosticLoss: 1, notificationLoss: 0, watchLoss: 0 });
  } finally { console.log = original; causal.configure({ enabled: false }); }
});
