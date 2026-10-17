const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalIncidentReporter, terminalSendIncidentNotification,
  resolveTerminalIncidentSendIdentity, terminalSendFailureDiagnosticPayload } = require('./terminal-incident-reporting');

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

test('failure channel keeps only exact durable identity and bounded metadata, never prompt content', () => {
  const record = receipt(), store = { list: () => [record] };
  const input = { tabId: 'tab-A', toolType: 'codex', handoffId: 'handoff-A',
    sendAttemptId: 'attempt-A', sendOperationKey: 'spoofed-operation', promptText: 'SECRET',
    error: 'SECRET EXCEPTION', code: 'terminal_draft_state_unknown', submitted: false, pasteWritten: false };
  const value = terminalSendFailureDiagnosticPayload(input, store);
  assert.deepEqual(value.sendIdentity, { operationKey: 'operation-A', attemptId: 'attempt-A', handoffId: 'handoff-A' });
  assert.equal(value.context.durableIdentity, 'exact-tab-handoff-attempt');
  assert.equal(value.silent, true); assert.doesNotMatch(JSON.stringify(value), /SECRET/);
  for (const patch of [{ sendAttemptId: 'other' }, { toolType: 'claude' }, { tabId: 'foreign' }]) {
    const next = terminalSendFailureDiagnosticPayload({ ...input, ...patch }, store);
    assert.deepEqual(next.sendIdentity, { handoffId: 'handoff-A' });
    assert.equal(next.context.durableIdentity, 'unavailable');
  }
  assert.equal(terminalSendFailureDiagnosticPayload({ ...input, tabId: 'bad\nID' }, store), null);
  const standalone = terminalSendFailureDiagnosticPayload({ ...input, sendAttemptId: null }, store);
  assert.deepEqual(standalone.sendIdentity, { handoffId: 'handoff-A' });
  assert.equal(resolveTerminalIncidentSendIdentity(store, { tabId: 'tab-A', provider: 'codex',
    handoffId: 'handoff-A', attemptId: 'other' }), null);
});

test('actual Main failure channel freezes immediately, deduplicates same report, rejects foreign sender and stays silent', async () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf('const reportTerminalIncident = createTerminalIncidentReporter({');
  const end = main.indexOf('\nfunction requestTerminalIncidentRendererSnapshot(', start);
  const sender = { isDestroyed: () => false }, captures = [], notifications = [];
  const runtime = vm.runInNewContext(main.slice(start, end)
    + '\n({ handleTerminalSendFailureDiagnostic, reportTerminalRejectedSendDiagnostic })', {
    createTerminalIncidentReporter, terminalSendIncidentNotification, terminalSendFailureDiagnosticPayload,
    captureTerminalHistoryPreviewDiagnostic: payload => { captures.push(payload); return Promise.resolve({ reference: 'saved', artifactPath: '/fixture' }); },
    BrowserWindow: { fromWebContents: wc => wc === sender ? {} : null },
    agentSendReceiptStore: { list: () => [receipt()], get: () => receipt() }, console: { warn() {} },
    mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => notifications.push(args) } },
  });
  const input = { tabId: 'tab-A', toolType: 'codex', handoffId: 'handoff-A', sendAttemptId: 'attempt-A' };
  const first = runtime.handleTerminalSendFailureDiagnostic({ sender }, input);
  assert.equal(captures.length, 1, 'pin starts before any renderer/disk await');
  assert.equal(runtime.handleTerminalSendFailureDiagnostic({ sender }, input), first);
  await first;
  runtime.handleTerminalSendFailureDiagnostic({ sender: { isDestroyed: () => false } }, input);
  runtime.handleTerminalSendFailureDiagnostic({ sender }, { ...input, toolType: 'foreign' });
  assert.equal(captures.length, 1); assert.equal(notifications.length, 0);
  await runtime.handleTerminalSendFailureDiagnostic({ sender }, { ...input, handoffId: 'standalone-H', sendAttemptId: null });
  assert.equal(captures.length, 2, 'no-attempt local slash refusal is captured too');
  await runtime.reportTerminalRejectedSendDiagnostic(receipt({ state: 'not-submitted' }));
  assert.equal(captures.length, 3); assert.equal(captures[2].context.state, 'not-submitted');
  assert.equal(notifications.length, 0, 'does not add a second error toast');
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

test('caller deadline keeps a pending send diagnostic silent, without hiding lost proof', () => {
  const result = {
    incidentReason: 'send-confirmation-delayed', success: true,
    tabId: 'tab-A', toolType: 'codex', historyEntry: { handoffId: 'handoff-A' },
    sendIdentity: { operationKey: 'operation-A', attemptId: 'attempt-A' },
  };
  const pending = terminalSendIncidentNotification(result, receipt({ state: 'audit-pending' }), 1000);
  assert.equal(pending.tone, 'info');
  assert.equal(pending.notifyUser, false);
  assert.match(pending.headline, /^Подтверждение отправки задержалось\./);
  assert.match(pending.referenceSuffix, /deliveryStatusAtNotification: audit-pending/);
  const failedCapture = terminalSendIncidentNotification({ ...result, success: false },
    receipt({ state: 'audit-pending' }), 1000);
  assert.equal(failedCapture.tone, 'warning', 'a real diagnostic write failure remains visible');
  assert.equal(failedCapture.notifyUser, true);
  assert.match(failedCapture.headline, /сохранить не удалось/);
  assert.equal(terminalSendIncidentNotification(result, receipt({ state: 'delivery-unknown' }), 1000).tone,
    'warning', 'a later loss of delivery evidence is not hidden by the earlier delay');
  assert.equal(terminalSendIncidentNotification(result, receipt({ state: 'delivery-unknown' }), 1000).notifyUser, true);
  assert.equal(terminalSendIncidentNotification(result, receipt({ state: 'confirmed' }), 1000).notifyUser, false);
  assert.equal(terminalSendIncidentNotification(result, receipt({ state: 'confirmed', attemptId: 'other' }), 1000).notifyUser, true);
});

test('actual delayed reporter saves evidence but does not emit a toast for pending or late confirmed', async () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf('const reportTerminalIncident = createTerminalIncidentReporter({');
  const end = main.indexOf('\nfunction requestTerminalIncidentRendererSnapshot(', start);
  for (const state of ['audit-pending', 'confirmed', 'delivery-unknown']) {
    let finishCapture, captures = 0;
    const sent = [];
    const current = receipt({ state });
    const runtime = vm.runInNewContext(main.slice(start, end) + '\n({reportTerminalIncident, reportTerminalSendDiagnostic})', {
      createTerminalIncidentReporter, terminalSendIncidentNotification,
      captureTerminalHistoryPreviewDiagnostic: () => { captures++; return new Promise(r => { finishCapture = r; }); },
      agentSendReceiptStore: { get: () => current }, console: { warn() {} },
      mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } },
    });
    runtime.reportTerminalSendDiagnostic(receipt({ state: 'audit-pending' }), 'send-confirmation-delayed');
    finishCapture({ reference: 'packet', artifactPath: '/private/fixture' });
    await runtime.reportTerminalIncident('send-delay:operation-A:attempt-A', {});
    assert.equal(captures, 1);
    assert.equal(sent.length, state === 'delivery-unknown' ? 1 : 0, state);
  }
});
