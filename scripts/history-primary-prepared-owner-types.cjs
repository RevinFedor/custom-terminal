'use strict';
// V52 narrow actual declared Panel handoff. Full standard libraries are
// checked; no raw-client checkJS, whole Panel AST, app build or ambient stubs.
// NOTED_TYPESCRIPT_PATH=... node --max-old-space-size=128 --max-semi-space-size=2 scripts/history-primary-prepared-owner-types.cjs
const assert = require('node:assert/strict'), path = require('node:path'), v8 = require('node:v8');
const ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
assert(v8.getHeapStatistics().heap_size_limit <= 140 * 1024 ** 2, 'original bounded compiler cap');
const filename = path.join(__dirname, '.history-primary-prepared-owner-probe.mts');
const options = { strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: false,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [] };
function diagnostics(source) {
  assert(Buffer.byteLength(source) < 10 * 1024);
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === filename ? source : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  for (const file of program.getSourceFiles()) assert(!file.fileName.endsWith('HistoryPanel.tsx'), 'no whole Panel parse');
  return ts.getPreEmitDiagnostics(program).map(value => ({ code: value.code,
    line: value.file && value.start !== undefined ? value.file.getLineAndCharacterOfPosition(value.start).line + 1 : null,
    message: ts.flattenDiagnosticMessageText(value.messageText, ' ') }));
}
const source = `import type {HistoryPrimaryRootReadModel, HistoryPrimaryPreparedMetadataRow}
  from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import type {HistoryPrimaryPreparedOwner, HistoryPrimaryPreparedCapability}
  from '../src/renderer/utils/historyPrimaryPreparedOwner.mjs';
import type {HistoryPrimaryPromptAdoptionCandidate}
  from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
import {createHistoryPrimarySparsePublicationOwner}
  from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
import {canBindHistoryPreparedPositionFrame,createHistoryPreparedPositionSource}
  from '../src/renderer/utils/historyPreparedPosition.mjs';
import {createHistoryPresentationPositionOwner}
  from '../src/renderer/utils/historyPresentationPosition.mjs';
declare const model: HistoryPrimaryRootReadModel;
declare const candidate: HistoryPrimaryPromptAdoptionCandidate;
interface Row {uuid:string;role:string;content:string;timestamp:string;rowStub?:boolean}
declare const rows: Row[];
const scope = {ownerKey:'A',generation:1};
const signal = new AbortController().signal;
const prepared:HistoryPrimaryPreparedOwner = model.retainPreparedPresentation({signal,owns:()=>true});
const again:HistoryPrimaryPreparedOwner = prepared.retain({owns:()=>true});
const selected:HistoryPrimaryPreparedMetadataRow = await again.readMetadataOrdinal(0,{signal,owns:()=>true});
const exact:boolean = again.ownsCompatibilityMetadata(rows);
const state:'held'|'pending'|'released'|'unknown' = again.releaseState;
const capability:HistoryPrimaryPreparedCapability = again.capability;
const shown = createHistoryPrimarySparsePublicationOwner<Row>({isLocal:row=>row.role==='queued'});
const current = shown.publishCompatibility(rows,scope,{owns:()=>true});
const proof = await candidate.preparePromptAdoptionSparse(rows,rows,{isLocal:row=>row.role==='queued',signal,owns:()=>true});
const native = proof.materializeCompatibility(rows);
const publication = shown.adopt(proof,native,scope);
const units = [{kind:'entry' as const,entry:rows[0]!}];
const input = {prepared:publication.prepared,metadata:[],sparse:publication.sparse,
  currentRows:publication.rows,units,itemKeys:['exact-full-key'],owns:()=>true};
const canBind:boolean = await canBindHistoryPreparedPositionFrame(input,{signal});
const positionSource = createHistoryPreparedPositionSource({...input,invoke:async()=>({})});
const position = createHistoryPresentationPositionOwner({invoke:async()=>({})});
const positionPublication = position.publish({source:positionSource,frame:{},witness:{},owns:()=>true});
await again.close();await prepared.close();await prepared.retirement();
// @ts-expect-error async owner does not authorize a synchronous retained handle
model.retainPreparedPresentation({owns:async()=>true});
// @ts-expect-error the original signal is required, not its controller
prepared.readMetadataOrdinal(0,{signal:new AbortController()});
// @ts-expect-error a UUID does not replace an original ordinal
prepared.readMetadataOrdinal('uuid');
// @ts-expect-error selected row read remains asynchronous
const immediate:HistoryPrimaryPreparedMetadataRow = prepared.readMetadataOrdinal(0);
// @ts-expect-error source identity of a retained handle is immutable
prepared.header = model.header!;
// @ts-expect-error a consumer cannot upgrade UNKNOWN cleanup
prepared.releaseState = 'released';
// @ts-expect-error retained wrapper exposes no historical row inventory
prepared.entries;
// @ts-expect-error selected read authority conveys no input writer
prepared.canWriteInput;
// @ts-expect-error plain count/header cannot fabricate the runtime-branded capability
const fake:HistoryPrimaryPreparedCapability = {header:model.header};
// @ts-expect-error canonical validation cannot replace independent prepared ownership
const canonicalOwner:HistoryPrimaryPreparedOwner = model.metadata!.canonicalMetadataFact;
// @ts-expect-error sparse result must be awaited before adoption
shown.adopt(candidate.preparePromptAdoptionSparse(rows,rows,{isLocal:()=>true}),native,scope);
// @ts-expect-error CURRENT local array belongs to publication, not mutation consumers
publication.rows.push(rows[0]!);
// @ts-expect-error published data subject cannot be retargeted to a canonical tail
publication.dataSubject = model.metadata!.canonicalMetadataFact.diagnosticTail;
// @ts-expect-error current-local-only publication is not a sparse adoption proof
shown.adopt(current,native,scope);
// @ts-expect-error prepared selection owner must implement a selected ordinal reader
createHistoryPreparedPositionSource({prepared:{closed:false},units,itemKeys:['x'],invoke:async()=>({})});
// @ts-expect-error async frame authority cannot authorize registration
canBindHistoryPreparedPositionFrame({units,owns:async()=>true});
`;
const positive = diagnostics(source);
assert.deepEqual(positive, [], 'actual model/prepared/sparse/position declaration handoff');
const negative = diagnostics(source.replace(/\/\/ @ts-expect-error[^\n]*\n/g, ''));
assert.equal(negative.length, 16, 'all meaningful negative controls reject');
assert(negative.some(value => value.code === 2540), 'readonly owner/source evidence');
assert(negative.some(value => value.code === 2339), 'no inventory or writer authority');
console.log(JSON.stringify({scope:'V52 actual declared model/prepared/sparse/position Panel handoff',
  typescript:ts.version,node:process.version,skipLibCheck:false,noUncheckedIndexedAccess:true,
  heapLimit:v8.getHeapStatistics().heap_size_limit,positive:'PASS',negativeCount:negative.length,negative}));
