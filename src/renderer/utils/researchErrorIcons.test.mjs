import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';
import {isFailedResearchPresentation} from './researchResultPresentation.mjs';
import {timelinePromptPreview} from './timelineEntryPreview.mjs';
import {timelineMarkerKind, timelineAutomaticGroupKind} from './timelineMarkerPresentation.mjs';
import {projectTimelineLiveUserMessage, projectTimelineSentHandoff} from './timelineTranscriptRefresh.mjs';
const require=createRequire(import.meta.url);
const {normalizePromptPresentationSnapshot}=require('../../main/history-prompt-presentations.js');
const hash=t=>createHash('sha256').update(t).digest('hex');
const source=(phase='completion',outcome='failed')=>({kind:'orchestration',runId:'exact-run',runKind:'external-research',phase,...(outcome===undefined?{}:{outcome})});
const entry=(tag,body='Готов применимый V15 patch…')=>{const prefix='[exact saved completion]\n',content=prefix+body;return {uuid:'exact-research',role:'user',type:'user',content,
  semanticTags:normalizePromptPresentationSnapshot({semanticTags:[{...tag,envelopeStart:0,envelopeText:prefix,bodyStart:prefix.length,bodyEnd:content.length,bodyProjectionHash:hash(content)}]}).semanticTags};};

test('current actual producer preserves outcome through normalizer and both display projections',t=>{
  const text=fs.readFileSync(new URL('../../main/web-server.js',import.meta.url),'utf8');
  const ast=ts.createSourceFile('web-server.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='orchestrationPresentationSnapshot');
  assert.ok(declaration);
  const code=declaration.getText(ast),snapshot=new Function('crypto',code+';return orchestrationPresentationSnapshot;')({createHash});
  t.diagnostic('actual producer SHA256 '+hash(code));
  for(const [outcome,status,failed] of [['failed','failed',true],['success','completed',false]]){
    const body='Готов применимый V15 patch…',prefix='[exact saved completion]\n',prompt=prefix+body;
    const run={runId:'exact-run',runKind:'external-research',outcome,status,partialFiles:[{status:'error'}]};
    const normalized=normalizePromptPresentationSnapshot(snapshot(run,'completion',{prompt,bodyStart:prefix.length,bodyEnd:prompt.length},prompt));
    const row={uuid:'exact-research',role:'user',type:'user',content:prompt,semanticTags:normalized.semanticTags};
    const before=JSON.stringify(row),preview=timelinePromptPreview(row,hash);
    assert.equal(preview.service.outcome,outcome);assert.equal(preview.research.failed,failed);
    assert.equal(isFailedResearchPresentation(row.semanticTags[0]),failed);
    assert.equal(JSON.stringify(row),before);
  }
});

for(const outcome of ['failed','error','startup_failed','target_closed','process_exited','process_replaced','result_unavailable']){
  test('canonical '+outcome+' outcome colors the completion despite positive saved prose',()=>{
    const row=entry(source('completion',outcome)),before=JSON.stringify(row),preview=timelinePromptPreview(row,hash);
    assert.equal(preview.service.outcome,outcome);assert.equal(preview.research.failed,true);
    assert.equal(isFailedResearchPresentation(row.semanticTags[0]),true);
    assert.equal(timelineMarkerKind(row),'sc-desktop');assert.equal(timelineAutomaticGroupKind(row),null);
    assert.equal(JSON.stringify(row),before);
  });
}

test('queued/running request, success, partial files and notification failure never become Research failure',()=>{
  for(const row of [source('request',undefined),source('request','failed'),source('completion','success'),
    {...source('completion','success'),partialFiles:[{status:'error'}],notificationStatus:'failed'},
    {...source('completion','success'),status:'completed',externalResearchStatus:'done',resultError:'old warning'}]){
    assert.equal(isFailedResearchPresentation(row),false);
  }
  const row=entry(source('completion','success'),'Готов…\n{"status":"failed","partialFiles":["missing"]}');
  assert.equal(timelinePromptPreview(row,hash).research.failed,false);
});

test('legacy failure remains an error but explicit success/manual interruption do not borrow its red',()=>{
  assert.equal(isFailedResearchPresentation(source('failure',undefined)),true);
  for(const outcome of ['success','interrupted','paused','detached'])assert.equal(isFailedResearchPresentation(source('failure',outcome)),false);
  for(const tag of [{...source(),runKind:'agent'},{...source(),runId:''},{phase:'failure',outcome:'failed'},source('completion','unknown')]){
    assert.equal(isFailedResearchPresentation(tag),false);
  }
});

test('exact SENT/live semantic tags carry the same outcome before full transcript refresh',()=>{
  const row=entry(source()),before=JSON.stringify(row);
  const handoff={handoffId:'orchestration-complete:exact-run',source:'codex-orchestration-completion:exact-run',
    queueStatus:'sent',submittedAt:1000,text:row.content,semanticTags:row.semanticTags,
    auditProof:{entryUuid:row.uuid,sessionId:'session',auditTimestamp:'2026-10-25T01:00:00Z'}};
  const sent=projectTimelineSentHandoff(handoff,{sessionId:'session'});
  assert.equal(isFailedResearchPresentation(sent.semanticTags.find(t=>t.kind==='orchestration')),true);
  const live=projectTimelineLiveUserMessage({toolType:'codex',sessionId:'session',timestamp:'2026-10-25T01:00:00Z',message:{uuid:row.uuid,type:'user',semanticTags:row.semanticTags,
    message:{role:'user',content:row.content}}},{sessionId:'session',toolType:'codex',fingerprint:hash});
  assert.equal(isFailedResearchPresentation(live.semanticTags.find(t=>t.kind==='orchestration')),true);
  assert.equal(JSON.stringify(row),before);
});
