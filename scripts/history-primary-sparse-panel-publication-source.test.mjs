// SOURCE controls execute the bounded verbatim Panel publication callback with
// the actual sparse owner. Synthetic refs replace React; there is no renderer,
// producer/IPC, native, layout, paint, Main ACK or Send/Input claim here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';

assert(getHeapStatistics().heap_size_limit <= 70 * 1024 ** 2, '64MiB old/2MiB semi runtime cap required');
const require = createRequire(import.meta.url), ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
assert.equal(ts.version, '5.9.3', 'exact supplied compiler');
const panel = fs.readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const first = '  const publishHistoryRows = useCallback(', last = '  const primaryLocalPublicationAtRender =';
const start = panel.indexOf(first), end = panel.indexOf(last, start + first.length);
assert(start >= 0 && end > start && panel.indexOf(first, start + first.length) === -1, 'exact actual callback boundary');
const fragment = panel.slice(start, end);
assert(Buffer.byteLength(fragment) <= 4096, 'bounded callback; never parse whole Panel AST');
const compiled = ts.transpileModule(fragment, { reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
assert.deepEqual(compiled.diagnostics, []);
const install = new Function('env', 'with(env){\n' + compiled.outputText + '\nreturn {publishHistoryRows};\n}');
const sha = value => createHash('sha256').update(value).digest('hex');
console.log('V52_PANEL_SPARSE_PUBLICATION_SOURCE ' + JSON.stringify({
  panelSHA256: sha(panel), panelBytes: Buffer.byteLength(panel),
  fragmentSHA256: sha(fragment), fragmentBytes: Buffer.byteLength(fragment),
  node: process.version, typescript: ts.version, heapLimit: getHeapStatistics().heap_size_limit,
  electron: process.versions.electron || null,
}));
const local = id => ({ uuid: 'local-prompt-' + id, role: 'queued', content: 'full ' + id });
const scope = Object.freeze({ ownerKey: 'A', generation: 1 });
function rig(classify = row => row.role === 'queued') {
  const original = [local('original')];
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal: classify });
  const before = owner.publishCompatibility(original, scope);
  const env = { presentationEntriesRef: { current: original }, primarySparsePublicationOwner: owner,
    historyOwnerKeyRef: { current: scope.ownerKey }, historyOwnerGenerationRef: { current: scope.generation },
    useCallback: value => value,
    get primaryRootRef() { throw Error('NO_PRIMARY_ROOT_NEEDED'); },
    get rawServerEntriesRef() { throw Error('NO_HISTORICAL_ARRAY_READ'); },
  };
  Object.assign(env, install(env));
  return { env, owner, before, original, publish: env.publishHistoryRows, close: () => owner.close() };
}

test('actual Panel helper synchronously stages current-only native locals then assigns the exact ref', () => {
  const h = rig();
  try {
    const one = local('one'), next = [one];
    assert.equal(h.publish(next), true);
    assert.equal(h.env.presentationEntriesRef.current, next);
    assert.equal(h.owner.current().entries.deref(), next);
    assert.equal(h.owner.current().rows[0], one);
    assert.equal(h.owner.current().kind, 'current-local-only');
    assert.equal(h.owner.current().prepared, null);
  } finally { h.close(); }
});

test('actual Panel helper checks the original full witness after classification and refuses atomically', () => {
  const handoff = { text: 'original' }, sequence = [];
  const h = rig(row => { sequence.push('classify:' + row.uuid); if (row.uuid.endsWith('next')) handoff.text = 'changed'; return row.role === 'queued'; });
  try {
    sequence.length = 0;
    assert.equal(h.publish([local('next')], () => { sequence.push('original-witness'); return handoff.text === 'original'; }), false);
    assert.deepEqual(sequence, ['classify:local-prompt-next', 'original-witness']);
    assert.equal(h.env.presentationEntriesRef.current, h.original);
    assert.equal(h.owner.current(), h.before);
  } finally { h.close(); }
});

test('actual helper final cheap owner fence follows a work-bearing original witness', () => {
  for (const dimension of ['ref', 'owner', 'generation']) {
    const h = rig(), foreign = [local('foreign')];
    try {
      assert.equal(h.publish([local('next')], () => {
        if (dimension === 'ref') h.env.presentationEntriesRef.current = foreign;
        if (dimension === 'owner') h.env.historyOwnerKeyRef.current = 'replacement';
        if (dimension === 'generation') h.env.historyOwnerGenerationRef.current++;
        return true;
      }), false);
      assert.equal(h.owner.current(), h.before);
      assert.equal(h.env.presentationEntriesRef.current, dimension === 'ref' ? foreign : h.original);
    } finally { h.close(); }
  }
});

test('actual helper preserves a nested newer publication when native classification reenters', () => {
  let h, entered = false;
  const winner = [local('winner')];
  h = rig(row => {
    if (row.uuid.endsWith('outer') && !entered) { entered = true; assert.equal(h.publish(winner), true); }
    return row.role === 'queued';
  });
  try {
    assert.equal(h.publish([local('outer')]), false);
    assert.equal(h.env.presentationEntriesRef.current, winner);
    assert.equal(h.owner.current().entries.deref(), winner);
    assert.equal(h.owner.current().rows[0], winner[0]);
  } finally { h.close(); }
});

test('actual helper leaves both publications unchanged when native classification throws', () => {
  const error = Error('ORIGINAL_NATIVE_CLASSIFIER_FAILURE');
  const h = rig(row => { if (row.uuid.endsWith('throw')) throw error; return row.role === 'queued'; });
  try {
    assert.throws(() => h.publish([local('throw')]), actual => actual === error);
    assert.equal(h.env.presentationEntriesRef.current, h.original);
    assert.equal(h.owner.current(), h.before);
  } finally { h.close(); }
});

test('actual same-array fast path still replays original witness and rejects disposal', () => {
  const h = rig(); let checks = 0;
  try {
    assert.equal(h.publish(h.original, () => { checks++; return false; }), false);
    assert.equal(checks, 1); assert.equal(h.owner.current(), h.before);
    assert.equal(h.publish(h.original, () => { h.owner.clear(); return true; }), false);
    assert.equal(h.env.presentationEntriesRef.current, h.original); assert.equal(h.owner.current(), null);
  } finally { h.close(); }
});

test('actual helper refuses close during classification without assigning its candidate ref', () => {
  let h;
  h = rig(row => { if (row.uuid.endsWith('close')) h.owner.close(); return row.role === 'queued'; });
  try {
    assert.equal(h.publish([local('close')]), false);
    assert.equal(h.env.presentationEntriesRef.current, h.original);
    assert.equal(h.owner.current(), null);
  } finally { h.close(); }
});
