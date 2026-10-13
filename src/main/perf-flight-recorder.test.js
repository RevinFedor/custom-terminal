'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cpuFrame, systemCpu, summarizeFrames, createArtifactStore, captureDecision } = require('./perf-flight-recorder');

const proc = (pid, cpuNs, extra = {}) => ({ pid, ppid: 1, startedAtTicks: '10', cpuNs,
  name: 'process', footprintBytes: 1048576, ...extra });
test('same interval distinguishes app, PTY descendant and external CPU; omits raw arguments', () => {
  const before = { processes: [proc(10, 0), proc(20, 0), proc(21, 0), proc(30, 0)] };
  const after = { processes: [proc(10, 1e9), proc(20, 1e8, { ppid: 10 }),
    proc(21, 2e8, { ppid: 20, commandLine: 'SECRET', execPath: '/private/SECRET' }), proc(30, 6e9, { name: 'OrbStack' })] };
  const frame = cpuFrame(before, after, 2000, [{ pid: 10, type: 'Browser' }], [{ pid: 20, tabId: 'tab-1' }], 10);
  assert.equal(frame.appCpu, 50); assert.equal(frame.tabCpu, 15);
  assert.equal(frame.rows.find(p => p.pid === 30).cpu, 300);
  assert.equal(frame.rows.find(p => p.pid === 21).tabId, 'tab-1');
  assert.ok(!JSON.stringify(frame).includes('SECRET'));
});
test('first sample and PID reuse with a LARGER counter are unknown, not 0 or false CPU', () => {
  const before = { processes: [proc(10, 1e9), proc(11, 1e9)] };
  const after = { processes: [proc(10, 2e9, { startedAtTicks: '11' }), proc(11, 0), proc(12, 9e9)] };
  assert.deepEqual(cpuFrame(before, after, 1000, [], [], 100).rows, []);
  assert.deepEqual(cpuFrame(null, after, 1000, [], [], 100).rows, []);
});
test('normalized CPU keeps its provenance in frames/checkpoints without scaling twice', () => {
  const normalization = { sourceUnit: 'mach-ticks', outputUnit: 'nanoseconds', numer: 125, denom: 3 };
  const before = { processes: [proc(10, 0)] };
  const after = { processes: [proc(10, 1e9)], cpuTimeNormalization: normalization };
  const frame = { ...cpuFrame(before, after, 1000, [], [], 10), wallMs: 1000, elapsedMs: 1000,
    systemBusy: 10, probeMs: 1, observerGapMs: 0 };
  assert.equal(frame.appCpu, 100);
  assert.deepEqual(frame.cpuTimeNormalization, normalization);
  const summary = summarizeFrames([frame]);
  assert.equal(summary.appPeak, 100);
  assert.deepEqual(summary.cpuTimeNormalization, normalization);
});
test('system busy uses all-core delta and rejects a reset/topology change', () => {
  const cpu = (user, idle) => ({ times: { user, idle, sys: 0, nice: 0, irq: 0 } });
  assert.equal(systemCpu([cpu(0, 0), cpu(0, 0)], [cpu(100, 0), cpu(0, 100)]), 50);
  assert.equal(systemCpu([cpu(100, 0)], [cpu(0, 100)]), null);
  assert.equal(systemCpu([], [cpu(0, 0)]), null);
});
test('CPU ownership keeps Electron, its helpers, tab processes and unrelated Docker separate', () => {
  const before = { processes: [proc(10,0),proc(11,0,{ppid:10}),proc(20,0,{ppid:10}),proc(30,0,{name:'Docker'})] };
  const after = { processes: [proc(10,2e8),proc(11,4e8,{ppid:10}),proc(20,6e8,{ppid:10}),proc(30,8e8,{name:'Docker'})] };
  const frame = cpuFrame(before,after,1000,[{pid:10,type:'Browser'}],[{pid:20,tabId:'tab'}],10);
  assert.equal(frame.appCpu,20);assert.equal(frame.appChildCpu,40);assert.equal(frame.tabCpu,60);assert.equal(frame.externalCpu,80);
  const summary=summarizeFrames([{...frame,wallMs:1000,elapsedMs:1000,cores:8,systemBusy:25,probeMs:1,observerGapMs:0}]);
  assert.equal(summary.ownerGroups.externalCpu.peakCpu,80);assert.equal(summary.cores,8);
  assert.equal(summary.ownerGroups.appCpu.meanCpu,20);
});
test('checkpoint preserves burst BETWEEN flushes and observed identity coverage', () => {
  const frames = [10, 300, 20].map((cpu, i) => ({ wallMs: 2000 * (i + 1), elapsedMs: 2000,
    systemBusy: 50, appCpu: cpu, probeMs: 4, observerGapMs: 0,
    rows: [{ pid: 10, identity: 'a', cpu, owner: 'app' }] }));
  const result = summarizeFrames(frames);
  assert.equal(result.rows[0].peakCpu, 300); assert.equal(result.rows[0].meanCpu, 110);
  assert.equal(result.rows[0].observedMs, 6000); assert.equal(result.from, 0); assert.equal(result.to, 6000);
});
test('capture quota is rolling and survives a new recorder; retention touches only owned regular files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-flight-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createArtifactStore(dir), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const name = 'incident-' + (now - 7200000 + i * 700000) + '-1.capture.json';
    store.write(name, {});
    fs.utimesSync(store.file(name), new Date(now - 7200000 + i * 700000), new Date(now - 7200000 + i * 700000));
  }
  const reloaded = createArtifactStore(dir);
  assert.equal(reloaded.reserveCapture('incident-' + now + '-1', now), false);
  assert.equal(reloaded.reserveCapture('incident-' + (now + 86400000) + '-1', now + 86400000), true);
  assert.throws(() => store.file('../secret'));
  fs.writeFileSync(path.join(dir, 'user-notes.txt'), 'keep');
  store.write('incident-1-1.main.cpuprofile', {});
  store.write('incident-1-1.ui.json', { animations: [] });
  const old = new Date(now - 8 * 86400000);
  fs.utimesSync(store.file('incident-1-1.main.cpuprofile'), old, old);
  fs.utimesSync(store.file('incident-1-1.ui.json'), old, old);
  fs.symlinkSync(path.join(dir, 'user-notes.txt'), store.file('incident-2-1.json'));
  store.prune(now);
  assert.equal(fs.existsSync(store.file('incident-1-1.main.cpuprofile')), false);
  assert.equal(fs.existsSync(store.file('incident-1-1.ui.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'user-notes.txt'), 'utf8'), 'keep');
  assert.throws(() => store.write('incident-2-1.json', {}));
});
test('passive renderer diagnostics never hit-test, read computed style or scan the hover tree', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/utils/perfFreezeProbe.ts'), 'utf8');
  assert.doesNotMatch(source, /document\.elementFromPoint\s*\(|window\.getComputedStyle\s*\(|querySelectorAll\(['"]:hover/);
  assert.match(source, /targetEvidence=event/);
  assert.match(source, /createPerfSocketWriter/);
  const transport = fs.readFileSync(path.join(__dirname, '../renderer/utils/perfIncidentChannel.ts'), 'utf8');
  assert.match(transport, /writableLength >= 16384/);
});

test('ambient CPU cannot consume the two responsiveness slots; skip reason and expiry are exact', () => {
  const now = 86400000;
  const background = [{ at: now - 1200000, group: 'background' }, { at: now - 600001, group: 'background' }];
  assert.equal(captureDecision(background, now, 'sustained-cpu').reason, 'reserved-for-responsiveness');
  assert.equal(captureDecision(background, now, 'ui-click').allowed, true);
  const recent = [...background, { at: now - 1000, group: 'responsiveness' }];
  const cooldown = captureDecision(recent, now, 'ui-click');
  assert.equal(cooldown.reason, 'capture-group-cooldown'); assert.equal(cooldown.nextEligibleWallMs, now + 599000);
  recent.push({ at: now - 2000, group: 'responsiveness' });
  assert.equal(captureDecision(recent, now, 'ui-click').reason, 'rolling-quota-exhausted');
});
test('system load without an Electron hotspot does not waste a background profile or suppress a real UI stall', () => {
  const pressure = { appCpu: 10, appChildCpu: 3, externalCpu: 750, systemBusy: 98 };
  assert.equal(captureDecision([], Date.now(), 'sustained-cpu', pressure).reason, 'system-pressure-no-electron-hotspot');
  assert.equal(captureDecision([], Date.now(), 'ui-click', pressure).allowed, true);
  assert.equal(captureDecision([], Date.now(), 'sustained-cpu', { ...pressure, appCpu: 150 }).allowed, true);
});

function artifactFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-artifacts-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createArtifactStore(directory), now = Date.now();
  const sparse = (name, bytes, at) => {
    const fd = store.openExclusive(name);
    try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
    fs.utimesSync(store.file(name), new Date(at), new Date(at));
  };
  return { directory, store, now, sparse };
}

test('artifact entries and bounded read/exclusive receipt API reject unknown paths and symlinks', t => {
  const { directory, store } = artifactFixture(t);
  const id = 'stall-1000-321-1';
  for (const extension of ['.sample.txt', '.sample.json', '.sample-capture.json']) store.write(id + extension, 'evidence');
  store.write('causal-2026100912.ndjson', '{}\n', true);
  fs.writeFileSync(path.join(directory, 'user-data'), 'untouched');
  fs.symlinkSync(path.join(directory, 'user-data'), store.file('stall-1000-321-2.sample.txt'));
  fs.mkdirSync(store.file('stall-1000-321-3.sample.txt'));
  assert.equal(store.entries().length, 4);
  assert.equal(store.read(id + '.sample.txt'), 'evidence');
  assert.throws(() => store.read(id + '.sample.txt', 2), /read/);
  assert.throws(() => store.read('stall-1000-321-2.sample.txt'));
  assert.throws(() => store.read('stall-1000-321-3.sample.txt'));
  assert.throws(() => store.openExclusive('stall-1000-321-2.sample.txt'));
  assert.throws(() => store.file('../stall-1000-321-1.sample.txt'));
  assert.throws(() => store.file('user-data'));
  store.writeExclusive('stall-1000-321-4.sample-capture.json', { version: 1 });
  assert.throws(() => store.writeExclusive('stall-1000-321-4.sample-capture.json', 'replace'));
  assert.deepEqual(JSON.parse(store.read('stall-1000-321-4.sample-capture.json')), { version: 1 });
  store.prune(Date.now() + 8 * 86400000);
  assert.equal(fs.readFileSync(path.join(directory, 'user-data'), 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(store.file('stall-1000-321-2.sample.txt')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(store.file('stall-1000-321-3.sample.txt')).isDirectory(), true);
});

test('5GiB pruning evicts large artifacts without refunding either current quota', t => {
  const { store, now, sparse } = artifactFixture(t), day = 86400000;
  const receipt = 'stall-' + (now - 1000) + '-123-1.sample-capture.json';
  // Even an old mtime cannot evict a newly named immutable native receipt.
  sparse(receipt, 128, now - 8 * day);
  for (let i = 0; i < 4; i++) sparse('incident-' + (now - 7200000 + i * 700000) + '-1.capture.json', 128, now - 7200000 + i * 700000);
  sparse('stall-' + now + '-123-1.sample.txt', 6 * 1024 * 1024 * 1024, now - 180000);
  const pruned = store.prune(now);
  assert.ok(pruned.bytes < 5 * 1024 * 1024 * 1024);
  assert.equal(fs.existsSync(store.file(receipt)), true);
  assert.equal(store.entries().filter(e => e.name.endsWith('.capture.json')).length, 4);
  assert.equal(createArtifactStore(store.directory).reserveCaptureDetails('incident-' + now + '-1', now).reason, 'rolling-quota-exhausted');
});

test('native receipts expire at 24h while sample metadata/full report retain the general 7-day policy', t => {
  const { store, now, sparse } = artifactFixture(t), day = 86400000;
  const id = 'stall-' + (now - day - 1) + '-123-1';
  for (const extension of ['.sample.txt', '.sample.json', '.sample-capture.json']) sparse(id + extension, 100, now - day - 1);
  store.prune(now);
  assert.equal(fs.existsSync(store.file(id + '.sample-capture.json')), false);
  assert.equal(fs.existsSync(store.file(id + '.sample.txt')), true);
  assert.equal(fs.existsSync(store.file(id + '.sample.json')), true);
  store.prune(now + 7 * day);
  assert.deepEqual(store.entries(), []);
});

test('old incident metadata cannot erase every freshly captured native stack under the same global cap', t => {
  const { store, now, sparse } = artifactFixture(t), miB = 1048576;
  for (let i = 0; i < 1281; i++) sparse('incident-' + (now - 4 * 3600000 - i) + '-1.json', 4 * miB, now - 4 * 3600000 - i);
  const id = 'stall-' + (now - 180000) + '-123-1';
  sparse(id + '.sample.txt', miB, now - 180000);
  store.write(id + '.sample.json', { id, status: 'complete', output: { file: id + '.sample.txt', complete: true } });
  const after = store.prune(now);
  assert.ok(after.bytes <= 5 * 1024 * miB);
  assert.equal(fs.existsSync(store.file(id + '.sample.txt')), true, 'the recent stack remains useful beyond its two-minute write grace');
});

test('causal journals retain one week and may borrow unused space beyond their protected share', t => {
  const { store, now, sparse } = artifactFixture(t), hour = 3600000, miB = 1048576;
  const bucket = at => 'causal-' + new Date(at).toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
  const expired = bucket(now - 169 * hour), recent = bucket(now - 167 * hour);
  sparse(expired, 1024, now - 169 * hour); sparse(recent, 1024, now - 167 * hour);
  store.prune(now);
  assert.equal(fs.existsSync(store.file(expired)), false); assert.equal(fs.existsSync(store.file(recent)), true);
  fs.unlinkSync(store.file(recent));
  const names = Array.from({ length: 17 }, (_, i) => bucket(now - i * hour));
  // These journals use the shared 5GiB budget rather than being deleted at
  // 64MiB while the rest of that budget is empty. Sparse files allocate no data.
  names.forEach((name, i) => sparse(name, 4 * miB, now - i * 1000));
  const after = store.prune(now);
  assert.equal(after.causalBytes, 68 * miB);
  assert.equal(fs.existsSync(store.file(names.at(-1))), true);
  assert.equal(fs.existsSync(store.file(names[0])), true);
});

test('native reports may borrow the shared budget; heavy expiry records loss without refunding quota', t => {
  const { store, now, sparse } = artifactFixture(t), miB = 1048576;
  const ids=Array.from({length:9},(_,i)=>'stall-'+(now-7200000-i*900000)+'-123-'+i);
  for(const [i,id] of ids.entries()){
    sparse(id+'.sample.txt',8*miB,now-7200000-i*900000);
    store.write(id+'.sample.json',{id,status:'complete',output:{file:id+'.sample.txt',complete:true}});
    store.writeExclusive(id+'.sample-capture.json',{version:1,id,requestedWallMs:now-7200000-i*900000});
  }
  const after=store.prune(now);
  assert.equal(after.nativeSampleBytes,72*miB);
  assert.equal(fs.existsSync(store.file(ids.at(-1)+'.sample.txt')),true);
  const old=new Date(now-86400000-1);
  fs.utimesSync(store.file(ids.at(-1)+'.sample.txt'),old,old);
  store.prune(now);
  const metadata=JSON.parse(store.read(ids.at(-1)+'.sample.json'));
  assert.equal(metadata.status,'complete');assert.equal(metadata.output.retained,false);
  assert.equal(metadata.output.removalReason,'heavy-retention-expired');
  assert.equal(store.entries().filter(e=>e.name.endsWith('.sample-capture.json')).length,9);
});

test('CPU profiles, traces and oversized files expire at 24h; small reports and metadata retain one week', t => {
  const { store, now, sparse } = artifactFixture(t), day = 86400000;
  const profiles=['incident-1000-1.main.cpuprofile','incident-1000-1.cpuprofile','incident-1000-1.trace.json'];
  store.write('incident-1000-1.profile.json',{traceComplete:true,mainStoppedWallMs:now-day-1});
  for(const name of profiles)sparse(name,100,now-day-1);
  sparse('incident-1001-1.ui.json',8*1048576,now-day-1);
  sparse('incident-1002-1.main.cpuprofile',100,now-day+1);
  sparse('stall-1000-1-1.sample.txt',100,now-day-1);
  sparse('incident-1000-1.json',100,now-7*day-1);
  store.prune(now);
  for(const name of profiles)assert.equal(fs.existsSync(store.file(name)),false);
  assert.equal(fs.existsSync(store.file('incident-1001-1.ui.json')),false);
  for(const name of ['incident-1002-1.main.cpuprofile','incident-1000-1.profile.json','stall-1000-1-1.sample.txt'])
    assert.equal(fs.existsSync(store.file(name)),true);
  const metadata=JSON.parse(store.read('incident-1000-1.profile.json'));
  assert.equal(metadata.traceComplete,true);
  for(const name of profiles)assert.equal(metadata.artifactRetention[name].removalReason,'heavy-retention-expired');
  assert.equal(fs.existsSync(store.file('incident-1000-1.json')),false);
});

test('causal append has an explicit hourly byte bound and preserves existing complete lines on overload', t => {
  const { store, now } = artifactFixture(t);
  const bucket = 'causal-' + new Date(now).toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
  const body = 'x'.repeat(4 * 1024 * 1024 - 1) + '\n';
  store.write(bucket, body, true);
  assert.throws(() => store.write(bucket, '{}\n', true), /bucket full/);
  assert.equal(fs.statSync(store.file(bucket)).size, Buffer.byteLength(body));
  assert.throws(() => store.read(bucket), /read/);
});

for(const pool of ['causal','native'])test(pool+' 65MiB pool cannot fall to 61MiB when ordinary metadata can satisfy pressure', t=>{
  const {store,now,sparse}=artifactFixture(t),miB=1048576;
  for(let i=0;i<17;i++){
    const name=pool==='native'?'stall-'+(now-14400000-i)+'-123-'+i+'.sample.txt'
      :'causal-202610'+String(i+1).padStart(2,'0')+'00.ndjson';
    sparse(name,(i===16?1:4)*miB,i===16?now-3600000:now-14400000-i);
  }
  for(let i=0;i<1264;i++)sparse('incident-'+(now-7200000-i)+'-1.json',4*miB,now-7200000-i);
  const result=store.prune(now);
  assert.equal(pool==='native'?result.nativeSampleBytes:result.causalBytes,65*miB);
  assert.ok(result.bytes<=5*1024*miB);
});
