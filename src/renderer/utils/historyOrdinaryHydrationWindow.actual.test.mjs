import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { buildHistoryDisplayUnits } from './historyDisplayUnits.mjs';
import { ordinaryHistoryHydrationDemand } from './historyOrdinaryHydrationWindow.mjs';
import { collectHistoryMaterializedWindowUuids, retainHistoryMaterializedWindow } from './historyMaterializedWindow.mjs';
import { isHistoryHydrationTargetStub } from './historyHydrationTarget.mjs';
const require = createRequire(import.meta.url);
const { applyHistoryRowWindow } = require('../../main/history-entry-window.js');
const panel = readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const start = panel.indexOf('  const maybeRequestHistoryHydration = useCallback(');
const end = panel.indexOf('  const scheduleHistoryHydrationRangeCheck = useCallback(', start);
assert.ok(start >= 0 && end > start);
const watcher = transformSync(panel.slice(start, end), { loader: 'ts' }).code;
const ref = current => ({ current });
function harness(rows) {
  const calls = [];
  const env = { useCallback: fn => fn, toolType: 'codex', primaryRootRef: ref(null),
    historyPresentationProofRef: ref({ presented: true }), hydrationRequestInFlightRef: ref(false),
    hydrationRangePendingRef: ref(null), historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(1),
    hydrationBurstRef: ref({ since: 0, count: 0, tripped: false }), performance: { now: () => 100 },
    HYDRATION_BURST_WINDOW_MS: 5000, HYDRATION_BURST_MAX_REQUESTS: 20, historyDiag() {}, tabId: 'test',
    historyJumpHydrationActiveRef: ref(false), historyRestoreInFlightRef: ref(0),
    visibleRangeRef: ref({ start: 0, end: 0 }), rawServerEntriesRef: ref(rows),
    displayUnitsRef: ref([]), groupCaptionSelectionsRef: ref(new Map()), ordinaryHistoryHydrationDemand,
    requestHistoryHydrationAt: (...args) => calls.push(args) };
  return { env, calls, run: new Function('env', `const {${Object.keys(env).join(',')}} = env;\n${watcher}\nreturn maybeRequestHistoryHydration;`)(env) };
}
const rows = Array.from({ length: 128 }, (_, i) => ({ uuid: `r${i}`, role: i % 2 ? 'assistant' : 'user',
  content: `content-${i}-` + 'x'.repeat(1200), sourceIdentity: `source-${i}`, contentRevision: '1' }));
const units = entries => buildHistoryDisplayUnits(entries);
test('actual cold-tail policy covers the viewport and two ordinary short wheel advances',()=>{
  const match=panel.match(/const HISTORY_HYDRATION_TAIL_ROWS = (\d+);/);assert(match);
  const tail=Number(match[1]);assert.equal(tail,32);
  const initial=applyHistoryRowWindow(rows,{radius:16,alwaysHydrateTail:tail}).entries;
  for(const range of [{start:116,end:127},{start:113,end:124},{start:110,end:121}]){
    assert(initial.slice(range.start,range.end+1).every(row=>!row.rowStub));
    assert.equal(ordinaryHistoryHydrationDemand(initial,units(initial),range),null);
  }
  assert.equal(initial.filter(row=>!row.rowStub).length,32);
});
test('already covered viewport does not traverse the raw history', () => {
  const raw = new Array(100000);
  Object.defineProperty(raw, '0', { get() { throw Error('unexpected historical scan'); } });
  assert.equal(ordinaryHistoryHydrationDemand(raw, [{kind:'entry',entry:rows[30]}], {start:0,end:0}), null);
});
test('actual seek exit re-arms the skipped hydration check, but a retired scroller cannot', () => {
  const from=panel.indexOf('  historyScrollSeekTransitionRef.current = (');
  const to=panel.indexOf('  historyPresentationHideCleanupRef.current =',from);
  assert(from>0&&to>from);
  const script=transformSync(panel.slice(from,to),{loader:'ts'}).code;
  let hydration=0,rows=0;
  const env={historyScrollSeekTransitionRef:ref(null),historySeekRealRowsReadyCancelRef:ref(null),
    virtuosoScrollerRef:ref({isConnected:true}),freezeHistoryWheelGeometry(){},
    scheduleHistorySeekRealRowsReady(){rows++;},scheduleHistoryHydrationRangeCheck(){hydration++;},
    releaseHistoryWheelGeometryFreeze(){},historyWheelGeometryFreezeRef:ref({scroller:null}),
    setHistorySeekGeometryMask(){},captureHistoryWheelGeometryAnchor(){},historyDiag(){},
    historyTabIdRef:ref('finite'),requestAnimationFrame(){}};
  new Function('env',`const {${Object.keys(env).join(',')}}=env;${script}`)(env);
  env.historyScrollSeekTransitionRef.current({kind:'exit',reason:'velocity-settled'});
  assert.equal(hydration,1);assert.equal(rows,1);
  for(const reason of ['scroller-change','scroller-gone'])env.historyScrollSeekTransitionRef.current({kind:'exit',reason});
  env.virtuosoScrollerRef.current.isConnected=false;
  env.historyScrollSeekTransitionRef.current({kind:'exit',reason:'velocity-settled'});
  assert.equal(hydration,1);assert.equal(rows,1);
});
function read(h, range, previous) {
  h.env.visibleRangeRef.current = range;
  h.env.displayUnitsRef.current = units(previous);
  h.env.rawServerEntriesRef.current = previous;
  h.calls.length = 0; h.run('restore-settled');
  if (!h.calls.length) return previous;
  const [centerUuid, , , radius] = h.calls[0];
  const incoming = applyHistoryRowWindow(rows, { centerUuid, radius, alwaysHydrateTail: 16 }).entries;
  const protectedUuids = collectHistoryMaterializedWindowUuids(h.env.displayUnitsRef.current, range);
  return retainHistoryMaterializedWindow(previous, incoming, protectedUuids).entries;
}
test('actual ordinary watcher requests viewport-sized windows and moving evicts, revisiting restores', () => {
  const h = harness(rows);
  let current = applyHistoryRowWindow(rows, { radius: 16, alwaysHydrateTail: 16 }).entries;
  current = read(h, { start: 3, end: 12 }, current);
  assert.equal(h.calls.length, 1);
  assert.ok(current.slice(3,13).every(r => !r.rowStub));
  assert.equal(current[4].content, rows[4].content);
  current = read(h, { start: 75, end: 114 }, current);
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0][3] >= 36, '40 visible rows fit, plus buffer');
  assert.ok(current.slice(75,115).every(r => !r.rowStub));
  assert.equal(current[4].rowStub, true, 'old body becomes a stub');
  assert.ok(current.filter(r => !r.rowStub).length <= 75);
  current = read(h, { start: 75, end: 114 }, current);
  assert.equal(h.calls.length, 0, 'covered viewport does not rehydrate');
  current = read(h, { start: 3, end: 12 }, current);
  assert.equal(current[4].content, rows[4].content);
  assert.equal(current[85].rowStub, true);
  assert.equal(isHistoryHydrationTargetStub(current, 'r65'), true);
  const jumped = applyHistoryRowWindow(rows, { centerUuid: 'r65', radius: 16, alwaysHydrateTail: 16 }).entries;
  assert.equal(isHistoryHydrationTargetStub(jumped, 'r65'), false);
  assert.equal(jumped[65].content, rows[65].content);
  assert.match(panel, /requestHistoryHydrationAt\(targetUuid/);
  assert.match(panel, /radius: hydrationRadiusRef\.current/);
});
test('collapsed groups request only their selected visible caption, never hidden members', () => {
  const entries = rows.map((r, i) => ({ ...r, rowStub: true, content: undefined }));
  const group = { kind: 'group', key: 'g', familyKey: 'tool', expanded: false,
    entries: entries.slice(20, 80), captionEntry: entries[65] };
  const h = harness(entries);
  h.env.visibleRangeRef.current = { start: 0, end: 2 };
  h.env.displayUnitsRef.current = [{ kind: 'entry', entry: entries[10] }, group, { kind: 'entry', entry: entries[90] }];
  h.run('restore-settled');
  const [centerUuid, , , radius] = h.calls[0];
  const projected = applyHistoryRowWindow(rows, { centerUuid, radius, alwaysHydrateTail: 16 }).entries;
  assert.ok([10,65,90].every(i => !projected[i].rowStub));
  h.env.rawServerEntriesRef.current = projected;
  h.env.displayUnitsRef.current = [{ kind: 'entry', entry: projected[10] },
    { ...group, entries: projected.slice(20,80), captionEntry: projected[65] }, { kind: 'entry', entry: projected[90] }];
  h.calls.length = 0; h.run('restore-settled');
  assert.equal(h.calls.length, 0);
});
test('range skipped during an older flight retains only an owner/visit wake',()=>{
 const h=harness(rows);h.env.hydrationRequestInFlightRef.current=true;
 h.env.historyPresentationProofRef.current={presented:true,visit:9};
 h.run('range-idle');assert.equal(h.calls.length,0);
 assert.deepEqual(h.env.hydrationRangePendingRef.current,{ownerKey:'owner',generation:1,visit:9});
});
test('actual flight settlement wakes the current deferred viewport once, not a hidden or newer visit',async()=>{
 const from=panel.indexOf('  requestHistoryHydrationAtRef.current = (');
 const to=panel.indexOf('  const cycleHistoryGroupCaption =',from);
 const code=transformSync(panel.slice(from,to),{loader:'ts'}).code;
 for(const stale of [false,true]){
  let complete,wakes=0;const env={requestHistoryHydrationAtRef:ref(null),primaryRootRef:ref(null),hydrationRequestInFlightRef:ref(false),
   historyOwnerKeyRef:ref('owner'),historyOwnerGenerationRef:ref(1),hydrationLastResultRef:ref(null),hydrationLastIssuedRef:ref(new Map()),
   performance:{now:()=>100},HYDRATION_REISSUE_COOLDOWN_MS:5000,hydrationCenterUuidRef:ref(null),hydrationRadiusRef:ref(16),
   hydrationPendingRef:ref(null),hydrationRequestSeqRef:ref(0),HISTORY_HYDRATION_RADIUS_ROWS:16,historyDiag(){},tabId:'finite',useCallback:f=>f,
   loadHistoryRef:ref(()=>new Promise(resolve=>{complete=resolve;})),hydrationRangePendingRef:ref(null),
   hydrationRangeCheckRef:ref(()=>wakes++),historyPresentationProofRef:ref({presented:true,visit:2}),
   historyPresentationOwnsWrite:(proof,visit)=>proof.presented&&proof.visit===visit};
  const request=new Function('env',`const {${Object.keys(env).join(',')}}=env;${code};return requestHistoryHydrationAt;`)(env);
  request('r10','range-idle');env.hydrationRangePendingRef.current={ownerKey:'owner',generation:1,visit:2};
  if(stale)env.historyPresentationProofRef.current={presented:true,visit:3};
  complete(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(wakes,stale?0:1);assert.equal(env.hydrationRangePendingRef.current,null);
  assert.equal(env.hydrationRequestInFlightRef.current,false);
 }
});
test('live work stays available outside the window and a giant row is not capped', () => {
  const input = rows.map(r => ({ ...r }));
  input[2] = { ...input[2], actions: [{ tool: 'Task', toolUseId: 'live', subagentStatus: 'running' }] };
  input[40] = { ...input[40], content: 'large'.repeat(30000) };
  const result = applyHistoryRowWindow(input, { centerUuid: 'r40', radius: 16, alwaysHydrateTail: 16 }).entries;
  assert.equal(result[2].rowStub, undefined);
  assert.equal(result[40].content, input[40].content);
  assert.equal(result[3].rowStub, true);
});
test('actual request caller preserves radius, exact jump and prompt revisit across a moved window', async () => {
  const from = panel.indexOf('  requestHistoryHydrationAtRef.current = (');
  const to = panel.indexOf('  const cycleHistoryGroupCaption =', from);
  assert.ok(from >= 0 && to > from);
  const code = transformSync(panel.slice(from, to), { loader: 'ts' }).code;
  const calls = [], center = ref(null), radius = ref(16), pending = ref(null), inFlight = ref(false);
  const env = { requestHistoryHydrationAtRef: ref(null), primaryRootRef: ref(null), hydrationRequestInFlightRef: inFlight,
    historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(1), hydrationLastResultRef: ref(null),
    hydrationLastIssuedRef: ref(new Map()), performance: { now: () => 100 }, HYDRATION_REISSUE_COOLDOWN_MS: 5000,
    hydrationCenterUuidRef: center, hydrationRadiusRef: radius, hydrationPendingRef: pending,
    hydrationRequestSeqRef: ref(0), HISTORY_HYDRATION_RADIUS_ROWS: 16, historyDiag() {}, tabId: 'tab',
    hydrationRangePendingRef: ref(null),hydrationRangeCheckRef:ref(null),historyPresentationProofRef:ref({presented:true,visit:1}),
    historyPresentationOwnsWrite:(proof,visit)=>proof.presented&&proof.visit===visit,
    useCallback: f => f, loadHistoryRef: ref(async () => { calls.push([center.current, radius.current]); return true; }) };
  const request = new Function('env', `const {${Object.keys(env).join(',')}} = env;\n${code}\nreturn requestHistoryHydrationAt;`)(env);
  request('r40', 'range-idle', '', 36); await new Promise(resolve => setImmediate(resolve));
  request('r80', 'timeline'); await new Promise(resolve => setImmediate(resolve));
  request('r40', 'range-idle', '', 36); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['r40',36], ['r80',16], ['r40',36]]);
  assert.equal(request('r40', 'range-idle', '', 36), false, 'same current request remains guarded');
});
test('actual delta reassembly replaces old full bodies with new stubs', () => {
  const from = panel.indexOf('const reassembleHistoryDeltaEntries = (');
  const to = panel.indexOf('const entryClockMs =', from);
  assert.ok(from >= 0 && to > from);
  const code = transformSync(panel.slice(from, to), { loader: 'ts' }).code;
  const reassemble = new Function(`${code}\nreturn reassembleHistoryDeltaEntries;`)();
  const old = applyHistoryRowWindow(rows, { centerUuid: 'r20', radius: 16, alwaysHydrateTail: 16 }).entries;
  const next = applyHistoryRowWindow(rows, { centerUuid: 'r85', radius: 16, alwaysHydrateTail: 16 }).entries;
  const changed = next.filter((r, i) => Boolean(r.rowStub) !== Boolean(old[i].rowStub));
  const merged = reassemble(old, next.map(r => r.uuid), changed);
  assert.equal(merged[20].rowStub, true);
  assert.equal(merged[20].content, undefined);
  assert.equal(merged[85].content, rows[85].content);
});
