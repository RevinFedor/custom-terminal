import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import * as ui from './uiPerformanceDiagnostics.mjs';

const module = { exports: {} };
const compiled = transformSync(readFileSync(new URL('./perfIncidentChannel.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'node18' }).code;
new Function('module', 'exports', 'require', compiled)(module, module.exports, name => {
  assert.equal(name, './uiPerformanceDiagnostics.mjs'); return ui;
});
const { createPerfIncidentChannel, createPerfSocketWriter, addDiagnosticCount } = module.exports;
const hb = { abs: 10000, vis: 'visible', focused: true, context: 'appView=workspace' };
class Socket extends EventEmitter {
  destroyed = false; writable = true; writableLength = 0;
  acceptsMore = true; fail = false; lines = [];
  write(line) {
    if (this.fail) throw Error('SECRET transport error');
    this.lines.push(JSON.parse(line)); return this.acceptsMore;
  }
}
function harness(readActionHealth) {
  let at = 0;
  const channel = createPerfIncidentChannel({ now: () => at, emittedNow: () => 10000 + at,
    sourceBoot: 'test-boot', ...(readActionHealth ? { readActionHealth } : {}) });
  return { channel, time: value => { at = value; } };
}

test('no connection and throttling remain visible across reconnects in the next heartbeat', () => {
  const { channel, time } = harness();
  assert.equal(channel.report('ui-keydown', 9000, 120, 'ui-abc-1'), false);
  assert.equal(channel.report('ui-keydown', 9000, 119), false);
  assert.equal(channel.report('long-task', NaN, 300), false);
  const first = new Socket(); channel.setWriter(createPerfSocketWriter(first, 23));
  time(50); assert.equal(channel.report('ui-keydown', 9000, 120, 'ui-abc-2'), true);
  time(500); assert.equal(channel.report('ui-keyup', 9100, 200, 'ui-abc-3'), false);
  channel.setWriter(null);
  time(600); assert.equal(channel.report('long-task', 9500, 300), false);
  const next = new Socket(); channel.setWriter(createPerfSocketWriter(next, 23));
  time(900); assert.equal(channel.report('long-task', 9500, 300), false, 'reconnect does not reset the one-second throttle');
  channel.heartbeat(hb);
  const packet = next.lines[0];
  assert.equal(first.lines[0].sourceSeq, 2); assert.equal(packet.sourceSeq, 6);
  assert.equal(first.lines[0].sourceBoot, packet.sourceBoot); assert.equal(packet.emittedAbs, 10900);
  assert.deepEqual(packet.diagnosticHealth.drops, { noConnection: 2, rateLimit: 2, backpressure: 0, writeThrow: 0 });
  assert.equal(packet.diagnosticHealth.delivery, 'socket-write-only-no-ack');
  time(1050); assert.equal(channel.report('ui-keyup', 9900, 150, 'ui-abc-4'), true);
  channel.heartbeat(hb);
  assert.equal(next.lines.at(-1).diagnosticHealth.drops.rateLimit, 2, 'a successful heartbeat never erases loss');
  assert.equal(next.lines[1].actionId, 'ui-abc-4');
});

test('write false is accepted once; later packets drop until drain with no queue or replay', () => {
  const { channel, time } = harness();
  const socket = new Socket(); socket.acceptsMore = false;
  channel.setWriter(createPerfSocketWriter(socket, 23));
  assert.equal(channel.report('long-task', 9000, 300), true);
  assert.equal(channel.health().drops.backpressure, 0, 'false is not a loss of the accepted write');
  assert.equal(channel.heartbeat(hb), false);
  time(1000); assert.equal(channel.report('ui-keydown', 9800, 180), false);
  time(1100); assert.equal(channel.report('ui-keydown', 9800, 180), false);
  assert.equal(socket.lines.length, 1);
  socket.acceptsMore = true; socket.emit('drain');
  assert.equal(channel.heartbeat(hb), true);
  assert.equal(socket.lines.length, 2, 'no dropped packet gets replayed');
  assert.deepEqual(socket.lines[1].diagnosticHealth.drops,
    { noConnection: 0, rateLimit: 1, backpressure: 2, writeThrow: 0 });
  socket.writableLength = 16384;
  assert.equal(channel.heartbeat(hb), false);
  socket.writableLength = 0;
  assert.equal(channel.heartbeat(hb), true);
  assert.equal(socket.lines.at(-1).diagnosticHealth.drops.backpressure, 3);
  socket.destroyed = true; time(3000);
  assert.equal(channel.report('long-task', 10000, 300), false);
  const replacement = new Socket(); channel.setWriter(createPerfSocketWriter(replacement, 23));
  channel.heartbeat(hb);
  assert.equal(replacement.lines[0].diagnosticHealth.drops.noConnection, 1);
  assert.equal(replacement.lines[0].diagnosticHealth.drops.backpressure, 3);
});

test('throwing writes are isolated, counted once and never retried', () => {
  const { channel } = harness(); const socket = new Socket(); socket.fail = true;
  channel.setWriter(createPerfSocketWriter(socket, 23));
  assert.equal(channel.report('long-task', 9000, 300), false);
  assert.equal(channel.heartbeat(hb), false);
  assert.equal(socket.lines.length, 0);
  socket.fail = false; channel.heartbeat(hb);
  assert.equal(socket.lines[0].diagnosticHealth.drops.writeThrow, 2);
  assert.doesNotMatch(JSON.stringify(socket.lines), /SECRET/);
});

test('health counters saturate monotonically and snapshots do not expose mutable state', () => {
  const cap = ui.DIAGNOSTIC_COUNTER_LIMIT;
  assert.equal(addDiagnosticCount(cap - 1, 50), cap);
  assert.equal(addDiagnosticCount(cap), cap);
  assert.equal(addDiagnosticCount(12, -100), 12);
  assert.equal(addDiagnosticCount(12, NaN), 12);
  let ring = cap + 100, phases = 7;
  const { channel } = harness(() => ({ actionRingEvicted: ring, actionPhasesDropped: phases }));
  const state = channel.health();
  assert.equal(state.actionRingEvicted, cap); assert.equal(state.saturated, true);
  state.drops.noConnection = 999; ring = 0; phases = 0;
  const later = channel.health();
  assert.equal(later.actionRingEvicted, cap); assert.equal(later.actionPhasesDropped, 7);
  assert.equal(later.drops.noConnection, 0);
});

test('incident wire is bounded and allowlisted; no key text, URL, phase or prototype payload escapes', () => {
  const { channel } = harness(); const socket = new Socket();
  channel.setWriter(createPerfSocketWriter(socket, 23));
  const summary = Object.assign(Object.create({ meta: true, handlerMs: 999, event: 'SECRET' }), {
    keyClass: 'constructor', target: Object.create({ source: 'SECRET' }),
    inputDelayMs: 20, presentationMs: 90, phases: new Array(100000).fill('SECRET'),
    key: 'SECRET', code: 'SECRET', text: 'SECRET', url: 'https://secret.invalid',
    toJSON() { throw Error('never serialize the input'); },
  });
  Object.defineProperty(summary, 'repeat', { get() { throw Error('do not invoke snapshot getters'); } });
  channel.report('ui-keydown', 9000, 200, 'ui-abc-1', summary);
  const packet = socket.lines[0];
  assert.equal(packet.actionId, 'ui-abc-1'); assert.equal(packet.keyClass, 'Other');
  assert.equal(packet.meta, false); assert.equal(packet.handlerMs, null);
  assert.deepEqual([packet.inputDelayMs, packet.presentationMs], [20, 90]);
  assert.equal(packet.coverage, ui.UI_ACTION_COVERAGE);
  assert.doesNotMatch(JSON.stringify(packet), /SECRET|constructor|https:|phases|payload|"key"|"code"/);
  assert.ok(JSON.stringify(packet).length < 1000);
  channel.heartbeat(Object.create({ context: 'SECRET', focused: true }));
  channel.heartbeat({ ...hb, context: 'https://secret.invalid' });
  assert.equal(socket.lines[1].context, ''); assert.equal(socket.lines[1].focused, false);
  assert.equal(socket.lines[2].context, '');
});

test('flat target fields have fixed bounds and are copied before later target mutation', () => {
  const { channel } = harness(); const socket = new Socket();
  channel.setWriter(createPerfSocketWriter(socket, 23));
  const target = { source: 's'.repeat(100000), tag: 't'.repeat(100000), tab: 'b'.repeat(100000), historyOwner: 'o'.repeat(100000),
    get textContent() { throw Error('no text'); }, get value() { throw Error('no value'); } };
  channel.report('ui-click', 9000, 200, 'ui-abc-1', { event: 'click', target, handlerMs: 100 });
  target.source = 'removed'; target.tab = 'changed';
  const record = socket.lines[0];
  assert.deepEqual([record.targetSource.length, record.targetTag.length, record.tabId.length, record.historyOwner.length], [180, 40, 80, 80]);
  assert.equal(record.targetSource, 's'.repeat(180)); assert.equal(record.tabId, 'b'.repeat(80));
  assert.ok(JSON.stringify(record).length < 1100);
});
