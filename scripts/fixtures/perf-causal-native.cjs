'use strict';
const fs = require('fs'), path = require('path'), net = require('net'), assert = require('assert/strict');
const { performance } = require('perf_hooks');
const { fork } = require('child_process');
const [repo, directory, kind, rendererModule] = process.argv.slice(2);
const { createArtifactStore } = require(path.join(repo, 'src/main/perf-flight-recorder'));
const { createThreadMetrics } = require(path.join(repo, 'src/main/perf-thread-metrics'));
const { createCausalContext } = require(path.join(repo, 'src/main/perf-causal-context'));
const { createPerfIncidentChannel, createPerfSocketWriter } = require(rendererModule);
const artifactDir = path.join(directory, 'perf-incidents'), store = createArtifactStore(artifactDir);
const at = Date.now();
for (let i = 0; i < 4; i++) {
  const when = at - 7200000 + i * 700000, name = 'incident-' + when + '-1.capture.json';
  store.write(name, { group: 'responsiveness', requestedAt: when }); fs.utimesSync(store.file(name), when / 1000, when / 1000);
}
assert.equal(store.reserveCaptureDetails('incident-' + at + '-1', at).reason, 'rolling-quota-exhausted');
if(kind==='critical')for(let i=0;i<6;i++){
  const when=at-120000-i*1000,id='stall-'+when+'-'+(900000+i)+'-1';
  store.writeExclusive(id+'.sample-capture.json',{version:1,id,requestedWallMs:when,
    pid:900000+i,processIdentity:'private-initial-'+i,stallId:'private-initial-'+i,admissionClass:'initial'});
}
const socket = '/private/tmp/noted-perf-canary-' + process.pid + '.sock', log = path.join(directory, 'watchdog.log');
const wdLog = fs.openSync(path.join(directory, 'watchdog-stderr.log'), 'w');
const wd = fork(path.join(repo, 'src/main/perf-watchdog.js'), [String(process.pid), log, socket], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', wdLog, wdLog, 'ipc'],
});
const causal = createCausalContext(), metrics = createThreadMetrics();
causal.configure({ enabled: true, metrics, sink: record => { wd.send({ t: 'causal', record }); return true; } });
const sendHeartbeat = () => {
  if (wd.connected) wd.send({ t: 'hb', proc: 'main', sentAbs: performance.timeOrigin + performance.now(),
    causal: causal.snapshot(), context: { appPids: [{ pid: process.pid, type: 'Browser' }], tabs: [] } }, () => {});
};
let heartbeat, watcher, socketClient, metricResult, sampleResult, started = false, finishing = false;
let begin, end;
const timeout = setTimeout(() => finish(new Error('canary did not receive a complete native sample')), 28000);
function inspectArtifacts() {
  if (finishing || !metricResult) return;
  for (const file of fs.readdirSync(artifactDir).filter(n => n.endsWith('.sample.json'))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(artifactDir, file)));
      if (record.status === 'complete' && record.resumeObservedWallMs !== null) { sampleResult = record; finish(); }
      else if (record.status === 'failed') finish(Error('sample failed: ' + record.reason));
    } catch (error) { if (error.message.startsWith('sample failed:')) finish(error); }
  }
}
async function finish(error) {
  if (finishing) return; finishing = true; clearTimeout(timeout); clearInterval(heartbeat); watcher?.close();
  socketClient?.destroy(); metrics.close();
  if (!error) try {
    assert.equal(sampleResult.overlap.status, 'overlap');
    assert.equal(sampleResult.output.hasCallGraph, true);
    assert.ok(metricResult.threadCpuMs !== null, 'actual Electron18 thread clock must be available');
    if (kind !== 'wait') assert.ok(metricResult.threadCpuMs > 700, 'known CPU block consumes measured thread CPU');
    else assert.ok(metricResult.threadCpuMs < 200, 'known native wait is not mislabeled Main CPU');
    if(kind==='critical')assert.ok(sampleResult.stall.stalledMs>=1000,'same still-silent process reached the reserved critical slot');
  } catch (caught) { error = caught; }
  const stopped = wd.exitCode !== null || wd.signalCode !== null ? Promise.resolve({ code: wd.exitCode, signal: wd.signalCode })
    : new Promise(resolve => wd.once('exit', (code, signal) => resolve({ code, signal })));
  try { if (wd.connected) wd.send({ t: 'bye' }, () => { if (wd.connected) wd.disconnect(); }); else wd.kill('SIGTERM'); }
  catch { wd.kill('SIGTERM'); }
  const watchdogExit = await stopped;
  fs.closeSync(wdLog);
  try { if (fs.existsSync(socket)) fs.unlinkSync(socket); } catch {}
  const causalLines = fs.readdirSync(artifactDir).filter(n => n.startsWith('causal-'))
    .flatMap(n => fs.readFileSync(path.join(artifactDir, n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  if (!error) try {
    assert.ok(causalLines.some(r => r.name === 'canary-' + kind && r.phase === 'enter'));
    assert.ok(causalLines.some(r => r.kind === 'stall'));
    assert.ok(causalLines.some(r => r.keyClass === 'Meta' && r.actionId === 'ui-canary-meta'));
    assert.ok(causalLines.some(r => r.kind === 'main-gap' && r.durationMs >= 2000 && r.threadCpuMs !== null),
      'measured Main gap survives the synthetic ordinary-GC journal pressure');
    if(kind==='critical')assert.ok(fs.readFileSync(log,'utf8').includes('native-reserved-for-critical-stall'));
  } catch (caught) { error = caught; }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: error ? 'fail' : 'pass',
    error: error?.stack || null, runtime: process.versions, mainPid: process.pid, watchdogPid: wd.pid,
    watchdogExit, heavyQuota: 'rolling-quota-exhausted', beginAbs: begin, endAbs: end,
    metrics: metricResult, sample: sampleResult, causalRecords: causalLines.length,
    socketRemoved: !fs.existsSync(socket) }, null, 2));
  process.exitCode = error ? 1 : 0;
}
process.once('SIGTERM', () => finish(Error('canary terminated')));
wd.on('error', error => { if (!finishing) finish(error); });
wd.once('exit', code => { if (!finishing) finish(Error('watchdog exited before result: ' + code)); });
wd.on('message', message => {
  if (message.t !== 'watchdog-observed' || started) return;
  started = true;
  // Direct renderer channel is an actual socket but a labeled synthetic Meta
  // summary; no keyboard is injected into the host or any provider.
  socketClient = net.createConnection(socket);
  socketClient.once('error', finish);
  socketClient.once('connect', () => {
    const channel = createPerfIncidentChannel(); channel.setWriter(createPerfSocketWriter(socketClient, process.pid));
    channel.heartbeat({ abs: performance.timeOrigin + performance.now(), vis: 'visible', focused: false, context: 'private-canary' });
    channel.report('ui-keydown', performance.timeOrigin + performance.now() - 150, 150, 'ui-canary-meta', {
      event: 'keydown', keyClass: 'Meta', meta: true, ctrl: false, alt: false, shift: false, repeat: false,
      target: { tag: 'button', source: 'private-canary', tab: 'synthetic-tab', historyOwner: 'synthetic-owner' },
      inputDelayMs: 120, handlerMs: 20, presentationMs: 10,
    });
    const before = metrics.read(); begin = before.at;
    causal.run('canary-' + kind, { caller: 'private-native-regression' }, () => {
      if (kind !== 'wait') { const until = performance.now() + (kind==='critical'?2600:2200); while (performance.now() < until) Math.sqrt(Math.random()); }
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
    });
    const after = metrics.read(); end = after.at; metricResult = metrics.between(before, after);
    // Controlled metadata pressure only: no forced production GC. The actual
    // watchdog must retain the measured gap in its existing critical lane.
    for(let i=0;i<65;i++)causal.event('gc',{durationMs:1,gcId:i,startAbs:begin});
    causal.event('main-gap',{startAbs:begin,durationMs:end-begin,...metricResult});
    sendHeartbeat(); inspectArtifacts();
  });
});
watcher = fs.watch(artifactDir, inspectArtifacts);
heartbeat = setInterval(sendHeartbeat, 250); sendHeartbeat();
