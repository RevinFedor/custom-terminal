'use strict';
// Exact declaration + ACTUAL bounded Main normalization/capture callers.
// No complete Panel AST. Node runtime type budget remains128old/2semi.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{getHeapStatistics}=require('node:v8');
const ts=require(process.env.NOTED_TYPESCRIPT_PATH||'typescript');
assert(getHeapStatistics().heap_size_limit<=140*1024**2,'existing128/2 type budget');
const root=path.resolve(__dirname,'..'),file=path.join(__dirname,'.v53r-main-facts-types.mts');
const panel=fs.readFileSync(path.join(root,'src/renderer/components/Workspace/HistoryPanel.tsx'),'utf8');
const start=panel.indexOf('  const exactActiveSubagents = useMemo(() => {'),end=panel.indexOf('  // Chips must see the SAME rows',start);
assert(start>=0&&end>start);const capture=panel.slice(start,end);assert(Buffer.byteLength(capture)<5000);
const ownerAt=panel.indexOf('  const [mainBackgroundWork, setMainBackgroundWork]');
const at=panel.indexOf('    const accept = (detail: any) => {',ownerAt),last=panel.indexOf('    const onBackgroundWork',at);
assert(at>=0&&last>at);const normalize=panel.slice(at,last);assert(Buffer.byteLength(normalize)<5000);
const source=`import {createHistoryAgentCatalogCurrent,createHistoryAgentCatalogMainFact,
 createHistoryAgentCatalogMainFactsMap,createHistoryAgentCatalogMainFactsSet} from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import type {HistoryAgentCatalogMainFactsMap,HistoryAgentCatalogMainFactsSet,HistoryAgentCatalogMainFactRecord} from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
type SubagentLaunchSettings={version:1;readonly [key:string]:unknown};
interface HistoryBackgroundAgentProof {provider:'claude'|'codex';toolUseId:string;agentSessionId:string;
 agentId?:string;sessionId:string|null;generation:string|null;startedAt:number;completedAt?:number;
 status?:'completed'|'interrupted';launchSettings?:SubagentLaunchSettings;}
interface HistoryBackgroundTaskProof {provider:'claude';toolUseId:string;taskId:string;kind:'bash'|'monitor';label:string;
 command:string;acceptance:string;entryUuid:string;sessionId:string|null;generation:string|null;startedAt:number;}
interface Snapshot {tabId:string;revision:number;agents:HistoryBackgroundAgentProof[];terminalSubagents:HistoryBackgroundAgentProof[];
 tasks:HistoryBackgroundTaskProof[];terminalBackgroundToolUseIds:string[];}
declare const mainBackgroundWork:Snapshot,cancelled:boolean;
declare const tabId:string,toolType:'claude'|'codex',sessionId:string,agentProcessGeneration:string|null;
declare function setMainBackgroundWork(update:(previous:Snapshot)=>Snapshot):void;
declare function useMemo<T>(fn:()=>T,deps:readonly unknown[]):T;
declare function historySubagentCallIdentity(value:unknown):string;
${normalize}
${capture}
const context={isTurnBusy:false,agentProcessAlive:true,currentSessionId:sessionId,currentProcessGeneration:agentProcessGeneration,
 chipToolType:toolType,exactActiveSubagents,exactActiveBackgroundTasks,terminalBackgroundTaskCalls,terminalFacts:terminalAgentFacts};
const base={recipe:{live:[] as object[]},isLocalPromptEntry:(row:object)=>false,isTaskAction:(action:unknown)=>false,
 historyAgentKey:(action:unknown,entryUuid:string)=>entryUuid,fingerprint:(value:unknown)=>''};
const current=createHistoryAgentCatalogCurrent({...base,context});
const exact:boolean=current.hasIntrinsicReadAuthority(true);
const record=createHistoryAgentCatalogMainFact({provider:'codex',startedAt:7,launchSettings:{version:1}});
const owned:HistoryAgentCatalogMainFactRecord=record;
const map=createHistoryAgentCatalogMainFactsMap([['call',record]]);
const set=createHistoryAgentCatalogMainFactsSet(['call']);
map.set('another',record);const scalar:number=map.get('call')!.startedAt;
createHistoryAgentCatalogCurrent({...base,context:{...context,terminalFacts:map,terminalBackgroundTaskCalls:set}});
declare const broad:ReadonlyMap<string,unknown>;
class Facts extends Map<string,unknown>{get(key:string){return super.get(key);}}
// @ts-expect-error structural ReadonlyMap is not authenticated Main provenance
createHistoryAgentCatalogCurrent({...base,context:{...context,terminalFacts:broad}});
// @ts-expect-error ordinary Map is not an authenticated collection
createHistoryAgentCatalogCurrent({...base,context:{...context,exactActiveSubagents:new Map()}});
// @ts-expect-error custom subclass cannot promise source-independent intrinsic semantics
createHistoryAgentCatalogCurrent({...base,context:{...context,terminalFacts:new Facts()}});
// @ts-expect-error ordinary Set is not authenticated Main provenance
createHistoryAgentCatalogCurrent({...base,context:{...context,terminalBackgroundTaskCalls:new Set()}});
// @ts-expect-error structural fake custom getter is not the new authenticated API
createHistoryAgentCatalogCurrent({...base,context:{...context,terminalFacts:{get:(key:string)=>undefined}}});
// @ts-expect-error records must be constructed at normalization; no structural brand
const counterfeit:HistoryAgentCatalogMainFactRecord={provider:'codex'};
// @ts-expect-error fact constructor receives a normalized object, not a scalar
createHistoryAgentCatalogMainFact('record');
// @ts-expect-error source-dependent Main key profile remains exact strings
createHistoryAgentCatalogCurrent({...base,context:{...context,terminalFacts:createHistoryAgentCatalogMainFactsMap([[1,record]])}});
// @ts-expect-error final authority check is synchronous
current.hasIntrinsicReadAuthority(true).then(()=>{});
// @ts-expect-error history keys cannot be forged into collection provenance
const forged:HistoryAgentCatalogMainFactsMap<string,unknown>={};
void owned;void scalar;void exact;
`;
assert(Buffer.byteLength(source)<16384);
const options={strict:true,noUncheckedIndexedAccess:true,skipLibCheck:false,noEmit:true,target:ts.ScriptTarget.ES2022,
 module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,lib:['lib.es2022.d.ts','lib.dom.d.ts'],types:[]};
function diagnostics(value){const host=ts.createCompilerHost(options),read=host.readFile,exists=host.fileExists;
 host.readFile=name=>name===file?value:read(name);host.fileExists=name=>name===file||exists(name);
 const program=ts.createProgram([file],options,host);for(const s of program.getSourceFiles())assert(!s.fileName.endsWith('HistoryPanel.tsx'));
 return ts.getPreEmitDiagnostics(program).map(x=>({code:x.code,message:ts.flattenDiagnosticMessageText(x.messageText,' ')}));}
const positive=diagnostics(source);assert.deepEqual(positive,[]);
const negative=diagnostics(source.replace(/\/\/ @ts-expect-error[^\n]*\n/g,''));assert.equal(negative.length,10);
const sha=value=>createHash('sha256').update(value).digest('hex');
console.log(JSON.stringify({scope:'V53r Main-facts genuine normalization/capture + strict authenticated declarations',node:process.version,
 typescript:ts.version,heapLimit:getHeapStatistics().heap_size_limit,panelSHA256:sha(panel),normalizeSHA256:sha(normalize),captureSHA256:sha(capture),
 positiveDiagnostics:positive.length,negativeDiagnostics:negative.length,negative,
 declarations:['src/renderer/utils/historyAgentCatalogCurrent.d.mts','src/shared/history-agent-catalog-client.d.mts'].map(p=>{const b=fs.readFileSync(path.join(root,p));return{path:p,bytes:b.length,sha256:sha(b)}})}));
