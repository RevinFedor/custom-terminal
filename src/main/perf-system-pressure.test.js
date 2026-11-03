'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSystemPressure, pressureDelta, collectSystemPressure } = require('./perf-system-pressure');
const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 2.\nSwapouts: 5.\nPageins: 20.\nPageouts: 4.\nPages occupied by compressor: 100.\nPages stored in compressor: 400.\n';
test('free RAM, compression, page I/O and swap are distinct measurements; zero swap remains a real zero', () => {
  const value = parseSystemPressure('vm.swapusage: total = 0.00M used = 0.00M free = 0.00M\nkern.memorystatus_vm_pressure_level: 1', vm);
  assert.equal(value.swapUsedBytes, 0); assert.equal(value.pressureLevel, 1);
  assert.equal(value.swapInBytes, 32768); assert.equal(value.pageInBytes, 327680);
  assert.equal(value.compressorPhysicalBytes, 1638400); assert.equal(value.compressorLogicalBytes, 6553600);
});
test('missing counters or reboot do not fabricate a zero or negative paging rate', () => {
  const first = { ...parseSystemPressure('', vm), sampledAt: 1000 };
  const reset = { ...first, swapInBytes: 0, sampledAt: 2000 };
  assert.equal(pressureDelta(first, reset).swapInDeltaBytes, null);
  assert.equal(pressureDelta(first, reset).resetOrUnavailable, true);
  assert.equal(pressureDelta(null, first).swapOutDeltaBytes, null);
  assert.equal(pressureDelta({ sampledAt: 500, available: false }, first).swapInDeltaBytes, null);
});
test('partial OS query failures preserve independently measured values and explicit unavailable fields', async () => {
  const run = (file, _args, options, done) => {
    assert.equal(options.timeout, 1500);
    if (file.endsWith('sysctl')) done(Object.assign(new Error('private stderr'), { code: 1 }), 'vm.swapusage: used = 1.50G');
    else done(null, vm);
  };
  const value = await collectSystemPressure({ platform: 'darwin', run });
  assert.equal(value.partial, true); assert.equal(value.pressureLevel, null);
  assert.equal(value.swapUsedBytes, 1.5 * 1024 ** 3); assert.equal(value.freeMemoryIsPressure, false);
  assert.ok(!JSON.stringify(value).includes('private stderr'));
});

test('available RAM counts reclaimable pages, not only fully free ones', () => {
  // Шрам 02.11: по `os.freemem()` причиной пользовательских лагов трижды была
  // объявлена нехватка памяти — 154/130/167МБ «свободно». В тот же момент
  // free+inactive+speculative давало 11.7ГБ: разница в 14 раз, вывод неверный,
  // настоящая причина зависаний скрыта.
  //
  // macOS держит почти всю память занятой намеренно; `inactive` отдаётся
  // приложению по первому требованию. Решение «мало памяти» принимается по
  // availableMemoryBytes, а не по freeMemoryBytes.
  const stat = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\n'
    + 'Pages free: 1000.\nPages active: 500000.\nPages inactive: 400000.\nPages speculative: 2000.\n'
    + 'Swapins: 0.\nSwapouts: 0.\nPageins: 0.\nPageouts: 0.\n';
  const value = parseSystemPressure('kern.memorystatus_vm_pressure_level: 1', stat);
  assert.equal(value.availableMemoryBytes, (1000 + 400000 + 2000) * 16384);
  assert.ok(value.availableMemoryBytes > 6 * 1024 ** 3,
    'почти свободная система не должна выглядеть как 16МБ свободных');
  assert.match(value.availableMemoryBasis, /inactive/,
    'состав числа назван явно, иначе его снова прочитают как os.freemem()');
});

test('available RAM stays null when vm_stat does not provide the pages', () => {
  // Недостающее измерение нельзя подменять нулём: ноль читается как
  // «памяти нет» и возвращает ровно тот ложный вывод, от которого защищаемся.
  const value = parseSystemPressure('', 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPageins: 1.\n');
  assert.equal(value.availableMemoryBytes, null);
});

test('speculative pages are optional, free+inactive is enough', () => {
  // На части систем строки speculative нет. Её отсутствие не должно обнулять
  // всё число.
  const stat = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\n'
    + 'Pages free: 100.\nPages inactive: 900.\n';
  assert.equal(parseSystemPressure('', stat).availableMemoryBytes, 1000 * 4096);
});

test('both numbers are reported, the old field keeps its meaning', async () => {
  // Прежние потребители читают freeMemoryBytes; менять его значение нельзя,
  // иначе сравнение с историческими логами перестанет работать.
  const value = await collectSystemPressure({ platform: 'darwin',
    run: (file, args, options, callback) => callback(null,
      file.endsWith('vm_stat')
        ? 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\n'
        : 'kern.memorystatus_vm_pressure_level: 1\n') });
  assert.equal(typeof value.freeMemoryBytes, 'number', 'прежнее поле на месте');
  assert.equal(value.availableMemoryBytes, 30 * 16384, 'и новое рядом');
  assert.notEqual(value.freeMemoryBytes, value.availableMemoryBytes,
    'это РАЗНЫЕ измерения, а не переименование');
});
