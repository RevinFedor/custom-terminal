'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const esbuild = require('esbuild');
const { imagePresentationFromReceipt } = require('./history-authoring-projection');
const { createCodexImageRequestProjection } = require('./codex-image-request-projection');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const web = fs.readFileSync(path.join(__dirname,'web-server.js'),'utf8');
const ast = ts.createSourceFile('web.js',web,ts.ScriptTarget.Latest,true);
let publisher;
const visit = node => {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast)==='publish'
    && node.initializer.getText(ast).includes("'agent:send-queue-receipt'")) publisher=node.initializer.getText(ast);
  ts.forEachChild(node,visit);
};
visit(ast); assert.ok(publisher);
const rendererCode = esbuild.buildSync({entryPoints:[path.join(__dirname,'../renderer/utils/historyPromptHandoffs.ts')],
  bundle:true,write:false,format:'cjs',platform:'node',target:'node18',logLevel:'silent'}).outputFiles[0].text;
function renderer() {
  const module={exports:{}};
  vm.runInNewContext(rendererCode,{module,exports:module.exports,require,console,setTimeout,clearTimeout,Date,Map,Set});
  return module.exports;
}
const clone = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const tabId='image-private-T',handoffId='H',operationKey='project:T:H',attemptId='A';
  const text='before [imagePath: /var/mobile.jpg] after';
  const refs=[{id:0,path:'/var/mobile.jpg',mediaType:'image/jpeg',size:123}];
  const plan=buildCodexImagePastePlan(text,p=>({success:true,path:p,inputPath:'/tmp/transport.jpg'}));
  const proof=createCodexImageRequestProjection({tabId,handoffId,operationKey,attemptId,requestText:text,
    transportText:plan.text,segments:plan.segments,imageRefs:refs});
  return {tabId,handoffId,operationKey,attemptId,promptHash:promptAuditFingerprint(text),promptLength:text.length,
    provider:'codex',sessionId:'S',surface:'project-api',state:'audit-pending',createdAt:1,updatedAt:2,
    applicationQueue:{version:1,id:55,state:'awaiting-receipt',queuedAt:1},
    receipt:{operationKey,attemptId,promptText:text,transportText:plan.text,imageRequestProjection:proof,
      expectedImageRefs:refs,expectedImagePaths:['/tmp/transport.jpg'],source:'codex-ios-terminal'}};
}
function livePublisher(onRecord) {
  const remote=[];
  const publish=vm.runInNewContext('('+publisher+')',{
    imagePresentationFromReceipt,tabWorkContext:null,
    BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,webContents:{isDestroyed:()=>false,
      send:(channel,record)=>{assert.equal(channel,'agent:send-queue-receipt');onRecord(clone(record));}}}]},
    publicAgentSendReceipt:r=>({status:r.state,submitted:true}),webBroadcast:(_tab,payload)=>remote.push(payload),
  });
  return {publish,remote};
}

test('actual Main queue publication → renderer hydration populates existing pathless local card before canonical read', () => {
  const r=fixture(), client=renderer(), before=clone(r);
  client.beginHistoryPromptHandoff({tabId:r.tabId,handoffId:r.handoffId,toolType:'codex',text:r.receipt.promptText,
    promptChips:[],imagePaths:[],submittedAt:1,statusAtSend:'busy',sessionIdHint:'S'});
  let imageProof;
  const events=livePublisher(record=>{imageProof=record.imagePresentation;client.hydrateHistoryPromptHandoffFromDurableReceipt(record);});
  events.publish(r);
  const row=client.getHistoryPromptHandoffsSnapshot(r.tabId)[0];
  assert.equal(row.sendAttemptId,'A'); assert.equal(row.imagePaths[0]?.path,'/var/mobile.jpg');
  assert.equal(imageProof.imagePaths[0].transportPath,'/tmp/transport.jpg'); assert.equal(row.statusAtSend,'busy');
  assert.equal(row.queueStatus,'audit-pending'); assert.deepEqual(r,before,'publish is a read-only DTO, never a receipt mutation');
  assert.equal(events.remote[0].type,'send-receipt'); assert.equal(events.remote[0].receipt.imagePresentation,undefined);
  assert.equal(events.remote[0].receipt.promptText,undefined,'SSE remains a small wake');
});

test('corrupt scope stays pathless; live publication does not bless arbitrary refs', () => {
  const r=clone(fixture());r.receipt.imageRequestProjection.attemptId='foreign';
  const client=renderer(),events=livePublisher(record=>client.hydrateHistoryPromptHandoffFromDurableReceipt(record));
  events.publish(r);
  assert.equal(client.getHistoryPromptHandoffsSnapshot(r.tabId)[0].imagePaths.length,0);
});

test('actual bounded list IPC and live publication carry identical proven image projection', async () => {
  const r=fixture(),main=fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
  const start=main.indexOf("ipcMain.handle('agent:list-send-receipts'");
  const end=main.indexOf("ipcMain.handle('agent:acknowledge-send-receipt-presentation'",start);
  let handler;
  vm.runInNewContext(main.slice(start,end),{ipcMain:{handle:(_name,fn)=>{handler=fn;}},path,srcMainDir:__dirname,
    agentSendReceiptStartupReady:Promise.resolve(),agentSendReceiptStore:{list:()=>[r]},imagePresentationFromReceipt,
    // This project-API image fixture has no desktop return registration. The
    // separate return IPC/SQLite suite exercises its real durable controller.
    historySendReturnControl:()=>({read:()=>null}),
    require:()=>({projectQueuedSendReceipt:x=>x,applicationQueueInfo:()=>r.applicationQueue})});
  const listed=await handler(null,{tabId:r.tabId});let live;
  livePublisher(value=>{live=value;}).publish(r);
  assert.deepEqual(clone(listed.records[0].imagePresentation),live.imagePresentation);
});

test('captured4944 project-api receipt publishes original /var ref without rewritten delivery or a canonical read', t => {
  const file='/private/tmp/ios-dictation-scroll-20261004/audit-input-v1/receipt-4944.json';
  if(!fs.existsSync(file))return t.skip('captured private packet unavailable');
  const raw=JSON.parse(fs.readFileSync(file,'utf8')).receipts[0];
  const r={...raw,receipt:raw,promptLength:raw.imageRequestProjection.requestLength,auditIdentity:{provider:raw.provider,
    attemptId:raw.attemptId,sessionId:raw.sessionId,promptHash:raw.actualHash,entryUuid:raw.entryUuid,
    sourceIdentity:raw.sourceIdentity,auditTimestamp:raw.auditTimestamp}};
  const client=renderer();
  client.beginHistoryPromptHandoff({tabId:r.tabId,handoffId:r.handoffId,toolType:'codex',text:r.promptText,
    promptChips:[],imagePaths:[],submittedAt:r.createdAt,statusAtSend:'busy',sessionIdHint:r.sessionId});
  livePublisher(record=>client.hydrateHistoryPromptHandoffFromDurableReceipt(record)).publish(r);
  const row=client.getHistoryPromptHandoffsSnapshot(r.tabId)[0];
  assert.equal(row.queueStatus,'sent');assert.equal(row.imagePaths[0].path,r.expectedImageRefs[0].path);
  assert.equal(row.imagePaths.length,1);assert.equal(row.auditProof.entryUuid,r.entryUuid);
});
