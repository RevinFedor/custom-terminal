import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canStopObservedProcess, executeObservedProcessStops, freezeProcessStopTargets, processControlRows,
} from './globalProcessControls.mjs';

const ai = (overrides = {}) => ({ pid: 101, ppid: 1, command: 'codex --no-alt-screen',
  startTime: '12:40', cwd: '/fixture', tabId: null, kind: 'ai', provider: 'codex',
  ownerInstance: 'external', ownerPid: null, protectedByApp: false, killable: true, ...overrides });
const inventory = rows => ({ claude: [], gemini: [], codex: rows.filter(x => x.kind === 'ai'),
  mcp: rows.filter(x => x.kind === 'mcp'), electronDev: rows.filter(x => x.kind === 'electron') });
const run = async (targets, fresh, extra = {}) => {
  const writes = [];
  const result = await executeObservedProcessStops(targets, {
    readInventory: async () => inventory(fresh), findTab: () => null,
    invoke: async (...args) => { writes.push(args); return { success: true }; }, ...extra,
  });
  return { result, writes };
};

test('bulk preserves external-only provider targets and never includes tab/other-app/protected/unknown', () => {
  const rows = [ai(), ai({pid:102,tabId:'T',ownerInstance:'current',protectedByApp:true}),
    ai({pid:103,ownerInstance:'custom-terminal',protectedByApp:true,killable:false}),
    ai({pid:104,protectedByApp:undefined})];
  assert.deepEqual(freezeProcessStopTargets(rows, true).map(x => x.pid), [101]);
  assert.equal(canStopObservedProcess(rows[1]), true);
  assert.equal(canStopObservedProcess(rows[2]), false);
  assert.equal(Object.isFrozen(freezeProcessStopTargets(rows)[0]), true);
});
test('same PID with changed observed process, parent, owner, protection or provider refuses before write', async () => {
  const original = ai();
  for (const delta of [{command:'foreign'}, {ppid:77}, {startTime:'12:41'}, {cwd:'/other'},
    {ownerPid:123}, {ownerInstance:'custom-terminal',protectedByApp:true}, {killable:false}, {tabId:'replacement'}]) {
    const {result,writes} = await run([original], [ai(delta)]);
    assert.equal(writes.length, 0); assert.equal(result[0].success, false);
  }
  assert.equal((await run([original], [])).writes.length, 0);
});
test('CPU/MEM drift does not invalidate exact external kill; bulk does not expand', async () => {
  const original = ai();
  const {writes} = await run(freezeProcessStopTargets([original], true), [ai({cpu:'12',mem:'3'}), ai({pid:999})]);
  assert.deepEqual(writes, [['system:kill-process',101]]);
});
test('bound current tab uses owned stop API, including unopened background owner; loaded mismatched tab refuses', async () => {
  const original = ai({tabId:'T',ownerInstance:'current',ownerPid:60,protectedByApp:true});
  const accepted = await run([original],[original]);
  assert.deepEqual(accepted.writes, [['terminal:stop-ai-process',{tabId:'T',toolType:'codex',reason:'manual-global-process-controls'}]]);
  assert.equal((await run([original],[original],{findTab:()=>({commandType:'claude'})})).writes.length,0);
});
test('Electron Dev preserves dedicated API and exact launcher identity', async () => {
  const original = ai({kind:'electron',provider:'electron',launcherPid:91});
  assert.deepEqual((await run([original],[original])).writes,[['system:kill-electron-dev-process',101]]);
  assert.equal((await run([original],[{...original,launcherPid:92}])).writes.length,0);
});
test('MCP cleanup only targets orphan rows and refuses a reattached/protected process', async () => {
  const original = ai({kind:'mcp',provider:'mcp',isAlive:false});
  assert.equal(processControlRows(inventory([original,{...original,pid:102,isAlive:true}]),'mcp-orphans').length,1);
  assert.deepEqual((await run([original],[original])).writes,[['system:kill-process',101]]);
  assert.equal((await run([original],[{...original,isAlive:true}])).writes.length,0);
});
test('delayed read followed by menu disposal cannot send a process action', async () => {
  let valid = true;
  const {writes} = await run([ai()],[ai()],{isCurrent:()=>valid,readInventory:async()=>{valid=false;return inventory([ai()]);}});
  assert.equal(writes.length,0);
});
test('Main refusal and invalid inventory remain explicit failure, not a successful stop', async () => {
  const {result} = await run([ai()],[ai()],{invoke:async()=>({success:false,error:'protected custom-terminal process'})});
  assert.equal(result[0].success,false); assert.equal(result[0].error,'protected custom-terminal process');
  assert.throws(()=>processControlRows({}),/unavailable/);
});
test('MCP menu retains individual current live Stop while bulk stays orphan-only; Main receives the full birth observation',async()=>{
  const live=ai({kind:'mcp',provider:'mcp',isAlive:true,ownerInstance:'current',protectedByApp:true,
    processStartedAt:'Tue Oct 6 22:18:19 2026'});
  const orphan=ai({kind:'mcp',provider:'mcp',pid:102,isAlive:false});
  assert.equal(processControlRows(inventory([live,orphan]),'mcp').length,2);
  assert.equal(canStopObservedProcess(live),true);assert.equal(canStopObservedProcess(live,true),false);
  assert.deepEqual(freezeProcessStopTargets([live,orphan],true).map(row=>row.pid),[102]);
  const accepted=await run([live],[live]);
  assert.equal(accepted.writes[0][1].expectedProcess.processStartedAt,live.processStartedAt);
  assert.equal((await run([live],[{...live,processStartedAt:'Tue Oct 6 22:18:20 2026'}])).writes.length,0);
});
