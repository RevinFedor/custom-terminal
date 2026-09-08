const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalIncidentReporter } = require('./terminal-incident-reporting');

test('freeze starts at detection, exact repeats share one artifact and notification', async () => {
  const notifications = [];
  let captures = 0, finish;
  const report = createTerminalIncidentReporter({ capture: () => { captures++; return new Promise(r => { finish = r; }); },
    notify: value => notifications.push(value) });
  const first = report('attempt-a', { tabId: 'T' });
  assert.equal(captures, 1);
  assert.equal(report('attempt-a', { tabId: 'T' }), first);
  finish({ artifactPath: '/private/artifact', reference: 'exact reference' });
  await first;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].success, true);
});

test('disk failure is reported and never throws into the input operation', async () => {
  const notifications = [];
  const report = createTerminalIncidentReporter({ capture: () => { throw Error('disk full'); },
    notify: value => notifications.push(value) });
  const result = await report('attempt-b', { tabId: 'T' });
  assert.equal(result.success, false);
  assert.equal(result.error, 'disk full');
  assert.equal(notifications.length, 1);
});
