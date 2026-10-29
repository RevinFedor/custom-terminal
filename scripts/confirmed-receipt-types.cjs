'use strict';
// Focused declarations only. No full Panel/program/build or emitted output.
const ts = require('typescript'), path = require('node:path'), assert = require('node:assert/strict');
assert(require('node:v8').getHeapStatistics().heap_size_limit <= 256 * 1024 ** 2);
const filename = path.resolve(__dirname, '.confirmed-receipt-probe.mts');
const source = `import {HistoryPrimaryRootReadModel, type HistoryPrimaryConfirmedReceiptProof} from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
declare const root: HistoryPrimaryRootReadModel;
const proof: HistoryPrimaryConfirmedReceiptProof = await root.readConfirmedCanonicalReceipt({}, {owns:()=>true});
const present: boolean = proof.found;
// @ts-expect-error ownership cannot be asynchronous
root.readConfirmedCanonicalReceipt({}, {owns:async()=>true});
// @ts-expect-error proof cannot be consumed before await
root.readConfirmedCanonicalReceipt({}).found;
// @ts-expect-error readonly selected evidence
proof.found = false;
// @ts-expect-error method is a Promise, not a boolean
const ready: boolean = root.readConfirmedCanonicalReceipt({});
root.onReceiptReadWake(event => {
  const kind: 'adopted'|'settled' = event.kind;
  // @ts-expect-error settlement evidence is readonly
  event.sequence = 0;
});
// @ts-expect-error the event is not a generic string or body packet
root.onReceiptReadWake((event: string) => {});
`;
const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [] };
function diagnostics(text) {
  const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists;
  host.readFile = name => name === filename ? text : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  return ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
}
assert.deepEqual(diagnostics(source), []);
const negative = diagnostics(source.replace(/\/\/ @ts-expect-error[^\n]*\n/g, ''));
assert.equal(negative.length, 6, 'all six actual declaration negative controls are consumed');
console.log(JSON.stringify({ scope: 'actual model declaration only', positive: 'PASS', negativeDiagnostics: negative,
  heapLimit: require('node:v8').getHeapStatistics().heap_size_limit }));
