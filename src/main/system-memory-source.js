'use strict';

// Read-only kernel counters, only for an open whole-PC view. No subprocesses.
// ABI checked with the SDK compiler: vm_statistics64 size248/count62,
// compressor_page_count offset128; xsw_usage size32/xsu_used offset16.
let native = null;
function load() {
  if (native) return native;
  if (process.platform !== 'darwin') return (native = { error: 'platform-unsupported' });
  try {
    const lib = require('koffi').load('/usr/lib/libSystem.B.dylib');
    const hostSelf = lib.func('uint32_t mach_host_self()');
    native = {
      sysctl: lib.func('int sysctlbyname(const char *name, _Out_ uint8_t *data, _Inout_ size_t *length, void *newp, size_t newlen)'),
      vm: lib.func('int host_statistics64(uint32_t host, int flavor, _Out_ uint8_t *data, _Inout_ uint8_t *count)'),
      host: hostSelf(),
    };
  } catch (e) { native = { error: 'native-init-failed' }; }
  return native;
}

function decodeSystemMemory({ total, pageSize, pressure, swap, vm, vmOk }) {
  return {
    available: total !== null,
    totalBytes: total,
    pressureLevel: pressure,
    swapUsedBytes: swap?.length >= 24 ? Number(swap.readBigUInt64LE(16)) : null,
    compressedBytes: vmOk && vm?.length >= 136 && pageSize
      ? Number(vm.readBigUInt64LE(128)) * pageSize : null,
  };
}

function captureSystemMemory() {
  const n = load();
  if (n.error) return { available: false, reason: n.error };
  const read = (name, size) => {
    const value = Buffer.alloc(size), length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(size));
    if (n.sysctl(name, value, length, null, 0) !== 0) return null;
    return value.subarray(0, Number(length.readBigUInt64LE()));
  };
  try {
    const total = read('hw.memsize', 8), pageSize = read('hw.pagesize', 8);
    const pressure = read('kern.memorystatus_vm_pressure_level', 4);
    const swap = read('vm.swapusage', 32), vm = Buffer.alloc(248), count = Buffer.alloc(4);
    count.writeUInt32LE(62);
    const vmOk = n.vm(n.host, 4, vm, count) === 0 && count.readUInt32LE() >= 34;
    return decodeSystemMemory({
      total: total?.length >= 8 ? Number(total.readBigUInt64LE()) : null,
      pageSize: pageSize?.length >= 4 ? pageSize.readUInt32LE() : null,
      pressure: pressure?.length >= 4 ? pressure.readUInt32LE() : null,
      swap, vm, vmOk,
    });
  } catch { return { available: false, reason: 'kernel-read-failed' }; }
}

module.exports = { captureSystemMemory, decodeSystemMemory };
