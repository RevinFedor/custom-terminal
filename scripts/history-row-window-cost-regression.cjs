'use strict';
// Headless A/B: same real row-window module, negative control disables ONLY
// label reuse in its private VM. No application API, production data or cursor.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const modulePath = path.resolve(__dirname, '../src/main/history-entry-window.js');
const source = fs.readFileSync(modulePath, 'utf8');
const controls = ['before', 'after'];

(async () => {
  const reports = [];
  let baseline = null;
  for (const control of controls) {
    const code = control === 'before'
      ? source.replace('const cacheable = argsPlain', 'const cacheable = false && argsPlain') : source;
    if (control === 'before') assert.notEqual(code, source, 'negative control must actually disable the cache');
    const ctx = { module: { exports: {} }, require: createRequire(modulePath), __dirname: path.dirname(modulePath), performance };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    vm.runInContext(`
      var fixtures = Array.from({length:6084},(_,i)=>({uuid:'row'+i,role:'assistant',sessionId:'fixture',
        actions:[{tool:'__raw__',rawTool:{toolUseId:'call'+i,toolName:'Bash',family:'bash',bashWord:'node',
          args:{command:'node -e "'+('x'.repeat(2000))+'"'},result:'done'}}]}));
      var hydration={radius:750,alwaysHydrateTail:200};
      var warmed=module.exports.applyHistoryRowWindow(fixtures,hydration);
    `, ctx);
    const begun = performance.now();
    const eventLoop = new Promise(resolve => setImmediate(() => resolve(performance.now() - begun)));
    const result = vm.runInContext('module.exports.applyHistoryRowWindow(fixtures,hydration)', ctx);
    const syncMs = performance.now() - begun;
    const delayedTaskMs = await eventLoop;
    // Compare every field, not just counts or a sampled hash.
    const encoded = JSON.stringify(result);
    if (baseline === null) baseline = encoded;
    else assert.equal(encoded, baseline, 'warm optimization must preserve the entire response');
    reports.push({ control, rows: result.total, stubs: result.stubbedCount,
      syncMs: +syncMs.toFixed(2), delayedTaskMs: +delayedTaskMs.toFixed(2) });
  }
  assert.ok(reports[1].syncMs < reports[0].syncMs / 4, 'repeated parse cost must materially fall');
  console.log(JSON.stringify({ proof: 'headless-row-window-not-native-scroll', identical: true, reports }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
