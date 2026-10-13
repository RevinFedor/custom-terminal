'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const SQLite = require('better-sqlite3');
const Manager = require('./database');
const { createWorkflowOrganizationApi } = require('./workflow-organization-api');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'prepareTabContextForkLaunch');
assert.ok(node);
function fixture(t, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-fork-target-'));
  const db = new SQLite(path.join(root, 'private.db'));
  const manager = new Manager({ existingConnection: db }); manager.initTables();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const namespace = '__tab_catalog_v2__';
  const api = createWorkflowOrganizationApi({ database: manager, validateDirectory: () => true });
  api.bootstrap({ migrationId: 'm', mutationId: 'm:commit', workspace: { activeSpaceId: 'w', spaces: [{ id: 'w', layout: {}, projectIds: [] }] } });
  for (const id of ['source', 'target']) api.createTab({ mutationId: 'create:' + id, tabId: id, workflowId: 'w', executionNamespace: namespace, cwd: root,
    record: { name: id, tabType: 'terminal', commandType: provider, ...(id === 'source' ? { [provider + 'SessionId']: 'S' } : {}) } });
  let cancel = false;
  const calls = [], input = { tabId: 'target', command: provider + '-f', [provider === 'codex' ? 'sessionId' : 'forkSessionId']: 'S',
    contextFork: { sourceTabId: 'source', sourceSessionId: 'S', fromLatestCompact: true } };
  const copy = async () => { calls.push('copy'); return { success: true, newSessionId: 'C' }; };
  const ctx = vm.createContext({ projectManager: { db: manager }, require, path, srcMainDir: __dirname,
    terminals: new Map(), getTerminalLifecycleGeneration: () => 'source-generation',
    getCodexForkSourceRuntimeSnapshot: async () => ({ canForkSnapshot: true, readSessionId: 'S' }),
    getSessionMaterialization: () => ({ materialized: true }),
    codexDataModule: { _api: { forkCodexFromLatestCompact: copy } }, claudeDataApi: { forkSessionFile: copy },
    agentLaunchPreparations: { update() {} }, console: { log() {}, warn() {} },
  });
  const run = vm.runInContext(node.getText(tree) + ';prepareTabContextForkLaunch;', ctx);
  return { db, manager, ctx, calls, namespace, input,
    run: () => run(input, provider, () => { if (cancel) throw Error('cancelled'); }, { token: 1 }),
    stop: () => { cancel = true; }, row: id => db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(id) };
}
for (const provider of ['claude', 'codex']) {
  test(`${provider}: actual Main/SQLite binds only exact empty v2 target; manual title and source survive`, async t => {
    const f = fixture(t, provider), before = f.row('target');
    f.db.prepare('UPDATE tabs SET name=?,name_set_manually=1 WHERE tab_id=?').run('Моя ветка', 'target');
    const result = await f.run(), after = f.row('target');
    assert.equal(result.contextForkBinding.committed, true);
    assert.equal(after[provider + '_session_id'], 'C'); assert.equal(after.id, before.id);
    assert.equal(after.name, 'Моя ветка'); assert.equal(after.name_set_manually, 1);
    assert.equal(f.row('source')[provider + '_session_id'], 'S');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id=?').get(f.namespace).n, 0);
  });
  test(`${provider}: replacement target binding during copy cannot be overwritten`, async t => {
    const f = fixture(t, provider);
    const copy = async () => {
      f.db.prepare(`UPDATE tabs SET ${provider}_session_id=? WHERE tab_id=?`).run('foreign', 'target');
      return { success: true, newSessionId: 'C' };
    };
    f.ctx.codexDataModule._api.forkCodexFromLatestCompact = copy; f.ctx.claudeDataApi.forkSessionFile = copy;
    await assert.rejects(f.run(), /target_changed/);
    assert.equal(f.row('target')[provider + '_session_id'], 'foreign');
  });
  test(`${provider}: source rewrite or cancellation during copy never commits target`, async t => {
    const f = fixture(t, provider);
    const copy = async () => { f.stop(); return { success: true, newSessionId: 'C' }; };
    f.ctx.codexDataModule._api.forkCodexFromLatestCompact = copy; f.ctx.claudeDataApi.forkSessionFile = copy;
    await assert.rejects(f.run(), /cancelled/);
    assert.equal(f.row('target')[provider + '_session_id'], null);
  });
}
