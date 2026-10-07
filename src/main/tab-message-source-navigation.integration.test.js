'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const url = require('node:url');
const Database = require('better-sqlite3');
const { TabMessageService } = require('./tab-messages');
const { handleTabMessageApi, messageApiAcceptance } = require('./tab-message-api');
const { HistoryReadClient } = require('./history-read-client');
const { SessionTranscriptService } = require('./session-transcript-service');
const { resolveTabMessageSourceLocation } = require('./tab-message-source-location');
const Module = require('node:module');

test('real private HTTP -> persisted message -> transcript worker -> actual Codex parser finds the source without a send', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-source-message-'));
  const db = new Database(':memory:');
  const service = new TabMessageService({db,resolveTab: async id => ({tabId:id,tabName:id,projectId:'P',
    projectName:'Project',provider:'codex',sessionId:id==='A'?'S':'T',cwd:directory}),send:async () => ({state:'confirmed'})});
  await service.initialize();
  const reservation = await service.sendMessage({source:'A',target:'B',text:'synthetic exact question',requestId:'exact-request'});
  while (service.lanes.size) await Promise.all([...service.lanes.values()]);
  const acceptance = messageApiAcceptance(reservation), messageId = acceptance.messageId;
  const filePath = path.join(directory, 'rollout-S.jsonl');
  const records = [
    {type:'session_meta',payload:{id:'S',cwd:directory}},
    {type:'response_item',payload:{type:'function_call',name:'mcp__terminal__send_message',call_id:'actual-call',
      arguments:JSON.stringify({tabId:'B',text:'synthetic exact question',requestId:'exact-request'})}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'actual-call',output:JSON.stringify(acceptance)}},
  ];
  await fs.writeFile(filePath,records.map(r => JSON.stringify(r)+'\n').join(''));
  const reader = new HistoryReadClient({sessionsDir:directory,cacheDirectory:path.join(directory,'cache'),memoryBudgetMb:32});
  const transcript = new SessionTranscriptService({historyReader:reader});
  const before = db.prepare('SELECT * FROM tab_messages').all();
  const locator = id => resolveTabMessageSourceLocation(id, {
    getMessage: id => service.getMessage(id),
    readOwner: async () => ({toolType:'codex',sessionId:'S',cwd:directory}),
    readLocation: payload => transcript.getTabMessageSourceLocation(payload),
  });
  const server = http.createServer(async (req,res) => {
    const handled = await handleTabMessageApi(req,res,url.parse(req.url,true), {
      service,locateSource:locator,sendJson:(res,status,body) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));},
    });
    if (!handled) {res.writeHead(404);res.end();}
  });
  t.after(async () => {await new Promise(resolve => server.close(resolve));await reader.close();service.dispose();db.close();await fs.rm(directory,{recursive:true,force:true});});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const request = suffix => new Promise((resolve,reject) => http.get('http://127.0.0.1:'+server.address().port+'/api/tab-messages/'+suffix,res => {
    let body='';res.on('data',chunk => body+=chunk);res.on('end',() => resolve({status:res.statusCode,body:JSON.parse(body)}));
  }).on('error',reject));
  const result = await request(messageId+'/source');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.location.messageId,messageId);
  assert.equal(result.body.location.tabId,'A');
  assert.equal(result.body.location.readSessionId,'S');
  assert.equal(result.body.location.toolUseId,'actual-call:canonical:0');
  assert.equal(result.body.location.proof,'accepted-message-id');
  const full = await reader.call('getHistory',{toolType:'codex',sessionId:'S',cwd:directory,tabId:'A'});
  assert.ok(full.entries.some(row => row.uuid===result.body.location.entryUuid
    && row.actions?.some(a => a.rawTool?.toolUseId==='actual-call:canonical:0')));
  assert.equal((await request('missing/source')).status,409);
  assert.equal((await request(messageId)).body.message.messageId,messageId,'original GET unchanged');
  assert.deepEqual(db.prepare('SELECT * FROM tab_messages').all(),before,'source read cannot mutate receipt/delivery');
  assert.equal((await fs.readFile(filePath,'utf8')),records.map(r => JSON.stringify(r)+'\n').join(''),'transcript untouched');
});

test('actual Claude tool-use/result carriers resolve a reply through the same service, not a body quote', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'noted-claude-source-'));
  const cwd='/synthetic-claude-source', sessionId='claude-source';
  const projectDir=path.join(directory,'.claude/projects',cwd.replace(/\//g,'-'));
  await fs.mkdir(projectDir,{recursive:true});
  const message={messageId:'reply-message',kind:'reply',replyTo:'question',sourceTabId:'A',sourceProvider:'claude',sourceSessionId:sessionId,targetTabId:'B',requestId:'reply-request'};
  const acceptance={ok:true,accepted:true,messageId:message.messageId,requestId:message.requestId,message};
  const records=[
    {uuid:'assistant',type:'assistant',parentUuid:null,message:{role:'assistant',content:[{type:'tool_use',id:'claude-call',name:'mcp__terminal__reply_to_message',input:{messageId:'question',requestId:'reply-request',text:'exact reply'}}]}},
    {uuid:'result',type:'user',parentUuid:'assistant',message:{role:'user',content:[{type:'tool_result',tool_use_id:'claude-call',content:JSON.stringify(acceptance)}]}},
    {uuid:'quoted',type:'user',parentUuid:'result',message:{role:'user',content:JSON.stringify(acceptance)}},
  ].map((row,i) => ({...row,sessionId,cwd,timestamp:new Date(1780000000000+i).toISOString()}));
  const sourcePath=require.resolve('./ipc/claude-data'), prior=require.cache[sourcePath], load=Module._load;
  delete require.cache[sourcePath];
  let claude;
  try {
    Module._load=function(request,parent,isMain) {
      if(request==='electron')return {ipcMain:{handle(){}}};
      if(request==='os'||request==='node:os')return {...os,homedir:() => directory};
      return load.call(this,request,parent,isMain);
    };
    claude=require(sourcePath);
  } finally {Module._load=load;delete require.cache[sourcePath];if(prior)require.cache[sourcePath]=prior;}
  claude.register({projectManager:{},formatToolAction:() => null});
  t.after(async () => {claude._api.resetJsonlCacheForTests();await fs.rm(directory,{recursive:true,force:true});});
  await fs.writeFile(path.join(projectDir,sessionId+'.jsonl'),records.map(r=>JSON.stringify(r)+'\n').join(''));
  const service=new SessionTranscriptService({claudeData:claude});
  const result=await service.getTabMessageSourceLocation({message,toolType:'claude',sessionId,cwd,tabId:'A'});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.location.entryUuid,'assistant');
  assert.equal(result.location.toolUseId,'claude-call');
  assert.equal(result.location.method,'reply_to_message');
});
