'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const codexData = require('./ipc/codex-data');
const { makeHistoryRowStub } = require('./history-entry-window');
const source = fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
const ast = ts.createSourceFile('main.js',source,ts.ScriptTarget.Latest,true);
const declaration = name => ast.statements.find(n=>ts.isFunctionDeclaration(n) && n.name?.text===name).getText(ast);
const SID = '01a05364-5bb1-7c11-9252-2622e6882c67';
const record = (line,type,fields={}) => ({ type:'event_msg',__line:line,__byteOffset:line*100,
  timestamp:'2026-10-04T00:00:00Z',payload:{type,turn_id:'turn-1',...fields} });
const abort = record(12,'turn_aborted');
const user = record(10,'user_message',{message:'ordinary prompt'});
const carrier = record(11,'user_message',{message:'<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>'});
function publisher(window=true) {
  const ipc=[],sse=[];
  const context=vm.createContext({CODEX_HISTORY_TURN_BOUNDARIES:new Set(['task_started','task_complete','turn_aborted']),
    codexDataModule:codexData,codexKnownSessions:new Map(),
    mainWindow:window?{isDestroyed:()=>false,webContents:{send:(channel,data)=>ipc.push({channel,...data})}}:null,
    _webBroadcast:(tabId,data)=>sse.push({tabId,...data})});
  vm.runInContext(declaration('emitCodexHistoryLiveTurnBoundary'),context);
  return {ipc,sse,publish:r=>context.emitCodexHistoryLiveTurnBoundary({tabId:'T',sessionId:SID},r,r.payload?.type)};
}

test('actual Main publishes the canonical interruption immediately on the existing boundary, IPC and SSE', () => {
  const p=publisher(); p.publish(abort);
  assert.equal(p.ipc.length,2); assert.equal(p.ipc[0].type,'history_entry'); assert.equal(p.ipc[1].type,'turn_boundary');
  assert.equal(p.sse.length,1); assert.equal(p.sse[0].entry.role,'interrupted');
  const canonical=codexData._api.buildCodexFullHistory([user,abort],SID).find(e=>e.role==='interrupted');
  for (const field of ['uuid','sourceIdentity','sessionId','role','content','serviceCarrier']) assert.equal(p.sse[0].entry[field],canonical[field]);
  const background=publisher(false); background.publish(abort); assert.equal(background.sse.length,1);
  assert.match(declaration('processCodexTurnLine'),/if \(!suppressPublications && event\) \{\s*emitCodexHistoryLiveTurnBoundary/);
});

test('Escape intent, ordinary text, task_complete and unsafe/foreign carriers do not mint an interruption', () => {
  for (const r of [user,record(13,'task_complete'),{...abort,__byteOffset:undefined},
    {...abort,__byteOffset:-1},{...abort,type:'response_item'},record(14,'user_message',{message:'Conversation interrupted'})]) {
    assert.equal(codexData._api.buildCodexInterruptedHistoryEntry(r,SID,undefined,{live:true}),null);
  }
  const p=publisher(); p.publish(record(3,'task_started')); p.publish(record(4,'task_complete'));
  assert.equal(p.sse.length,0);
});

test('live row survives a held/partial History, adopts exact canonical aliases once, and keeps its render key', async () => {
  const {reduceHistoryLiveProjection,buildHistoryLivePresentation,historyLivePresentationKey,reconcileCommittedHistoryLiveProjection}=await import('../renderer/utils/historyLiveProjection.mjs');
  const p=publisher(); p.publish({...abort,__line:undefined});
  let live=reduceHistoryLiveProjection([],p.sse[0]); assert.equal(live.length,1);
  live=reduceHistoryLiveProjection(live,p.sse[0]); assert.equal(live.length,1);
  const keys=new Map(); const options={settingsPresentationKeys:keys};
  const shown=buildHistoryLivePresentation([],live,options);
  const key=historyLivePresentationKey(shown[0]);
  const firstRead=codexData._api.buildCodexFullHistory([user],SID);
  assert.equal(buildHistoryLivePresentation(firstRead,live,options).filter(e=>e.role==='interrupted').length,1);
  const canonical=codexData._api.buildCodexFullHistory([user,carrier,abort],SID);
  const interrupted=canonical.find(e=>e.role==='interrupted');
  assert.equal(canonical.filter(e=>e.role==='interrupted').length,1);
  assert.ok(interrupted.sourceIdentityAliases.includes(p.sse[0].entry.sourceIdentity));
  const merged=buildHistoryLivePresentation(canonical,live,options).filter(e=>e.role==='interrupted');
  assert.equal(merged.length,1); assert.equal(historyLivePresentationKey(merged[0]),key);
  assert.equal(reconcileCommittedHistoryLiveProjection(live,canonical).entries.length,0);
  const after=buildHistoryLivePresentation(canonical,[],options).find(e=>e.role==='interrupted');
  assert.equal(historyLivePresentationKey(after),key);
  const stub=buildHistoryLivePresentation([makeHistoryRowStub(interrupted)],[],options)[0];
  assert.equal(historyLivePresentationKey(stub),key);
  const foreign=canonical.map(e=>({...e,sourceIdentity:e.sourceIdentity?.replace(SID,'other'),sourceIdentityAliases:[],sessionId:'other'}));
  assert.equal(reconcileCommittedHistoryLiveProjection(live,foreign).entries.length,1);
});

test('new prompt creates a second interruption while same text and nested subagent interruption are not main boundaries', () => {
  const canonical=codexData._api.buildCodexFullHistory([user,abort,record(15,'user_message',{message:'next'}),record(17,'turn_aborted')],SID);
  assert.equal(canonical.filter(e=>e.role==='interrupted').length,2);
  assert.equal(codexData._api.buildCodexInterruptedHistoryEntry(record(18,'sub_agent_activity',{kind:'interrupted'}),SID,undefined,{live:true}),null);
});
