'use strict';

// Finite declaration/caller control. No full Panel AST, application build or
// project-wide TypeScript program. Use the documented <=128MiB V8 envelope.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const ts = require('typescript');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2);
const ROOT = path.resolve(__dirname, '..');
const filename = path.join(__dirname, '.history-primary-live-probe.mts');
const options = { strict: true, noEmit: true, skipLibCheck: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [], allowJs: true, checkJs: false };

function diagnostics(source) {
  assert(Buffer.byteLength(source) < 40 * 1024, 'only narrow caller slices');
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === filename ? source : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  for (const file of program.getSourceFiles()) {
    assert(!file.fileName.endsWith('HistoryPanel.tsx'), 'full Panel AST is forbidden');
  }
  return ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
}

const declaration = `import {HistoryPrimaryRootReadModel, type HistoryPrimaryLiveIdentityCoverageProof} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import {createHistoryPrimaryLiveCoverageOwner, type HistoryPrimaryLiveCoverageOwner} from '../src/renderer/utils/historyPrimaryLiveCoverageOwner.mjs';
declare const root: HistoryPrimaryRootReadModel;
const entry = {sourceIdentity:'current', sourceIdentityAliases:['alias']};
const proof: HistoryPrimaryLiveIdentityCoverageProof<typeof entry> = await root.readLiveIdentityCoverage([entry], {owns:()=>true});
const covered: boolean = proof.claims[0].coveredIdentity;
const conflict: boolean = proof.claims[0].settingsConflict;
const exactEntry: typeof entry = proof.claims[0].entry;
// @ts-expect-error a Promise cannot authorize ownership
root.readLiveIdentityCoverage([entry], {owns:async()=>true});
// @ts-expect-error ownership must return a known boolean
root.readLiveIdentityCoverage([entry], {owns:()=>undefined});
// @ts-expect-error a proof must be awaited before use
root.readLiveIdentityCoverage([entry]).claims;
// @ts-expect-error a proof Promise is not a boolean result
const ready: boolean = root.readLiveIdentityCoverage([entry]);
// @ts-expect-error exact result evidence is readonly
proof.claims[0].coveredIdentity = false;
// @ts-expect-error the current batch result is readonly
proof.claims.push(proof.claims[0]);
declare const currentOwner: HistoryPrimaryLiveCoverageOwner<typeof entry>;
const awaitedUnmatched: boolean|null = await currentOwner.readUnmatched('owner');
// @ts-expect-error async coverage is not an immediate predicate
const unawaitedUnmatched: boolean|null = currentOwner.readUnmatched('owner');
// @ts-expect-error UNKNOWN must remain visible to callers
const assumedKnown: boolean = currentOwner.peekUnmatched('owner');
// @ts-expect-error readCurrent ownership cannot arrive after an await
createHistoryPrimaryLiveCoverageOwner({readCurrent:async()=>null, fingerprint:()=>'', publish:()=>null});
// @ts-expect-error publication is an owned synchronous boundary
createHistoryPrimaryLiveCoverageOwner({readCurrent:()=>null, fingerprint:()=>'', publish:async()=>null});
`;

assert.deepEqual(diagnostics(declaration), []);
const negative = diagnostics(declaration.replace(/\/\/ @ts-expect-error[^\n]*\n/g, ''));
assert.equal(negative.length, 10, 'all ten actual declaration negatives must reject');
assert(negative.some(d => d.code === 2339));
assert(negative.some(d => d.code === 2540));

const panel = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
function cut(first, last) {
  const start = panel.indexOf(first), end = panel.indexOf(last, start + first.length);
  assert(start >= 0 && end > start, first);
  assert.equal(panel.indexOf(first, start + first.length), -1, 'caller start must be unique');
  const result = panel.slice(start, end);
  assert(Buffer.byteLength(result) < 16 * 1024);
  return result;
}
const fragments = {
  owner: cut('  const primaryLiveCoverageEnabledRef =', '\n  const historyPresentationApplyGuardRef ='),
  unmatched: cut('  const hasUnmatchedLiveForOwner =', '\n  const historyPayloadContextValue ='),
  flush: cut('  const flushLiveHistoryToDurable =', '\n  // Suppression is a temporary presentation overlay'),
  commit: cut('  const primaryReceiptRootAtRender =', '\n  // Bind coverage to THIS render'),
  settled: cut('  useEffect(() => {\n    if (isTurnBusy) return;\n    // Claude may publish', '\n  // Listen for scroll-to-bottom from Timeline arrow button'),
};
// This is a typed React/ref frame around verbatim CURRENT candidate callbacks.
// It deliberately does not claim to validate the enormous surrounding Panel,
// its full application types, React scheduling, DOM, or installed runtime.
const frame = `import {HistoryPrimaryRootReadModel, historyPrimaryLiveClaimFingerprint, type HistoryPrimaryReadHeader} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import {createHistoryPrimaryLiveCoverageOwner, type HistoryPrimaryLiveDataCommit, type HistoryPrimaryLiveFoldCommit} from '../src/renderer/utils/historyPrimaryLiveCoverageOwner.mjs';
import {flushHistoryDurableWithRetry} from '../src/renderer/utils/historyDurableFlush.mjs';
interface FullHistoryEntry {uuid:string;role:string;liveProjection?:boolean;[key:string]:unknown}
type Ref<T> = {current:T};
declare function useRef<T>(value:T): Ref<T>;
declare function useMemo<T>(factory:()=>T, dependencies:readonly unknown[]):T;
declare function useCallback<T extends (...args:any[])=>any>(callback:T, dependencies:readonly unknown[]):T;
declare function useEffect(effect:()=>void|(()=>void), dependencies:readonly unknown[]):void;
declare function useLayoutEffect(effect:()=>void|(()=>void), dependencies:readonly unknown[]):void;
declare const primaryPhysicalCandidate:boolean, isTurnBusy:boolean, fileRewriteEpoch:number;
declare const primaryRoot:HistoryPrimaryRootReadModel|null;
declare const primaryRootRef:Ref<HistoryPrimaryRootReadModel|null>, primaryCompositeOwnerRef:Ref<string>;
declare const historyOwnerKey:string, tabId:string, sessionId:string|null, toolType:string, presentedOwnerKey:string;
declare const historyOwnerKeyRef:Ref<string>, historyOwnerGenerationRef:Ref<number>;
declare const liveProjectionRef:Ref<{ownerKey:string;entries:FullHistoryEntry[]}>;
declare const liveToolResultsRef:Ref<{ownerKey:string;results:Map<string,unknown>}>;
declare const primaryReceiptCommitRef:Ref<HistoryPrimaryLiveDataCommit|null>;
declare const primaryLiveCommitRef:Ref<HistoryPrimaryLiveFoldCommit<FullHistoryEntry>|null>;
declare const liveOrphanDigestRef:Ref<string>, isTurnBusyRef:Ref<boolean>;
declare const deferredTranscriptRefreshRef:Ref<boolean>;
declare const rawServerEntriesRef:Ref<FullHistoryEntry[]>, presentationEntriesRef:Ref<FullHistoryEntry[]>;
declare const entries:FullHistoryEntry[];
declare const committedHistoryEntriesRef:Ref<{ownerKey:string;entries:FullHistoryEntry[]}>;
declare const primarySurfaceWitnessRef:Ref<{root:HistoryPrimaryRootReadModel;header:HistoryPrimaryReadHeader;entries:WeakRef<FullHistoryEntry[]>}|null>;
declare function historyLivePresentationIdentities(entry:FullHistoryEntry):string[];
declare function historyDiag(message:string):void;
declare function setLiveEntries(entries:FullHistoryEntry[]):void;
declare function loadHistory(refresh:boolean):Promise<boolean>;
declare function reconcileLiveProjectionAgainstDurable(entries:FullHistoryEntry[], ownerKey:string):void;
declare function isLocalPromptEntry(entry:FullHistoryEntry):boolean;
declare function consumeMaterializedPromptHandoffs(entries:FullHistoryEntry[]):void;
declare function consumePrimaryMaterializedPromptHandoffs():void;
declare function reduceHistoryLiveProjection(entries:FullHistoryEntry[], event:{type:string;boundary:string;sessionId:string|null}):FullHistoryEntry[];
`;
const callers = frame + Object.values(fragments).join('\n');
assert.deepEqual(diagnostics(callers), [], 'actual narrow owner/unmatched/flush/data-commit/settled callbacks typecheck');
const awaited = 'observedUnmatched = await hasUnmatchedLiveForOwner(ownerKey);';
assert.equal(callers.split(awaited).length, 2);
const callerNegative = diagnostics(callers.replace(awaited, 'observedUnmatched = hasUnmatchedLiveForOwner(ownerKey);'));
assert.equal(callerNegative.length, 1, 'removing await in the actual flush caller must fail');
assert.equal(callerNegative[0].code, 2322);
assert(fragments.settled.includes('const hasLiveProjection = await hasUnmatchedLiveForOwner(ownerKey);'));
assert(fragments.unmatched.includes('const result = await primaryLiveCoverageOwner.readUnmatched(ownerKey);'));
console.log(JSON.stringify({ scope: 'actual declarations and five bounded verbatim Panel callbacks; typed React/ref frame only',
  positive: 'PASS', negativeDiagnostics: negative, callerNegative,
  callbackBytes: Object.fromEntries(Object.entries(fragments).map(([name, value]) => [name, Buffer.byteLength(value)])),
  heapLimit: v8.getHeapStatistics().heap_size_limit }));
