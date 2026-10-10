'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { createProcessMetricsService, toAmbient } = require('./process-metrics-service');

function makeHarness(overrides = {}) {
  const timers = [];
  const updates = [];
  const ambientUpdates = [];
  let captureCount = 0;
  let scannedAt = 1000;

  const service = createProcessMetricsService({
    capture: () => {
      captureCount += 1;
      scannedAt += 1000;
      return { ok: true, processes: [{ pid: 1, ppid: 0, cpuNs: captureCount * 1e9, footprintBytes: 100 }], scannedAt, durationMs: 4 };
    },
    computeCpu: (previous, current) => new Map([[1, previous && current ? 50 : 0]]),
    group: ({ cpuByPid, snapshot }) => ({
      projectTabs: [],
      hasCpu: !!cpuByPid,
      scannedAt: snapshot ? snapshot.scannedAt : null,
      orphans: { count: 2, totalBytes: 40 },
      totals: { projectBytes: 100, otherBytes: 0, allBytes: 140 },
    }),
    collectContext: () => ({ tabs: [], appPids: [], projectId: 'p1' }),
    onUpdate: payload => updates.push(payload),
    onAmbientUpdate: payload => ambientUpdates.push(payload),
    setIntervalFn: (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; },
    clearIntervalFn: (handle) => { handle.cleared = true; },
    log: { warn() {} },
    ...overrides,
  });

  return { service, timers, updates, ambientUpdates, getCaptureCount: () => captureCount };
}

test('общий расход и команды в фоне приходят из одного снимка без нового таймера', () => {
  const { service, timers, updates, ambientUpdates, getCaptureCount } = makeHarness({
    group: ({ snapshot }) => ({ ok: true, scannedAt: snapshot.scannedAt,
      totals: { allBytes: snapshot.scannedAt * 2, commandBytes: snapshot.scannedAt }, orphans: { count: 0 } }),
  });
  const first = service.enableAmbient();
  assert.equal(first.totalBytes, 4000); assert.equal(first.commandBytes, 2000);
  service.subscribe('panel');
  const before = getCaptureCount();
  timers.at(-1).fn();
  assert.equal(getCaptureCount(), before + 1);
  assert.equal(service.isAmbientRunning(), false);
  assert.equal(ambientUpdates.at(-1).scannedAt, updates.at(-1).scannedAt);
  assert.equal(ambientUpdates.at(-1).commandBytes, updates.at(-1).totals.commandBytes);
  assert.equal(ambientUpdates.at(-1).totalBytes, updates.at(-1).totals.allBytes);
  assert.equal(toAmbient({ ok: true, totals: { allBytes: 100 } }).commandBytes, null,
    'старый payload без breakdown не превращается в ложный ноль');
});

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

test('чип получает итог без открытой панели', () => {
  // Главное, ради чего заведён второй темп: до этого закрытая кнопка стояла с
  // прочерком, пока по ней не кликнешь.
  const { service, ambientUpdates, timers } = makeHarness();
  const first = service.enableAmbient();

  assert.equal(first.ok, true);
  assert.equal(first.totalBytes, 140, 'итог берётся из раскладки, не пересчитывается');
  assert.equal(first.orphanCount, 2);
  assert.equal(service.isAmbientRunning(), true);
  assert.equal(service.isRunning(), false, 'панель при этом не подписана');

  timers.at(-1).fn();
  assert.equal(ambientUpdates.at(-1).totalBytes, 140);
  // Тяжёлую раскладку в фон не шлём: у чипа одно число.
  assert.equal('projectTabs' in ambientUpdates.at(-1), false);
});

test('фоновый итог идёт реже, чем разбор для открытой панели', () => {
  const { service, timers } = makeHarness();
  service.enableAmbient();
  const ambientHandle = timers.at(-1);
  assert.ok(ambientHandle.ms > 2000, 'фон не обязан частить: ' + ambientHandle.ms);
});

test('открытая панель кормит чип своим же замером, вторым таймером не дублирует', () => {
  // Два независимых таймера сделали бы лишний проход по процессам и развели бы
  // число в чипе с подписью под открытой панелью.
  const { service, timers, updates, ambientUpdates } = makeHarness();
  service.enableAmbient();
  const ambientHandle = timers.at(-1);

  service.subscribe('a');
  assert.equal(ambientHandle.cleared, true, 'медленный таймер уступил быстрому');
  assert.equal(service.isAmbientRunning(), false);

  const updatesBefore = updates.length;
  const ambientBefore = ambientUpdates.length;
  timers.at(-1).fn();
  assert.equal(updates.length, updatesBefore + 1, 'панель получила раскладку');
  assert.equal(ambientUpdates.length, ambientBefore + 1, 'чип получил итог тем же тиком');

  service.unsubscribe('a');
  assert.equal(service.isAmbientRunning(), true, 'панель закрылась — фон вернулся');
});

test('без включённого фона тик панели не шлёт лишний итог', () => {
  const { service, timers, ambientUpdates } = makeHarness();
  service.subscribe('a');
  timers[0].fn();
  assert.equal(ambientUpdates.length, 0);
});

test('сбой замера приходит в чип как явная неудача, а не как ноль', () => {
  // Ноль означал бы «ничего не потребляется» — это другое утверждение.
  const { service } = makeHarness({ capture: () => ({ ok: false, reason: 'koffi-load-failed' }) });
  const payload = service.enableAmbient();
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'koffi-load-failed');
  assert.equal(payload.totalBytes, undefined);
});

test('whole-PC view reuses the snapshot and timer; ambient never builds or carries its rows',()=>{
  let apps=0, system=0;
  const h=makeHarness({ groupApps:({snapshot})=>{apps++;return {available:true,totalBytes:snapshot.scannedAt,apps:[{id:'A'}]};},
    captureSystem:()=>{system++;return {available:true,totalBytes:32};} });
  h.service.enableAmbient(); h.timers.at(-1).fn();
  assert.equal(apps,0); assert.equal(system,0);
  h.service.subscribe('panel');
  const captures=h.getCaptureCount(), timers=h.timers.length;
  const pc=h.service.setView('panel','system');
  assert.equal(pc.applications.available,true);
  assert.equal(h.getCaptureCount(),captures); assert.equal(h.timers.length,timers);
  h.service.setView('panel','system');
  assert.equal(apps,1); assert.equal(system,1,'same snapshot has one application projection');
  h.timers.at(-1).fn();
  assert.equal(h.getCaptureCount(),captures+1); assert.equal(apps,2);
  assert.equal('applications' in h.ambientUpdates.at(-1),false);
  h.service.setView('panel','noted'); h.timers.at(-1).fn();
  assert.equal(apps,2); assert.equal(system,2);
  h.service.unsubscribe('panel'); h.timers.at(-1).fn();
  assert.equal(apps,2); assert.equal(system,2);
  assert.equal(h.service.isAmbientRunning(),true);
});

test('opening remembered whole-PC scope still captures once and closing removes it',()=>{
  let apps=0;
  const h=makeHarness({groupApps:()=>{apps++;return {available:true};},captureSystem:()=>({})});
  h.service.enableAmbient(); const before=h.getCaptureCount();
  const p=h.service.subscribe('panel',{view:'system'});
  assert.equal(h.getCaptureCount(),before+1); assert.equal(apps,1);
  assert.equal(p.applications.available,true);
  h.service.unsubscribe('panel');
  assert.equal(h.service.setView('panel','system').reason,'not-subscribed');
  assert.equal(h.getCaptureCount(),before+1);
});

test('application failure leaves Noted totals usable; source failure cannot revive old apps on switch',()=>{
  let fail=false;
  const h=makeHarness({capture:()=>fail?{ok:false,reason:'lost'}:{ok:true,scannedAt:1000,processes:[]},
    groupApps:()=>{throw Error('projection');}, captureSystem:()=>({})});
  h.service.subscribe('panel');
  const r=h.service.setView('panel','system');
  assert.equal(r.ok,true); assert.equal(r.applications.available,false);
  assert.equal(r.totals.allBytes,140);
  fail=true; h.timers.at(-1).fn();
  assert.equal(h.service.setView('panel','system').reason,'snapshot-unavailable');
});
