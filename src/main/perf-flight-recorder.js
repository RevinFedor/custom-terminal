'use strict';

// Runs in the external watchdog, never in a UI/IPC handler. No command-line
// arguments, terminal text, DOM, network payloads or executable paths are saved.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { captureNativeSnapshot } = require('./process-metrics-source');
const { collectSystemPressure, pressureDelta } = require('./perf-system-pressure');

const DAY = 86400000;
// Cheap CPU checkpoints may help compare days; detailed gesture/span/stack
// evidence only needs the last day. Both remain inside the SAME disk cap.
const RETENTION_MS = 7 * DAY;
const DETAIL_RETENTION_MS = DAY;
const DISK_CAP = 5 * 1024 * 1024 * 1024;
const HEAVY_RETENTION_MS = DAY;
const HEAVY_BYTES = 8 * 1024 * 1024;
// These are protected shares, not smaller deletion caps. Ordinary evidence can
// use the whole shared budget until age or total disk pressure requires pruning.
const CAUSAL_PROTECTED_BYTES = 64 * 1024 * 1024;
const NATIVE_SAMPLE_PROTECTED_BYTES = 64 * 1024 * 1024;
const PAYLOAD_CAP = 4 * 1024 * 1024;
const CAUSAL_NORMAL_BYTES = 2 * 1024 * 1024;
const RETENTION_LEDGER = 'retention-ledger.json';
const LEDGER_BYTES = 16384;
const LEDGER_ENTRIES = 32;
const OWN_FILE = /^(?:(?:cpu|causal)-\d{10}\.ndjson|stall-\d+-\d+-\d+\.(?:sample\.txt|sample\.json|sample-capture\.json)|incident-\d+-\d+(?:\.json|\.sample\.txt|\.main\.cpuprofile|\.cpuprofile|\.trace\.json|\.profile\.json|\.capture\.json|\.ui\.json))$/;
const NATIVE_RECEIPT = /^stall-(\d+)-\d+-\d+\.sample-capture\.json$/;
const NATIVE_SAMPLE = /^stall-\d+-\d+-\d+\.sample\.txt$/;
const HEAVY_RECEIPT = /^incident-\d+-\d+\.capture\.json$/;
const HEAVY_PROFILE = /\.(?:cpuprofile|trace\.json)$/;
const round = (n) => Math.round(n * 10) / 10;
const monoNow = () => performance.now();

function captureDecision(recent, now, kind = 'unknown', detail = {}) {
  const background = kind === 'sustained-cpu';
  const group = background ? 'background' : 'responsiveness';
  if (background && Number.isFinite(detail.appCpu) && detail.appCpu < 80
    && Number.isFinite(detail.appChildCpu) && detail.appChildCpu < 80 && detail.systemBusy >= 90) {
    return { allowed: false, reason: 'system-pressure-no-electron-hotspot', remaining: Math.max(0, 4 - recent.length), group };
  }
  if (recent.length >= 4) return { allowed: false, reason: 'rolling-quota-exhausted',
    nextEligibleWallMs: Math.min(...recent.map(e => e.at)) + DAY, remaining: 0, group };
  const ownGroup = recent.filter(e => e.group === group || !e.group);
  // The same four captures/day, with two slots unavailable to recurring
  // ambient CPU. It previously consumed all four before the user's click.
  if (background && ownGroup.length >= 2) return { allowed: false, reason: 'reserved-for-responsiveness',
    nextEligibleWallMs: Math.min(...ownGroup.map(e => e.at)) + DAY, remaining: 4 - recent.length, group };
  const last = ownGroup.length ? Math.max(...ownGroup.map(e => e.at)) : -Infinity;
  if (now - last < 600000) return { allowed: false, reason: 'capture-group-cooldown',
    nextEligibleWallMs: last + 600000, remaining: 4 - recent.length, group };
  return { allowed: true, reason: 'reserved', nextEligibleWallMs: now, remaining: 3 - recent.length, group };
}

function cpuFrame(before, after, elapsedMs, appPids, tabs, mainPid) {
  const previous = new Map((before?.processes || []).map(p => [p.pid, p]));
  const current = new Map((after.processes || []).map(p => [p.pid, p]));
  const direct = new Map(appPids.map(p => [p.pid, p.type]));
  direct.set(mainPid, 'Browser');
  const tabPids = new Map(tabs.map(t => [t.pid, t.tabId]));
  const rows = [];
  for (const p of current.values()) {
    const old = previous.get(p.pid);
    if (!old || old.startedAtTicks !== p.startedAtTicks || p.cpuNs < old.cpuNs || !(elapsedMs > 0)) continue;
    let owner = direct.has(p.pid) ? 'app' : 'external';
    let tabId = null;
    const seen = new Set();
    for (let parent = p; parent && !seen.has(parent.pid); parent = current.get(parent.ppid)) {
      seen.add(parent.pid);
      if (tabPids.has(parent.pid)) { owner = 'tab'; tabId = tabPids.get(parent.pid); break; }
      if (parent.pid === mainPid) { if (owner !== 'app') owner = 'app-child'; break; }
    }
    rows.push({ pid: p.pid, ppid: p.ppid, identity: p.startedAtTicks,
      name: String(p.name || 'unknown').slice(0, 80), type: direct.get(p.pid) || null,
      owner, tabId, cpu: round((p.cpuNs - old.cpuNs) / (elapsedMs * 1e4)),
      footprintMiB: round(p.footprintBytes / 1048576) });
  }
  rows.sort((a, b) => b.cpu - a.cpu);
  return { measured: rows.length, appCpu: round(rows.filter(p => p.owner === 'app').reduce((n, p) => n + p.cpu, 0)),
    appChildCpu: round(rows.filter(p => p.owner === 'app-child').reduce((n, p) => n + p.cpu, 0)),
    externalCpu: round(rows.filter(p => p.owner === 'external').reduce((n, p) => n + p.cpu, 0)),
    ...(after.cpuTimeNormalization ? { cpuTimeNormalization: after.cpuTimeNormalization } : {}),
    tabCpu: round(rows.filter(p => p.owner === 'tab').reduce((n, p) => n + p.cpu, 0)),
    // Keep every Electron process and the top external/tab processes. Missing
    // inaccessible/system/short-lived processes are NOT inferred to be idle.
    rows: [...rows.filter(p => p.owner === 'app').slice(0, 12), ...rows.filter(p => p.owner !== 'app').slice(0, 12)] };
}

function systemCpu(before, after) {
  if (!before || before.length !== after.length) return null;
  let idle = 0, total = 0;
  for (let i = 0; i < after.length; i++) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = after[i].times[key] - before[i].times[key];
      if (delta < 0) return null;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  return total > 0 ? round(100 * (1 - idle / total)) : null;
}

// Preserve a WHOLE checkpoint window, not a single instantaneous value every
// 30 seconds. A short CPU burst in between checkpoints remains represented.
function summarizeFrames(frames) {
  if (!frames.length) return null;
  const systemValues = frames.map(f => f.systemBusy).filter(Number.isFinite);
  const byIdentity = new Map();
  for (const f of frames) for (const p of f.rows) {
    const key = p.pid + ':' + p.identity;
    const acc = byIdentity.get(key) || { ...p, sum: 0, ms: 0, peak: 0 };
    acc.sum += p.cpu * f.elapsedMs; acc.ms += f.elapsedMs; acc.peak = Math.max(acc.peak, p.cpu);
    byIdentity.set(key, acc);
  }
  const ownerGroups = {};
  for (const key of ['appCpu', 'appChildCpu', 'tabCpu', 'externalCpu']) {
    const known = frames.filter(frame => Number.isFinite(frame[key]));
    const duration = known.reduce((sum, frame) => sum + frame.elapsedMs, 0);
    ownerGroups[key] = known.length ? { meanCpu: round(known.reduce((sum, frame) => sum + frame[key] * frame.elapsedMs, 0) / duration),
      peakCpu: Math.max(...known.map(frame => frame[key])), observedMs: duration } : null;
  }
  return { from: frames[0].wallMs - frames[0].elapsedMs, to: frames.at(-1).wallMs,
    cores: frames.at(-1).cores ?? null, ownerGroups, systemPressure: frames.at(-1).systemPressure ?? null,
    ...(frames.at(-1).cpuTimeNormalization ? { cpuTimeNormalization: frames.at(-1).cpuTimeNormalization } : {}),
    samples: frames.length, systemPeak: systemValues.length ? Math.max(...systemValues) : null,
    appPeak: Math.max(...frames.map(f => f.appCpu)), maxProbeMs: Math.max(...frames.map(f => f.probeMs)),
    maxObserverGapMs: Math.max(...frames.map(f => f.observerGapMs)),
    // Average is over observed intervals for this identity, not a fabricated
    // zero for periods when it was outside the top list or not alive.
    rows: [...byIdentity.values()].sort((a, b) => b.peak - a.peak).slice(0, 24)
      .map(({ sum, ms, peak, cpu, ...p }) => ({ ...p, observedMs: round(ms), meanCpu: round(sum / ms), peakCpu: peak })) };
}

function createArtifactStore(directory, { log = () => {} } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = name => {
    if (name !== RETENTION_LEDGER && !OWN_FILE.test(name)) throw new Error('invalid perf artifact name');
    return path.join(directory, name);
  };
  const entries = () => fs.readdirSync(directory).filter(n => OWN_FILE.test(n)).flatMap(name => {
    try {
      const stat = fs.lstatSync(file(name));
      return stat.isFile() && !stat.isSymbolicLink()
        ? [{ name, size: stat.size, at: stat.mtimeMs, dev: stat.dev, ino: stat.ino }] : [];
    } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  });
  const read = (name, maxBytes = 16384) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PAYLOAD_CAP) throw new Error('invalid perf read bound');
    const fd = fs.openSync(file(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('invalid perf artifact read');
      const buffer = Buffer.alloc(maxBytes + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > maxBytes) throw new Error('perf artifact grew beyond read bound');
      return buffer.toString('utf8', 0, size);
    } finally { fs.closeSync(fd); }
  };
  // Used by the sampler for a bounded stream. O_EXCL also rejects an existing
  // symlink, and prevents a restart/sequence collision from replacing evidence.
  const openExclusive = name => fs.openSync(file(name), fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  const writeExclusive = (name, data) => {
    const bytes = typeof data === 'string' ? data : JSON.stringify(data);
    if (Buffer.byteLength(bytes) > 16384) throw new Error('perf receipt payload too large');
    const fd = openExclusive(name);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // File contents AND its new directory entry precede permission to spawn.
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  };
  const write = (name, data, append = false) => {
    const bytes = typeof data === 'string' ? data : JSON.stringify(data);
    const size = Buffer.byteLength(bytes);
    if (size > (name === RETENTION_LEDGER ? LEDGER_BYTES : PAYLOAD_CAP)) throw new Error('perf artifact payload too large');
    const causal = name.startsWith('causal-');
    const fd = fs.openSync(file(name), (append ? fs.constants.O_APPEND : 0) |
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      const stat = fs.fstatSync(fd), current = fs.lstatSync(file(name));
      if (!stat.isFile() || stat.nlink !== 1 || !current.isFile() || current.isSymbolicLink()
        || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('invalid perf artifact write');
      // An active hour must not grow forever while exempt from age-based
      // pruning. Parent records this explicit loss; never silently trim NDJSON.
      if (causal && (append ? stat.size : 0) + size > PAYLOAD_CAP) throw new Error('causal artifact bucket full');
      if (!append) fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, bytes);
      if (name === RETENTION_LEDGER) fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  // One global file per hour, across all source PIDs/boots. Ordinary writes
  // stop at the lower watermark; essential evidence can consume the reserved
  // remainder. Check the actual inode size, so a new store has the same quota.
  // Maintenance is deliberately NOT part of an append's persistence result.
  const writeCausal = (name, text, { essential = false } = {}) => {
    if (!/^causal-\d{10}\.ndjson$/.test(name) || typeof text !== 'string' || !text.endsWith('\n')) {
      throw new Error('invalid causal append');
    }
    const size = Buffer.byteLength(text);
    const ceiling = essential ? PAYLOAD_CAP : CAUSAL_NORMAL_BYTES;
    const bucketFull = () => Object.assign(new Error('causal artifact bucket full'),
      { code: essential ? 'CAUSAL_TOTAL_BUCKET_FULL' : 'CAUSAL_NORMAL_BUCKET_FULL' });
    if (size > ceiling) throw bucketFull();
    const fd = fs.openSync(file(name), fs.constants.O_APPEND | fs.constants.O_CREAT |
      fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    let receipt;
    try {
      const stat = fs.fstatSync(fd), current = fs.lstatSync(file(name));
      if (!stat.isFile() || stat.nlink !== 1 || !current.isFile() || current.isSymbolicLink()
        || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('invalid causal artifact inode');
      if (stat.size + size > ceiling) throw bucketFull();
      // A failed append AND failed rollback may have left an undecodable tail.
      // Check this same guarded inode on every append, including after restart;
      // never ACK a new record concatenated onto ambiguous previous bytes.
      if (stat.size > 0) {
        const tail = Buffer.alloc(1);
        if (fs.readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10) {
          throw Object.assign(new Error('causal artifact has incomplete tail'), { code: 'CAUSAL_TORN_BUCKET' });
        }
      }
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
        if (stat.size === 0) {
          const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
          try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
        }
        const after = fs.lstatSync(file(name));
        if (!after.isFile() || after.nlink !== 1 || after.dev !== stat.dev || after.ino !== stat.ino
          || after.size !== stat.size + size) throw new Error('causal artifact changed during append');
      } catch (error) {
        // A failed partial append must not leave a torn NDJSON line in front
        // of the next retry. This fd is our checked, single-link inode.
        try { fs.ftruncateSync(fd, stat.size); fs.fsyncSync(fd); } catch {}
        throw error;
      }
      receipt = { name, appended: true, bytes: size, fromBytes: stat.size,
        toBytes: stat.size + size, essential: !!essential };
    } finally { fs.closeSync(fd); }
    return receipt;
  };
  function retentionLedger() {
    try {
      const value = JSON.parse(read(RETENTION_LEDGER, LEDGER_BYTES));
      if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > LEDGER_ENTRIES
        || !Number.isSafeInteger(value.omitted) || value.omitted < 0) throw new Error('invalid retention ledger');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, entries: [], omitted: 0 };
      throw error;
    }
  }
  function prune(now = Date.now()) {
      const all = entries().sort((a, b) => a.at - b.at);
      const ledger = retentionLedger();
      let ledgerSize = 0;
      try { ledgerSize = fs.lstatSync(file(RETENTION_LEDGER)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let bytes = all.reduce((sum, e) => sum + e.size, 0) + ledgerSize;
      // Reserve the ledger's maximum growth inside the SAME five GiB cap.
      const pruneCap = DISK_CAP - (LEDGER_BYTES - ledgerSize);
      let causalBytes = all.filter(e => e.name.startsWith('causal-')).reduce((sum, e) => sum + e.size, 0);
      let nativeSampleBytes = all.filter(e => NATIVE_SAMPLE.test(e.name)).reduce((sum, e) => sum + e.size, 0);
      let removed = 0, removedNative = 0, removedExpired = 0, removedHeavyExpired = 0, removedBudget = 0;
      const nativeAt = e => Math.max(e.at, Number(NATIVE_RECEIPT.exec(e.name)?.[1]) || 0);
      const heavy = e => HEAVY_PROFILE.test(e.name) || e.size >= HEAVY_BYTES;
      const retention = e => heavy(e) ? HEAVY_RETENTION_MS
        : e.name.startsWith('cpu-') ? RETENTION_MS : DETAIL_RETENTION_MS;
      const expired = e => now - (NATIVE_RECEIPT.test(e.name) ? nativeAt(e) : e.at) >= retention(e);
      // Heavy profiles remain lower-priority than historical CPU evidence.
      // Independent native stacks have their own bounded tier; old metadata
      // must make room instead of immediately destroying their diagnostic value.
      const ordered = [
        ...all.filter(expired),
        ...all.filter(e => !expired(e) && heavy(e)),
        ...all.filter(e => !expired(e) && !heavy(e)),
      ];
      try { for (const e of ordered) {
        const causal = e.name.startsWith('causal-');
        const nativeSample = NATIVE_SAMPLE.test(e.name);
        // Native and heavy receipts are independent, small, and non-evictable
        // during their quota window, even if their large artifacts are gone.
        if (NATIVE_RECEIPT.test(e.name) && !expired(e)) continue;
        if (HEAVY_RECEIPT.test(e.name) && now - e.at < DAY) continue;
        if (!causal && now - e.at < 120000) continue;
        if (!expired(e) && bytes <= pruneCap) continue;
        if (nativeSample && !expired(e) && e.size <= DISK_CAP && nativeSampleBytes - e.size < NATIVE_SAMPLE_PROTECTED_BYTES) continue;
        if (causal && !expired(e) && e.size <= DISK_CAP && causalBytes - e.size < CAUSAL_PROTECTED_BYTES) continue;
        try {
          const current = fs.lstatSync(file(e.name));
          if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== e.ino || current.dev !== e.dev ||
            current.mtimeMs !== e.at || current.size !== e.size) continue;
          fs.unlinkSync(file(e.name)); bytes -= e.size;
          removed++;
          const removalReason = expired(e)
            ? heavy(e) ? 'heavy-retention-expired' : 'retention-expired' : 'artifact-budget';
          const sourceHour = /^(?:causal|cpu)-(\d{10})\.ndjson$/.exec(e.name)?.[1]
            || new Date(e.at).toISOString().slice(0, 13).replace(/\D/g, '');
          ledger.entries.push({ file: e.name, sourceHour, bytes: e.size, reason: removalReason, removedAt: now });
          while (ledger.entries.length > LEDGER_ENTRIES || Buffer.byteLength(JSON.stringify(ledger)) > LEDGER_BYTES) {
            ledger.entries.shift(); ledger.omitted = Math.min(Number.MAX_SAFE_INTEGER, ledger.omitted + 1);
          }
          if (removalReason === 'heavy-retention-expired') removedHeavyExpired++;
          else if (removalReason === 'retention-expired') removedExpired++;
          else removedBudget++;
          if (causal) causalBytes -= e.size;
          if (nativeSample) {
            nativeSampleBytes -= e.size; removedNative++;
            // Capture completion and later retention are separate facts.
            // Keep the quota receipt untouched, and explain a removed payload.
            try {
              const metadataName = e.name.replace(/\.txt$/, '.json');
              const metadata = JSON.parse(read(metadataName));
              if (metadata?.id + '.sample.txt' === e.name && metadata.output?.file === e.name) {
                const before = fs.statSync(file(metadataName)).size;
                metadata.output.retained = false;
                metadata.output.removedAt = now;
                metadata.output.removalReason = removalReason;
                write(metadataName, metadata);
                bytes += fs.statSync(file(metadataName)).size - before;
              }
            } catch { /* A missing/unreadable metadata file cannot block pruning. */ }
          }
          if (HEAVY_PROFILE.test(e.name) || /^incident-\d+-\d+\.sample\.txt$/.test(e.name)) {
            try {
              const metadataName = e.name.replace(/\.(?:main\.cpuprofile|cpuprofile|trace\.json|sample\.txt)$/, '.profile.json');
              const metadata = JSON.parse(read(metadataName, 65536));
              if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
                const before = fs.statSync(file(metadataName)).size;
                metadata.artifactRetention ||= {};
                metadata.artifactRetention[e.name] = { retained: false, removedAt: now, removalReason };
                write(metadataName, metadata);
                bytes += fs.statSync(file(metadataName)).size - before;
              }
            } catch { /* Legacy/missing metadata cannot prevent bounded pruning. */ }
          }
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
      } } finally {
        // A later unlink failure must not hide earlier successful removals.
        if (removed) {
          write(RETENTION_LEDGER, ledger);
          bytes += Buffer.byteLength(JSON.stringify(ledger)) - ledgerSize;
        }
      }
      if (removed) try { log('[Perf:ArtifactPrune] removed=' + removed + ' native=' + removedNative
        + ' retentionExpired=' + removedExpired + ' heavyExpired=' + removedHeavyExpired + ' budgetEvicted=' + removedBudget
        + ' lightRetentionHours=168 detailRetentionHours=24'
        + ' bytes=' + bytes + ' nativeBytes=' + nativeSampleBytes + ' causalBytes=' + causalBytes); } catch {}
      return { bytes, causalBytes, nativeSampleBytes };
  }
  return { directory, file, write, writeCausal, entries, read, openExclusive, writeExclusive, prune, retentionLedger,
    reserveCaptureDetails(id, now = Date.now(), kind = 'unknown', detail = {}) {
      const recent = entries().filter(e => HEAVY_RECEIPT.test(e.name) && now - e.at < DAY).map(e => {
        try { return { ...e, group: JSON.parse(read(e.name)).group }; }
        catch { return e; } // Legacy/unreadable receipt still consumes its slot.
      });
      const decision = captureDecision(recent, now, kind, detail);
      if (decision.allowed) write(id + '.capture.json', { requestedAt: now, kind, group: decision.group });
      return decision;
    },
    reserveCapture(id, now = Date.now(), kind = 'unknown') {
      return this.reserveCaptureDetails(id, now, kind).allowed;
    },
  };
}

function createFlightRecorder({ directory, mainPid, log, requestCapture, context, snapshot = captureNativeSnapshot,
  pressure = collectSystemPressure }) {
  const artifacts = createArtifactStore(directory, { log });
  artifacts.prune();
  let previous = null, previousCpus = null, previousAt = monoNow();
  const startedAt = previousAt;
  let ring = [], checkpoint = [], active = null;
  let lastCheckpoint = previousAt, lastIncident = -Infinity, lastPrune = previousAt;
  let hotSince = null, timer = null, stopped = false, consecutiveFailures = 0;
  let lastWriteErrorAt = -Infinity;
  let pressureSample = null, pressurePending = false, lastPressureAt = -Infinity;
  const decisionReports = new Map();
  function logDecision(kind, detail, decision) {
    const key = kind + ':' + decision.reason;
    const previous = decisionReports.get(key);
    const now = monoNow();
    if (previous && now - previous.at < 10000 && !decision.allowed) { previous.omitted++; return; }
    log('[Perf:CaptureDecision] ' + JSON.stringify({ kind, actionId: detail.actionId || null,
      ...decision, omittedRepeats: previous?.omitted || 0 }));
    decisionReports.set(key, { at: now, omitted: 0 });
    if (decisionReports.size > 32) decisionReports.delete(decisionReports.keys().next().value);
  }
  function maybeCapture(kind, detail) {
    const decision = monoNow() - startedAt < 60000
      ? { allowed: false, reason: 'startup-warmup', nextEligibleWallMs: Date.now() + 60000 - (monoNow() - startedAt) }
      : artifacts.reserveCaptureDetails(active.id, Date.now(), kind, detail);
    active.capture = { requested: decision.allowed, skipReason: decision.allowed ? null : decision.reason, ...decision };
    logDecision(kind, detail, decision); persist();
    if (decision.allowed) requestCapture({ id: active.id, requestedWallMs: Date.now(), kind, ...detail });
    return decision.allowed;
  }
  function persist() {
    try {
      if(active) {
        // Existing incident/stop persistence retains the latest receiver view,
        // including SQL entered after the incident began. Other context stays
        // pinned to the incident edge. No extra timer, capture or disk quota.
        try { const latest=context();if(latest?.causal)active.context={...active.context,causal:latest.causal}; } catch {}
        artifacts.write(active.id + '.json', active);
      }
    }
    catch (err) {
      if (monoNow() - lastWriteErrorAt > 30000) {
        lastWriteErrorAt = monoNow(); log('[Perf:Incident] write-failed error=' + String(err.message).slice(0, 160));
      }
    }
  }
  function incident(kind, detail = {}) {
    try { return beginIncident(kind, detail); }
    catch (err) { log('[Perf:Incident] unavailable error=' + String(err.message).slice(0, 160)); return null; }
  }
  function beginIncident(kind, detail) {
    const now = monoNow();
    if (active) {
      if (active.events.length < 24) active.events.push({ kind, ...detail, observedWallMs: Date.now() });
      else active.omittedEvents = (active.omittedEvents || 0) + 1;
      if (!active.capture?.requested && kind !== 'sustained-cpu') maybeCapture(kind, detail);
      else logDecision(kind, detail, { allowed: false, reason: 'merged-into-active-incident', incident: active.id });
      return null;
    }
    const incidentCooldown = kind === 'sustained-cpu' ? 600000 : 30000;
    if (now - lastIncident < incidentCooldown) {
      logDecision(kind, detail, { allowed: false, reason: 'incident-window-cooldown',
        nextEligibleWallMs: Date.now() + incidentCooldown - (now - lastIncident) });
      return null;
    }
    lastIncident = now;
    const id = 'incident-' + Date.now() + '-' + process.pid;
    active = { id, version: 1, startedWallMs: Date.now(), endsMono: now + 20000,
      coverage: 'current-user-processes; CPU100=one-core; systemBusy100=all-cores',
      complete: false, frames: ring.slice(-30), events: [{ kind, ...detail, observedWallMs: Date.now() }], context: context() };
    persist(); // survive a later kill without waiting for the post-window
    const heavy = maybeCapture(kind, detail);
    log('[Perf:Incident] id=' + id + ' kind=' + kind + ' capture=' + Number(heavy) +
      ' captureSkip=' + (active.capture.skipReason || 'none') + ' file=' + artifacts.file(id + '.json'));
    return heavy ? id : null;
  }
  function tick() {
    if (stopped) return;
    const start = monoNow(), elapsedMs = start - previousAt;
    let delayMs = 2000;
    try {
      if (!pressurePending && start - lastPressureAt >= 30000) {
        pressurePending = true; lastPressureAt = start;
        Promise.resolve().then(() => pressure()).then(sample => {
          if (stopped) return;
          const delta = pressureDelta(pressureSample, sample);
          pressureSample = { ...sample, delta };
          log('[Perf:SystemPressure] ' + JSON.stringify(pressureSample));
        }).catch(() => {
          pressureSample = { sampledAt: Date.now(), available: false, reason: 'pressure-query-failed' };
          log('[Perf:SystemPressure] ' + JSON.stringify(pressureSample));
        }).finally(() => { pressurePending = false; });
      }
      const nowCpus = os.cpus();
      const now = snapshot({ includeCommandLine: false });
      if (!now.ok) throw new Error(now.reason || 'native snapshot failed');
      const ctx = context();
      if (previous && elapsedMs > 0 && elapsedMs < 10000) {
        const cpu = cpuFrame(previous, now, elapsedMs, ctx.appPids || [], ctx.tabs || [], mainPid);
        const frame = { ...cpu, wallMs: Date.now(), absMs: performance.timeOrigin + start, monoMs: start, elapsedMs: round(elapsedMs),
          systemBusy: systemCpu(previousCpus, nowCpus), cores: nowCpus.length, loadAvg: os.loadavg(),
          systemPressure: pressureSample ? { ...pressureSample, ageMs: Date.now() - pressureSample.sampledAt } : { available: false, reason: 'pending-first-sample' },
          probeMs: round(monoNow() - start), observerGapMs: round(Math.max(0, elapsedMs - 2000)),
          inaccessible: now.skipped, contextAgeMs: ctx.contextAgeMs };
        ring.push(frame); if (ring.length > 30) ring.shift();
        checkpoint.push(frame);
        if (checkpoint.length > 60) checkpoint.shift(); // bounded even on disk-full/write failures
        if (active) { active.frames.push(frame); if (active.frames.length > 45) active.frames.shift(); persist(); }
        const hot = frame.appCpu >= 80 || (frame.systemBusy !== null && frame.systemBusy >= 90);
        hotSince = hot ? (hotSince ?? start) : null;
        if (hotSince !== null && start - hotSince >= 6000) incident('sustained-cpu', {
          pid: frame.rows.find(p => p.owner === 'app')?.pid,
          appCpu: frame.appCpu, appChildCpu: frame.appChildCpu, tabCpu: frame.tabCpu,
          externalCpu: frame.externalCpu, systemBusy: frame.systemBusy });
      } else if (previous) {
        log('[Perf:CpuWindow] coverage-gap elapsedMs=' + round(elapsedMs) + ' reason=observer-delayed-or-sleep');
        hotSince = null;
      }
      previous = now; previousCpus = nowCpus; previousAt = start;
      if (active && start >= active.endsMono) {
        active.complete = true; active.completedWallMs = Date.now(); persist(); active = null;
      }
      if (start - lastCheckpoint >= 30000) {
        const summary = summarizeFrames(checkpoint);
        if (summary) {
          const bucket = 'cpu-' + new Date().toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
          artifacts.write(bucket, JSON.stringify(summary) + '\n', true);
          log('[Perf:CpuWindow] from=' + summary.from + ' to=' + summary.to + ' appPeak=' + summary.appPeak +
            ' ownerGroups=' + JSON.stringify(summary.ownerGroups) + ' cores=' + summary.cores +
            ' systemPeak=' + summary.systemPeak + ' probeMaxMs=' + summary.maxProbeMs +
            (summary.cpuTimeNormalization ? ' cpuUnit=' + summary.cpuTimeNormalization.outputUnit +
              ' timebase=' + summary.cpuTimeNormalization.numer + '/' + summary.cpuTimeNormalization.denom : '') +
            ' file=' + artifacts.file(bucket));
        }
        checkpoint = []; lastCheckpoint = start;
      }
      if (start - lastPrune > 60000) { artifacts.prune(); lastPrune = start; }
      consecutiveFailures = 0;
      // Don't turn expensive native diagnostics into a new permanent load.
      if (monoNow() - start > 100) delayMs = 10000;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures === 1 || consecutiveFailures % 30 === 0) log('[Perf:CpuWindow] unavailable error=' + String(err.message).slice(0, 160));
      previous = null; previousAt = monoNow(); delayMs = 10000;
    }
    timer = setTimeout(tick, delayMs); timer.unref?.();
  }
  timer = setTimeout(tick, 2000); timer.unref?.();
  return { artifacts, incident, stop() { stopped = true; clearTimeout(timer); persist(); } };
}

module.exports = { cpuFrame, systemCpu, summarizeFrames, createArtifactStore, createFlightRecorder, captureDecision };
