import test from 'node:test';
import assert from 'node:assert/strict';
import { createUIActionDiagnostics, createStylesheetDiagnostics } from './uiPerformanceDiagnostics.mjs';

test('a removed click target keeps captured source and correlated frame/native outcome', () => {
  let time = 100; const logs = [], native = [];
  const d = createUIActionDiagnostics({ now: () => time, emit: s => logs.push(JSON.parse(s.slice(s.indexOf('{')))), notify: s => native.push(s) });
  const target = { tag: 'button', source: 'HistorySearchBar.tsx:33', secretText: 'SECRET' };
  const a = d.capture('click', 92, target); target.source = '';
  time = 110; d.phase('commit', { ms: 7, text: 'SECRET' });
  d.frame(300); d.frame(320);
  d.eventTiming('click', 92, 230, { handlerMs: 7 });
  assert.equal(logs[1].id, a.id); assert.equal(logs[1].target.source, 'HistorySearchBar.tsx:33');
  assert.equal(native[0].id, a.id); assert.equal(logs[0].frame2Abs, 320);
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
});
test('rings and phase lists are bounded and late work is not attributed to old input', () => {
  let time = 100; const logs = [];
  const d = createUIActionDiagnostics({ now: () => time, emit: s => logs.push(s), max: 4 });
  for (let i = 0; i < 10; i++) { time++; d.capture('keydown', time, {}, false); }
  assert.equal(d.matching('keydown', 101), null);
  for (let i = 0; i < 100; i++) d.phase('phase', { count: i });
  const current = d.matching('keydown', time);
  assert.equal(current.phases.length, 32); assert.equal(current.phasesDropped, 68);
  assert.equal(current.phases.at(-1).count, 99, 'the final phase must survive a busy middle');
  time += 2100; d.phase('unrelated'); assert.equal(current.phasesDropped, 68);
});
test('stylesheet identities expose nested mount/remove without reading rules or walking descendants', () => {
  const d = createStylesheetDiagnostics();
  const sheet = { ownerNode: null, get cssRules() { throw Error('do not inspect CSS'); } };
  d.sample([]); assert.equal(d.sample([sheet]).added.length, 1);
  assert.equal(d.sample([sheet]).added.length, 0);
  assert.equal(d.sample([]).removed.length, 1);
});

test('a delayed rAF keeps mutations with its delivery time even if its frame timestamp predates the click', () => {
  const records = [];
  const d = createUIActionDiagnostics({ now: () => 200, emit: s => records.push(JSON.parse(s.slice(s.indexOf('{')))) });
  d.capture('click', 195, { source: 'button' });
  d.frame(450, { added: [{ id: 1 }], removed: [], omitted: 0 }, 180);
  d.frame(465, null, 460);
  assert.equal(records[0].styles.added[0].id, 1);
  assert.equal(records[0].frame1Abs, 450); assert.equal(records[0].frame1RafTimestampAbs, 180);
});
