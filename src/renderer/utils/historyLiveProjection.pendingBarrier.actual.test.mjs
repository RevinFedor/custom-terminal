import test from 'node:test';
import assert from 'node:assert/strict';
import * as actual from './historyLiveProjection.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
let {buildHistoryLivePresentation,reduceHistoryLiveProjection}=actual;
if(process.env.HISTORY_LIVE_PREIMAGE){
  const require=createRequire(import.meta.url),ts=require('typescript');
  const source=fs.readFileSync(process.env.HISTORY_LIVE_PREIMAGE,'utf8');
  const ast=ts.createSourceFile('historyLiveProjection.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='buildHistoryLivePresentationBase');
  assert.ok(node,'the exact actual preimage merge body must exist');
  const before=vm.runInNewContext('('+node.getText(ast)+')',{
    historyLivePresentationIdentities:actual.historyLivePresentationIdentities,
  });
  buildHistoryLivePresentation=(...args)=>Array.from(before(...args));
}

// Metadata-only public History witness for tab5957,20Oct00:36:54.877UTC.
// Bodies/tools are deliberately not copied from the user's conversation.
const sid='d9c3efa6-b525-4ed6-9454-c6c840a66c3d';
const row=(uuid,role,offset)=>({uuid,role,sessionId:sid,
  sourceIdentity:`codex-${role}-source-${sid}-${offset}`,content:role});
const prior=row('prior','user',517000000),before=row('before','assistant',517088715);
const native=row('canonical-33412','user',517122940);
native.sourceIdentityAliases=[`codex-user-source-${sid}-517107687`];
const answer=row('answer-33420','assistant',517136292),tool=row('tool-33421','assistant',517137499);
const pending={uuid:'local-unconfirmed-Hmvft8nny',role:'queued',queueStatus:'delivery-unknown',
  statusAtSend:'unknown',sessionId:sid,content:'unconfirmed original intent'};
const ids=rows=>rows.map(x=>x.uuid);

test('actual merge: an old unconfirmed card cannot strand a later canonical user below its own response',()=>{
  const out=buildHistoryLivePresentation([prior,pending,native],[before,answer,tool]);
  assert.deepEqual(ids(out),['prior','before','canonical-33412','answer-33420','tool-33421',pending.uuid]);
  assert.equal(out.at(-1),pending,'presentation must not rewrite unknown delivery or authoring');
  assert.equal(pending.queueStatus,'delivery-unknown');
});

for(const queueStatus of ['application-queued','preparing','sending','queued','audit-pending','delivery-unknown']){
  test(`actual merge: ${queueStatus} defers only its own unconsumed input, not later exact rows`,()=>{
    const q={...pending,queueStatus},later={...pending,uuid:'later-waiting',queueStatus:'application-queued'};
    const sent={...native,role:'queued',queueStatus:'sent'};
    const out=buildHistoryLivePresentation([prior,q,sent,later],[before,answer]);
    assert.deepEqual(ids(out),['prior','before',native.uuid,answer.uuid,q.uuid,later.uuid]);
    assert.equal(out.at(-2),q);assert.equal(out.at(-1),later);
  });
}

test('actual reducer promotion1289→1290 and canonical adoption keep one exact user and response order',()=>{
  const envelope=(offset,uuid,aliases=[])=>({toolType:'codex',sessionId:sid,recordByteOffset:offset,
    message:{type:'user',uuid,sourceIdentity:`codex-user-source-${sid}-${offset}`,
      sourceIdentityAliases:aliases,sessionId:sid,
      message:{role:'user',content:[{type:'text',text:'synthetic same native prompt'}]}}});
  let live=reduceHistoryLiveProjection([before],envelope(517107687,'live-1289'),{includeUserText:true});
  live=reduceHistoryLiveProjection(live,envelope(517122940,'live-1290',native.sourceIdentityAliases),{includeUserText:true});
  live=[...live,answer];
  const out=buildHistoryLivePresentation([prior,pending,native],live);
  assert.equal(out.filter(e=>e.role==='user'&&e!==prior).length,1);
  assert.deepEqual(ids(out),['prior','before',native.uuid,answer.uuid,pending.uuid]);
});

test('failed/cancelled cards do not become pending again and equal text is not a dedupe proof',()=>{
  const failed={...pending,uuid:'failed',queueStatus:'failed'},cancelled={...pending,uuid:'cancelled',queueStatus:'cancelled'};
  const next={...native,uuid:'different-record',sourceIdentity:`codex-user-source-${sid}-517150000`,sourceIdentityAliases:[],content:native.content};
  const out=buildHistoryLivePresentation([prior,failed,pending,native,cancelled],[answer,next]);
  assert.ok(out.indexOf(native)<out.indexOf(answer));
  assert.ok(out.includes(failed)&&out.includes(cancelled)&&out.includes(next));
  assert.equal(out.at(-1),pending);
});
