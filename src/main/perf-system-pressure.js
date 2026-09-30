'use strict';

// Read-only OS queries, run by the external watchdog at most every 30 seconds.
// Free RAM is recorded as free RAM, never relabelled "memory pressure".
const { execFile } = require('node:child_process');
const os = require('node:os');
const { performance } = require('node:perf_hooks');

function parseSystemPressure(sysctl, vmstat) {
  const number = (text, expression) => { const match = expression.exec(text); return match ? Number(match[1]) : null; };
  const pageSize = number(vmstat, /page size of (\d+) bytes/);
  const pages = label => number(vmstat, new RegExp('^' + label + ':\\s*(\\d+)\\.', 'm'));
  const bytes = count => count !== null && pageSize !== null ? count * pageSize : null;
  const swap = /vm\.swapusage:.*?used\s*=\s*([\d.]+)([KMGTP])\b/i.exec(sysctl);
  const pressureLevel = number(sysctl, /kern\.memorystatus_vm_pressure_level:\s*(\d+)/);
  return { pressureLevel, pageSize,
    swapUsedBytes: swap ? Number(swap[1]) * 1024 ** ('KMGTP'.indexOf(swap[2].toUpperCase()) + 1) : null,
    swapInBytes: bytes(pages('Swapins')), swapOutBytes: bytes(pages('Swapouts')),
    compressorPhysicalBytes: bytes(pages('Pages occupied by compressor')),
    compressorLogicalBytes: bytes(pages('Pages stored in compressor')),
    pageInBytes: bytes(pages('Pageins')), pageOutBytes: bytes(pages('Pageouts')) };
}

function pressureDelta(previous, current) {
  const elapsedMs = previous ? current.sampledAt - previous.sampledAt : null;
  const result = { elapsedMs, swapInDeltaBytes: null, swapOutDeltaBytes: null,
    pageInDeltaBytes: null, pageOutDeltaBytes: null, resetOrUnavailable: false };
  for (const [source, target] of [['swapInBytes', 'swapInDeltaBytes'], ['swapOutBytes', 'swapOutDeltaBytes'],
    ['pageInBytes', 'pageInDeltaBytes'], ['pageOutBytes', 'pageOutDeltaBytes']]) {
    if (!(elapsedMs > 0) || !Number.isFinite(current[source]) || !Number.isFinite(previous?.[source]) || current[source] < previous[source]) {
      result.resetOrUnavailable = true; continue;
    }
    result[target] = current[source] - previous[source];
  }
  return result;
}

async function collectSystemPressure({ platform = process.platform, run = execFile } = {}) {
  const started = performance.now();
  const base = { sampledAt: Date.now(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    freeMemoryIsPressure: false };
  if (platform !== 'darwin') return { ...base, available: false, reason: 'platform-unsupported' };
  const read = (file, args) => new Promise(resolve => run(file, args, { timeout: 1500, maxBuffer: 65536, encoding: 'utf8' },
    (error, stdout) => resolve({ text: typeof stdout === 'string' ? stdout : '',
      error: error ? (error.killed ? 'timeout' : String(error.code || 'command-failed').slice(0, 30)) : null })));
  const [sysctl, vmstat] = await Promise.all([
    read('/usr/sbin/sysctl', ['vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
    read('/usr/bin/vm_stat', []),
  ]);
  const values = parseSystemPressure(sysctl.text, vmstat.text);
  return { ...base, sampledAt: Date.now(), ...values, available: values.pressureLevel !== null || values.swapUsedBytes !== null,
    partial: !!sysctl.error || !!vmstat.error || values.pressureLevel === null || values.pageSize === null,
    queryErrors: { sysctl: sysctl.error, vmstat: vmstat.error },
    probeMs: +(performance.now() - started).toFixed(1),
    interpretation: 'pressureLevel=OS-raw; pagein-is-not-swap; compressed-logical-is-not-extra-physical-RAM' };
}

module.exports = { collectSystemPressure, parseSystemPressure, pressureDelta };
