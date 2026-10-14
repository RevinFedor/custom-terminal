const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function declaration(path, name) {
  const ast = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn, name); return fn.getText(ast);
}
test('actual Noted run lookup uses only the saved external job and preserves both registries', async () => {
  let run = { runId: 'run', runKind: 'external-research', externalResearchJobId: 'exact-job' };
  const calls = [];
  const ctx = vm.createContext({ Date, console: { log() {} }, crypto: { randomUUID: () => 'navigation' },
    getOrchestrationRunStore: () => ({ get: async id => { assert.equal(id, 'run'); return run; } }),
    getScExternalResearchClient: () => ({ openBrowser: async (id, options) => { calls.push([id, options.requestId]); return { jobId: id, tabId: 7, focused: true }; } }),
  });
  vm.runInContext(declaration(require.resolve('./web-server'), 'openExternalResearchBrowser'), ctx);
  const before = structuredClone(run);
  assert.equal((await ctx.openExternalResearchBrowser('run')).tabId, 7);
  assert.deepEqual(calls, [['exact-job', 'navigation']]); assert.deepEqual(run, before);
  for (const value of [null, { runKind: 'agent' }, { runKind: 'external-research' }]) {
    run = value; assert.equal((await ctx.openExternalResearchBrowser('run')).success, false);
  }
  assert.equal(calls.length, 1);
  const main = fs.readFileSync(require.resolve('./main'), 'utf8');
  assert.equal((main.match(/ipcMain\.handle\('orchestration:open-research-browser'/g) || []).length, 1);
  assert.match(main, /webServer\.openExternalResearchBrowser\(payload\.runId/);
});
test('actual SC metadata SQL reads URL without materializing result, prompt or assets', t => {
  const Database = require('better-sqlite3');
  let db;
  try { db = new Database(':memory:'); }
  catch (e) { if (/NODE_MODULE_VERSION/.test(e.message)) { t.skip('Run with ELECTRON_RUN_AS_NODE=1'); return; } throw e; }
  t.after(() => db.close());
  db.exec('CREATE TABLE research_jobs(job_id TEXT,provider TEXT,url TEXT,result_json TEXT,prompt TEXT)');
  db.prepare('INSERT INTO research_jobs VALUES(?,?,?,?,?)').run('job', 'chatgpt', 'https://chatgpt.com/c/one', 'invalid '.repeat(262144), 'secret prompt');
  const ctx = vm.createContext({ getDb: () => db });
  vm.runInContext(declaration('/Users/example/Desktop/sc-desktop/electron/database.js', 'getResearchBrowserLink'), ctx);
  const row = ctx.getResearchBrowserLink('job');
  assert.deepEqual(Object.keys(row).sort(), ['jobId', 'provider', 'url']);
  assert.equal(row.jobId, 'job'); assert.equal(ctx.getResearchBrowserLink('missing'), null);
});
