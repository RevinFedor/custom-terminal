'use strict';

const assert = require('node:assert');
const test = require('node:test');

const {
  captureNativeSnapshot,
  computeCpuPercent,
  loadNative,
  __offsets,
} = require('./process-metrics-source');

const darwinOnly = { skip: process.platform !== 'darwin' ? 'macOS-only source' : false };

test('смещения структур соответствуют системным заголовкам', () => {
  // Значения получены через offsetof на macOS и являются частью стабильного
  // ABI ядра. Если тест упал — структура разъехалась, и снимок начнёт молча
  // возвращать мусор (именно так выглядел баг с пустым списком процессов).
  assert.equal(__offsets.OFFSET_USER_TIME_NS, 16);
  assert.equal(__offsets.OFFSET_SYSTEM_TIME_NS, 24);
  assert.equal(__offsets.OFFSET_PHYS_FOOTPRINT, 72);
  assert.equal(__offsets.OFFSET_PROC_START_ABSTIME, 80);
  assert.equal(__offsets.OFFSET_SHORT_PPID, 4);
  assert.equal(__offsets.OFFSET_SHORT_PGID, 8);
  assert.equal(__offsets.OFFSET_SHORT_COMM, 16);
  assert.equal(__offsets.OFFSET_SHORT_UID, 36);
});

test('снимок возвращает непустой список с осмысленными полями', darwinOnly, () => {
  const native = loadNative();
  if (!native.ok) {
    assert.ok(native.reason, 'недоступность источника обязана быть объяснена');
    return;
  }

  const snapshot = captureNativeSnapshot();
  assert.equal(snapshot.ok, true);

  // Пустой список при ok=true — это ровно тот отказ, который выглядит как
  // успех. Мы всегда видим как минимум сами себя.
  assert.ok(snapshot.processes.length > 0, 'снимок не может быть пустым');

  const self = snapshot.processes.find(item => item.pid === process.pid);
  assert.ok(self, 'собственный процесс обязан присутствовать в снимке');
  assert.equal(self.ppid, process.ppid);
  assert.ok(self.footprintBytes > 0, 'память собственного процесса > 0');
  assert.ok(self.cpuNs > 0, 'процессорное время собственного процесса > 0');
  assert.ok(self.name.length > 0, 'имя процесса не может быть пустым');

  for (const item of snapshot.processes) {
    assert.ok(Number.isInteger(item.pid) && item.pid > 0);
    assert.ok(Number.isFinite(item.footprintBytes) && item.footprintBytes >= 0);
  }
});

test('повторный снимок переиспользует кэш путей и не теряет данные', darwinOnly, () => {
  if (!loadNative().ok) return;

  const first = captureNativeSnapshot();
  const second = captureNativeSnapshot();

  const firstSelf = first.processes.find(item => item.pid === process.pid);
  const secondSelf = second.processes.find(item => item.pid === process.pid);

  assert.ok(firstSelf && secondSelf);
  assert.equal(secondSelf.execPath, firstSelf.execPath, 'кэш не должен искажать путь');
  assert.ok(secondSelf.cpuNs >= firstSelf.cpuNs, 'процессорное время не идёт назад');
});

test('загрузка процессора считается как прирост за интервал', () => {
  const previous = {
    scannedAt: 1000,
    processes: [
      { pid: 10, cpuNs: 0 },
      { pid: 11, cpuNs: 500e6 },
    ],
  };
  const current = {
    scannedAt: 2000, // прошла ровно секунда
    processes: [
      { pid: 10, cpuNs: 1000e6 }, // потратил секунду CPU за секунду времени
      { pid: 11, cpuNs: 750e6 },  // потратил четверть секунды
      { pid: 12, cpuNs: 900e6 },  // новый процесс — сравнивать не с чем
    ],
  };

  const cpu = computeCpuPercent(previous, current);
  assert.equal(Math.round(cpu.get(10)), 100);
  assert.equal(Math.round(cpu.get(11)), 25);
  assert.equal(cpu.has(12), false, 'новый процесс не получает выдуманное значение');
});

test('переиспользованный номер процесса не даёт всплеска нагрузки', () => {
  // Счётчик пошёл назад — значит под этим номером уже другой процесс.
  // Наивная арифметика дала бы огромное отрицательное или ложное значение.
  const cpu = computeCpuPercent(
    { scannedAt: 1000, processes: [{ pid: 42, cpuNs: 900e6 }] },
    { scannedAt: 2000, processes: [{ pid: 42, cpuNs: 10e6 }] },
  );
  assert.equal(cpu.has(42), false);
});

test('нулевой или обратный интервал не порождает деления на ноль', () => {
  const same = { scannedAt: 1000, processes: [{ pid: 1, cpuNs: 0 }] };
  assert.equal(computeCpuPercent(same, same).size, 0);

  const backwards = computeCpuPercent(
    { scannedAt: 2000, processes: [{ pid: 1, cpuNs: 0 }] },
    { scannedAt: 1000, processes: [{ pid: 1, cpuNs: 100e6 }] },
  );
  assert.equal(backwards.size, 0);
});

test('отсутствующий снимок не роняет расчёт', () => {
  assert.equal(computeCpuPercent(null, null).size, 0);
  assert.equal(computeCpuPercent(undefined, { scannedAt: 1, processes: [] }).size, 0);
});
