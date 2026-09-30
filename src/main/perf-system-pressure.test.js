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
