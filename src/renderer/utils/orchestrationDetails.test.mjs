import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationDateTime, orchestrationRequestTime, orchestrationDetailRows, orchestrationNotificationText,
  orchestrationOutcomeText } from './orchestrationDetails.mjs';

const createdAt = Date.parse('2026-10-04T15:10:31.022Z');
const browserFailure = Object.freeze({ runKind: 'external-research', sourceTabId: 'source', status: 'failed',
  outcome: 'failed', createdAt, completedAt: createdAt + 6200, deliveryAcceptedAt: createdAt + 6245,
  notificationStatus: 'sent', completionReason: 'external-research-error', externalResearchStage: 'open_failed',
  error: 'Extension not connected', resultError: 'Extension not connected' });

test('browser failure has one error, one outcome and a separate delivered failure notification', () => {
  const rows = orchestrationDetailRows(browserFailure, 'source');
  assert.equal(rows.find(row => row.key === 'error').value, 'Extension not connected');
  assert.equal(rows.find(row => row.key === 'outcome').value, 'Не выполнено: ошибка внешнего исследования');
  assert.equal(rows.find(row => row.key === 'notification').value, 'Об ошибке доставлено');
  assert.equal(rows.find(row => row.key === 'time').label, 'Создан');
  assert.equal(rows.some(row => ['Состояние', 'Исход', 'Причина', 'Результат', 'Доставка'].includes(row.label)), false);
});

test('successful work stays successful when its notification fails', () => {
  const run = { sourceTabId: 'source', createdAt, status: 'completed', outcome: 'success',
    resultComplete: true, completionReason: 'task_complete', notificationStatus: 'failed',
    notificationError: 'Cannot submit notification' };
  const rows = orchestrationDetailRows(run, 'source');
  assert.equal(rows.find(row => row.key === 'outcome').value, 'Выполнено');
  assert.equal(rows.find(row => row.key === 'notification').value, 'С результатом не доставлено');
  assert.equal(rows.find(row => row.key === 'error').value, 'Уведомление: Cannot submit notification');
});

test('different failures retain their text and stage; only exact duplicates are merged', () => {
  const run = { ...browserFailure, error: 'Writer failed', resultError: 'Missing proof',
    notificationError: 'Writer failed', externalResearchTransportError: 'SC offline' };
  const rows = orchestrationDetailRows(run, 'source');
  const error = rows.find(row => row.key === 'error');
  assert.equal(error.label, 'Ошибки');
  assert.equal(error.value, 'Выполнение: Writer failed\n\nРезультат: Missing proof\n\nСвязь с SC Desktop: SC offline');
  assert.equal(orchestrationDetailRows({ ...run, resultError: 'Writer failed elsewhere' }, 'source')
    .find(row => row.key === 'error').value.includes('Writer failed elsewhere'), true);
});

test('all notification states are explicit, without promoting queue or unknown to delivered', () => {
  const expected = {
    pending: 'Ожидает отправки', sending: 'Отправляется', 'audit-pending': 'Проверяется доставка уведомления',
    sent: 'Об ошибке доставлено', queued: 'В очереди исходной вкладки',
    'waiting-for-input': 'Не доставлено: занят ввод исходной вкладки',
    unconfirmed: 'Доставка уведомления не подтверждена', failed: 'Об ошибке не доставлено',
    suppressed: 'Отправка отменена', 'source-closed': 'Не доставлено: исходная вкладка закрыта',
  };
  for (const [notificationStatus, label] of Object.entries(expected)) {
    assert.equal(orchestrationNotificationText({ ...browserFailure, notificationStatus }, 'source'), label);
  }
  assert.equal(orchestrationNotificationText({ ...browserFailure, notificationStatus: 'future-state' }, 'source'),
    'Неизвестный статус: future-state');
});

test('a live run does not imply that a not-yet-created result is awaiting delivery', () => {
  const run = { createdAt, sourceTabId: 'source', status: 'running', notificationStatus: 'pending' };
  assert.equal(orchestrationNotificationText(run, 'source'), '');
  assert.equal(orchestrationNotificationText({ ...run, notificationAttemptedAt: createdAt + 2 }, 'source'), 'Ожидает отправки');
});

test('finished lifecycle is not presented as a verified result while proof remains pending', () => {
  const run = { ...browserFailure, runKind: 'agent', status: 'completed', outcome: 'success',
    resultComplete: false, notificationStatus: 'pending', error: null, resultError: null };
  assert.equal(orchestrationOutcomeText(run), 'Работа завершена; результат ещё проверяется');
  assert.equal(orchestrationNotificationText(run, 'source'), 'Ожидает проверки результата');
});

test('notification stays source-scoped; opting out is not a delivery error', () => {
  assert.equal(orchestrationNotificationText(browserFailure, 'target'), '');
  assert.equal(orchestrationNotificationText({ ...browserFailure, notifySource: false }, 'source'), '');
  const run = { createdAt, sourceTabId: 'source', notificationStatus: 'failed', notificationError: 'Source-only failure' };
  assert.equal(orchestrationDetailRows(run, 'target').find(row => row.key === 'error').value,
    'Уведомление: Source-only failure');
});

test('reason and outcome preserve unknown codes but collapse equivalent success and duplicate codes', () => {
  assert.equal(orchestrationOutcomeText({ outcome: 'failed', completionReason: 'future-reason' }), 'Не выполнено: future-reason');
  assert.equal(orchestrationOutcomeText({ outcome: 'future-outcome', completionReason: 'future-reason' }), 'future-outcome: future-reason');
  assert.equal(orchestrationOutcomeText({ outcome: 'interrupted', completionReason: 'interrupted' }), 'Остановлено вручную');
  assert.equal(orchestrationOutcomeText({ outcome: 'success', completionReason: 'recovered-from-transcript' }),
    'Выполнено: результат восстановлен из истории');
  assert.equal(orchestrationOutcomeText({ completionReason: 'external-research-error' }), 'ошибка внешнего исследования');
  assert.equal(orchestrationOutcomeText({}), '');
});

test('manual turn cancellation is an outcome, not an extra delivery/execution error', () => {
  const run = Object.freeze({ sourceTabId: 'source', createdAt, status: 'cancelled',
    outcome: 'interrupted', completionReason: 'turn_aborted', error: 'turn_aborted',
    resultError: 'turn_aborted', notificationStatus: 'suppressed' });
  const rows = orchestrationDetailRows(run, 'source');
  assert.equal(rows.find(row => row.key === 'outcome').value, 'Остановлено вручную');
  assert.equal(rows.find(row => row.key === 'notification').value, 'Отправка отменена');
  assert.equal(rows.some(row => row.key === 'error'), false);
  assert.equal(run.error, 'turn_aborted');
  assert.equal(run.status, 'cancelled');
});

test('manual cancellation does not hide independent result or notification failures', () => {
  const run = { sourceTabId: 'source', createdAt, status: 'cancelled', outcome: 'interrupted',
    completionReason: 'turn_aborted', error: 'turn_aborted', resultError: 'Missing saved result',
    notificationStatus: 'failed', notificationError: 'Source writer changed' };
  const issue = orchestrationDetailRows(run, 'source').find(row => row.key === 'error');
  assert.equal(issue.value, 'Результат: Missing saved result\n\nУведомление: Source writer changed');
  assert.equal(orchestrationDetailRows({ ...run, resultError: null, notificationError: 'turn_aborted' }, 'source')
    .find(row => row.key === 'error').value, 'Уведомление: turn_aborted');
  assert.equal(orchestrationDetailRows({ ...run, resultError: null, notificationError: null,
    externalResearchTransportError: 'turn_aborted' }, 'source').find(row => row.key === 'error').value, 'turn_aborted');
});

test('an unknown or mismatched abort reason remains visible rather than guessed cancellation', () => {
  for (const run of [
    { outcome: 'failed', completionReason: 'turn_aborted', error: 'turn_aborted' },
    { outcome: 'interrupted', completionReason: 'future-abort', error: 'turn_aborted' },
    { outcome: 'interrupted', completionReason: 'turn_aborted', error: 'turn_aborted: unexpected provider failure' },
  ]) {
    assert.equal(orchestrationDetailRows({ createdAt, ...run }, 'source').find(row => row.key === 'error').value, run.error);
  }
});

test('dates include day/month/year and minute precision in the system timezone, even across midnight', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Bangkok';
    assert.equal(orchestrationDateTime(createdAt), '04.10.2026, 22:10');
    assert.equal(orchestrationDateTime(Date.parse('2026-10-04T23:59:58Z')), '05.10.2026, 06:59');
    process.env.TZ = 'UTC';
    assert.equal(orchestrationDateTime(createdAt), '04.10.2026, 15:10');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  for (const value of [null, undefined, 0, -1, NaN, Infinity, 9e20, 'invalid']) assert.equal(orchestrationDateTime(value), '—');
});

test('native send date requires proof and never relabels mere browser acceptance as sending', () => {
  const run = { createdAt, deliveryAcceptedAt: createdAt + 1000, targetPromptProofAt: null };
  assert.equal(orchestrationRequestTime(run).label, 'Создан');
  const sent = orchestrationRequestTime({ ...run, targetPromptProofAt: createdAt + 5000 });
  assert.equal(sent.label, 'Отправлен');
  assert.equal(sent.value, orchestrationDateTime(createdAt + 1000));
  assert.equal(orchestrationRequestTime({ ...run, deliveryAcceptedAt: null, targetPromptProofAt: createdAt + 5000 }).label, 'Подтверждён');
  assert.equal(orchestrationRequestTime({ ...browserFailure, targetPromptProofAt: createdAt + 5000 }).label, 'Создан');
});
test('offline selected browser is an unsent wait, not a completion or generic transport error', () => {
  const rows = orchestrationDetailRows({ status: 'queued', deliveryDeferredReason: 'waiting-for-browser',
    externalResearchRequestedBrowserId: 'chrome',
    externalResearchBrowserWait: { notSubmitted: true, browserInstanceId: 'own-chrome' } }, 'source');
  assert.equal(rows.find(row => row.key === 'browser-wait').value, 'Chrome: не в сети. Не отправлен');
  assert.equal(rows.some(row => row.key === 'error'), false);
  assert.equal(orchestrationDetailRows({ status: 'cancelled', deliveryDeferredReason: 'waiting-for-browser',
    externalResearchBrowserWait: { notSubmitted: true } }, 'source').some(row => row.key === 'browser-wait'), false);
});
