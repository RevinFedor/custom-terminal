'use strict';
// Actual SQLite + shipping revision method, private synthetic metadata only.
// Negative control disables reuse without changing the query/hash algorithm.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-prompt-revision-cost-'));
const electronPath = require.resolve('electron');
const originalElectron = require.cache[electronPath];
require.cache[electronPath] = { exports: { app: { isPackaged: false, getPath: () => root } } };
const DatabaseManager = require('../src/main/database');
if (originalElectron) require.cache[electronPath] = originalElectron; else delete require.cache[electronPath];
const source = fs.readFileSync(path.join(__dirname, '../src/main/database.js'), 'utf8');
const start = source.indexOf('  getHistoryPromptPresentationRevision(');
const end = source.indexOf('\n  getHistoryPromptPresentationAssetIds(', start);
assert.ok(start > 0 && end > start);
const method = source.slice(start, end);
const before = method.replace('const cacheable = !this.db.inTransaction;', 'const cacheable = false;');
assert.notEqual(before, method);
const beforeRead = new Function('crypto', `return class {${before}}`)(crypto).prototype.getHistoryPromptPresentationRevision;
const manager = new DatabaseManager();
(async () => {
  try {
    const text = 'synthetic prompt body '.repeat(1600);
    manager.db.transaction(() => {
      for (let i = 0; i < 900; i++) manager.saveHistoryPromptPresentation({ toolType: 'codex',
        sessionId: 'source-' + i, auditTimestamp: 'fixture-time', transportHash: 'hash-' + i,
        entryUuid: 'entry-' + i, chips: [{ kind: 'prompt', text }] });
    })();
    const payloadBytes = manager.db.prepare('SELECT SUM(length(chips_json)) AS n FROM history_prompt_presentations').get().n;
    const expected = beforeRead.call(manager, 'codex', 'child');
    const coldStart = performance.now();
    assert.equal(manager.getHistoryPromptPresentationRevision('codex', 'child'), expected);
    const coldMs = performance.now() - coldStart;
    const result = { proof: 'private-sqlite-revision-not-native-input', root, payloadBytes, coldMs, controls: {} };
    for (const [name, read] of [['before', beforeRead], ['after', manager.getHistoryPromptPresentationRevision]]) {
      let payloadReads = 0;
      const prepare = manager.db.prepare.bind(manager.db);
      manager.db.prepare = sql => {
        if (/SELECT session_id, audit_timestamp, transport_hash, entry_uuid, schema_version, chips_json/.test(sql)) payloadReads++;
        return prepare(sql);
      };
      const times = [], gaps = [];
      for (let i = 0; i < 6; i++) {
        const started = performance.now();
        const nextTurn = new Promise(resolve => setTimeout(() => { gaps.push(performance.now() - started); resolve(); }, 0));
        assert.equal(read.call(manager, 'codex', 'different-child-' + i), expected);
        times.push(performance.now() - started);
        await nextTurn;
      }
      manager.db.prepare = prepare;
      result.controls[name] = { payloadReads, reloadedPayloadBytes: payloadReads * payloadBytes,
        minMs: Math.min(...times), maxMs: Math.max(...times), meanMs: times.reduce((a,b) => a+b,0)/times.length,
        timerMaxMs: Math.max(...gaps) };
    }
    assert.equal(result.controls.before.payloadReads, 6);
    assert.equal(result.controls.after.payloadReads, 0);
    assert.ok(result.controls.after.maxMs < result.controls.before.minMs / 10);
    result.hashIdentical = true;
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { manager.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
