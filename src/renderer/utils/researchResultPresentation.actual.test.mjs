import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import * as crypto from 'node:crypto';
import * as timeline from './timelineTranscriptRefresh.mjs';
import { timelinePromptPreview } from './timelineEntryPreview.mjs';

const source=fs.readFileSync(new URL('../components/Workspace/Timeline.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('Timeline.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let body;
const visit=node=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'
  &&node.arguments[0]?.getText(ast).includes('projectTimelineLiveUserMessage('))body=node.arguments[0].getText(ast);ts.forEachChild(node,visit)};
visit(ast);assert.ok(body);
const code=transformSync('globalThis.effect='+body,{loader:'tsx',format:'cjs'}).code;
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');

test('actual busy listener handles late SC proof even with identical short body/time/UUID',()=>{
  const envelope='saved envelope\n',content=envelope+'<CodeBlock language="json" editable={false}>{"items":[]}</CodeBlock>';
  const tag={kind:'orchestration',runKind:'external-research',runId:'sc-run',phase:'completion',envelopeStart:0,
    envelopeText:envelope,bodyStart:envelope.length,bodyEnd:content.length,bodyProjectionHash:hash(content)};
  const message={type:'user',uuid:'same-uuid',sourceIdentity:'same-source',message:{content:[{type:'text',text:content}]}};
  const detail={tabId:'tab',toolType:'codex',sessionId:'sid',timestamp:'2026-10-10T08:58:57.927Z',message};
  let listener,snapshot={ownerKey:'owner',entries:[]},commits=0;
  const scope={...timeline,toolType:'codex',sessionId:'sid',tabId:'tab',timelineOwnerKey:'owner',
    timelineInstanceIdRef:{current:'instance'},isTurnBusyRef:{current:true},console:{warn(){}},
    window:{require:name=>{assert.equal(name,'node:crypto');return crypto;}},
    setLiveUserSnapshot:fn=>{const next=fn(snapshot);if(next!==snapshot)commits++;snapshot=next;},
    useUIStore:{getState:()=>({historyRewindPreviews:{}})},shouldClearRewindPreviewForDurableUser:()=>false,
    ipcRenderer:{on:(_event,fn)=>{listener=fn},removeListener(){}},setHistoryRewindPreview(){}};
  vm.runInNewContext(code,scope);scope.effect();listener({},detail);
  assert.equal(timelinePromptPreview(snapshot.entries[0],hash).research,null);
  const oldContent=snapshot.entries[0].content;
  listener({}, {...detail,message:{...message,semanticTags:[tag]}});
  assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].content,oldContent);
  assert.equal(timelinePromptPreview(snapshot.entries[0],hash).research.summary,'JSON · 1 строка');
  const before=commits;listener({}, {...detail,message:{...message,semanticTags:[{...tag}]}});
  assert.equal(commits,before);listener({}, {...detail,tabId:'foreign'});assert.equal(commits,before);
  assert.equal(scope.isTurnBusyRef.current,true);
});

test('History disclosure keeps the existing reveal owner, and Copy consumes the full original entry',()=>{
  const history=fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
  const reply=history.slice(history.indexOf('const HistoryResearchReply ='),history.indexOf('const HistoryUserEntry ='));
  assert.match(reply,/useHistoryRevealToggle\(anchorRef, expanded, setExpanded\)/);
  assert.doesNotMatch(reply,/scrollTop|scrollIntoView|setTimeout|setInterval/);
  const user=history.slice(history.indexOf('const HistoryUserEntry ='),history.indexOf('const HistoryAssistantEntry ='));
  assert.match(user,/buildHistoryMessageClipboardPayload\(\{\s*text: entry.content/);
  assert.match(user,/onCopy=\{copyPrompt\}/);
  assert.match(user,/researchReplyFromProjection/);
  assert.match(source,/useResearchRunModels\(tabId, sessionId,/);
  assert.doesNotMatch(source,/researchCatalogRef/,'no duplicate per-surface catalog owner');
});
