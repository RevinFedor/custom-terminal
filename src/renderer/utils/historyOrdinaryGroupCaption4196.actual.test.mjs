import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildHistoryDisplayUnits } from './historyDisplayUnits.mjs';
import { ordinaryHistoryHydrationDemand } from './historyOrdinaryHydrationWindow.mjs';
import { collectHistoryMaterializedWindowUuids, retainHistoryMaterializedWindow } from './historyMaterializedWindow.mjs';

const { applyHistoryRowWindow } = createRequire(import.meta.url)('../../main/history-entry-window.js');
const text = (uuid, content) => ({ uuid, role: 'assistant', textPhase: 'commentary', content, contentRevision: '1' });
const call = i => ({ uuid: `call-${i}`, role: 'assistant', content: '', contentRevision: '1', actions: [{
  tool: '__raw__', rawTool: { toolUseId: `tool-${i}`, toolName: 'Read', family: 'read', args: { file_path: `file-${i}` }, result: 'ok' },
}] });

test('ordinary viewport requests the real multiline captions of three groups and retains exact bodies', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ uuid: `before-${i}`, role: 'user', content: `before ${i}`, contentRevision: '1' }));
  for (let group = 0; group < 3; group++) {
    rows.push(text(`caption-${group}`, `Caption ${group}\n**full multiline** Ω`));
    for (let i = 0; i < 30; i++) rows.push(call(group * 30 + i));
  }
  rows.push(...Array.from({ length: 80 }, (_, i) => ({ uuid: `after-${i}`, role: 'user', content: `after ${i}`, contentRevision: '1' })));
  let current = applyHistoryRowWindow(rows, { radius: 16, alwaysHydrateTail: 32 }).entries;
  let units = buildHistoryDisplayUnits(current, { responseWork: false });
  const indices = units.flatMap((unit, index) => unit.kind === 'group' && unit.captionEntry ? [index] : []);
  assert.equal(indices.length, 3);
  const range = { start: indices[0], end: indices[2] };
  assert.deepEqual(indices.map(i => units[i].captionEntry.uuid), ['caption-0', 'caption-1', 'caption-2']);
  assert.ok(indices.every(i => units[i].captionEntry.rowStub));
  const demand = ordinaryHistoryHydrationDemand(current, units, range, new Map());
  assert.equal(demand.stubUuid, 'caption-0');
  const incoming = applyHistoryRowWindow(rows, { centerUuid: demand.centerUuid, radius: demand.radius, alwaysHydrateTail: 32 }).entries;
  const retained = retainHistoryMaterializedWindow(current, incoming, collectHistoryMaterializedWindowUuids(units, range)).entries;
  units = buildHistoryDisplayUnits(retained, { responseWork: false });
  assert.deepEqual(indices.map(i => units[i].captionEntry.content), [0, 1, 2].map(i => `Caption ${i}\n**full multiline** Ω`));
  assert.equal(ordinaryHistoryHydrationDemand(retained, units, range, new Map()), null);
  assert.ok(retained.filter(row => !row.rowStub).length < rows.length);
});
