'use strict';
// SOURCE declaration handoff: actual prepared/model/catalog/current/owner
// declarations, complete standard libs, strict negatives. No whole Panel AST,
// checkJS, app build or ambient runtime substitute. Original prepared128 cap.
// NOTED_TYPESCRIPT_PATH=... node --max-old-space-size=128 --max-semi-space-size=2 scripts/history-agent-catalog-types-v53.cjs
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const { createHash } = require('node:crypto'), v8 = require('node:v8');
const ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
assert(v8.getHeapStatistics().heap_size_limit <= 140 * 1024 ** 2, 'prepared-owner declaration128/semi2 source budget');
const filename = path.join(__dirname, '.history-agent-catalog-v53-probe.mts');
const options = { strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: false,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [] };
const source = `import type {HistoryPrimaryPreparedOwner} from '../src/renderer/utils/historyPrimaryPreparedOwner.mjs';
import {createHistoryPrimaryAgentCatalogOwner} from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
import type {HistoryPrimaryAgentCatalogSnapshot} from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
import {openHistoryAgentCatalog} from '../src/shared/history-agent-catalog-client.mjs';
import type {HistoryAgentCatalogCurrent,HistoryAgentCatalogReader} from '../src/shared/history-agent-catalog-client.mjs';
import {historyPrimaryMetadataOrigin,copyHistoryPrimaryMetadataOrigin} from '../src/renderer/utils/historyPrimaryMetadataOrigin.mjs';
declare const prepared:HistoryPrimaryPreparedOwner;
declare const current:HistoryAgentCatalogCurrent;
declare const subject:object;
const signal = new AbortController().signal;
const reader:HistoryAgentCatalogReader = await prepared.openAgentCatalog(current,{signal,owns:()=>true});
let state:HistoryPrimaryAgentCatalogSnapshot|null = null;
const owner = createHistoryPrimaryAgentCatalogOwner({onChange: update=>{ state=update(state); },onReleaseError: error=>{void error;}});
owner.update({ownerKey:'A',generation:1,prepared,current,fullWitness:()=>true,ownerFence:()=>true,subject,deadlineAt:Date.now()+30_000});
owner.requestPage({section:'roster',offset:64,limit:64});
owner.select('task:exact');
const mounted = ['native full UUID'];
owner.requestMembership({entries:mounted,calls:['exact:canonical:19'],any:[{id:'group',kind:'entry',values:()=>mounted.values()}]});
const currentProof:boolean = owner.isCurrent(state);
owner.update({ownerKey:'A',generation:1,prepared,current:null,sourceError:Error('construction'),fullWitness:()=>false});
const page = await reader.readPage({section:'background',offset:0,limit:32,signal});
const count:number = reader.counts.backgroundAgents;
const full = await reader.lookup('task:exact',{signal,owns:()=>true});
if(full.kind==='found') {const key:string = full.record.key; const prompt:unknown=full.record.taskPrompt; void key; void prompt;}
const member = await reader.membership('entry',['exact'],{signal});
const found:boolean|undefined = member[0]?.found;
const marker = historyPrimaryMetadataOrigin({});
if(marker) {const native:boolean=marker.native; const ordinal:number=marker.ordinal; void native; void ordinal;}
const clone=copyHistoryPrimaryMetadataOrigin({}, {uuid:'CURRENT'});
const cap=await openHistoryAgentCatalog(prepared.capability,current.wire,{signal});
void cap;void clone;void found;void count;void currentProof;
await reader.close(); owner.close();
// @ts-expect-error null CURRENT without an explicit source error is not an input
owner.update({ownerKey:'A',generation:1,prepared,current:null,fullWitness:()=>false});
// @ts-expect-error async full witness cannot authorize queued native publication
owner.update({ownerKey:'A',generation:1,prepared,current,fullWitness:async()=>true});
// @ts-expect-error unknown section cannot become an empty roster fact
owner.requestPage({section:'latest'});
// @ts-expect-error a UUID is not a physical catalog page rank
owner.requestPage({offset:'uuid'});
// @ts-expect-error runtime keyed detail is the explicit lookup API
reader.membership('detail',['key']);
// @ts-expect-error full exact selected keys remain strings
reader.lookup(7);
// @ts-expect-error counts are read-only facts of one held cut
reader.counts.total=0;
// @ts-expect-error published bounded pages cannot grow into a roster array
page.rows.push({key:'task:x',kind:'subagent',label:'x'});
// @ts-expect-error pending/missing selections do not promise a detail record
full.record;
// @ts-expect-error no native historical entry inventory
reader.entries;
// @ts-expect-error no writer or Input authority
reader.set('key','body');
// @ts-expect-error a plain header cannot mint prepared ownership
openHistoryAgentCatalog({header:{}},current.wire);
// @ts-expect-error source provenance cannot be retargeted
prepared.metadataSubject={};
// @ts-expect-error origin copying annotates a real existing clone only
copyHistoryPrimaryMetadataOrigin({},null);
// @ts-expect-error mounted group enumeration is synchronous native iteration
owner.requestMembership({any:[{id:'bad',kind:'entry',values:async function*(){yield 'x';}}]});
// @ts-expect-error async guard cannot authorize an independently retained source
prepared.openAgentCatalog(current,{owns:async()=>true});
// @ts-expect-error selected read remains asynchronous
const immediate:HistoryAgentCatalogReader=prepared.openAgentCatalog(current);
// @ts-expect-error membership results cannot be mutated into claimed liveness
member[0]!.found=true;
// @ts-expect-error root subject is a retained object identity, not a revision string
owner.update({ownerKey:'A',generation:1,prepared,current,fullWitness:()=>true,subject:'different'});
// @ts-expect-error selected string is not the exact snapshot publication subject
owner.isCurrent('task:exact');
// @ts-expect-error fresh cleanup proof is synchronous, not a second asynchronous load
owner.isCurrent(state).then(()=>{});
`;
assert(Buffer.byteLength(source) < 10 * 1024);
function diagnostics(text) {
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === filename ? text : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  for (const file of program.getSourceFiles()) assert(!file.fileName.endsWith('HistoryPanel.tsx'), 'no whole-project/Panel parse');
  return ts.getPreEmitDiagnostics(program).map(value => ({code:value.code,
    file:value.file && path.relative(path.resolve(__dirname,'..'),value.file.fileName),
    line:value.file && value.start !== undefined ? value.file.getLineAndCharacterOfPosition(value.start).line+1:null,
    message:ts.flattenDiagnosticMessageText(value.messageText,' ')}));
}
const positive = diagnostics(source);
assert.deepEqual(positive, [], 'actual declaration handoff and every @ts-expect-error control');
const negative = diagnostics(source.replace(/\/\/ @ts-expect-error[^\n]*\n/g,''));
assert.equal(negative.length, 21, 'all 21 actual API controls reject');
assert(negative.some(value=>value.code===2540)); assert(negative.some(value=>value.code===2339));
console.log(JSON.stringify({scope:'V53 actual prepared/model/catalog/current/owner declaration handoff',
  typescript:ts.version,node:process.version,heapLimit:v8.getHeapStatistics().heap_size_limit,
  skipLibCheck:false,noUncheckedIndexedAccess:true,negativeControls:negative.length,positiveDiagnostics:positive.length,
  pins:Object.fromEntries(['src/shared/history-agent-catalog-client.d.mts','src/renderer/utils/historyPrimaryAgentCatalogOwner.d.mts',
    'src/renderer/utils/historyPrimaryPreparedOwner.d.mts','src/renderer/utils/historyPrimaryMetadataOrigin.d.mts',
    'scripts/history-agent-catalog-types-v53.cjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'..',file))).digest('hex')]))}));
