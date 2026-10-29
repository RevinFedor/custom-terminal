'use strict';
// Strict finite ACTUAL Panel caller excerpts. Native UI refs and React hook
// signatures are named typed boundaries; owner/current/source/publication
// declarations are real imports. No complete HistoryPanel/dependency AST.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto'), { getHeapStatistics } = require('node:v8');
const ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
assert.equal(ts.version, '5.9.3');
assert(getHeapStatistics().heap_size_limit <= 140 * 1024 ** 2, 'original128MiB old/2MiB semi declaration budget');
const root = path.resolve(__dirname, '..'), file = path.join(__dirname, '.v53-actual-agent-callers.mts');
const panel = fs.readFileSync(path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const pins = [];
function excerpt(first, last, cap = 8192) {
  const at = panel.indexOf(first), end = panel.indexOf(last, at + first.length);
  assert(at >= 0 && end > at && panel.indexOf(first, at + first.length) < 0, first);
  const text = panel.slice(at, end); assert(Buffer.byteLength(text) <= cap);
  pins.push({ first, bytes: Buffer.byteLength(text), sha256: sha(text) }); return text;
}
const publication = excerpt('  const publishHistoryRows = useCallback(', '  const primaryLocalPublicationAtRender =');
const admission = excerpt('  useLayoutEffect(() => {\n    if (!primaryPhysicalCandidate) return;\n    const input = primaryAgentCatalogInputs;',
  '  // `transcriptEntries` already committed');
const dock = excerpt('  const requestAgentCatalogPage = useCallback(', '  useLayoutEffect(() => {\n    // One already selected native record');
const selectedCurrentCapture = excerpt('  useLayoutEffect(() => {\n    // One already selected native record', '  const primaryAgentCurrentChipsAtPublish =');
const cleanup = excerpt('  useEffect(() => {\n    if (!expandedBackgroundChipKey || !chipsOwnerSettled) return;',
  '  useEffect(() => {\n    primaryAgentSelectionEpochRef.current++;\n    const epoch = primaryAgentSelectionEpochRef.current, ownerKey = historyOwnerKey;');
const reset = excerpt('  useEffect(() => {\n    primaryAgentSelectionEpochRef.current++;\n    const epoch = primaryAgentSelectionEpochRef.current, ownerKey = historyOwnerKey;',
  '  const openHistoryAgent = useCallback(');
const currentPage = excerpt('  const agentCount = catalog ?',
  '  if (displayChips.length === 0 && agentCount === 0');
const liveCounts = excerpt('  const primaryAgentCurrentChipsAtPublish =', '  useEffect(() => {');
const liveMembership = excerpt('  const primaryAgentLiveness = useMemo(', '  const availableDetailKeys = useMemo(');
const currentFace = excerpt('  const primaryAgentCurrentFace = (', '  const primaryAgentCatalogCurrentSnapshot =');
const chipTypes = excerpt('interface HistoryBackgroundChip {', 'const EMPTY_HISTORY_AGENTS:');
const frame = `import {createHistoryAgentCatalogCurrent} from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import type {HistoryAgentCatalogSource,HistoryAgentCatalogSourceOwner} from '../src/renderer/utils/historyAgentCatalogSourceOwner.mjs';
import type {HistoryPrimaryAgentCatalogOwner,HistoryPrimaryAgentCatalogSnapshot} from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
import type {HistoryPrimaryShownPublication,HistoryPrimarySparsePublicationOwner} from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
import type {HistoryAgentCatalogCounts} from '../src/shared/history-agent-catalog-client.mjs';
type SubagentLaunchSettings=unknown;
interface FullHistoryEntry {uuid:string;role:string;content?:string;}
declare function useMemo<T>(fn:()=>T,deps:readonly unknown[]):T;
declare function useCallback<T extends (...args:any[])=>any>(fn:T,deps:readonly unknown[]):T;
declare function useLayoutEffect(fn:()=>void|(()=>void),deps:readonly unknown[]):void;
declare function useEffect(fn:()=>void|(()=>void),deps:readonly unknown[]):void;
declare const historyOwnerKeyRef:{current:string},historyOwnerGenerationRef:{current:number};
declare const presentationEntriesRef:{current:FullHistoryEntry[]};
declare const primaryAgentCatalogModeRef:{current:boolean};
declare const primaryPhysicalCandidate:boolean,chipsOwnerSettled:boolean;
declare const historyOwnerKey:string;
declare const primaryAgentSourceOwner:HistoryAgentCatalogSourceOwner<FullHistoryEntry>;
declare const primarySparsePublicationOwner:HistoryPrimarySparsePublicationOwner<FullHistoryEntry>;
declare const primaryAgentCatalogOwner:HistoryPrimaryAgentCatalogOwner;
type Input=Readonly<{source:HistoryAgentCatalogSource<FullHistoryEntry>|null;
  publication:HistoryPrimaryShownPublication<FullHistoryEntry>; ownerKey:string;generation:number;
  rows:readonly FullHistoryEntry[];live:FullHistoryEntry[];rawLiveOwner:object;settled:boolean;
  context:Parameters<typeof createHistoryAgentCatalogCurrent>[0]['context']}>;
declare const primaryAgentCatalogInputs:Input,primaryAgentCatalogInputsRef:{current:Input};
declare const liveProjectionRef:{current:object};
declare const primaryPresentationDataCommitRef:{current:{publication:HistoryPrimaryShownPublication<FullHistoryEntry>}|null};
declare const primaryAgentCatalogCurrentSnapshot:HistoryPrimaryAgentCatalogSnapshot|null;
declare const expandedBackgroundChipKey:string|null,availableDetailKeys:ReadonlySet<string>|null;
declare const primaryAgentSelectionEpochRef:{current:number};
declare const primaryAgentCurrentSelectionEpochAtRender:number;
declare const primaryAgentCurrentSelectedRef:{current:{ownerKey:string;generation:number;key:string;epoch:number;record:HistoryBackgroundChip}|null};
declare const primaryAgentCurrentFace:{status:'ready'|'pending'|'error';chips:HistoryBackgroundChip[];agents:HistoryAgentChip[];error:any;isCurrent:()=>boolean};
declare const EMPTY_HISTORY_CHIPS:HistoryBackgroundChip[];
declare const EMPTY_HISTORY_AGENTS:HistoryAgentChip[];
declare function setExpandedBackgroundChipKey(value:string|null|((current:string|null)=>string|null)):void;
declare function setAgentRosterOpen(value:boolean):void;
declare const chips:HistoryBackgroundChip[],agents:HistoryAgentChip[],catalog:HistoryAgentCatalogDock|null|undefined;
declare const primaryAgentCatalogDock:HistoryAgentCatalogDock|null,primaryAgentMembershipDemand:object;
declare const backgroundHistoryChips:HistoryBackgroundChip[];
declare const currentChipPageOffset:number;
declare function setCurrentChipPageOffset(value:number):void;
declare function buildHistoryLivePresentation(rows:FullHistoryEntry[],live:FullHistoryEntry[]):FullHistoryEntry[];
declare function collectHistoryBackgroundChips(rows:FullHistoryEntry[],busy:boolean,alive:boolean,session:string,generation:string|null,toolType:string,active:any,background:any,terminal:any):HistoryBackgroundChip[];
declare function collectHistoryAgentChips(rows:FullHistoryEntry[],chips:HistoryBackgroundChip[],facts:any):HistoryAgentChip[];
declare function isLocalPromptEntry(row:FullHistoryEntry):boolean;
declare function isTaskAction(action:unknown):boolean;
declare function historyAgentKey(action:unknown,entryUuid:string):string;
declare function historyPrimaryPromptAdoptionFingerprint(value:unknown):string;
`;
const fragments = { publication, admission, dock, cleanup, reset, currentPage, currentFace, liveCounts, liveMembership, selectedCurrentCapture };
const options = { strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [] };
function diagnose(parts) {
  const source = frame + chipTypes + Object.entries(parts).map(([name, code]) => '\nfunction actual_' + name + '(){\n' + code + '\n}').join('\n');
  assert(Buffer.byteLength(source) < 32 * 1024);
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === file ? source : read(name);
  host.fileExists = name => name === file || exists(name);
  const program = ts.createProgram([file], options, host);
  for (const value of program.getSourceFiles()) assert(!value.fileName.endsWith('HistoryPanel.tsx'));
  return ts.getPreEmitDiagnostics(program).map(value => ({code:value.code,
    message:ts.flattenDiagnosticMessageText(value.messageText,' ')}));
}
assert.deepEqual(diagnose(fragments), [], 'original actual callers and genuine public contracts');
const mutations = [
  ['async owner cannot authorize native operations', 'admission', 'const owns = () =>', 'const owns = async () =>'],
  ['source subject is original object identity', 'admission', 'subject: input,', "subject: 'revision-only',"],
  ['CURRENT original witness cannot be asynchronous', 'admission', 'fullWitness: () => fingerprint', 'fullWitness: async () => fingerprint'],
  ['page demand rejects invented section', 'dock', 'primaryAgentCatalogOwner.requestPage(request);', "primaryAgentCatalogOwner.requestPage({section:'last-K',offset:0,limit:64});"],
  ['UNKNOWN is not missing', 'cleanup', "selected.kind === 'missing'", "selected.kind === 'empty'"],
  ['published bounded rows are immutable', 'dock', 'const snapshot = primaryAgentCatalogCurrentSnapshot;',
    "const snapshot = primaryAgentCatalogCurrentSnapshot; snapshot?.rows.push({key:'task:x',kind:'subagent',label:'x'});"],
  ['queued reset updater remains synchronous', 'reset', 'setExpandedBackgroundChipKey((current) =>',
    'setExpandedBackgroundChipKey(async (current) =>'],
  ['CURRENT face must consume native rows, not an invented scalar', 'currentFace', 'buildHistoryLivePresentation(input.rows as FullHistoryEntry[],', "buildHistoryLivePresentation('not rows',"],
  ['original synchronous CURRENT witness cannot be replaced by a Promise', 'currentFace', 'const witness = historyPrimaryPromptAdoptionFingerprint(nativeInput);', 'const witness = Promise.resolve(historyPrimaryPromptAdoptionFingerprint(nativeInput));'],
  ['selected CURRENT cache retains an exact record rather than an arbitrary owner object', 'selectedCurrentCapture', 'key, epoch, record };', 'key, epoch, record: input };'],
  ['CURRENT page offset remains a numeric coordinate', 'currentPage', 'setCurrentChipPageOffset(offset);',
    "setCurrentChipPageOffset('32');"],
];
const negatives = [];
for (const [name, key, before, after] of mutations) {
  assert(fragments[key].includes(before), name);
  const diagnostics = diagnose({...fragments,[key]:fragments[key].replace(before,after)});
  assert(diagnostics.length > 0, name); negatives.push({name,rejected:true,codes:[...new Set(diagnostics.map(x=>x.code))]});
}
console.log(JSON.stringify({scope:'V53 strict bounded ACTUAL Panel publication/admission/dock/cleanup callers; typed React/ref boundaries',
  panelSHA256:sha(panel),panelBytes:Buffer.byteLength(panel),pins,node:process.version,typescript:ts.version,
  heapLimit:getHeapStatistics().heap_size_limit,skipLibCheck:false,noUncheckedIndexedAccess:true,positive:'PASS',negatives}));
