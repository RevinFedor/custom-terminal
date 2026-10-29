'use strict';

// SOURCE-only TypeScript noEmit qualification. No renderer build/install and
// no claim of the whole repository type gate. External React/store context in
// the extracted Panel slice is explicitly declared; the edited callback text,
// public model declarations and ownership exports are actual current files.
// NOTED_TYPESCRIPT=/absolute/typescript/lib/typescript.js node --expose-gc --max-old-space-size=96 --max-semi-space-size=4 scripts/history-canonical-consumers-types.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const ts = require(process.env.NOTED_TYPESCRIPT || 'typescript');
const heapLimit = require('node:v8').getHeapStatistics().heap_size_limit;
assert(heapLimit <= 128 * 1024 ** 2, 'finite V8 TOTAL <=128MiB; use documented command');
const ROOT = path.resolve(__dirname, '..');
const MODEL = 'src/renderer/utils/historyPrimaryRootReadModel.d.mts';
const PANEL = 'src/renderer/components/Workspace/HistoryPanel.tsx';
const HANDOFFS = 'src/renderer/utils/historyPromptHandoffs.ts';
const DRAFT = 'src/renderer/utils/historyComposerDraftOwner.mjs';
const STORE = 'src/renderer/store/useUIStore.ts';
const absolute = file => path.join(ROOT, file);
const read = file => fs.readFileSync(absolute(file), 'utf8');
const parse = file => ts.createSourceFile(absolute(file), read(file), ts.ScriptTarget.Latest, true,
  file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const find = (source, predicate) => {
  let found;
  const visit = node => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(source); assert(found, 'actual source node missing'); return found;
};
const texts = (() => {
  let panel = parse(PANEL);
  const variable = name => find(panel, node => ts.isVariableDeclaration(node) && node.name.getText(panel) === name).getText(panel);
  const alias = find(panel, node => ts.isTypeAliasDeclaration(node) && node.name.text === 'PrimaryTerminalPreviewMembership').getText(panel);
  const effect = find(panel, node => ts.isCallExpression(node) && node.expression.getText(panel) === 'useEffect'
    && node.getText(panel).includes('void root.readTerminalPreviewMembership(')).getText(panel);
  const receipt = find(panel, node => ts.isExpressionStatement(node) && node.getText(panel)
    .startsWith('laterCanonicalMatch = await root!.hasLaterCanonicalReceipt(')).getText(panel);
  const variables = ['publishPrimaryTerminalPreviewMembership', 'readCurrentPrimaryTerminalPreviewMembership',
    'readTerminalPreviewCanonicalNode'].map(variable);
  panel = null; global.gc?.();
  let handoffs = parse(HANDOFFS);
  let owner = find(handoffs, node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'captureHistoryReceiptRecoveryOwner');
  let point = find(handoffs, node => ts.isMethodDeclaration(node) && node.name.getText(handoffs) === 'readReceiptRecoveryOwner');
  const ownershipSpans = [[owner.getStart(handoffs), owner.end], [point.getStart(handoffs), point.end]];
  owner = null; point = null; handoffs = null; global.gc?.();
  const store = parse(STORE);
  const writes = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(store) === 'noteHistoryComposerDraftWrite') writes.push(node.getText(store));
    ts.forEachChild(node, visit);
  }; visit(store); assert.equal(writes.length, 6, 'all six actual draft writer callsites');
  return { alias, effect, receipt, writes, variables, ownershipSpans };
})();

const syntaxFiles = [MODEL, PANEL, HANDOFFS, STORE, DRAFT,
  'src/renderer/components/Workspace/HistoryPrimaryRootSurface.tsx',
  'src/renderer/utils/historyPrimaryPanelBindings.mjs'];
const syntax = syntaxFiles.map(file => {
  const source = parse(file), diagnostics = source.parseDiagnostics || [];
  assert.equal(diagnostics.length, 0, 'full-file parse: ' + file);
  return { file, bytes: Buffer.byteLength(source.text), syntacticDiagnostics: diagnostics.length };
});
global.gc?.();

const virtual = absolute('scripts/.history-canonical-consumers-type-probe.mts');
const imports = `import { HistoryPrimaryRootReadModel, type HistoryPrimaryReadOptions,
  type HistoryPrimaryTerminalPreviewMembership, type HistoryPrimaryTerminalPreviewTarget } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { captureHistoryReceiptRecoveryOwner, type DurableHistorySendReceiptRecord } from '../src/renderer/utils/historyPromptHandoffs';
import { captureHistoryComposerDraftOwner, noteHistoryComposerDraftWrite } from '../src/renderer/utils/historyComposerDraftOwner.mjs';
`;
const context = `
// Explicit adapters for external React and current refs, not a React typegate.
declare function useCallback<T extends (...args: any[]) => any>(callback: T, dependencies: readonly unknown[]): T;
declare function useEffect(callback: () => void | (() => void), dependencies: readonly unknown[]): void;
declare const primaryPhysicalCandidate: boolean, historyOwnerKey: string, historyOwnerDomId: string, tabId: string;
declare const primaryRoot: HistoryPrimaryRootReadModel | null;
declare const primaryHeader: HistoryPrimaryRootReadModel['header'];
declare const primaryPresentation: unknown;
declare const primaryInputsCurrent: () => boolean;
declare const primaryRootRef: { current: HistoryPrimaryRootReadModel | null };
declare const historyOwnerKeyRef: { current: string }, historyOwnerGenerationRef: { current: number };
declare const historyPresentationProofRef: { current: { visit: number; presented: boolean } };
type Handoff = { previewId: string; canonicalIdentity: string; canonicalTextHash?: string | null };
declare const terminalPreviewClearHandoffRef: { current: Handoff | null };
declare const terminalPreviewClearHandoff: Handoff | null, terminalPreviewCanonicalIdentity: string;
declare function historyDiag(message: string): void;
${texts.alias}
declare const primaryTerminalPreviewMembershipRef: { current: PrimaryTerminalPreviewMembership | null };
declare function setPrimaryTerminalPreviewMembership(value: PrimaryTerminalPreviewMembership | null): void;
${texts.variables.map(text => 'const ' + text + ';').join('\n')}
${texts.effect};
async function actualReceiptCall(root: HistoryPrimaryRootReadModel | null, record: unknown,
  controller: AbortController, ownsRecord: () => boolean) {
  let laterCanonicalMatch = false;
  ${texts.receipt}
  const exact: boolean = laterCanonicalMatch;
  return exact;
}
declare const store: {getState(): unknown; subscribe(listener: (state: unknown) => void): () => void};
declare const useUIStore: typeof store, input: {tabId: string};
${texts.writes.map(text => text + ';').join('\n')}
declare const record: DurableHistorySendReceiptRecord;
const receiptOwner = captureHistoryReceiptRecoveryOwner(record, { onInvalidated: () => {} });
const draftOwner = captureHistoryComposerDraftOwner({ store, tabId });
const ownerCheck: () => boolean = receiptOwner.isCurrent, draftCheck: () => boolean = draftOwner.isCurrent;
const allowed: boolean = receiptOwner.recoveryAllowed, hidden: boolean = receiptOwner.presentationDismissed;
receiptOwner.dispose(); draftOwner.dispose();
type IsAny<T> = 0 extends (1 & T) ? true : false;
const ownedBooleanIsNotAny: IsAny<ReturnType<typeof receiptOwner.isCurrent>> = false;
const draftBooleanIsNotAny: IsAny<ReturnType<typeof draftOwner.isCurrent>> = false;
const allowedIsNotAny: IsAny<typeof receiptOwner.recoveryAllowed> = false;
const hiddenIsNotAny: IsAny<typeof receiptOwner.presentationDismissed> = false;
declare const root: HistoryPrimaryRootReadModel, identity: string, scroller: HTMLElement;
const options: HistoryPrimaryReadOptions = { owns: () => true, signal: new AbortController().signal };
async function boundary() {
  const hasLater: boolean = await root.hasLaterCanonicalReceipt(record, options);
  const membership: HistoryPrimaryTerminalPreviewMembership = await root.readTerminalPreviewMembership(identity, options);
  const canonical: boolean = membership.canonicalPresent, prepared: boolean = membership.preparedPresent;
  const hash: string | null = membership.preparedTextHash;
  const target: HistoryPrimaryTerminalPreviewTarget | null = membership.target;
  const node: HTMLElement | null = readTerminalPreviewCanonicalNode(scroller, target);
  return { hasLater, canonical, prepared, hash, node };
}
`;
const expectedErrors = `
// @ts-expect-error ownership is synchronous boolean authority, never a promise
root.hasLaterCanonicalReceipt(record, { owns: async () => true });
// @ts-expect-error ownership is synchronous for membership as well
root.readTerminalPreviewMembership(identity, { owns: async () => true });
// @ts-expect-error a promise is not an absence/presence proof
const unawaitedReceipt: boolean = root.hasLaterCanonicalReceipt(record);
// @ts-expect-error a promise cannot be used as a synchronous boolean condition
if (root.hasLaterCanonicalReceipt(record)) historyDiag('invalid promise proof');
// @ts-expect-error membership fields are available only after the awaited proof
const unawaitedMembership = root.readTerminalPreviewMembership(identity).canonicalPresent;
// @ts-expect-error physical identity is an exact string
const badPhysicalTarget: HistoryPrimaryTerminalPreviewTarget = { canonicalUuid: '', unitIndex: 0, domUuid: '', groupKey: null, presentationKind: 'entry', physicalKey: 1 };
`;
const options = { noEmit: true, strict: true, allowJs: true, checkJs: false, skipLibCheck: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [] };
const summarize = diagnostic => ({ file: diagnostic.file ? path.relative(ROOT, diagnostic.file.fileName) : null,
  line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
  code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') });
function check(probe, declaration = read(MODEL)) {
  const base = ts.createCompilerHost(options), overrides = new Map([[virtual, probe], [absolute(MODEL), declaration]]);
  const host = { ...base, fileExists: filename => overrides.has(filename) || base.fileExists(filename),
    readFile: filename => overrides.get(filename) ?? base.readFile(filename),
    writeFile() { throw new Error('noEmit SOURCE probe attempted to write output'); } };
  host.getSourceFile = (filename, languageVersion) => {
    const value = host.readFile(filename);
    return value === undefined ? undefined : ts.createSourceFile(filename, value, languageVersion, true);
  };
  const program = ts.createProgram([virtual], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const own = diagnostics.filter(item => !item.file || item.file.fileName === virtual || item.file.fileName === absolute(MODEL));
  const newOwnership = diagnostics.filter(item => item.file?.fileName === absolute(HANDOFFS)
    && texts.ownershipSpans.some(([start, end]) => item.start >= start && item.start < end));
  return { own: own.map(summarize), ownership: newOwnership.map(summarize),
    other: diagnostics.filter(item => !own.includes(item) && !newOwnership.includes(item)).map(summarize),
    files: program.getSourceFiles().length,
    applicationFiles: program.getSourceFiles().filter(file => file.fileName.startsWith(ROOT + path.sep)
      && file.fileName !== virtual).length };
}
const declarationWithout = name => {
  const source = parse(MODEL), method = find(source, node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  return source.text.slice(0, method.getStart(source)) + source.text.slice(method.end);
};
const probe = imports + context + expectedErrors;
const positive = check(probe);
assert.deepEqual(positive.own, [], 'actual model + extracted Panel/writer/ownership probe must typecheck');
assert.deepEqual(positive.ownership, [], 'new ownership bodies must typecheck');
global.gc?.();
const missing = {};
for (const name of ['hasLaterCanonicalReceipt', 'readTerminalPreviewMembership']) {
  const control = check(probe, declarationWithout(name));
  assert(control.own.some(item => item.code === 2339 && item.message.includes(name)), 'missing method control: ' + name);
  missing[name] = control.own.filter(item => item.code === 2339 && item.message.includes(name)).length;
  global.gc?.();
}
const withoutExpect = check(imports + context + expectedErrors.replace(/^\/\/ @ts-expect-error.*\n/gm, ''));
assert(withoutExpect.own.filter(item => item.code === 2322).length >= 4, 'async owns, promise boolean and wrong physical key are rejected');
assert(withoutExpect.own.some(item => item.code === 2801), 'Promise-as-condition negative control is exercised');
assert(withoutExpect.own.some(item => item.code === 2339 && item.message.includes('canonicalPresent')), 'unawaited membership is rejected');
global.gc?.();
let original = { status: 'not supplied; removed-method controls only' };
if (process.env.NOTED_TYPES_PREIMAGE_DTS) {
  const control = check(probe, fs.readFileSync(process.env.NOTED_TYPES_PREIMAGE_DTS, 'utf8'));
  for (const name of ['hasLaterCanonicalReceipt', 'readTerminalPreviewMembership']) assert(control.own.some(item => item.message.includes(name)),
    'original CURRENT declaration must fail new caller: ' + name);
  original = { status: 'exact supplied CURRENT preimage rejected', diagnostics: control.own.length };
}
console.log(JSON.stringify({ status: 'qualified-source-pass', typescript: ts.version, noEmit: true,
  strict: true, skipLibCheck: true, checkJs: false, v8HeapLimitBytes: heapLimit,
  syntax, compilerSourceFilesIncludingLibraries: positive.files, referencedApplicationFiles: positive.applicationFiles,
  actualProbeDiagnostics: positive.own.length,
  newOwnershipBodyDiagnostics: positive.ownership.length, expectErrorControls: 6,
  removedMethodNegativeControls: missing, noExpectErrorDiagnosticCodes: withoutExpect.own.map(item => item.code),
  originalDeclarations: original, unrelatedWholeModuleDiagnostics: positive.other,
  scope: 'actual d.mts + extracted actual Panel callback/effect/await/DOM calls + six actual writer calls + actual ownership exports; explicit external context adapters; no full React/Zustand/project gate' }, null, 2));
