'use strict';
// Finite real declaration probe. Full checked standard libraries; no Panel AST.
const assert = require('node:assert/strict'), path = require('node:path'), v8 = require('node:v8');
const ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
assert(v8.getHeapStatistics().heap_size_limit <= 140 * 1024 ** 2, 'compiler 128MiB cap');
const filename = path.join(__dirname, '.history-primary-sparse-adoption-probe.mts');
const options = { strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: false,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [], allowJs: true, checkJs: false };
function diagnostics(source) {
  assert(Buffer.byteLength(source) < 10 * 1024);
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === filename ? source : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  for (const file of program.getSourceFiles()) assert(!file.fileName.endsWith('HistoryPanel.tsx'));
  return ts.getPreEmitDiagnostics(program).map(value => ({ code: value.code,
    message: ts.flattenDiagnosticMessageText(value.messageText, ' ') }));
}
const source = `import {prepareHistoryPrimarySparsePromptAdoption, historyPrimarySparsePreparedOverride,
  historyPrimarySparseCompatibilityOrdinal, materializeHistoryPrimarySparseCompatibility,
  type HistoryPrimarySparsePublication} from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
import type {HistoryPrimaryRootReadModel} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
declare const model: HistoryPrimaryRootReadModel;
declare const view: unknown;
const rows = [{uuid:'local-prompt-one',role:'queued',content:'full',timestamp:'2026-10-28'}];
const proof = await prepareHistoryPrimarySparsePromptAdoption(model, view, rows, [],
  {isLocal: row => row.role === 'queued', owns: () => true,
    suppressions: [{text:'full',since:0,until:1} ]});
const same:boolean = proof.isCurrent();
const publication:HistoryPrimarySparsePublication<(typeof rows)[number]> = proof.publication;
const entries:typeof rows = proof.materializeCompatibility(rows);
const override = historyPrimarySparsePreparedOverride(publication, 0);
const ordinal:number|null = historyPrimarySparseCompatibilityOrdinal(publication, rows[0]);
materializeHistoryPrimarySparseCompatibility(publication, rows);
// @ts-expect-error sparse publication contains no historical entries
proof.entries;
// @ts-expect-error original-order replacement coordinates are immutable
publication.replacements[0]!.ordinal = 2;
// @ts-expect-error current local membership array is immutable
publication.currentLocals.push(rows[0]!);
// @ts-expect-error asynchronous owner cannot authorize selected work
prepareHistoryPrimarySparsePromptAdoption(model, view, rows, [], {isLocal:()=>true, owns:async()=>true});
// @ts-expect-error thin selected proof is not a synchronous result
prepareHistoryPrimarySparsePromptAdoption(model, view, rows, [], {isLocal:()=>true}).publication;
// @ts-expect-error strings are not source ordinals
historyPrimarySparsePreparedOverride(publication, '0');
// @ts-expect-error text field is required on CURRENT suppression
prepareHistoryPrimarySparsePromptAdoption(model, view, rows, [], {isLocal:()=>true, suppressions:[{since:0}]});
// @ts-expect-error bare count/header is not an authenticated sparse publication
const forged:HistoryPrimarySparsePublication<unknown> = {kind:'history-primary-sparse-presentation-v1',sourceEntryCount:0};
`;
const positive = diagnostics(source);
assert.deepEqual(positive, [], 'strict actual declarations and full standard libraries');
const negative = diagnostics(source.replace(/\/\/ @ts-expect-error[^\n]*\n/g, ''));
assert.equal(negative.length, 8, 'all meaningful negatives rejected');
console.log(JSON.stringify({scope:'V52 sparse actual declarations',typescript:ts.version,node:process.version,
  skipLibCheck:options.skipLibCheck,noUncheckedIndexedAccess:options.noUncheckedIndexedAccess,
  heapLimit:v8.getHeapStatistics().heap_size_limit,positive:'PASS',negativeCount:negative.length,negative}));
