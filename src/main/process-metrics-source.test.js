'use strict';

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

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
  assert.equal(__offsets.OFFSET_USER_TIME_TICKS, 16);
  assert.equal(__offsets.OFFSET_SYSTEM_TIME_TICKS, 24);
  assert.equal(__offsets.OFFSET_PHYS_FOOTPRINT, 72);
  assert.equal(__offsets.OFFSET_PROC_START_ABSTIME, 80);
  assert.equal(__offsets.OFFSET_SHORT_PPID, 4);
  assert.equal(__offsets.OFFSET_SHORT_PGID, 8);
  assert.equal(__offsets.OFFSET_SHORT_COMM, 16);
  assert.equal(__offsets.OFFSET_SHORT_UID, 36);
});

// Exercise the real source boundary, including the FFI timebase read, without
// native sampling or CPU load. No consumer is given an extra conversion step.
function mockedSource({ numer = 125, denom = 3, rc = 0, timebaseThrows = false } = {}) {
  const row = { userTicks: 18_000_000n, systemTicks: 6_000_000n, startedAtTicks: 18_342_043_085_814n };
  const calls = { timebase: 0, listPids: 0 };
  const warnings = [];
  const nativeFunctions = {
    mach_timebase_info: (buffer) => {
      calls.timebase++;
      if (timebaseThrows) throw new Error('timebase unavailable');
      buffer.writeUInt32LE(numer, 0);
      buffer.writeUInt32LE(denom, 4);
      return rc;
    },
    proc_listpids: (_type, _info, buffer) => { calls.listPids++; buffer.writeInt32LE(42, 0); return 4; },
    proc_pid_rusage: (_pid, flavor, buffer) => {
      assert.equal(flavor, 4);
      buffer.fill(0);
      buffer.writeBigUInt64LE(row.userTicks, 16);
      buffer.writeBigUInt64LE(row.systemTicks, 24);
      buffer.writeBigUInt64LE(4096n, 72);
      buffer.writeBigUInt64LE(row.startedAtTicks, 80);
      return 0;
    },
    proc_pidinfo: (_pid, _flavor, _arg, buffer) => {
      buffer.fill(0);
      buffer.writeUInt32LE(1, 4);
      buffer.writeUInt32LE(42, 8);
      buffer.writeUInt32LE(501, 36);
      return 64;
    },
    proc_pidpath: (_pid, buffer) => { buffer.write('/test/process\0'); return 14; },
    sysctl: () => assert.fail('includeCommandLine:false does not read arguments'),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'process-metrics-source.js'), 'utf8'), {
    module, exports: module.exports, Buffer, Date,
    process: { platform: 'darwin', arch: 'arm64', getuid: () => 501, hrtime: process.hrtime },
    console: { warn: (warning) => warnings.push(warning) },
    require: (name) => name === 'koffi' ? { load: () => ({ func: (declaration) => {
      const symbol = declaration.match(/\b(\w+)\(/)[1];
      assert.ok(nativeFunctions[symbol], symbol);
      return nativeFunctions[symbol];
    } }) } : require(name),
  });
  return { api: module.exports, row, calls, warnings };
}

test('native Mach 125/3 counters become cpuNs once; start identity stays in ticks', () => {
  const { api, row, calls } = mockedSource();
  const first = api.captureNativeSnapshot({ includeCommandLine: false });
  assert.equal(first.ok, true);
  assert.equal(first.processes[0].cpuNs, 1_000_000_000);
  assert.equal(first.processes[0].startedAtTicks, row.startedAtTicks.toString());
  assert.deepEqual({ ...first.cpuTimeNormalization }, {
    sourceUnit: 'mach-ticks', outputUnit: 'nanoseconds', numer: 125, denom: 3,
  });
  row.userTicks += 18_000_000n;
  row.systemTicks += 6_000_000n;
  const second = api.captureNativeSnapshot({ includeCommandLine: false });
  assert.equal(second.processes[0].cpuNs, 2_000_000_000);
  assert.equal(second.processes[0].startedAtTicks, first.processes[0].startedAtTicks);
  assert.equal(computeCpuPercent({ ...first, scannedAt: 1000 }, { ...second, scannedAt: 2000 }).get(42), 100);
  assert.equal(calls.timebase, 1, 'timebase is cached, not queried per PID or snapshot');
});

test('1/1 timebase is honored when returned by the kernel', () => {
  const { api, row } = mockedSource({ numer: 1, denom: 1 });
  const snapshot = api.captureNativeSnapshot({ includeCommandLine: false });
  assert.equal(snapshot.processes[0].cpuNs, Number(row.userTicks + row.systemTicks));
  assert.equal(snapshot.cpuTimeNormalization.numer, 1);
  assert.equal(snapshot.cpuTimeNormalization.denom, 1);
});

test('native conversion sums before division and avoids floating-point/uint64 intermediate overflow', () => {
  const { api, row } = mockedSource();
  row.userTicks = 1n; row.systemTicks = 2n;
  assert.equal(api.captureNativeSnapshot({ includeCommandLine: false }).processes[0].cpuNs, 125);
  row.userTicks = (1n << 64n) - 1n; row.systemTicks = (1n << 63n) + 17n;
  const expected = Number((row.userTicks + row.systemTicks) * 125n / 3n);
  assert.equal(api.captureNativeSnapshot({ includeCommandLine: false }).processes[0].cpuNs, expected);
});

test('failed or invalid timebase makes the source unavailable on ARM; never silently assumes 1/1', () => {
  for (const options of [{ rc: 5 }, { numer: 0 }, { denom: 0 }, { timebaseThrows: true }]) {
    const { api, calls, warnings } = mockedSource(options);
    const snapshot = api.captureNativeSnapshot({ includeCommandLine: false });
    assert.equal(snapshot.ok, false);
    assert.match(snapshot.reason, /timebase/);
    assert.equal(snapshot.processes.length, 0);
    assert.equal(api.loadNative().ok, false);
    assert.equal(calls.timebase, 1);
    assert.equal(calls.listPids, 0, 'unscaled counters must not leave the native boundary');
    assert.equal(warnings.length, 1);
  }
});

test('native cumulative CPU seconds fall inside a passive ps TIME bracket', darwinOnly, async (t) => {
  const native = loadNative();
  if (!native.ok) { t.skip(native.reason); return; }
  const run = promisify(execFile);
  const readTime = async () => {
    const { stdout } = await run('/bin/ps', ['-p', String(process.pid), '-o', 'time=']);
    const raw = stdout.trim();
    assert.match(raw, /^(?:\d+-)?\d+(?::\d+){1,2}\.\d+$/);
    const [days, clock] = raw.includes('-') ? raw.split('-') : ['0', raw];
    return Number(days) * 86400 + clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  };
  const before = await readTime();
  const snapshot = captureNativeSnapshot({ includeCommandLine: false });
  const self = snapshot.processes.find(item => item.pid === process.pid);
  const after = await readTime();
  assert.ok(self);
  // ps formats hundredths of a second; allow rounding at either endpoint.
  assert.ok(self.cpuNs / 1e9 >= before - 0.02, `native=${self.cpuNs / 1e9}s psBefore=${before}s`);
  assert.ok(self.cpuNs / 1e9 <= after + 0.02, `native=${self.cpuNs / 1e9}s psAfter=${after}s`);
  assert.equal(snapshot.cpuTimeNormalization.outputUnit, 'nanoseconds');
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

test('командная строка читается целиком, а не обрезается буфером', darwinOnly, () => {
  // Шрам 12.09: буфер под блок аргументов был 4 КБ, а блок содержит ещё и всё
  // окружение процесса (~5–6 КБ у обычной AI-сессии). `sysctl` обрезал молча,
  // возвращая 0, и разбор упирался в край буфера до первого аргумента: у 368
  // процессов из 902 строка выходила пустой. Панель ресурсов тогда подписывала
  // команду как «node», а сессию Claude — как «2.1.269» (имя каталога версии).
  if (!loadNative().ok) return;

  const snapshot = captureNativeSnapshot();
  const self = snapshot.processes.find(item => item.pid === process.pid);
  assert.ok(self, 'собственный процесс обязан присутствовать');
  assert.ok(self.commandLine.length > 0, 'собственная строка запуска не может быть пустой');
  assert.ok(
    self.commandLine.includes('process-metrics-source.test'),
    'в строке запуска обязан быть аргумент, а не только путь к node: ' + self.commandLine,
  );

  // Пустая строка у отдельного процесса законна (он мог завершиться между
  // перечислением и чтением), но массовая пустота означает обрезание буфера.
  const withArgs = snapshot.processes.filter(item => item.commandLine.length > 0);
  assert.ok(
    withArgs.length > snapshot.processes.length * 0.9,
    'строка запуска должна читаться почти у всех процессов, прочиталась у '
      + withArgs.length + ' из ' + snapshot.processes.length,
  );
});

test('снимок с прогретым кэшем остаётся дешёвым', darwinOnly, () => {
  // Буфер под аргументы теперь до мегабайта, и выделять его заново на каждом
  // замере значило бы обнулять мегабайт каждые пару секунд. Буфер общий, и
  // фоновый опрос обязан оставаться в единицах миллисекунд.
  if (!loadNative().ok) return;

  captureNativeSnapshot();
  const durations = [];
  for (let index = 0; index < 5; index += 1) {
    durations.push(captureNativeSnapshot().durationMs);
  }
  const worst = Math.max(...durations);
  assert.ok(worst < 50, 'замер должен оставаться дешёвым, худший: ' + worst.toFixed(1) + 'мс');
});
