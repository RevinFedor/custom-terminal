'use strict';
// V49 finite declaration negative controls; no megabyte Panel AST, no build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const ts = require('typescript');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite declaration heap');
const ROOT = path.resolve(__dirname, '..');
const filename = path.join(__dirname, '.history-primary-adoption-probe.mts');
const options = { strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: false,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [], allowJs: true, checkJs: false };

function diagnostics(source) {
  assert(Buffer.byteLength(source) < 20 * 1024);
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === filename ? source : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  for (const file of program.getSourceFiles()) assert(!file.fileName.endsWith('HistoryPanel.tsx'), 'full Panel AST forbidden');
  return ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
}

const declaration = `import {HistoryPrimaryRootReadModel} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
declare const root: HistoryPrimaryRootReadModel;
const local = {uuid:'local-prompt-t-h',role:'queued',content:'body',timestamp:'2026-10-27',handoffId:'h'};
let currentProof:(()=>boolean)|undefined;
const proof = await root.readPromptAdoption(local, {scope:'canonical',excludedUuids:new Set<string>(),owns:()=>true,committed:true,onProof:check=>{currentProof=check;}});
if (proof) {
  const ordinal:number = proof.ordinal;
  const legacy:boolean = proof.legacy;
  const chips:boolean = proof.hasPromptChips;
  const images:boolean = proof.hasImagePaths;
}
const prepared = await root.readPromptAdoption(local, {scope:'prepared'});
// @ts-expect-error only canonical/prepared read domains exist
root.readPromptAdoption(local, {scope:'committed'});
// @ts-expect-error asynchronous ownership cannot guard dispatch
root.readPromptAdoption(local, {owns:async()=>true});
// @ts-expect-error uncertain ownership is not authority
root.readPromptAdoption(local, {owns:()=>undefined});
// @ts-expect-error array exclusions must not reset per-pass Set semantics
root.readPromptAdoption(local, {excludedUuids:['x']});
// @ts-expect-error private prepared substitution cannot be caller-supplied proof
root.readPromptAdoption(local, {preparedRow:()=>local});
// @ts-expect-error publication receives a synchronous proof-current checker
root.readPromptAdoption(local, {onProof:(check:number)=>{}});
// @ts-expect-error asynchronous read result requires await
root.readPromptAdoption(local).entry;
// @ts-expect-error read result Promise is not a boolean absence proof
const ready:boolean = root.readPromptAdoption(local);
if (proof) {
  // @ts-expect-error selected proof cannot be reassigned by a consumer
  proof.ordinal = 7;
  // @ts-expect-error selected legacy evidence cannot be upgraded in place
  proof.legacy = true;
}
`;
const positive = diagnostics(declaration);
assert.deepEqual(positive, [], 'actual adoption declarations accept the narrow caller');
const negatives = diagnostics(declaration.replace(/\/\/ @ts-expect-error[^\n]*\n/g, ''));
assert.equal(negatives.length, 10, 'all ten exact typed negative probes must reject');
assert(negatives.some(d => d.code === 2339));
assert(negatives.some(d => d.code === 2540));
const dts = fs.readFileSync(path.join(ROOT, 'src/renderer/utils/historyPrimaryRootReadModel.d.mts'), 'utf8');
assert(dts.includes('readPromptAdoption('));
assert(dts.includes('prepareAdopt'), 'actual provisional adoption callback is declared');
console.log(JSON.stringify({scope:'actual V49 model declarations; strict finite typed probes',
  typescript:ts.version,positive:'PASS',negativeCount:negatives.length,negativeDiagnostics:negatives,
  sourceBytes:Buffer.byteLength(declaration),heapLimit:v8.getHeapStatistics().heap_size_limit}));
