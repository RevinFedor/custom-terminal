'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { createProcessMetricsService } = require('./process-metrics-service');

function makeHarness(overrides = {}) {
  const timers = [];
  const updates = [];
  let captureCount = 0;
  let scannedAt = 1000;

  const service = createProcessMetricsService({
    capture: () => {
      captureCount += 1;
      scannedAt += 1000;
      return { ok: true, processes: [{ pid: 1, ppid: 0, cpuNs: captureCount * 1e9, footprintBytes: 100 }], scannedAt, durationMs: 4 };
    },
    computeCpu: (previous, current) => new Map([[1, previous && current ? 50 : 0]]),
    group: ({ cpuByPid }) => ({ projectTabs: [], hasCpu: !!cpuByPid }),
    collectContext: () => ({ tabs: [], appPids: [], projectId: 'p1' }),
    onUpdate: payload => updates.push(payload),
    setIntervalFn: (fn) => { const handle = { fn, cleared: false }; timers.push(handle); return handle; },
    clearIntervalFn: (handle) => { handle.cleared = true; },
    log: { warn() {} },
    ...overrides,
  });

  return { service, timers, updates, getCaptureCount: () => captureCount };
}

test('первый замер не выдумывает загрузку процессора', () => {
  const { service } = makeHarness();
  const first = service.measureOnce();
  assert.equal(first.ok, true);
  assert.equal(first.hasCpu, false, 'сравнивать не с чем — значит неизвестно');

  const second = service.measureOnce();
  assert.equal(second.hasCpu, true, 'со вторым замером появляется прирост');
});

test('замер идёт только пока есть подписчики', () => {
  const { service, timers } = makeHarness();
  assert.equal(service.isRunning(), false, 'без подписчиков ничего не крутится');

  service.subscribe('a');
  assert.equal(service.isRunning(), true);

  service.subscribe('b');
  assert.equal(timers.length, 1, 'второй подписчик не заводит второй таймер');

  service.unsubscribe('a');
  assert.equal(service.isRunning(), true, 'пока кто-то смотрит — продолжаем');

  service.unsubscribe('b');
  assert.equal(service.isRunning(), false, 'ушёл последний — остановились');
  assert.equal(timers[0].cleared, true);
});

test('повторная подписка того же клиента не плодит таймеры', () => {
  const { service, timers } = makeHarness();
  service.subscribe('a');
  service.subscribe('a');
  assert.equal(service.subscriberCount(), 1);
  service.unsubscribe('a');
  assert.equal(service.isRunning(), false);
  assert.equal(timers.length, 1);
});

test('после паузы загрузка считается заново, а не от старого снимка', () => {
  const { service } = makeHarness();
  service.subscribe('a');
  service.measureOnce();
  service.unsubscribe('a');

  // Пауза могла длиться сколько угодно. Прирост за неё размазался бы по
  // всему простою и показал ложный ноль для занятого процесса.
  const afterPause = service.measureOnce();
  assert.equal(afterPause.hasCpu, false, 'протухший снимок не используется');
});

test('подписка сразу отдаёт данные, не дожидаясь тика', () => {
  const { service, getCaptureCount } = makeHarness();
  const payload = service.subscribe('a');
  assert.equal(payload.ok, true);
  assert.equal(getCaptureCount(), 1, 'замер сделан немедленно');
});

test('недоступный источник не роняет сервис', () => {
  const { service } = makeHarness({
    capture: () => ({ ok: false, reason: 'koffi-load-failed' }),
  });

  const payload = service.measureOnce();
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'koffi-load-failed');
});

test('ошибка внутри замера не убивает таймер', () => {
  const warnings = [];
  const { service, timers, updates } = makeHarness({
    capture: () => { throw new Error('boom'); },
    log: { warn: message => warnings.push(message) },
  });

  service.subscribe('a');
  timers[0].fn();

  assert.equal(timers[0].cleared, false, 'таймер продолжает жить');
  assert.equal(updates.at(-1).ok, false);
  assert.equal(updates.at(-1).reason, 'measure-threw');
  assert.ok(warnings.length > 0, 'сбой обязан быть виден в логе');
});

test('тик рассылает данные подписчикам', () => {
  const { service, timers, updates } = makeHarness();
  service.subscribe('a');
  const before = updates.length;
  timers[0].fn();
  assert.equal(updates.length, before + 1);
  assert.equal(updates.at(-1).ok, true);
});
