'use strict';

// V50 finite strict declaration and actual caller controls. No application
// build, project-wide program, complete Panel AST, Electron, or native claim.
// Run alone with <=128MiB heap: node --max-old-space-size=96 --max-semi-space-size=4 scripts/history-primary-metadata-types.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const v8 = require('node:v8');
const ts = require('typescript');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite declaration heap');
const ROOT = path.resolve(__dirname, '..');
const filename = path.join(__dirname, '.history-primary-metadata-probe.mts');
const options = { strict: true, noEmit: true, skipLibCheck: false,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [], allowJs: true, checkJs: false };
function diagnostics(source) {
  assert(Buffer.byteLength(source) < 32 * 1024, 'only bounded caller/type probes');
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === filename ? source : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  for (const file of program.getSourceFiles()) assert(!file.fileName.endsWith('HistoryPanel.tsx'), 'full Panel AST forbidden');
  return ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
}
const declaration = `import {HistoryPrimaryRootReadModel, type HistoryPrimaryMetadata,
  type HistoryPrimaryCanonicalMetadataFact, type HistoryPrimaryDiagnosticMetadataValue} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import type {HistoryPrimaryPromptAdoptionCandidate} from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
declare const root:HistoryPrimaryRootReadModel, candidate:HistoryPrimaryPromptAdoptionCandidate;
const metadata = root.metadata;
if (metadata) {
  const kind:'prepared-metadata-compatibility' = metadata.preparedCompatibilityKind;
  const fact:HistoryPrimaryCanonicalMetadataFact = metadata.canonicalMetadataFact;
  const count:number = fact.canonicalEntryCount;
  const lease:string = fact.leaseId;
  const source:string = fact.sourceSnapshot.fileIdentity;
  const receipt:string = fact.validationReceipt;
  if (fact.diagnosticTail.kind === 'row') {
    const ordinal:number = fact.diagnosticTail.ordinal;
    const uuid:HistoryPrimaryDiagnosticMetadataValue|undefined = fact.diagnosticTail.row.uuid;
    // @ts-expect-error a selected diagnostic row is not a body
    fact.diagnosticTail.row.content;
    // @ts-expect-error a selected checked field is immutable
    fact.diagnosticTail.row.uuid = 'other';
  } else {
    const empty:'empty' = fact.diagnosticTail.kind;
    // @ts-expect-error a known empty domain has no row
    fact.diagnosticTail.row;
  }
  // @ts-expect-error retired Nc native inventory is unavailable
  metadata.durableEntries;
  // @ts-expect-error prepared compatibility is a genuine frozen inventory
  metadata.entries.push(metadata.entries[0]);
  // @ts-expect-error a caller cannot replace the validation fact
  metadata.canonicalMetadataFact = fact;
  // @ts-expect-error exact validated count cannot be upgraded
  fact.canonicalEntryCount = 0;
  // @ts-expect-error a fact cannot be rebound by caller mutation
  fact.leaseId = 'new-lease';
  // @ts-expect-error source binding is deeply readonly
  fact.sourceSnapshot.fileIdentity = 'foreign';
  // @ts-expect-error validation receipt cannot be forged in place
  fact.validationReceipt = 'forged';
}
// @ts-expect-error a root with no adopted validation fact is not successful metadata
root.metadata.canonicalMetadataFact;
// @ts-expect-error provisional prepare also exposes no canonical inventory
candidate.metadata.durableEntries;
// @ts-expect-error an empty prepared array cannot stand in for canonical validation
const invented:HistoryPrimaryMetadata = {preparedCompatibilityKind:'prepared-metadata-compatibility',entries:[],effectiveSettings:null};
// @ts-expect-error success-shaped plain objects cannot construct the private checked fact
const forged:HistoryPrimaryCanonicalMetadataFact = {kind:'validated-canonical-metadata'};
`;
assert.deepEqual(diagnostics(declaration), [], 'actual metadata/candidate declarations accept checked consumers');
const negative = diagnostics(declaration.replace(/\/\/ @ts-expect-error[^\n]*\n/g, ''));
assert.equal(negative.length, 14, 'every exact metadata declaration negative must reject');
assert(negative.some(d => d.code === 2339));
assert(negative.some(d => d.code === 2540));
assert(negative.some(d => d.code === 2741 || d.code === 2740));

const panel = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
function cut(first, last) {
  const from = panel.indexOf(first), to = panel.indexOf(last, from + first.length);
  assert(from >= 0 && to > from, first);
  assert.equal(panel.indexOf(first, from + first.length), -1, 'actual callback start must be unique');
  const result = panel.slice(from, to);
  assert(Buffer.byteLength(result) < 16 * 1024, 'bounded actual callback');
  return result;
}
const fragments = {
  selectedRef: cut('  const primaryCanonicalDiagnosticRef =', '\n  const isTurnBusyRef ='),
  prepare: cut('          prepareAdopt: async (candidate) => {', '          adopt: (adopted, promptAdoption) => {'),
  adopt: cut('          adopt: (adopted, promptAdoption) => {', '\n          });\n        } catch (error) {'),
  diagnostic: cut('  // This render\'s candidate and O(1) sample are committed data', '  // Capture the actual render\'s cut before the layout effect'),
  commit: cut('  // Capture the actual render\'s cut before the layout effect', '  // Bind coverage to THIS render\'s committed canonical cut'),
};
const frame = `import {HistoryPrimaryRootReadModel, historyPrimaryLiveClaimFingerprint,
  type HistoryPrimaryReadHeader, type HistoryPrimaryEffectiveSettings} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import {captureHistoryPrimaryPanelWitness, type HistoryPrimaryPanelWitness} from '../src/renderer/utils/historyPrimaryPanelBindings.mjs';
import type {HistoryPrimaryLiveDataCommit,HistoryPrimaryLiveFoldCommit} from '../src/renderer/utils/historyPrimaryLiveCoverageOwner.mjs';
interface FullHistoryEntry {uuid:string;role:string;rowStub?:boolean;liveProjection?:boolean;[key:string]:unknown}
type Ref<T>={current:T};
declare function useRef<T>(value:T):Ref<T>;
declare function useLayoutEffect(effect:()=>void|(()=>void),dependencies:readonly unknown[]):void;
declare const primaryPhysicalCandidate:boolean, surfaceLoading:boolean;
declare const primaryRoot:HistoryPrimaryRootReadModel|null;
declare const primaryRootRef:Ref<HistoryPrimaryRootReadModel|null>;
declare const historyOwnerKey:string,presentedOwnerKey:string,ownerKeyAtStart:string,tabId:string,sessionId:string|null;
declare const generationAtStart:number,historyPresentationVisit:number,capturedSuppressionCount:number,loadSequence:number;
declare const requestClass:'source'|'semantic'|'view',requestVersion:number,primaryRequestVersionRef:Ref<number>;
declare const historyOwnerKeyRef:Ref<string>,historyOwnerGenerationRef:Ref<number>;
declare const signal:AbortSignal|undefined;
declare function isCurrentOwner():boolean;
declare function viewCurrent():boolean;
declare const presentationEntriesRef:Ref<FullHistoryEntry[]>;
declare const viewPublicationEntries:{current:FullHistoryEntry[]};
declare const entries:FullHistoryEntry[],transcriptEntries:FullHistoryEntry[];
declare const suppressedPromptsRef:Ref<Map<string,unknown>>;
declare const composition:{localEntries:FullHistoryEntry[];settingsPresentationKeys:unknown[]};
declare const compositionFingerprint:string,viewWitness:{rewind:unknown;live:unknown;results:unknown},historySnapshotOwner:unknown;
declare const useUIStore:{getState():{historyRewindPreviews:Record<string,unknown>}};
declare const primarySurfaceWitnessRef:Ref<HistoryPrimaryPanelWitness|null>;
declare const lastServerEntryUuidsRef:Ref<Set<string>>;
declare const historyPresentationApplyGuardRef:Ref<(reason:string)=>void>;
declare const payloadGenerationRef:Ref<{ownerKey:string;value:string}|null>;
declare const physicalFileIdentityRef:Ref<{ownerKey:string;value:string}|null>;
declare const historyRevisionRef:Ref<string|null>,rewindPrefixOnScreenRef:Ref<unknown>,historyLoaderReasonRef:Ref<string>;
declare const primaryCompositionAppliedRef:Ref<unknown>,primarySuppressionCountAppliedRef:Ref<number|null>;
declare const historyPresentationProofRef:Ref<{presented:boolean;visit:number}>;
interface Diagnostics {candidate():unknown;adopt(attempt:unknown,source:{revisionToken:string;payloadGeneration:string;row:unknown}):unknown;
  commit(candidate:unknown,identity:{ownerKey:string;sessionId:string|null;generation:number;presentationVisit:number},row:unknown):unknown}
declare const historyCommitDiagnosticsRef:Ref<Diagnostics|null>,historyDiagnosticAttempt:unknown;
declare const primaryReceiptCommitRef:Ref<HistoryPrimaryLiveDataCommit|null>;
declare const primaryLiveCommitRef:Ref<HistoryPrimaryLiveFoldCommit<FullHistoryEntry>|null>;
declare const liveProjectionRef:Ref<{ownerKey:string;entries:FullHistoryEntry[]}>;
declare const liveToolResultsRef:Ref<{ownerKey:string;results:Map<string,unknown>}>;
declare const primaryLiveCoverageOwner:{wake(reason:'commit'):void};
declare const rawServerEntriesRef:Ref<FullHistoryEntry[]>;
declare const committedHistoryEntriesRef:Ref<{ownerKey:string;entries:FullHistoryEntry[]}>;
declare function filterSuppressedPromptEntries(rows:FullHistoryEntry[],suppressions:Iterable<unknown>):{entries:FullHistoryEntry[]};
declare function isLocalPromptEntry(row:FullHistoryEntry):boolean;
declare function isLocalRewindEntry(row:FullHistoryEntry):boolean;
declare function isLocalCompactErrorEntry(row:FullHistoryEntry):boolean;
declare function reconcileCodexEffectiveSettings(tabId:string,sessionId:string|null,rows:FullHistoryEntry[],options:{effective:HistoryPrimaryEffectiveSettings|null}):void;
declare function setEntries(rows:FullHistoryEntry[]):void;
declare function persistVolatileOverlay(owner:unknown,rows:FullHistoryEntry[]):void;
declare function setPayloadGeneration(generation:string):void;
declare function setPrimaryRoot(root:HistoryPrimaryRootReadModel):void;
declare function setPrimaryRootRevision(update:(previous:number)=>number):void;
declare function setChipsFreshOwnerKey(owner:string):void;
declare function setHistoryLoadError(error:null):void;
declare function setLoading(loading:boolean):void;
declare function historyDiag(message:string):void;
declare function reconcileLiveProjectionAgainstDurable(rows:FullHistoryEntry[],owner:string):void;
declare function consumeMaterializedPromptHandoffs(rows:FullHistoryEntry[]):void;
declare function consumePrimaryMaterializedPromptHandoffs():void;
`;
const callers = frame + fragments.selectedRef
  + '\nconst openOptions:NonNullable<Parameters<HistoryPrimaryRootReadModel["open"]>[1]>={\n'
  + fragments.prepare + fragments.adopt + '\n};\n' + fragments.diagnostic + fragments.commit;
assert.deepEqual(diagnostics(callers), [], 'typed actual selected ref, prepare/adopt and diagnostic/data effects');
const guardedTail = "selected.fact.diagnosticTail.kind === 'row' ? selected.fact.diagnosticTail.row : undefined";
assert.equal(callers.split(guardedTail).length, 2);
const callerNegative = diagnostics(callers.replace(guardedTail, 'selected.fact.diagnosticTail.row'));
assert.equal(callerNegative.length, 1, 'removing actual empty/row discrimination must reject');
assert.equal(callerNegative[0].code, 2339);
const sha = text => createHash('sha256').update(text).digest('hex');
console.log(JSON.stringify({ scope:'strict actual V50 declarations and five bounded verbatim Panel fragments; typed React/ref frame only',
  typescript:ts.version,positive:'PASS',negativeCount:negative.length,negativeDiagnostics:negative,callerNegative,
  callbacks:Object.fromEntries(Object.entries(fragments).map(([name,text])=>[name,{bytes:Buffer.byteLength(text),sha256:sha(text)}])),
  heapLimit:v8.getHeapStatistics().heap_size_limit }));
