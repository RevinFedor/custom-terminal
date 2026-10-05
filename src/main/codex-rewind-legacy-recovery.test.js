'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const data = require('./ipc/codex-data');
const { hashCodexRewindTargetText, classifyCodexStableSourceTranscriptRecovery } = require('./codex-rewind-target-proof');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { codexUserMessageAuditText, codexUserMessagePresentationText } = require('./codex-prompt-audit');
const ast = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'projectCodexSourceTranscriptForRewindRecovery');
const project = vm.runInNewContext(node.getText(ast) + '\nprojectCodexSourceTranscriptForRewindRecovery', {
  codexDataModule: data, hashCodexRewindTargetText, codexUserMessageAuditText, codexUserMessagePresentationText,
  pasteAuditHash: promptAuditFingerprint,
});

test('response-only target and later authored turn restore the same legacy source; service carriers never stand in for the user', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-rewind-response-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFilePath = path.join(root, 'source.jsonl');
  const response = (time, text) => ({ timestamp:new Date(time).toISOString(), type:'response_item',
    payload:{type:'message',role:'user',content:[{type:'input_text',text}]} });
  const records = [{type:'session_meta',payload:{id:'S'}}, response(1_000,'target'),
    {timestamp:new Date(3_000).toISOString(),type:'event_msg',payload:{type:'task_started',turn_id:'new-turn'}},
    response(3_001,'<environment_context>context</environment_context>'),
    response(3_002,'# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>rules</INSTRUCTIONS>'),
    response(3_003,'<turn_aborted>\nprovider notice\n</turn_aborted>'),
    response(3_004,'<codex_internal_context source="goal">continue goal</codex_internal_context>'),
    response(3_010,'new authored request')];
  fs.writeFileSync(sourceFilePath, records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const journal = {version:2,phase:'confirm-enter-boundary',sourceSessionId:'S',expectedBindingSessionId:'S',
    actionGeneration:'G',actionStartedAtMs:2_000,targetSourceLine:1,targetUuid:'codex-user-S-1',
    targetTextHash:hashCodexRewindTargetText('target')};
  const scan = await data._api.scanCodexStableSourceRewindProof(sourceFilePath,
    {targetSourceLine:1,actionStartedAtMs:2_000});
  assert.equal(scan.complete,true);
  assert.equal(scan.targetRecord.type,'response_item');
  assert.equal(scan.userMessageRecord?.__line,7,'real authored carrier after service context');
  const transcript=project([scan.targetRecord,scan.taskStartedRecord,scan.userMessageRecord], 'S');
  const proof=classifyCodexStableSourceTranscriptRecovery({journal,currentSessionId:'S',
    discoveryComplete:true,descendants:[],...transcript});
  assert.equal(proof.proven,true,proof.reason);
  assert.equal(proof.targetSourceLine,1); assert.equal(proof.userMessageSourceLine,7);
  for(const patch of [{targetTextHash:'0'.repeat(64)},{targetUuid:'codex-user-S-2'},{targetSourceLine:2}]) {
    assert.equal(classifyCodexStableSourceTranscriptRecovery({journal:{...journal,...patch},currentSessionId:'S',
      discoveryComplete:true,descendants:[],...transcript}).proven,false);
  }
  for(const patch of [{currentSessionId:'foreign'},{discoveryComplete:false},{descendants:[{sessionId:'child'}]}]) {
    assert.equal(classifyCodexStableSourceTranscriptRecovery({journal,currentSessionId:'S',
      discoveryComplete:true,descendants:[],...transcript,...patch}).proven,false);
  }
  const db = new Database(':memory:'); t.after(()=>db.close());
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);'
    +'CREATE TABLE tabs(project_id TEXT, tab_id TEXT, codex_session_id TEXT);');
  const manager = new DatabaseManager({existingConnection:db});
  const key='codex.pending-writer-handoff.v1:T';
  const saved={...journal,projectId:'P',tabId:'T',cwd:root,rollbackTurns:1};
  db.prepare('INSERT INTO app_state VALUES(?,?,?)').run(key,JSON.stringify(saved),1);
  db.prepare('INSERT INTO tabs VALUES(?,?,?)').run('P','T','S');
  const settled=manager.resolvePendingCodexStableSourceFromTranscript({journalKey:key,projectId:'P',tabId:'T',
    sourceSessionId:'S',actionGeneration:'G',targetSourceLine:1,targetTextHash:journal.targetTextHash,
    taskStartedSourceLine:proof.taskStartedSourceLine,taskStartedAtMs:3_000,
    userMessageSourceLine:proof.userMessageSourceLine,userMessageTimestampMs:3_010});
  assert.equal(settled.success,true); assert.equal(settled.journalCleared,true);
  assert.equal(manager.getTabCodexSessionId('P','T'),'S');
  fs.writeFileSync(sourceFilePath, records.slice(0,-1).map(r=>JSON.stringify(r)).join('\n')+'\n');
  const serviceOnly=await data._api.scanCodexStableSourceRewindProof(sourceFilePath,
    {targetSourceLine:1,actionStartedAtMs:2_000});
  assert.equal(serviceOnly.userMessageRecord,null);
});

test('exact-submit response/event companions share one first-user slot; steering and terminal boundaries cannot confirm', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-rewind-submit-carriers-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'source.jsonl');
  const event=(type,time,fields={})=>({type:'event_msg',timestamp:new Date(time).toISOString(),payload:{type,...fields}});
  const response=(text,time)=>({type:'response_item',timestamp:new Date(time).toISOString(),
    payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
  const base=[{type:'session_meta',payload:{id:'S'}},event('user_message',1000,{message:'target'}),event('task_started',3000)];
  const expected='[Image #1] hello';
  const before='<image name=[Image #1] path="/tmp/one.png">\n[Image #1]\n</image> hello';
  const run=async suffix=>{
    fs.writeFileSync(file,[...base,...suffix].map(r=>JSON.stringify(r)).join('\n')+'\n');
    return data._api.scanCodexStableSourceRewindProof(file,{targetSourceLine:1,actionStartedAtMs:2000,
      expectedSubmit:{expectedLen:expected.length,expectedHash:promptAuditFingerprint(expected),sentAtMs:2500,sourceFileSize:0}});
  };
  const alone=await run([response(expected,3010)]);
  assert.equal(alone.expectedSubmitMatched,true);
  const paired=await run([response(before,3010),event('user_message',3011,{message:expected})]);
  assert.equal(paired.expectedSubmitMatched,true,'only the existing cross-carrier grammar links the companion');
  for(const suffix of [[response('different request',3010),response(expected,3011)],
    [response(before,3010),event('task_complete',3011),event('user_message',3012,{message:expected})],
    [response(before,3010),event('turn_aborted',3011),event('user_message',3012,{message:expected})]]) {
    assert.equal((await run(suffix)).expectedSubmitMatched,false);
  }
});

test('legacy journal uses actual transcript proof and exact SQLite settlement without rewriting receipt or history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-legacy-rewind-'));
  const db = new Database(path.join(root, 'fixture.db'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);'
    + 'CREATE TABLE tabs(project_id TEXT, tab_id TEXT, codex_session_id TEXT);');
  const manager = new DatabaseManager({ existingConnection: db });
  const row = (time, type, payload) => JSON.stringify({ timestamp: new Date(time).toISOString(), type, payload }) + '\n';
  const prefix = row(500, 'session_meta', { id: 'S' })
    + row(1_000, 'event_msg', { type: 'user_message', message: 'target' });
  const bytes = prefix + row(2_220, 'event_msg', { type: 'task_started' })
    + row(2_240, 'event_msg', { type: 'user_message', message: 'continued' });
  const sourceFilePath = path.join(root, 'source.jsonl');
  fs.writeFileSync(sourceFilePath, bytes);
  const journal = { version: 2, projectId: 'P', originProjectId: 'P', tabId: 'T', cwd: root,
    sourceSessionId: 'S', expectedBindingSessionId: 'S', sourceBindingMode: 'confirmed-writer',
    sourceLifecycleGeneration: 'L:1', sourceRunSeq: 1, operationId: 'O', requestId: 'O',
    actionGeneration: 'G', actionStartedAtMs: 2_000,
    targetUuid: 'codex-user-S-1', targetSourceLine: 1, targetTextHash: hashCodexRewindTargetText('target'),
    rollbackTurns: 3, phase: 'stable-source-submit-written', appliedAtMs: 2_005,
    restoredTextHash: hashCodexRewindTargetText('target'), stableSourceSettledAtMs: 2_010,
    submitProof: { version: 1, submitId: 'A', sourceSessionId: 'S', actionGeneration: 'G',
      expectedLen: 9, expectedHash: promptAuditFingerprint('continued'), sentAtMs: 2_200,
      submitWrittenAtMs: 2_201, sourceFilePath, sourceFileSize: Buffer.byteLength(prefix), runSeq: 1 } };
  const key = 'codex.pending-writer-handoff.v1:T';
  const raw = JSON.stringify(journal);
  db.prepare('INSERT INTO tabs VALUES(?,?,?)').run('P', 'T', 'S');
  db.prepare('INSERT INTO app_state VALUES(?,?,?)').run(key, raw, 1);
  db.prepare('INSERT INTO app_state VALUES(?,?,?)').run('unrelated', '"preserved"', 1);
  const scan = await data._api.scanCodexStableSourceRewindProof(sourceFilePath, {
    targetSourceLine: 1, actionStartedAtMs: 2_000, expectedSubmit: journal.submitProof,
  });
  assert.equal(scan.complete, true);
  assert.equal(scan.expectedSubmitMatched, true);
  const transcript = project([scan.targetRecord, scan.taskStartedRecord, scan.userMessageRecord], 'S');
  const proof = classifyCodexStableSourceTranscriptRecovery({ journal, currentSessionId: 'S',
    discoveryComplete: true, descendants: [], ...transcript });
  assert.equal(proof.proven, true);
  assert.equal(Object.hasOwn(proof.submitProof, 'originPhase'), false);
  const request = { journalKey: key, projectId: 'P', tabId: 'T', sourceSessionId: 'S', actionGeneration: 'G',
    targetSourceLine: proof.targetSourceLine, targetTextHash: journal.targetTextHash,
    taskStartedSourceLine: proof.taskStartedSourceLine, taskStartedAtMs: 2_220,
    userMessageSourceLine: proof.userMessageSourceLine, userMessageTimestampMs: proof.userMessageTimestampMs,
    taskStartedByteOffset: proof.taskStartedByteOffset, userMessageByteOffset: proof.userMessageByteOffset,
    userMessageTextLength: proof.userMessageTextLength, userMessageAuditHash: proof.userMessageAuditHash,
    submitProof: proof.submitProof };
  for (const patch of [
    { actionGeneration: 'other' }, { targetTextHash: 'wrong' },
    { userMessageAuditHash: 'wrong' }, { userMessageByteOffset: 0 },
    { submitProof: { ...proof.submitProof, submitId: 'foreign' } },
    { submitProof: { ...proof.submitProof, originPhase: 'stable-source-settled' } },
  ]) {
    assert.equal(manager.resolvePendingCodexStableSourceFromTranscript({ ...request, ...patch }).success, false);
    assert.equal(db.prepare('SELECT value FROM app_state WHERE key=?').get(key).value, raw);
  }
  const settled = manager.resolvePendingCodexStableSourceFromTranscript(request);
  assert.equal(settled.success, true);
  assert.equal(settled.journalCleared, true);
  assert.equal(db.prepare('SELECT value FROM app_state WHERE key=?').get(key), undefined);
  assert.equal(manager.getTabCodexSessionId('P', 'T'), 'S');
  assert.equal(manager.getAppState('unrelated'), 'preserved');
  assert.equal(fs.readFileSync(sourceFilePath, 'utf8'), bytes);
});
