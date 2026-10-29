'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createManualCaptureController, handleManualWatchdogRequest, installManualCaptureMenu,
  validManualRequest } = require('./perf-manual-capture');

function fixture(t, options = {}) {
  const wc = new EventEmitter(), window = new EventEmitter(), child = new EventEmitter();
  let currentWindow = window, currentChild = child, pid = 123, loading = false;
  let dead = false, resumes = 0, suspends = 0, resolveCapture, sendCallback;
  const requests = [], captures = [], logs = [], timers = new Set();
  Object.assign(wc, { id: 8, isDestroyed: () => dead, isLoadingMainFrame: () => loading,
    getOSProcessId: () => pid, mainFrame: { processId: 4, routingId: 5, osProcessId: 123 } });
  Object.assign(window, { id: 7, webContents: wc, isDestroyed: () => dead });
  child.connected = true;
  child.send = (m, cb) => { requests.push(m); sendCallback = cb; if (options.sendThrows) throw Error('lost'); };
  const controller = createManualCaptureController({ mainPid: 99, getWatchdog: () => currentChild,
    fromId: () => currentWindow, directory: '/not-accessed',
    capture: args => { captures.push(args); return options.captureFails ? Promise.reject(Error('capture-failed'))
      : new Promise(resolve => { resolveCapture = resolve; }); },
    suspend: target => { assert.equal(target, wc); suspends++; return () => { resumes++; if (options.resumeFails) throw Error('resume-failed'); }; },
    log: line => logs.push(JSON.parse(line.slice(line.indexOf('{')))),
    schedule: fn => { timers.add(fn); return fn; }, cancel: timer => timers.delete(timer) });
  const request = () => controller.request(window);
  const reply = (extra = {}) => ({ ...requests[0], t: 'capture', id: 'incident-123-456', pid: 123, ...extra });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  t.after(() => {
    assert.equal(timers.size, 0, 'admission deadline cleaned');
    if (!options.leavePending) {
      for (const event of ['did-start-navigation', 'did-frame-navigate', 'render-process-gone', 'destroyed']) {
        assert.equal(wc.listenerCount(event), 0, event);
      }
      assert.equal(window.listenerCount('closed'), 0);
      for (const event of ['error', 'exit', 'disconnect']) assert.equal(child.listenerCount(event), 0, event);
    }
  });
  return { wc, window, child, requests, captures, logs, timers, controller, request, reply, flush,
    resolve: value => resolveCapture(value), callback: error => sendCallback(error),
    lose: what => {
      if (what === 'pid') pid++;
      if (what === 'frame') wc.mainFrame = { ...wc.mainFrame, routingId: 50 };
      if (what === 'window') currentWindow = {};
      if (what === 'webcontents') window.webContents = {};
      if (what === 'child') currentChild = { connected: true };
      if (what === 'loading') loading = true;
      if (what === 'destroyed') { dead = true; wc.emit('destroyed'); }
    }, counts: () => ({ suspends, resumes }) };
}

test('typed request is fixed10s, exact owner; duplicate request/reply never starts a second recording', async t => {
  const f = fixture(t); assert.equal(f.request(), true);
  assert.equal(validManualRequest(f.requests[0], 99), true);
  for (const patch of [{ durationMs: 60000 }, { mainPid: 1 }, { reason: 'LongTask' }, { version: 2 }, { kind: 'long-task' }]) {
    assert.equal(validManualRequest({ ...f.requests[0], ...patch }, 99), false);
  }
  assert.equal(f.request(), false); assert.equal(f.requests.length, 1);
  f.controller.handle(f.reply(), f.child); f.controller.handle(f.reply(), f.child);
  assert.equal(f.captures.length, 1); assert.equal(f.captures[0].webContents, f.wc);
  assert.equal(f.captures[0].durationMs, 10000);
  assert.ok(!f.logs.some(x => x.state === 'ready'), 'delivery is not ready');
  f.captures[0].onReady({ rendererCpu: true });
  assert.equal(f.logs.filter(x => x.state === 'ready').length, 1);
  f.resolve({ outcome: 'completed', artifacts: { trace: { bytes: 77 } } }); await f.flush();
  assert.deepEqual(f.counts(), { suspends: 1, resumes: 1 });
  assert.equal(f.logs.at(-1).outcome, 'completed');
  f.controller.handle(f.reply(), f.child); assert.equal(f.captures.length, 1);
});

test('quota refusal is exact, terminal, and never produces ready/suspend/capture', t => {
  const f = fixture(t); f.request();
  f.controller.handle({ t: 'perf-manual-decision', requestId: f.requests[0].requestId,
    allowed: false, reason: 'rolling-quota-exhausted', nextEligibleWallMs: 999, remaining: 0 }, f.child);
  assert.equal(f.logs.at(-1).decision.reason, 'rolling-quota-exhausted');
  assert.equal(f.logs.at(-1).decision.nextEligibleWallMs, 999);
  assert.equal(f.captures.length, 0); assert.deepEqual(f.counts(), { suspends: 0, resumes: 0 });
});

test('stale PID/frame/window/document/watchdog owner never falls back to another window', async t => {
  for (const loss of ['pid', 'frame', 'window', 'webcontents', 'loading', 'destroyed', 'navigation', 'commit', 'gone', 'disconnect']) {
    await t.test(loss, async t => {
      const f = fixture(t); f.request();
      if (loss === 'navigation') f.wc.emit('did-start-navigation', {}, 'ignored', false, true);
      else if (loss === 'commit') f.wc.emit('did-frame-navigate', {}, 'ignored', 200, 'OK', true);
      else if (loss === 'gone') f.wc.emit('render-process-gone');
      else if (loss === 'disconnect') { f.child.connected = false; f.child.emit('disconnect'); }
      else f.lose(loss);
      await f.flush(); f.controller.handle(f.reply(), f.child);
      assert.equal(f.captures.length, 0); assert.equal(f.request(), false);
      assert.ok(f.logs.some(x => x.state === 'unknown'));
    });
  }
});

test('wrong request ID/old watchdog cannot consume a pending request; deadline latches UNKNOWN and cleans listeners', t => {
  const f = fixture(t); f.request();
  f.controller.handle(f.reply({ requestId: 'manual-99-aaaaaaaaaaaaaaaaaaaaaaaa' }), f.child);
  f.controller.handle(f.reply(), { connected: true });
  f.lose('child'); f.controller.handle(f.reply(), f.child);
  assert.equal(f.captures.length, 0); [...f.timers][0]();
  assert.ok(f.logs.some(x => x.state === 'unknown'));
});

test('capture failure releases the original monitor and owner listeners once', async t => {
  const f = fixture(t, { captureFails: true }); f.request(); f.controller.handle(f.reply(), f.child);
  await f.flush(); assert.deepEqual(f.counts(), { suspends: 1, resumes: 1 });
  assert.ok(f.logs.some(x => x.state === 'failed' && x.reason === 'capture-failed'));
});

test('monitor cleanup failure is logged and cannot leak the flight latch or reject an unobserved Promise', async t => {
  const f = fixture(t, { resumeFails: true }); f.request(); f.controller.handle(f.reply(), f.child);
  f.resolve({ outcome: 'incomplete' }); await f.flush();
  assert.deepEqual(f.counts(), { suspends: 1, resumes: 1 });
  assert.ok(f.logs.some(x => x.state === 'cleanup-failed' && x.reason === 'resume-failed'));
});

test('unknown/lost send or admission ACK latches one request without automatic or new click retry', async t => {
  for (const loss of ['callback', 'deadline', 'throw']) await t.test(loss, async t => {
    const f = fixture(t, { sendThrows: loss === 'throw' }); f.request();
    if (loss === 'callback') f.callback(Error('lost'));
    if (loss === 'deadline') [...f.timers][0]();
    f.controller.handle(f.reply(), f.child);
    assert.equal(f.request(), false); assert.equal(f.requests.length, 1); assert.equal(f.captures.length, 0);
    assert.ok(f.logs.some(x => x.state === 'unknown' && x.retry === false));
  });
});

test('accepted admission alone is not ready; later channel/owner loss cancels the same capture and resumes monitor', async t => {
  const f = fixture(t); f.request();
  f.controller.handle({ t: 'perf-manual-decision', requestId: f.requests[0].requestId, allowed: true }, f.child);
  assert.ok(!f.logs.some(x => x.state === 'ready'));
  f.controller.handle(f.reply(), f.child);
  const guard = f.captures[0].ownerGuard;
  f.wc.emit('did-start-navigation', {}, 'ignored', true, true);
  assert.equal(guard.isCurrent(), true, 'same-document route retains lifetime');
  f.wc.emit('did-start-navigation', {}, 'ignored', false, false);
  assert.equal(guard.isCurrent(), true, 'subframe does not replace main document');
  f.wc.emit('render-process-gone');
  assert.equal(await guard.invalidated, 'renderer-gone'); assert.equal(guard.isCurrent(), false);
  f.captures[0].onReady({}); assert.ok(!f.logs.some(x => x.state === 'ready'));
  f.resolve({ outcome: 'incomplete', errors: ['original-owner-lost'] }); await f.flush();
  assert.deepEqual(f.counts(), { suspends: 1, resumes: 1 });
});

test('watchdog validates request and returns exact admission rejection without impersonating a slow event', t => {
  const f = fixture(t), sent = [], kinds = []; f.request();
  const port = { mainPid: 99, stopped: false, log() {}, send: m => sent.push(m),
    flight: { requestManualCapture: m => { kinds.push(m.kind); return { allowed: false, reason: 'startup-warmup' }; } } };
  handleManualWatchdogRequest(f.requests[0], port);
  assert.deepEqual(kinds, ['manual']); assert.equal(sent[0].reason, 'startup-warmup');
  handleManualWatchdogRequest({ ...f.requests[0], durationMs: 20000 }, port);
  assert.equal(sent[1].reason, 'invalid-manual-request'); assert.equal(kinds.length, 1);
  f.controller.handle(sent[0], f.child);
});

test('one native Help item preserves existing menu; click passes the original window and no fallback', () => {
  class Menu { constructor() { this.items = []; } append(item) { this.items.push(item); } }
  class MenuItem { constructor(data) { Object.assign(this, data); if (Array.isArray(data.submenu)) this.submenu = new Menu(); } }
  let menu = new Menu(); const edit = new MenuItem({ role: 'editMenu' }); menu.append(edit);
  Menu.getApplicationMenu = () => menu; Menu.setApplicationMenu = value => { menu = value; };
  const windows = [], controller = { request: win => windows.push(win) };
  installManualCaptureMenu({ Menu, MenuItem, controller }); installManualCaptureMenu({ Menu, MenuItem, controller });
  assert.equal(menu.items[0], edit); assert.equal(menu.items.length, 2);
  const items = menu.items[1].submenu.items; assert.equal(items.length, 1);
  const original = {}; items[0].click(items[0], original); items[0].click(items[0], undefined);
  assert.deepEqual(windows, [original, undefined]);
});
