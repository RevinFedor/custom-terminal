'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { captureIncidentProfile } = require('./perf-incident-profile');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-profile-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], commands = [], dbg = new EventEmitter();
  let attached = !!options.attached;
  let reads = 0;
  dbg.isAttached = () => attached;
  dbg.attach = () => { calls.push('attach'); attached = true; };
  dbg.detach = () => { calls.push('detach'); attached = false; dbg.emit('detach', {}, 'target closed'); };
  dbg.sendCommand = async (method, params) => {
    calls.push(method);
    commands.push({ method, params });
    if (method === 'Tracing.start' && options.traceBusy) throw new Error('Tracing already started');
    if (method === 'Profiler.start' && options.loseOwnership) {
      dbg.emit('detach', {}, 'replaced-with-devtools'); attached = true; // now somebody else's connection
    }
    if (method === 'Runtime.evaluate' && options.loseDuringUi) {
      dbg.emit('detach', {}, 'replaced-with-devtools'); attached = true;
    }
    if (method === 'Tracing.end') dbg.emit('message', {}, 'Tracing.tracingComplete', { stream: 's', dataLossOccurred: false });
    if (method === 'Profiler.stop') {
      if (options.stopFailed) throw new Error('stop-failed');
      return { profile: { nodes: [], samples: [] } };
    }
    if (method === 'IO.read') {
      reads++;
      if (options.overflowTrace) {
        const prefix = reads === 1 ? '{"traceEvents":[\n' + JSON.stringify({ name: 'LocalFrameView::layout', pid: 12,
          args: { endData: { layoutRoots: [{ nodeId: 753 }] } } }) + ',\n' : '';
        return { data: prefix + ' '.repeat(262143 - prefix.length) + '\n', eof: false };
      }
      return { data: '{"traceEvents":[\n' + JSON.stringify({ name: 'LocalFrameView::layout', pid: 12,
        args: { endData: { layoutRoots: [{ nodeId: 753 }] } } }) + '\n]}', eof: true };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'fixture-node' } };
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') return { result: { value: {
      entries: [{ cssName: 'fixture-perimeter', playState: 'running', target: { tag: 'circle' } }],
      observedCount: 1, node: { tag: 'svg', classes: ['fixture-TerminalActivityIcon'] },
    } } };
    return {};
  };
  return { directory, calls, commands, webContents: { debugger: dbg, isDestroyed: () => false,
    isDevToolsOpened: () => false, getOSProcessId: () => 12, getZoomFactor: () => 2 },
    request: { id: 'incident-123-1', pid: 12, requestedWallMs: Date.now() },
    durationMs: 0, log() {}, inspector: { url: () => 'external-inspector' } };
}
test('existing debugger remains attached and untouched', async t => {
  const f = fixture(t, { attached: true });
  await captureIncidentProfile(f);
  assert.deepEqual(f.calls, []);
  const result = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.profile.json')));
  assert.equal(result.rendererSkipped, 'no-renderer-or-external-debugger');
  const ui = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.ui.json')));
  assert.equal(ui.status, 'skipped'); assert.equal(ui.reason, 'external-debugger');
});
test('existing GLOBAL trace is not stopped; own CPU profile is saved and session detached', async t => {
  const f = fixture(t, { traceBusy: true });
  await captureIncidentProfile(f);
  assert.ok(f.calls.includes('Profiler.stop')); assert.ok(!f.calls.includes('Tracing.end'));
  assert.ok(f.calls.includes('detach')); assert.ok(fs.existsSync(path.join(f.directory, 'incident-123-1.cpuprofile')));
  assert.ok(!f.calls.includes('Runtime.evaluate'), 'observer never enters an existing global recording');
});
test('successful trace uses bounded stream and closes both stream and own session', async t => {
  const f = fixture(t);
  await captureIncidentProfile(f);
  assert.ok(f.calls.includes('IO.close')); assert.equal(f.calls.filter(x => x === 'detach').length, 1);
  const config = f.commands.find(call => call.method === 'Tracing.start').params.traceConfig;
  assert.ok(config.includedCategories.includes('input'), 'native wheel queue/ACK must be recorded');
  assert.ok(config.includedCategories.includes('latencyInfo'));
  assert.equal(config.enableArgumentFilter, true);
  assert.deepEqual(config.excludedCategories, ['*']);
  assert.equal(config.traceBufferSizeInKb, 8192);
  const result = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.profile.json')));
  assert.deepEqual(result.traceCategories, config.includedCategories);
  assert.equal(result.traceComplete, true); assert.equal(result.traceDataLoss, false);
  assert.ok(result.rendererStartedWallMs >= result.requestedWallMs);
  const uiFile = path.join(f.directory, 'incident-123-1.ui.json');
  const ui = JSON.parse(fs.readFileSync(uiFile));
  assert.equal(ui.status, 'complete'); assert.equal(ui.zoomFactor, 2);
  assert.equal(ui.roots[0].backendNodeId, 753); assert.equal(ui.roots[0].node.tag, 'svg');
  assert.equal(result.uiMetadata.file, 'incident-123-1.ui.json');
  assert.ok(ui.startedWallMs >= result.rendererStoppedWallMs && ui.startedWallMs >= result.traceStoppedWallMs);
  assert.ok(f.calls.indexOf('Runtime.evaluate') > f.calls.indexOf('IO.close'));
  assert.ok(f.calls.indexOf('Runtime.releaseObjectGroup') < f.calls.indexOf('detach'));
  assert.equal(fs.statSync(uiFile).mode & 0o777, 0o600);
});
test('replacement by user DevTools forbids further commands and detach', async t => {
  const f = fixture(t, { loseOwnership: true });
  await captureIncidentProfile(f);
  assert.ok(!f.calls.includes('Profiler.stop')); assert.ok(!f.calls.includes('Tracing.end'));
  assert.ok(!f.calls.includes('Tracing.start'));
  assert.ok(!f.calls.includes('detach'));
});
test('16 MiB partial export still writes usable trace root IDs and post-capture node metadata', async t => {
  const f = fixture(t, { overflowTrace: true });
  await captureIncidentProfile(f);
  const status = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.profile.json')));
  const ui = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.ui.json')));
  assert.equal(status.traceComplete, false); assert.ok(status.errors.includes('trace-export-size-limit'));
  assert.equal(status.traceBytes, 16 * 1024 * 1024);
  assert.equal(ui.trace.completeExport, false); assert.equal(ui.trace.bytes, status.traceBytes);
  assert.equal(ui.trace.roots[0].backendNodeId, 753); assert.equal(ui.roots[0].node.tag, 'svg');
  assert.equal(ui.status, 'complete'); assert.ok(fs.statSync(path.join(f.directory, 'incident-123-1.ui.json')).size <= 65536);
});
test('unconfirmed CPU stop records an explicit UI skip', async t => {
  const f = fixture(t, { stopFailed: true });
  await captureIncidentProfile(f);
  const ui = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.ui.json')));
  assert.equal(ui.status, 'skipped'); assert.equal(ui.reason, 'capture-stop-unconfirmed');
  assert.ok(!f.calls.includes('Runtime.evaluate')); assert.equal(f.calls.filter(x => x === 'detach').length, 1);
});
test('DevTools replacement during metadata forbids group release and detach through the new owner', async t => {
  const f = fixture(t, { loseDuringUi: true });
  await captureIncidentProfile(f);
  const ui = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.ui.json')));
  assert.equal(ui.status, 'partial'); assert.ok(ui.errors.some(e => e.code === 'ownership-lost'));
  assert.ok(!f.calls.includes('Runtime.releaseObjectGroup')); assert.ok(!f.calls.includes('DOM.resolveNode'));
  assert.ok(!f.calls.includes('detach'));
});
test('main CPU profiler is confirmed stopped before the metadata observer starts', async t => {
  const f = fixture(t);
  f.inspector = { url: () => '', Session: class {
    connect() {}
    disconnect() { f.calls.push('main:disconnect'); }
    post(method, _params, callback) {
      f.calls.push('main:' + method);
      callback(null, method === 'Profiler.stop' ? { profile: { nodes: [], samples: [] } } : {});
    }
  } };
  await captureIncidentProfile(f);
  const status = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.profile.json')));
  const ui = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.ui.json')));
  assert.ok(f.calls.indexOf('Runtime.evaluate') > f.calls.indexOf('main:Profiler.stop'));
  assert.ok(ui.startedWallMs >= status.mainStoppedWallMs);
  assert.equal(ui.status, 'complete');
});
