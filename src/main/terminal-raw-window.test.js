'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTerminalRawWindow, observeTerminalRaw, EVENT_CHARGE } = require(process.env.RAW_CONTROL_SOURCE || './terminal-raw-window');

function fixture(limits = {}, persistOverride) {
  let time = 1000, timerId = 0;
  const events = [], timers = new Map();
  const persist = persistOverride || Object.fromEntries(['start', 'append', 'seal'].map(kind => [kind,
    (id, value) => { events.push({ kind, id, ...value }); return true; }]));
  const journal = createTerminalRawWindow({ persist, limits, now: () => time,
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: id => timers.delete(id) });
  const identity = { tabId: 'T', lifecycleGeneration: 'L', mirrorGeneration: 'M', runSeq: 1, stopRevision: 0 };
  const token = {};
  return { journal, events, timers, identity, token,
    output: text => journal.output(token, text, identity),
    pin: extra => journal.pin(token, { incidentId: 'incident-A', identity, headlessSeq: 3334, syncOpen: true, ...extra }),
    at: value => { time = value; },
    expire: () => { for (const { fn } of [...timers.values()]) fn(); },
    commit: (seq = 4000, patch = {}) => journal.commit(token,
      { authoritativeFrameCommitted: true, synchronizedOutputOpen: false, writeSeq: seq, flushedSeq: seq, ...patch }, identity),
  };
}
const text = entries => entries.map(e => e.buffer.toString('utf16le')).join('');

test('early Send failure pins pre-output and keeps a 30-second late frame without writing input', () => {
  const h = fixture(); h.output('\x1b[?2026h'); h.output('start\r\n' + 'Ж'.repeat(180000));
  const reference = h.pin({ sendIdentity: { handoffId: 'H', operationKey: 'O', attemptId: 'A' } });
  h.at(32000); h.output('late\r\n' + '😀'.repeat(140000)); h.output('\x1b[?2026l'); h.commit();
  assert.equal(reference.available, true); assert.equal(h.events[0].kind, 'start');
  const last = h.events.at(-1);
  assert.equal(last.kind, 'seal'); assert.equal(last.summary.end.reason, 'committed-current-frame');
  assert.equal(last.summary.tail.complete, true); assert.equal(h.timers.size, 0);
  assert.equal(text(h.events[0].entries), '\x1b[?2026hstart\r\n' + 'Ж'.repeat(180000));
  assert.equal(text(h.events.filter(e => e.kind === 'append').flatMap(e => e.entries)), 'late\r\n' + '😀'.repeat(140000) + '\x1b[?2026l');
  assert.equal(last.summary.send.attemptId, 'A'); assert.equal(last.summary.replayFromBaselineComplete, false);
});

test('overflow, oversized chunk and global pressure report real loss while storage remains bounded', () => {
  const h = fixture({ rollingBytes: 1024, globalRollingBytes: 1600, preBytes: 1024 });
  h.output('a'.repeat(10000)); const snap = h.journal.snapshot();
  assert.ok(snap.rollingCharge <= 1024);
  h.pin(); const begin = h.events[0];
  assert.equal(begin.summary.pre.lossBeforeCapture.codeUnits, 10000 - (1024 - EVENT_CHARGE) / 2);
  assert.equal(begin.summary.pre.completeWithinRetainedRange, false);
  assert.equal(begin.entries[0].buffer.length + EVENT_CHARGE, 1024);
  for (let i = 0; i < 70; i++) h.journal.output({}, 'b'.repeat(300), { ...h.identity, tabId: 'T' + i });
  assert.ok(h.journal.snapshot().rollingCharge <= 1600);
});

test('tail budget never evicts prefix; dropped suffix and later chunks are explicit', () => {
  const h = fixture({ tailBytes: 1024 }); h.output('original'); h.pin();
  h.output('x'.repeat(1000)); h.output('unretained'); h.commit();
  const end = h.events.at(-1).summary;
  assert.equal(text(h.events[0].entries), 'original'); assert.equal(end.tail.complete, false);
  assert.equal(end.tail.storedCodeUnits + end.tail.droppedCodeUnits, end.tail.seenCodeUnits);
  assert.equal(end.tail.droppedEvents, 1);
});

test('four global pins, one pin per PTY, bounded aliases and active timer disposal', () => {
  const h = fixture(), tokens = Array.from({ length: 5 }, () => ({}));
  for (let i = 0; i < 4; i++) assert.equal(h.journal.pin(tokens[i], { identity: h.identity }).available, true);
  assert.equal(h.journal.pin(tokens[4], { identity: h.identity }).reason, 'pin-admission-budget');
  for (let i = 0; i < 20; i++) assert.equal(h.journal.pin(tokens[0], { identity: h.identity, incidentId: 'alias' + i }).joined, true);
  assert.equal(h.journal.snapshot().pins[0].aliases.length, 16);
  assert.equal(h.journal.snapshot().pins[0].aliasesOmitted, 4);
  h.journal.dispose(); assert.equal(h.timers.size, 0); assert.equal(h.journal.snapshot().activePins, 0);
});

test('old/unflushed/non-authoritative commit cannot stop tail; Stop and owner replacement can', () => {
  const h = fixture(); h.output('before'); h.pin();
  h.commit(3003); h.commit(3335, { flushedSeq: 3334 }); h.commit(3335, { authoritativeFrameCommitted: false });
  assert.equal(h.journal.snapshot().activePins, 1);
  h.identity.stopRevision++; h.output('after Stop');
  assert.equal(h.events.at(-1).summary.end.reason, 'owner-epoch-changed');
  assert.equal(h.events.filter(e => e.kind === 'append').length, 0);
  h.pin(); h.journal.end(h.token, 'terminal-disposed');
  assert.equal(h.events.at(-1).summary.end.reason, 'terminal-disposed');
  assert.equal(h.journal.snapshot().rollingCharge, 0);
});

test('deadline seals the same incident without any frame or synthetic close', () => {
  const h = fixture(); h.output('\x1b[?2026h'); const pin = h.pin(); h.at(61000); h.expire();
  assert.equal(h.events.at(-1).id, pin.id); assert.equal(h.events.at(-1).summary.end.reason, 'tail-deadline');
  assert.equal(h.events.at(-1).summary.tail.seenEvents, 0); assert.equal(h.timers.size, 0);
});

test('split surrogate halves and controls are preserved as delivered, without UTF8 normalization', () => {
  const h = fixture(); h.output('\ud83d'); h.output('\ude00\x1b['); h.pin(); h.output('?2026h\r\n'); h.commit();
  const parts = [...h.events[0].entries, ...h.events.filter(e => e.kind === 'append').flatMap(e => e.entries)];
  assert.equal(parts[0].buffer.toString('utf16le'), '\ud83d');
  assert.equal(parts[1].buffer.toString('utf16le'), '\ude00\x1b[');
  assert.equal(text(parts), '😀\x1b[?2026h\r\n');
});

test('persistence faults and missing observer cannot throw into parser or input', () => {
  const h = fixture({}, { start() { throw Error('disk'); }, append() { return false; }, seal() { throw Error('disk'); } });
  assert.doesNotThrow(() => { h.output('data'); h.pin(); h.output('tail'); h.commit(); });
  assert.equal(h.journal.snapshot().activePins, 0);
  assert.doesNotThrow(() => observeTerminalRaw({ output() { throw Error('observer'); } }, 'output', {}, 'data'));
  assert.doesNotThrow(() => observeTerminalRaw(null, 'output', {}, 'data'));
});

test('recent age eviction is separate from byte pressure', () => {
  const h = fixture({ ageMs: 1000 }); h.output('old'); h.at(3000); h.output('recent'); h.pin();
  assert.equal(text(h.events[0].entries), 'recent');
  assert.equal(h.events[0].summary.pre.lossBeforeCapture.reasons.age, 1);
});

test('joined owned completion extends no clock and only exact receipt keys settle the same pin', () => {
  const h = fixture(); h.output('before'); const a = h.pin();
  const timer = [...h.timers.values()][0].at;
  h.at(2000); const b = h.pin({ completionKey: 'receipt-A' });
  assert.equal(b.id, a.id); assert.equal(b.completionRegistered, true);
  h.pin({ completionKey: 'receipt-B' });
  assert.equal([...h.timers.values()][0].at, timer);
  h.output('OSC'); h.commit(); assert.equal(h.journal.snapshot().activePins, 1);
  assert.equal(h.journal.settle({}, { id: a.id, completionKey: 'receipt-A' }, h.identity), false);
  assert.equal(h.journal.settle(h.token, { id: 'wrong', completionKey: 'receipt-A' }, h.identity), false);
  assert.equal(h.journal.settle(h.token, { id: a.id, completionKey: 'foreign' }, h.identity), false);
  assert.equal(h.journal.settle(h.token, { id: a.id, completionKey: 'receipt-A' }, h.identity), false);
  assert.equal(h.journal.snapshot().pins[0].completion.pending, 1);
  assert.equal(h.journal.settle(h.token, { id: a.id, completionKey: 'receipt-B' }, h.identity), true);
  assert.equal(h.events.at(-1).summary.end.reason, 'owned-control-released');
  assert.equal(h.events.at(-1).summary.completion.pending, 0);
});

test('old completion cannot seal a replacement incident or cross its owner epoch', () => {
  const h = fixture(); h.output('before'); const a = h.pin({ completionKey: 'old' });
  h.identity.runSeq++; h.output('new owner');
  assert.equal(h.events.at(-1).summary.end.reason, 'owner-epoch-changed');
  const b = h.pin({ completionKey: 'new' });
  assert.equal(h.journal.settle(h.token, { id: a.id, completionKey: 'old' }, h.identity), false);
  assert.equal(h.journal.snapshot().pins[0].id, b.id);
  h.identity.stopRevision++;
  assert.equal(h.journal.settle(h.token, { id: b.id, completionKey: 'new' }, h.identity), false);
  assert.equal(h.events.at(-1).summary.end.reason, 'owner-epoch-changed');
});

test('completion registration is bounded and diagnostic expiry remains unresolved, not successful input', () => {
  const h = fixture({ tailBytes: 1024 }); h.output('baseline'); const a = h.pin({ completionKey: 'key-0' });
  for (let i = 1; i <= 20; i++) h.pin({ completionKey: 'key-' + i });
  assert.equal(h.journal.snapshot().pins[0].completion.registered, 16);
  assert.equal(h.journal.snapshot().pins[0].completion.omitted, 5);
  h.output('x'.repeat(2000)); h.output('late'); h.commit();
  assert.equal(h.journal.snapshot().activePins, 1);
  h.expire(); const end = h.events.at(-1).summary;
  assert.equal(end.end.reason, 'tail-deadline'); assert.equal(end.completion.pending, 16);
  assert.equal(end.tail.complete, false); assert.ok(end.tail.droppedCodeUnits > 0);
  assert.equal(h.journal.settle(h.token, { id: a.id, completionKey: 'key-0' }, h.identity), false);
  assert.equal(h.pin({ completionKey: 'bad\nkey' }).reason, 'invalid-completion-key');
});
