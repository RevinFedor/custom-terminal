// Full frozen Noted app, private data/CLI homes. No host installation or hub restart.
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), require = createRequire(import.meta.url);
const [mode, requestedRoot] = process.argv.slice(2);
assert(['prepare', 'build', 'run', 'acceptance'].includes(mode) && path.isAbsolute(requestedRoot || ''), 'mode and exact owned root required');
const root = await fs.realpath(requestedRoot);
assert(path.basename(root).startsWith('noted4412-batch-') && root.startsWith('/private/tmp/'), 'own temporary root required');
const cfg = JSON.parse(await fs.readFile(path.join(root, 'request.json'), 'utf8'));
const repo = await fs.realpath(cfg.repo);
assert.equal(cfg.root, root); assert.equal(await fs.realpath(process.cwd()), repo);
const compilerHeapMiB = cfg.compilerHeapMiB ?? 1792;
assert(Number.isSafeInteger(compilerHeapMiB) && compilerHeapMiB >= 1024 && compilerHeapMiB <= 1792,
  'own compiler heap may only lower the baseline, not raise resource caps');
const helpers = path.join(root, 'helpers'), source = path.join(root, 'source');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => fs.writeFile(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
const helperNames = ['owned-process.cjs', 'resources.cjs', 'compiler-zombie-resource.cjs', 'marker-proof.cjs',
  'files.cjs', 'core.cjs', 'compiler-phase.mjs', 'esbuild-lifetime.cjs'];
const trees = ['src', 'packages/claude-blocks/src', 'vendor/markdown-editor/src',
  'vendor/noted-shared/packages/structured-dnd/src', 'vendor/noted-shared/packages/file-explorer/src',
  'vendor/noted-shared/packages/file-explorer/main'];
const files = ['package.json', 'package-lock.json', '.gitignore', 'index.html', 'electron.vite.config.js',
  'packages/claude-blocks/package.json', 'vendor/markdown-editor/package.json', 'vendor/markdown-editor/vite.config.ts',
  'vendor/markdown-editor/tsconfig.json', 'vendor/noted-shared/package.json',
  'vendor/noted-shared/packages/structured-dnd/package.json', 'vendor/noted-shared/packages/file-explorer/package.json',
  'vendor/noted-shared/build/assert-packages.mjs', 'scripts/build-workflow-native-drag.mjs',
  'scripts/lib/history-virtuoso-measurement.mjs', 'scripts/lib/style-mod-same-rules.mjs', 'scripts/lib/renderer-shared-cjs.mjs',
  'mcp/terminal-server.mjs'];
const limits = { sourceBytes: 128 * 1024 ** 2, maxFiles: 12000, excludedTrees: ['src/pty-proxy/target'], ignoreSourceTests: true,
  pressure: 1, allowWarning: false, maxFamilyMiB: 4096, maxGrowthMiB: 3072, maxSwapGrowthMiB: 256,
  minFreeEstimateGiB: 6, diskAdmissionGiB: 8, diskFloorGiB: 6 };
if (mode === 'prepare') {
  assert(!sync.existsSync(source), 'one frozen preparation per root');
  const inputRoot = cfg.sourceSnapshot ? await fs.realpath(cfg.sourceSnapshot) : repo;
  if (cfg.sourceSnapshot) assert(inputRoot.startsWith('/private/tmp/noted4412-batch-')
    && path.basename(inputRoot) === 'source' && /^[a-f0-9]{64}$/.test(cfg.sourceSHA), 'exact prior own snapshot only');
  await fs.mkdir(helpers);
  const helperPins = {};
  for (const name of helperNames) {
    const input = path.join(cfg.helperSource, name), output = path.join(helpers, name);
    const bytes = await fs.readFile(input); await fs.writeFile(output, bytes); helperPins[name] = sha(bytes);
  }
  await write('HELPER-PINS.json', { from: cfg.helperSource, files: helperPins, borrowedProfiles: false });
  const F = require(path.join(helpers, 'files.cjs')), K = require(path.join(helpers, 'core.cjs'));
  const before = await F.manifest(inputRoot, trees, files, limits);
  if (cfg.sourceSnapshot) assert.equal(before.sha256, cfg.sourceSHA, 'prior candidate must remain byte-exact');
  await fs.mkdir(source);
  for (const row of before.files) {
    const dest = path.join(source, row.path); await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(inputRoot, row.path), dest, sync.constants.COPYFILE_EXCL);
  }
  const after = await F.manifest(inputRoot, trees, files, limits);
  assert.deepEqual(after, before, 'live source changed during snapshot; retry is not an atomic-tree claim');
  await write('SOURCE-FREEZE.json', { ...before, source, inputRoot, atomicTree: false, bookendsEqual: true });
  await fs.writeFile(path.join(source, 'electron.private.config.mjs'), K.transformConfig(await fs.readFile(path.join(source, 'electron.vite.config.js'), 'utf8')));
  async function dependencies(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from)) if (!entry.startsWith('.') && entry !== '@gt-editor') {
      await fs.symlink(path.join(from, entry), path.join(to, entry));
    }
    await fs.mkdir(path.join(to, '.vite-temp'));
  }
  await dependencies(path.join(repo, 'node_modules'), path.join(source, 'node_modules'));
  await fs.mkdir(path.join(source, 'node_modules/@gt-editor'));
  await fs.symlink(path.join(source, 'vendor/markdown-editor'), path.join(source, 'node_modules/@gt-editor/markdown-editor'));
  await dependencies(path.join(repo, 'vendor/markdown-editor/node_modules'), path.join(source, 'vendor/markdown-editor/node_modules'));
  for (const name of ['build-home', 'temp', 'data/app', 'data/discovery', 'data/codex', 'data/claude', 'home', 'data/workspace']) {
    await fs.mkdir(path.join(root, name), { recursive: true });
  }
  const harnessFiles = ['scripts/testing/tab-message-full-app.mjs', 'scripts/testing/tab-message-full-app-scenario.mjs',
    'scripts/fixtures/tab-message-busy.cjs', 'scripts/fixtures/tab-message-model-client.cjs'];
  const harnessPins = [];
  for (const file of harnessFiles) {
    const bytes = await fs.readFile(path.join(repo, file));
    await fs.writeFile(path.join(root, path.basename(file)), bytes, { flag: 'wx' });
    harnessPins.push({ file: path.basename(file), sha256: sha(bytes), bytes: bytes.length });
  }
  await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'));
  await write('HARNESS-PINS.json', { files: harnessPins, executedEntry: path.join(root, 'tab-message-full-app.mjs') });
  console.log(JSON.stringify({ status: 'PREPARED_NOT_RUN', root, sourceBytes: before.bytes, files: before.files.length }));
  process.exit(0);
}
const harnessPins = JSON.parse(await fs.readFile(path.join(root, 'HARNESS-PINS.json'), 'utf8'));
assert.equal(fileURLToPath(import.meta.url), harnessPins.executedEntry, 'run the exact prepared driver, not the mutable checkout');
for (const pin of harnessPins.files) assert.equal(sha(await fs.readFile(path.join(root, pin.file))), pin.sha256);
const O = require(path.join(helpers, 'owned-process.cjs')), R = require(path.join(helpers, 'resources.cjs'));
const MP = require(path.join(helpers, 'marker-proof.cjs'));
const K = require(path.join(helpers, 'core.cjs'));
const known = new Map(), children = [], samples = [], events = [], ports = new Set();
const cpuByPid = new Map();
const deadline = Date.now() + (mode === 'build' ? 600000 : 600000);
let baseline, refusal, sampleFlight, timer, lease, marker, app;
async function bounded(promise, ms, label) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(Error(label)), ms);
  })]); } finally { clearTimeout(timeout); }
}
async function sample() {
  if (sampleFlight) return sampleFlight;
  sampleFlight = (async () => {
    const value = await R.sample(root, known);
    const cpuRead = await exec('/bin/ps', ['-axo', 'pid=,time='], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const cpu = K.resourceCPU(cpuRead.stdout);
    for (const pid of new Set([process.pid, ...known.keys()])) if (cpu.has(pid)) cpuByPid.set(pid, Math.max(cpuByPid.get(pid) || 0, cpu.get(pid)));
    value.ownedCPUSecondsObserved = [...cpuByPid.values()].reduce((sum, seconds) => sum + seconds, 0);
    assert(value.ownedCPUSecondsObserved < 360, 'own finite CPU budget');
    if (!baseline) baseline = value;
    samples.push(value); R.admit(value, baseline, limits, { initial: samples.length === 1 });
    assert(Date.now() < deadline - 30000, 'finite work deadline/cleanup reserve');
    if (marker) marker.assertCurrent();
    return value;
  })().catch(error => { refusal ||= error; throw error; }).finally(() => { sampleFlight = null; });
  return sampleFlight;
}
function guard() { if (refusal) throw refusal; assert(Date.now() < deadline - 30000); marker?.assertCurrent(); }
async function acquire() {
  const owner = await O.captureSelf({ entry: fileURLToPath(import.meta.url), cwd: process.cwd(),
    attempt: path.basename(root), lease: cfg.marker, launchId: cfg.runId });
  await sample();
  const fd = sync.openSync(cfg.marker, 'wx', 0o600), raw = Buffer.from(JSON.stringify({ task: cfg.runId, mode, root, owner, deadline, nonce: randomUUID() }));
  sync.writeFileSync(fd, raw); sync.fsyncSync(fd);
  const st = sync.fstatSync(fd); lease = { fd, dev: st.dev, ino: st.ino, bytes: raw.length, sha256: sha(raw) };
  marker = MP.openMarkerProof({ file: cfg.marker, expected: lease });
  timer = setInterval(() => void sample().catch(() => {}), 5000);
  events.push({ kind: 'admitted', at: Date.now(), owner, mode });
}
async function compiler(phase) {
  await sample(); guard();
  const file = path.join(root, phase + '.log'), log = sync.openSync(file, 'wx', 0o600);
  const child = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=' + compilerHeapMiB, path.join(helpers, 'compiler-phase.mjs'), source, root, repo, phase], {
    cwd: source, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(root, 'build-home'),
      TMPDIR: path.join(root, 'temp'), LANG: 'en_US.UTF-8', NODE_ENV: 'production', NODE_ENV_ELECTRON_VITE: 'production' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const entry = { pid: child.pid, phase, child, closed: false }; children.push(entry);
  let resolveReady, rejectReady, carry = '', readyDone = false, bytes = 0;
  const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
  ready.catch(() => {});
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    entry.closed = true; entry.code = code; entry.signal = signal; rejectReady(Error('compiler closed before ready')); resolve();
  }));
  entry.closedPromise = closed;
  child.once('error', rejectReady);
  child.stdout.on('data', data => {
    bytes += data.length; if (bytes > 8 * 1024 ** 2) { refusal ||= Error('compiler output limit'); return; }
    sync.writeSync(log, data);
    if (!readyDone) {
      carry += data.toString(); const at = carry.indexOf('\n');
      if (at < 0 && Buffer.byteLength(carry) > 4096) { rejectReady(Error('compiler readiness envelope bound')); return; }
      if (at >= 0) { readyDone = true; try { resolveReady(JSON.parse(carry.slice(0, at))); } catch (error) { rejectReady(error); } }
    }
  });
  child.stderr.on('data', data => { bytes += data.length; if (bytes <= 8 * 1024 ** 2) sync.writeSync(log, data); else refusal ||= Error('compiler output limit'); });
  try {
    const identity = await O.observe(child.pid); assert.equal(identity.state, 'found'); assert.equal(identity.cwd, source);
    known.set(child.pid, identity); entry.identity = identity;
    let readyTimer;
    const packet = await Promise.race([ready, new Promise((_, no) => {
      readyTimer = setTimeout(() => no(Error('compiler ready deadline')), 10000);
    })]).finally(() => clearTimeout(readyTimer));
    assert.equal(packet.pid, child.pid); assert.equal(packet.phase, phase); assert.equal(packet.cwd, source);
    await sample(); guard(); child.stdin.end('GO\n');
    const stop = setInterval(() => {
      if (!entry.signalAttempted && (refusal || Date.now() > deadline - 30000)) {
        entry.signalAttempted = true;
        void O.signalExact(identity, 'SIGTERM', { authorize: () => !!lease }).then(result => events.push({ kind: 'compiler-refusal-signal', result }));
      }
    }, 1000);
    try { await closed; } finally { clearInterval(stop); }
    guard(); // A guard-owned SIGTERM is evidence of that refusal, not a compiler defect.
    assert.equal(entry.code, 0, 'compiler phase failed; see owned log'); assert.equal(entry.signal, null);
    const graph = JSON.parse(await fs.readFile(path.join(root, 'PHASE-' + phase + '-GRAPH.json'), 'utf8'));
    const completedCPU = (graph.resourceUsage.userCPUTime + graph.resourceUsage.systemCPUTime) / 1000000;
    cpuByPid.set(child.pid, Math.max(cpuByPid.get(child.pid) || 0, completedCPU));
    assert.equal(graph.status, 'COMPILED_PHASE_NOT_RUNTIME'); assert.equal(graph.envRead, false);
    events.push({ kind: 'compiled', phase, pid: child.pid, inputs: graph.inputs.length });
  } finally { sync.closeSync(log); }
}
async function release() {
  clearInterval(timer); if (sampleFlight) await sampleFlight.catch(() => {});
  if (lease) await R.sample(root, known);
  const absent = [];
  for (const [pid, identity] of known) {
    const current = await O.observe(pid); absent.push({ pid, current });
  }
  await write(mode.toUpperCase() + '-PROCESSES.json', { known: [...known.values()], absent, releaseConfirmed: false });
  assert(absent.every(row => row.current.state === 'absent'), 'owned child still live/UNKNOWN; keep lease');
  const ps = await exec('/bin/ps', ['-ww', '-axo', 'pid=,command='], { timeout: 5000, maxBuffer: 4 * 1024 ** 2 });
  const scoped = ps.stdout.split('\n').filter(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    assert(!line.trim() || match, 'cleanup argv census incomplete');
    return match && +match[1] !== process.pid && K.scopeHit(match[2], root);
  });
  assert.equal(scoped.length, 0, 'own scoped argv consumers remain');
  const portProofs = [];
  for (const port of ports) {
    const result = await exec('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp'], { timeout: 5000 })
      .then(value => ({ code: 0, stdout: value.stdout, stderr: value.stderr }), failure => ({ code: failure.code, stdout: failure.stdout, stderr: failure.stderr }));
    assert.equal(result.code, 1, 'own port still listening/unknown'); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    portProofs.push({ port, ...result });
  }
  await write(mode.toUpperCase() + '-PROCESSES.json', { known: [...known.values()], absent, scoped, portProofs, releaseConfirmed: true,
    driver: { pid: process.pid, ownsControlServer: false, exitsAfterReceipt: true } });
  if (lease) {
    marker.assertCurrent(); assert(K.sameStat(sync.fstatSync(lease.fd), sync.lstatSync(cfg.marker)));
    await fs.unlink(cfg.marker); marker.close(); sync.closeSync(lease.fd); lease = null;
    events.push({ kind: 'marker-released', at: Date.now() });
  }
}
let error;
try {
  await acquire();
  if (mode === 'build' || mode === 'acceptance') {
    for (const phase of ['markdown', 'main', 'renderer']) await compiler(phase);
    const F = require(path.join(helpers, 'files.cjs'));
    const current = await F.manifest(source, trees, files, limits), frozen = JSON.parse(await fs.readFile(path.join(root, 'SOURCE-FREEZE.json'), 'utf8'));
    assert.equal(current.sha256, frozen.sha256, 'frozen source changed during compilation');
    const inputs = new Map();
    for (const phase of ['markdown', 'main', 'renderer']) {
      const graph = JSON.parse(await fs.readFile(path.join(root, 'PHASE-' + phase + '-GRAPH.json'), 'utf8'));
      for (const row of graph.inputs) {
        const old = inputs.get(row.path); if (old) assert.equal(old.sha256, row.sha256);
        inputs.set(row.path, row);
      }
    }
    await write('BUILD-PINS.json', { status: 'FULL_UNPACKAGED_BUILD_NOT_RUNTIME', sourceSHA: frozen.sha256, inputs: [...inputs.values()] });
  }
  if (mode === 'run' || mode === 'acceptance') {
    const scenario = await import(new URL('./tab-message-full-app-scenario.mjs', import.meta.url));
    await scenario.run({ root, source, repo, cfg, known, events, sample, guard, ports,
      fixtureSource: root,
      setApp: value => { app = value; } });
    const result = JSON.parse(await fs.readFile(path.join(root, 'SCENARIO-RESULT.json'), 'utf8'));
    assert.equal(result.status, 'PASS', 'partial Source/runtime stage is not a completed scenario');
  }
} catch (failure) { error = failure; }
finally {
  await write('CLEANUP-CANDIDATES.json', { known: [...known.values()], lease: lease && { dev: lease.dev, ino: lease.ino, bytes: lease.bytes, sha256: lease.sha256 } });
  const workRelease = path.join(root, 'data/workspace/finish-work');
  if (sync.existsSync(path.join(root, 'data/workspace/busy-started.json'))) {
    const work = JSON.parse(await fs.readFile(path.join(root, 'data/workspace/busy-started.json'), 'utf8'));
    const previous = sync.existsSync(workRelease) ? JSON.parse(await fs.readFile(workRelease, 'utf8')) : null;
    if (previous?.epoch !== work.epoch) {
      await fs.writeFile(workRelease, JSON.stringify({ epoch: work.epoch, reason: 'owned finite fixture cleanup' }));
      events.push({ kind: 'own-work-fixture-release' });
    }
  }
  if (app) {
    try {
      const pages = app.windows().filter(page => page.url().includes('/dist/renderer/index.html'));
      if (pages.length === 1) await write('PARTIAL-PROOF.json', await bounded(pages[0].evaluate(() => window.batchAcceptance), 3000, 'partial proof deadline'));
      if (error && pages.length === 1) {
        await bounded(pages[0].screenshot({ path: path.join(root, mode.toUpperCase() + '-FAILURE.png') }), 3000, 'failure screenshot deadline');
        await write(mode.toUpperCase() + '-FAILURE-UI.json', await bounded(pages[0].evaluate(() => [...document.querySelectorAll('button')]
          .filter(button => button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0)
          .map(button => ({ title: button.title, label: button.getAttribute('aria-label'), text: button.textContent.slice(0, 100),
            owner: button.closest('[data-prompt-queue-owner]')?.getAttribute('data-prompt-queue-owner'), instance: button.closest('[data-prompt-queue-instance]')?.getAttribute('data-prompt-queue-instance') }))), 3000, 'failure UI deadline'));
      }
    } catch (failure) { events.push({ kind: 'partial-proof-unavailable', message: failure.message }); }
    try { await bounded(app.close(), 20000, 'own App normal Quit deadline'); events.push({ kind: 'normal-app-close' }); }
    catch (failure) {
      error ||= failure;
      const identity = known.get(app.process().pid);
      if (identity) events.push({ kind: 'exact-app-cleanup', result: await O.signalExact(identity, 'SIGTERM', { authorize: () => !!lease }) });
    }
  }
  for (const entry of children) if (!entry.closed && entry.identity && !entry.signalAttempted) {
    entry.signalAttempted = true;
    const result = await O.signalExact(entry.identity, 'SIGTERM', { authorize: () => !!lease });
    events.push({ kind: 'exact-compiler-cleanup', result });
    try { await bounded(entry.closedPromise, 10000, 'compiler cleanup close deadline'); } catch (failure) { error ||= failure; }
  }
  try { await release(); } catch (failure) { events.push({ kind: 'cleanup-refused', message: failure.message }); error ||= failure; }
  await write(mode.toUpperCase() + '-RESULT.json', { status: error ? 'FAILED_OR_REFUSED' : 'PASS', mode, root,
    error: error?.stack, samples, events, helpers: helperNames, runtime: process.versions, hostMutation: false });
}
if (error) { console.error(error.stack); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'PASS', mode, root }));
