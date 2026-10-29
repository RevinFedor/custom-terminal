import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const current = fs.readFileSync(new URL('./TaskDetailPane.tsx', import.meta.url), 'utf8');
function diagnostic(source, raw) {
  const line = source.split('\n').find(line => line.includes("console.warn('[BgProbeR:SubAgentLoad]"));
  assert(line, 'actual diagnostic call missing');
  let value;
  vm.runInNewContext(line.replaceAll('(m: any)', '(m)'), {
    raw, parsed: { length: raw.length }, agentId: 'owned-agent',
    console: { warn: text => { value = text; } },
  });
  return value;
}
test('actual diagnostic never serializes message payload or invokes toJSON', () => {
  const record = { type: 'assistant', toJSON() { throw Error('payload serialization forbidden'); } };
  Object.defineProperty(record, 'content', { get() { throw Error('payload read forbidden'); } });
  assert.match(diagnostic(current, [record]), /rawCount=1 parsedCount=1 rawTypes=assistant$/);
});
test('actual diagnostic visits at most ten records and keeps full raw/parsed counts', () => {
  let visited = 0;
  const rows = Array.from({ length: 100 }, (_, i) => ({ get type() {
    if (i >= 10) throw Error('diagnostic scanned full result');
    visited++; return 'assistant';
  } }));
  const text = diagnostic(current, rows);
  assert.match(text, /rawCount=100 parsedCount=100/);
  assert.equal(text.match(/assistant/g).length, 10);
  assert.equal(visited, 20); // type check + bounded slice for each selected scalar
});
test('actual diagnostic bounds long scalar labels and tolerates missing records', () => {
  const text = diagnostic(current, [null, {}, ...Array.from({ length: 10 }, () => ({ type: 'x'.repeat(262144), subagent_type: 'y'.repeat(262144) }))]);
  assert(text.length < 1100);
  assert.match(text, /rawTypes=unknown,unknown,/);
});
