'use strict';

// Fixed private SQLite workload; no app, provider, native harness or live DB.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createCausalContext } = require('./perf-causal-context');
const { PrivateSQLite, load } = require('./diagnostic25-sites.fixtures.cjs');

const db = new PrivateSQLite();
db.exec(`CREATE TABLE tabs(tab_id TEXT,project_id TEXT,execution_namespace TEXT);
  CREATE TABLE workflow_org_tabs(tab_id TEXT,execution_json TEXT);
  INSERT INTO tabs VALUES('tab','P','P');
  INSERT INTO workflow_org_tabs VALUES('tab','{"executionNamespace":"P"}');`);
let clockReads = 0, packets = 0, summary;
const causal = createCausalContext({ boot: 'sites-benchmark', now: () => { clockReads++; return performance.timeOrigin + performance.now(); } });
causal.configure({ sink: value => { packets++; if (value.kind === 'work-summary') summary = value.workSummary; return true; } });
const { WorkflowRootRegistry } = load('workflow-root-registry.js', { './perf-causal-context': { causal } });
const registry = new WorkflowRootRegistry({ db });
db.exec(`INSERT INTO workflow_roots VALUES('root','/fixture/source','{"enabled":true}',1,0);
  INSERT INTO workflow_root_scope_meta VALUES('tab:tab',1,1);
  INSERT INTO workflow_root_bindings VALUES('tab:tab','root',0,'{"project_id":"P"}');`);

function pass(enabled) {
  causal.configure({ enabled }); clockReads = packets = 0; summary = null; db.calls.length = 0;
  const start = performance.now();
  const result = causal.syncWork('control.sql4096', {}, () => {
    const read = registry.createSourcesReader(); let sources = 0;
    for (let i = 0; i < 1024; i++) sources += read('tab').length;
    return sources;
  });
  const elapsed = performance.now() - start;
  assert.equal(result, 1024);
  assert.equal(db.calls.length, 4100);
  if (enabled) {
    assert.deepEqual(summary.counts, [4, 3072, 1024, 0]);
    assert.equal(summary.sites.length, 4);
    assert.equal(packets, 2, 'one work enter and one summary, not per-query transport');
    assert.ok(clockReads <= 8206, 'two clocks per actual SQL op plus bounded work/transport clocks');
  } else {
    assert.equal(clockReads, 0); assert.equal(packets, 0);
  }
  return { ms: elapsed, clockReads, packets };
}

try {
  for (let i = 0; i < 5; i++) { pass(false); pass(true); }
  const pairs = [];
  for (let i = 0; i < 20; i++) {
    let off, on;
    if (i % 2) { on = pass(true); off = pass(false); }
    else { off = pass(false); on = pass(true); }
    pairs.push({ offMs: off.ms, onMs: on.ms, deltaMs: on.ms - off.ms, ratio: on.ms / off.ms,
      offClocks: off.clockReads, onClocks: on.clockReads, offPackets: off.packets, onPackets: on.packets });
  }
  const stats = key => {
    const values = pairs.map(p => p[key]).sort((a, b) => a - b);
    return { median: (values[9] + values[10]) / 2, p95: values[18], max: values[19] };
  };
  process.stdout.write(JSON.stringify({ runtime: process.version, sqlite: 'node:sqlite substitute for installed Electron-ABI better-sqlite3',
    workload: '1024 exact source reads, four actual prepares and 4096 actual get/all per pass; test adapter trace allocation included in both arms',
    warmupPairs: 5, measuredPairs: 20, offMs: stats('offMs'), onMs: stats('onMs'), deltaMs: stats('deltaMs'), ratio: stats('ratio'),
    instrumentation: { sqlCounts: [4, 3072, 1024, 0], sites: 4, offClocks: 0, onClocksMax: Math.max(...pairs.map(p => p.onClocks)),
      offPackets: 0, onPackets: 2 }, pairs }, null, 2) + '\n');
} finally { db.close(); }
