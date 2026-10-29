'use strict';

// Narrow actual declaration/caller probes. No Panel AST/world compilation.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ts = process.env.V51_TYPESCRIPT_PATH ? require(process.env.V51_TYPESCRIPT_PATH) : require('typescript');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-position-types-'));
const source = `
import { createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery } from ${JSON.stringify(path.join(root, 'src/renderer/utils/historyPresentationPosition.mjs'))};
import type { HistoryPositionPublication, HistoryPositionAddress, HistoryPositionReadOptions } from ${JSON.stringify(path.join(root, 'src/renderer/utils/historyPresentationPosition.mjs'))};
import { createHistoryPreparedPositionSource } from ${JSON.stringify(path.join(root, 'src/renderer/utils/historyPreparedPosition.mjs'))};
import type { HistoryPreparedPositionMetadataOwner } from ${JSON.stringify(path.join(root, 'src/renderer/utils/historyPreparedPosition.mjs'))};
import type { HistoryPrimarySparsePublication } from ${JSON.stringify(path.join(root, 'src/renderer/utils/historyPrimaryPromptAdoption.mjs'))};
type Row = {uuid:string;sourceIdentityAliases?:readonly string[]};
const owner = createHistoryPresentationPositionOwner<Row>({invoke:async (_channel, _payload)=>({})});
const units = [{kind:'entry' as const,entry:{uuid:'full\\0\\ud800😀'}}];
const frame={},witness={};
const publication=owner.publish({units,itemKeys:['uuid:exact'],frame,witness,owns:()=>true});
const lane=createHistoryPresentationPositionQuery(owner);
const signal=new AbortController().signal;
if(publication){
  const original:HistoryPositionPublication=publication;
  const selected=await lane.resolve(original,'full\\0\\ud800😀',{owns:()=>true,signal});
  if(selected.status==='ready'&&selected.address){
    const address:HistoryPositionAddress<Row>=selected.address;
    const member:Row|null=owner.entryAt(address);
    const rank:number=address.index;
    const key:string=address.physicalKey;
    const uuid:unknown=member?.uuid;
    void rank;void key;void uuid;
  }
  await lane.resolve(original,7n);
  await lane.resolve(original,true);
  await lane.resolve(original,1);
  await lane.resolve(original,null);
  await lane.resolve(original,undefined);
  // @ts-expect-error object UUID cannot enter the typed point protocol
  await lane.resolve(original,{});
  // @ts-expect-error symbol UUID cannot enter the typed point protocol
  await lane.resolve(original,Symbol());
  // @ts-expect-error function UUID cannot enter the typed point protocol
  await lane.resolve(original,()=>1);
  // @ts-expect-error async ownership is not synchronous authority
  await lane.resolve(original,'x',{owns:async()=>true});
  // @ts-expect-error captured owner guard cannot return a string
  await lane.resolve(original,'x',{owns:()=>''});
  // @ts-expect-error AbortController is not its captured signal
  await lane.resolve(original,'x',{signal:new AbortController()});
  // @ts-expect-error coordinates do not expose a full UUID inventory
  original.uuidMap;
  // @ts-expect-error position publication conveys no writer authority
  original.canWriteInput;
  // @ts-expect-error projection identity is readonly
  original.projectionId='replacement';
}
// @ts-expect-error raw canonical Root is not a presentation publication
lane.read({header:null,closed:false},'x');
// @ts-expect-error fabricated rank is not a branded selected address
owner.entryAt({index:0,physicalKey:'uuid:x'});
// @ts-expect-error rank cannot stand in for a physical key
owner.publish({units,itemKeys:[0],frame,witness,owns:()=>true});
// @ts-expect-error an async guard cannot publish a coordinate capability
owner.publish({units,itemKeys:['x'],frame,witness,owns:async()=>true});
// @ts-expect-error native entries alone do not supply a display-unit projection
owner.publish({units:[{uuid:'x'}],itemKeys:['x'],frame,witness,owns:()=>true});
// @ts-expect-error publication requires original witness
owner.publish({units,itemKeys:['x'],frame,owns:()=>true});
// @ts-expect-error publication requires original frame identity
owner.publish({units,itemKeys:['x'],witness,owns:()=>true});
// @ts-expect-error wrong invoke capability
createHistoryPresentationPositionOwner({invoke:42});
// @ts-expect-error query lane requires complete owner capability
createHistoryPresentationPositionQuery({query:async()=>null});
// @ts-expect-error position read ownership cannot be a Promise
const bad:HistoryPositionReadOptions={owns:()=>Promise.resolve(true)};
// @ts-expect-error readonly selected address cannot be retargeted to another rank
function retarget(address:HistoryPositionAddress){address.index=1;}
declare const prepared: HistoryPreparedPositionMetadataOwner<Row>;
const sparseSource=createHistoryPreparedPositionSource<Row>({invoke:async()=>({}),prepared,
  metadata:units.map(unit=>unit.entry),currentRows:[],units,itemKeys:['actual-full-key']});
const selectedPublication=owner.publish({source:sparseSource,frame,witness,owns:()=>true});
if(selectedPublication){
  const selected=await lane.resolve(selectedPublication,'kept');
  if(selected.address){const row:Row|null=owner.entryAt(selected.address);void row;}
}
// @ts-expect-error selected source unit count cannot be rewritten
sparseSource.unitCount=4;
// @ts-expect-error a ready Root header is not an independently retained prepared metadata owner
createHistoryPreparedPositionSource<Row>({invoke:async()=>({}),prepared:{header:null},units,itemKeys:['x']});
// @ts-expect-error source must allocate an independently selected client, not null
owner.publish({source:{unitCount:1,open:()=>null},frame,witness,owns:()=>true});
// @ts-expect-error full selected publication still requires original witness
owner.publish({source:sparseSource,frame,owns:()=>true});
// @ts-expect-error metadata rows cannot substitute full physical keys
createHistoryPreparedPositionSource<Row>({invoke:async()=>({}),units,itemKeys:units});
// @ts-expect-error async ownership cannot prove a selected-source publication
owner.publish({source:sparseSource,frame,witness,owns:async()=>true});
// @ts-expect-error source statistics expose no historical UUID registry
sparseSource.stats().uuidMap;
// @ts-expect-error selected metadata reads accept original integer ordinal only
prepared.readMetadataOrdinal('row');
type Thin=Row&{readonly rowStub:true};
type Current=Row&{content:string;rowStub?:boolean};
declare const thinOwner:HistoryPreparedPositionMetadataOwner<Thin>;
declare const sparsePlan:HistoryPrimarySparsePublication<Current>;
const localRows:Current[]=[{uuid:'local',content:'full'}];
const mixedSource=createHistoryPreparedPositionSource({invoke:async()=>({}),prepared:thinOwner,sparse:sparsePlan,
  metadata:[],currentRows:localRows,units:localRows.map(entry=>({kind:'entry' as const,entry})),itemKeys:['key']});
const mixedOwner=createHistoryPresentationPositionOwner<Current|Thin>({invoke:async()=>({})});
const mixedPublication=mixedOwner.publish({source:mixedSource,frame,witness,owns:()=>true});
if(mixedPublication){
  const point=await mixedOwner.query(mixedPublication,'historical');
  if(point){
    const row:Current|Thin=point.entry;void row;
    // @ts-expect-error a selected historical thin row is not guaranteed full CURRENT content
    const invented:Current=point.entry;
    void invented;
  }
}
await owner.clear();owner.activate();lane.clear();lane.dispose();await owner.dispose();
`;
try {
  const filename = path.join(temp, 'probe.mts'); fs.writeFileSync(filename, source);
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true,
    noUncheckedIndexedAccess: true, skipLibCheck: false, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] };
  const program = ts.createProgram([filename], options), diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    })); process.exitCode = 1;
  } else console.log(JSON.stringify({ status: 'PASS', compiler: ts.version,
    declaration: 'src/renderer/utils/historyPresentationPosition.d.mts',
    strict: true, noUncheckedIndexedAccess: true, negativeControls: (source.match(/@ts-expect-error/g) || []).length,
    scope: 'narrow declaration plus finite actual public API callers; no Panel/world typecheck' }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
