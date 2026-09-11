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
  const calls = [], dbg = new EventEmitter();
  let attached = !!options.attached;
  dbg.isAttached = () => attached;
  dbg.attach = () => { calls.push('attach'); attached = true; };
  dbg.detach = () => { calls.push('detach'); attached = false; dbg.emit('detach', {}, 'target closed'); };
  dbg.sendCommand = async (method) => {
    calls.push(method);
    if (method === 'Tracing.start' && options.traceBusy) throw new Error('Tracing already started');
    if (method === 'Profiler.start' && options.loseOwnership) {
      dbg.emit('detach', {}, 'replaced-with-devtools'); attached = true; // now somebody else's connection
    }
    if (method === 'Tracing.end') dbg.emit('message', {}, 'Tracing.tracingComplete', { stream: 's', dataLossOccurred: false });
    if (method === 'Profiler.stop') return { profile: { nodes: [], samples: [] } };
    if (method === 'IO.read') return { data: '{"traceEvents":[]}', eof: true };
    return {};
  };
  return { directory, calls, webContents: { debugger: dbg, isDestroyed: () => false,
    isDevToolsOpened: () => false, getOSProcessId: () => 12 },
    request: { id: 'incident-123-1', pid: 12, requestedWallMs: Date.now() },
    durationMs: 0, log() {}, inspector: { url: () => 'external-inspector' } };
}
test('existing debugger remains attached and untouched', async t => {
  const f = fixture(t, { attached: true });
  await captureIncidentProfile(f);
  assert.deepEqual(f.calls, []);
  const result = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.profile.json')));
  assert.equal(result.rendererSkipped, 'no-renderer-or-external-debugger');
});
test('existing GLOBAL trace is not stopped; own CPU profile is saved and session detached', async t => {
  const f = fixture(t, { traceBusy: true });
  await captureIncidentProfile(f);
  assert.ok(f.calls.includes('Profiler.stop')); assert.ok(!f.calls.includes('Tracing.end'));
  assert.ok(f.calls.includes('detach')); assert.ok(fs.existsSync(path.join(f.directory, 'incident-123-1.cpuprofile')));
});
test('successful trace uses bounded stream and closes both stream and own session', async t => {
  const f = fixture(t);
  await captureIncidentProfile(f);
  assert.ok(f.calls.includes('IO.close')); assert.equal(f.calls.filter(x => x === 'detach').length, 1);
  const result = JSON.parse(fs.readFileSync(path.join(f.directory, 'incident-123-1.profile.json')));
  assert.equal(result.traceComplete, true); assert.equal(result.traceDataLoss, false);
  assert.ok(result.rendererStartedWallMs >= result.requestedWallMs);
});
test('replacement by user DevTools forbids further commands and detach', async t => {
  const f = fixture(t, { loseOwnership: true });
  await captureIncidentProfile(f);
  assert.ok(!f.calls.includes('Profiler.stop')); assert.ok(!f.calls.includes('Tracing.end'));
  assert.ok(!f.calls.includes('Tracing.start'));
  assert.ok(!f.calls.includes('detach'));
});
