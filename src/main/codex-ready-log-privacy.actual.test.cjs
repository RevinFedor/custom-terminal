const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/main.js','utf8'),start=source.indexOf('function logCodexTuiReadyNotReady('),end=source.indexOf('\nasync function emitCodexTuiReadyAfterQuiet(',start);assert.ok(start>=0&&end>start);
test('actual readiness transition keeps its UI proof but logs no TUI conversation text and does not repeat for stream body changes',()=>{
 const lines=[],last=new Map(),keys=new Map(),context={Date,JSON,String,Array,console:{log:s=>lines.push(s)},codexTuiReadyLastNotReady:last,codexTuiReadyRejectKeys:keys,codexStartupAutoEnter:new Set(),codexLastRunCommandPayload:new Map(),isCodexStartupLifecycleFresh:()=>false,hasCodexPromptOrTurnInFlight:()=>false,markCodexManualActionRequired(){},emitCodexTuiNotReadyState(){}};
 vm.runInNewContext(source.slice(start,end)+';globalThis.run=logCodexTuiReadyNotReady;',context);
 const inspected={ready:false,source:'raw',reason:'composer-initialization-pending',sampleMode:'latest-sync-frame',sampleBytes:80,totalBytes:100,blockers:[],hasSynchronizedFrame:true,hasCodexUiText:true,hasPromptGlyph:false};
 context.run('fixture-tab',inspected,'raw CANARY_PRIVATE_PROMPT','assistant CANARY_PRIVATE_PROMPT','stream');assert.equal(last.get('fixture-tab').previewTail,'assistant CANARY_PRIVATE_PROMPT');assert.doesNotMatch(lines.join('\n'),/CANARY|PRIVATE|PROMPT/);assert.match(lines[0],/sampleBytes=80.*totalBytes=100.*previewChars=\d+.*diagnosticDedupe=semantic-state/);
 for(let i=0;i<500;i++)context.run('fixture-tab',inspected,'new raw '+i,'CANARY_PRIVATE_STREAM_'+i,'stream');assert.equal(lines.length,1,'changing content is not a new readiness state');assert.equal(last.get('fixture-tab').previewTail,'CANARY_PRIVATE_STREAM_499');
 context.run('fixture-tab',{...inspected,reason:'native-ready-pending'},'raw','CANARY_OTHER','stream');assert.equal(lines.length,2);assert.doesNotMatch(lines.join('\n'),/CANARY/);
});
