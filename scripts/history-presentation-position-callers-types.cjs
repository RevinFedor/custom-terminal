'use strict';

// Strict, finite ACTUAL Panel excerpts. React scheduling, the search flag
// client and Virtuoso are concrete ambient boundaries; the position owner,
// Root address model/bindings, sparse publication, prepared position adapter
// and reading-anchor contracts are real imports.
// This deliberately does not compile the whole Panel/dependency world.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const ts = process.env.V51_TYPESCRIPT_PATH ? require(process.env.V51_TYPESCRIPT_PATH) : require('typescript');
const root = path.resolve(__dirname, '..');
const panelPath = path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx');
const panel = fs.readFileSync(panelPath, 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const controls = [];
function excerpt(name, start, end, after = 0) {
  const a = panel.indexOf(start, after), b = a < 0 ? -1 : panel.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('Actual Panel excerpt missing: ' + name);
  const text = panel.slice(a, b);
  controls.push({ name, startLine: panel.slice(0, a).split('\n').length,
    endLine: panel.slice(0, b).split('\n').length, utf16: text.length, sha256: hash(text) });
  return { text, a, b };
}
const registration = excerpt('actual publication and four lane registration',
  '  // Coordinates describe THIS native current projection', '  // Expand the group containing');
const mounted = excerpt('actual mounted-search capture and async settle caller',
  '  // Root membership is queried for actual mounted subjects only.', '  // A new metadata alias');
const anchor = excerpt('actual saved-anchor convergence and jump',
  '    const anchor = getHistoryReadingAnchor(scrollPositionKeyRef.current);', '    if (anchor?.followBottom');
const resizeStart = panel.indexOf('  // Resize is a temporary position owner, independent of workflow visibility.');
if (resizeStart < 0) throw new Error('Actual resize effect missing');
const resizeOwner = excerpt('actual resize owner witness', '    const owner = () =>', '    const controller =', resizeStart);
const resizeReady = excerpt('actual resize pending/readiness callbacks', '      canWritePosition:', '      converge:', resizeStart);
const resizeJump = excerpt('actual resize key/UUID/tail jump', '      jumpToKey:', '      onPrepare:', resizeStart);
const timeline = excerpt('actual legacy-started Timeline current-primary point branch',
  '      let currentIdx: number;', '      const now = performance.now();');
const convergence = excerpt('actual existing convergence await and cancellation contract',
  'interface HistoryConvergenceOutcome {', 'function useHistoryRevealToggle(');
const anchorModulePath = path.join(root, 'src/renderer/utils/historyReadingAnchor.ts');
const anchorModule = fs.readFileSync(anchorModulePath, 'utf8');
const anchorInterfaceStart = anchorModule.indexOf('export interface HistoryReadingAnchor {');
const anchorInterfaceEnd = anchorModule.indexOf('\nconst STORAGE_KEY', anchorInterfaceStart);
const anchorGetter = anchorModule.match(/export const getHistoryReadingAnchor = \(([^\n]+)\): ([^\n]+) =>\n\s*loadAnchors\(\)\.get\(key\);/);
if (anchorInterfaceStart < 0 || anchorInterfaceEnd < 0 || !anchorGetter) throw new Error('Actual reading-anchor contract changed');
const anchorContract = anchorModule.slice(anchorInterfaceStart, anchorInterfaceEnd)
  + '\ndeclare const getHistoryReadingAnchor: (' + anchorGetter[1] + ') => ' + anchorGetter[2] + ';\n';
controls.push({ name: 'actual reading-anchor interface and getter declaration',
  source: 'src/renderer/utils/historyReadingAnchor.ts', sourceSha256: hash(anchorModule),
  interfaceSha256: hash(anchorModule.slice(anchorInterfaceStart, anchorInterfaceEnd)),
  getterSha256: hash(anchorGetter[0]),
  boundary: 'Storage body excluded; exact original interface/parameter/return types, declaration syntax only' });
const modulePath = relative => JSON.stringify(path.join(root, relative));

const prelude = `
import { createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery }
  from ${modulePath('src/renderer/utils/historyPresentationPosition.mjs')};
import { createHistoryPrimarySparsePublicationOwner }
  from ${modulePath('src/renderer/utils/historyPrimarySparsePublication.mjs')};
import { canBindHistoryPreparedPositionFrame, createHistoryPreparedPositionSource }
  from ${modulePath('src/renderer/utils/historyPreparedPosition.mjs')};
import { readHistoryPrimaryPanelAddress, collectHistoryPrimaryMountedSearchSubjects }
  from ${modulePath('src/renderer/utils/historyPrimaryPanelBindings.mjs')};
import type { HistoryPrimaryRootReadModel, HistoryPrimaryPresentationAddress }
  from ${modulePath('src/renderer/utils/historyPrimaryRootReadModel.mjs')};
import type { HistoryPrimarySelectedAddress }
  from ${modulePath('src/renderer/utils/historyPrimarySelectedAddress.mjs')};
${anchorContract}

// Finite ambient boundaries, never an untyped Panel context object.
type Ref<T> = { current: T };
type FullHistoryEntry = { uuid: string; sourceIdentityAliases?: string[] };
type DisplayUnit = { kind: 'entry'; entry: FullHistoryEntry }
  | { kind: 'group'; entries: FullHistoryEntry[] };
type PositionInput = Readonly<{ revision: number }>;
declare function useMemo<T>(make: () => T, dependencies: readonly unknown[]): T;
declare function useRef<T>(value: T): Ref<T>;
declare function useEffect(callback: () => void | (() => void), dependencies: readonly unknown[]): void;
declare function useLayoutEffect(callback: () => void | (() => void), dependencies: readonly unknown[]): void;
declare const ipcRenderer: { invoke(channel: string, payload: unknown): Promise<unknown> };
declare const primaryPhysicalCandidate: boolean;
declare const historyOwnerKey: string, tabId: string, historyOwnerDomId: string;
declare const fileRewriteEpoch: number, historyOwnerVisitState: number;
declare const displayEntries: FullHistoryEntry[], displayUnits: DisplayUnit[], displayUnitItemKeys: string[];
declare const entries: FullHistoryEntry[], visibleLiveEntries: FullHistoryEntry[];
declare const primarySparsePublicationOwner: ReturnType<typeof createHistoryPrimarySparsePublicationOwner<FullHistoryEntry>>;
declare const primaryLocalPublicationAtRender: NonNullable<ReturnType<typeof primarySparsePublicationOwner.current>>;
declare const primaryPreparedCompatibilityRef: Ref<{
  origin: ReturnType<HistoryPrimaryRootReadModel['retainPreparedPresentation']>['capability'];
  entries: NonNullable<HistoryPrimaryRootReadModel['metadata']>['entries'];
} | null>;
declare const primaryPresentation: PositionInput;
declare const displayEntriesRef: Ref<FullHistoryEntry[]>;
declare const displayUnitsRef: Ref<DisplayUnit[]>;
declare const displayUnitItemKeysRef: Ref<string[]>;
declare const primaryPresentationRef: Ref<PositionInput>;
declare const historyOwnerKeyRef: Ref<string>;
declare const historyOwnerGenerationRef: Ref<number>;
declare const mountedSearchDemandRef: Ref<(() => void) | null>;
declare const historyPresentationProofRef: Ref<{ visit: number; presented: boolean }>;
declare const historyUserGestureGenerationRef: Ref<number>;
declare const primaryRootRef: Ref<HistoryPrimaryRootReadModel | null>;
declare const virtuosoScrollerRef: Ref<HTMLElement | null>;
declare const panelRef: Ref<HTMLElement | null>;
declare const displayEntryIndexByUuidRef: Ref<Map<string, number> | null>;
declare const displayEntryIndexByUuid: Map<string, number> | null;
declare const virtuosoRef: Ref<{ scrollToIndex(input: {
  index: number; align: 'start' | 'center' | 'end'; behavior: 'auto'; offset?: number;
}): void } | null>;
declare const primaryResizeAddress: HistoryPrimarySelectedAddress;
declare const historyRestoreInFlightRef: Ref<number>;
declare const historyRestoreTokenRef: Ref<number>;
declare const scrollRestoreGenRef: Ref<number>;
declare const scrollPositionKeyRef: Ref<string>;
declare const mountWaveActiveRef: Ref<boolean>;
declare function primaryInputsCurrent(): boolean;
declare function historyDiag(message: string): void;
declare function setHistoryTailFollowIntent(value: boolean): void;
declare function findHistoryUnitIndexByKey(keys: readonly string[], key: string): number;
declare function cancelReasonForRestore(owner: string, generation: number, restore: number): string | null;
declare function settleRestoreAndBankGeometry(owner: string, token: number): void;
declare const primaryAnchorReady: boolean;
declare const primaryAnchorResolution: { address: HistoryPrimaryPresentationAddress | null };

// The unchanged search matcher is outside this coordinate prerequisite. Only
// its actual two used methods are a finite declared boundary here.
interface HistoryPagedSearchClient {
  retain(): () => Promise<void>;
  entryFlags(identities: string[]): Promise<{ entryUuid: string; match: boolean }[]>;
}
interface MountedSearchRows { request: object; client: HistoryPagedSearchClient; matches: Set<string>; }
declare const searchResult: { searchClient?: HistoryPagedSearchClient } | null;
declare const searchRequest: object;
declare const searchActive: boolean;
declare const searchHighlightDemandRef: Ref<(() => void) | null>;
declare function historySearchEntryKeys(entry: FullHistoryEntry): string[];
declare function setMountedSearchRows(value: MountedSearchRows | null
  | ((previous: MountedSearchRows | null) => MountedSearchRows | null)): void;
declare function setSearchError(value: string): void;
declare const primaryRootRevision: number, mountWaveRenderState: number, historySeekPresentationEpoch: number;

// Timeline state captured by its existing owning effect; concrete selected
// fragment below retains its actual request/owner/cut/visit/scroller guard.
declare const navigationRoot: HistoryPrimaryRootReadModel | null;
declare const navigationAddress: HistoryPrimaryPresentationAddress | null;
declare function ownsNavigation(): boolean;
declare const targetUuid: string, startedAt: number, JUMP_STUB_HYDRATION_WAIT_MS: number;
declare function finish(found: boolean, reason: string): void;
declare function step(): Promise<void>;
declare const requestGeneration: number;
declare const useUIStore: { getState(): { historyScrollRequestGeneration: number } };
declare function setHistoryLoadError(message: string): void;
`;
// Adapt only enclosing syntax, never callback bodies or type assertions.
const source = prelude + '\n' + convergence.text + '\n' + registration.text
  + '\n' + mounted.text + '\nfunction checkActualSavedAnchor() {\n' + anchor.text + '\n}\n'
  + '\nfunction checkActualResize() {\n let resizeToken = 0;\n' + resizeOwner.text
  + '\n const readiness = {\n' + resizeReady.text + '\n };\n'
  + '\n const jumps = {\n' + resizeJump.text + '\n };\n void readiness; void jumps;\n}\n'
  + '\nasync function checkActualTimeline() {\n' + timeline.text + '\n return currentIdx;\n}\n';

const mutants = [
  ['registration requires original witness',
    'frame, witness, owns });', 'frame, owns });'],
  ['resize rejects canonical Root as position publication',
    'primaryResizePosition.resolve(publication, uuid, { owns })',
    'primaryResizePosition.resolve(root, uuid, { owns })'],
  ['saved anchor requires scalar UUID, not anchor object',
    'primaryAnchorPosition.resolve(publication, anchor.uuid, { owns })',
    'primaryAnchorPosition.resolve(publication, anchor, { owns })'],
  ['mounted entry access requires branded selected coordinate',
    'primaryPositionOwner.entryAt(selected.address)', 'primaryPositionOwner.entryAt(selected)'],
  ['Timeline exact UUID cannot be a target wrapper',
    'primaryTimelinePosition.resolve(publication, targetUuid,',
    'primaryTimelinePosition.resolve(publication, { targetUuid },'],
  ['registration units cannot be physical-key strings',
    'primaryPositionOwner.publish({ units, itemKeys, frame, witness, owns });',
    'primaryPositionOwner.publish({ units: itemKeys, itemKeys, frame, witness, owns });'],
  ['resize synchronous ownership cannot become async',
    'primaryResizePosition.resolve(publication, uuid, { owns })',
    'primaryResizePosition.resolve(publication, uuid, { owns: async () => true })'],
  ['resize physical key cannot substitute for index',
    'resolved = selected.address.index;', 'resolved = selected.address.physicalKey;'],
];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-position-caller-types-'));
const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true,
  noUncheckedIndexedAccess: true, skipLibCheck: false, types: [], allowImportingTsExtensions: true,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] };
function diagnostics(name, text) {
  const filename = path.join(temp, name + '.mts'); fs.writeFileSync(filename, text);
  return ts.getPreEmitDiagnostics(ts.createProgram([filename], options));
}
try {
  const baseline = diagnostics('actual-callers', source);
  if (baseline.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(baseline, {
      getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    })); process.exitCode = 1;
  } else {
    const negativeControls = [];
    for (const [name, before, after] of mutants) {
      if (!source.includes(before)) throw new Error('Negative caller control no longer matches actual source: ' + name);
      const errors = diagnostics('negative-' + negativeControls.length, source.replace(before, after));
      if (!errors.length) throw new Error('Negative caller control unexpectedly compiled: ' + name);
      negativeControls.push({ name, rejected: true, diagnosticCodes: [...new Set(errors.map(error => error.code))] });
    }
    console.log(JSON.stringify({ status: 'PASS', compiler: ts.version, strict: true, noUncheckedIndexedAccess: true,
      panel: 'src/renderer/components/Workspace/HistoryPanel.tsx', panelSha256: hash(panel), excerpts: controls,
      negativeControls, scope: 'ACTUAL registration and four selected caller excerpts; actual existing convergence; real position/prepared-source/sparse-publication/Root/bindings/anchor contracts; exact prepared capability origin and metadata types; finite React/search/Virtuoso/ambient refs; no whole Panel typecheck' }));
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
