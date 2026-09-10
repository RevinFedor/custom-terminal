const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalIncidentReporter, terminalSendIncidentNotification } = require('./terminal-incident-reporting');

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

const receipt = (overrides = {}) => ({
  operationKey: 'operation-A', attemptId: 'attempt-A', tabId: 'tab-A',
  handoffId: 'handoff-A', provider: 'codex', sessionId: 'session-A',
  state: 'delivery-unknown', updatedAt: 100,
  receipt: { code: 'codex_user_message_audit_timeout', promptText: 'exact prompt' },
  ...overrides,
});

test('actual notification reads the same receipt after asynchronous capture, preserving the incident', async () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf('const reportTerminalIncident = createTerminalIncidentReporter({');
  const end = main.indexOf('\nfunction requestTerminalIncidentRendererSnapshot(', start);
  assert.ok(start >= 0 && end > start);
  let finishCapture;
  let capturedPayload;
  let current = receipt();
  let reads = 0;
  const sent = [];
  const reporter = vm.runInNewContext(main.slice(start, end)
    + '\n({ reportTerminalIncident, reportTerminalSendDiagnostic })', {
    createTerminalIncidentReporter, terminalSendIncidentNotification,
    captureClaudePromptShapeDiagnostic: () => { throw Error('unexpected Claude diagnostic'); },
    captureTerminalHistoryPreviewDiagnostic: payload => {
      capturedPayload = payload;
      return new Promise(resolve => { finishCapture = resolve; });
    },
    agentSendReceiptStore: { get: key => {
      assert.equal(key, 'operation-A');
      reads++;
      return current;
    } },
    console: { warn() {} },
    mainWindow: { isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) } },
  });
  reporter.reportTerminalSendDiagnostic(current);
  assert.equal(capturedPayload.historyEntry.queueStatus, 'delivery-unknown');
  assert.equal(reads, 0, 'current receipt must be read after the capture wait');
  current = receipt({ state: 'confirmed', updatedAt: 200 });
  finishCapture({ reference: 'captured unknown reference', artifactPath: '/private/incident.json' });
  await reporter.reportTerminalIncident('send:operation-A:attempt-A', {});
  assert.equal(reads, 1);
  assert.equal(sent.length, 1);
  const message = sent[0].payload;
  assert.equal(sent[0].channel, 'terminal:incident-saved');
  assert.equal(message.tone, 'info');
  assert.match(message.headline, /^Отправка подтверждена\./);
  assert.match(message.reference, /captured unknown reference/);
  assert.match(message.reference, /deliveryStatusAtNotification: confirmed/);
  assert.equal(capturedPayload.historyEntry.queueStatus, 'delivery-unknown',
    'the historic diagnostic stays intact');

  const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
  const onStart = app.indexOf('const onIncident = (_event: any, payload: any) => {');
  const onEnd = app.indexOf('\n    const onSnapshot =', onStart);
  assert.ok(onStart >= 0 && onEnd > onStart);
  const toasts = [];
  const onIncident = vm.runInNewContext(
    app.slice(onStart, onEnd).replace('(_event: any, payload: any)', '(_event, payload)')
      + '\nonIncident',
    { useUIStore: { getState: () => ({ showToast: (...args) => toasts.push(args) }) } },
  );
  onIncident(null, message);
  assert.equal(toasts[0][1], 'info');
  assert.equal(toasts[0][3], true, 'the diagnostic remains persistent and copyable');
  assert.equal(toasts[0][4], message.reference);
});

test('another attempt or owner cannot resolve an old send incident', () => {
  const result = { incidentReason: 'send-delivery-unconfirmed', success: true,
    tabId: 'tab-A', toolType: 'codex', historyEntry: { handoffId: 'handoff-A' },
    sendIdentity: { operationKey: 'operation-A', attemptId: 'attempt-A' } };
  for (const patch of [
    { operationKey: 'operation-B' }, { attemptId: 'attempt-B' },
    { tabId: 'tab-B' }, { handoffId: 'handoff-B' }, { provider: 'claude' },
  ]) {
    const notice = terminalSendIncidentNotification(result, receipt({ state: 'confirmed', ...patch }), 1000);
    assert.equal(notice.tone, 'warning');
    assert.match(notice.referenceSuffix, /deliveryStatusAtNotification: unavailable/);
    assert.doesNotMatch(notice.headline, /^Отправка подтверждена/);
  }
  const pending = terminalSendIncidentNotification(result, receipt(), 1000);
  assert.match(pending.headline, /^Подтверждение отправки задержалось/);
  assert.match(pending.referenceSuffix, /deliveryStatusAtNotification: delivery-unknown/);
  assert.equal(terminalSendIncidentNotification({ incidentReason: 'draft-screen-contradiction' }, receipt()), null);
});

test('late delivery does not hide a diagnostic write failure', () => {
  const notice = terminalSendIncidentNotification({
    incidentReason: 'send-delivery-unconfirmed', success: false,
    tabId: 'tab-A', toolType: 'codex', historyEntry: { handoffId: 'handoff-A' },
    sendIdentity: { operationKey: 'operation-A', attemptId: 'attempt-A' },
  }, receipt({ state: 'confirmed' }), 1000);
  assert.equal(notice.tone, 'warning');
  assert.match(notice.headline, /^Отправка подтверждена\./);
  assert.match(notice.headline, /сохранить не удалось/);
});

test('caller deadline keeps a pending send diagnostic informational', () => {
  const result = {
    incidentReason: 'send-confirmation-delayed', success: true,
    tabId: 'tab-A', toolType: 'codex', historyEntry: { handoffId: 'handoff-A' },
    sendIdentity: { operationKey: 'operation-A', attemptId: 'attempt-A' },
  };
  const pending = terminalSendIncidentNotification(result, receipt({ state: 'audit-pending' }), 1000);
  assert.equal(pending.tone, 'info');
  assert.match(pending.headline, /^Подтверждение отправки задержалось\./);
  assert.match(pending.referenceSuffix, /deliveryStatusAtNotification: audit-pending/);
  const failedCapture = terminalSendIncidentNotification({ ...result, success: false },
    receipt({ state: 'audit-pending' }), 1000);
  assert.equal(failedCapture.tone, 'warning', 'a real diagnostic write failure remains visible');
  assert.match(failedCapture.headline, /сохранить не удалось/);
  assert.equal(terminalSendIncidentNotification(result, receipt({ state: 'delivery-unknown' }), 1000).tone,
    'warning', 'a later loss of delivery evidence is not hidden by the earlier delay');
});
