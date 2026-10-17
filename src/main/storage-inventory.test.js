'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  inventoryGeneration,
  normalizeStorageRetentionSettings,
  scanStorageInventory,
} = require('./storage-inventory');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function fakeSqlite({ tabs = [], history = [], favorites = [], events = [] } = {}) {
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM tabs t')) return tabs;
          if (sql.includes('FROM tab_history h')) return history;
          if (sql.includes('FROM favorites f')) return favorites;
          if (sql.includes('FROM session_history_events')) return events;
          return [];
        },
      };
    },
  };
}

test('inventory groups Codex and Claude while protecting exact open dependencies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  const appDataDir = path.join(root, 'app-data');
  fs.mkdirSync(appDataDir, { recursive: true });
  const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

  const codexFile = (id) => path.join(codexHome, 'sessions', '2026', '08', '23', `rollout-${id}.jsonl`);
  writeJsonl(codexFile('source'), [{ type: 'session_meta', payload: { id: 'source', cwd: '/work' } }]);
  writeJsonl(codexFile('child'), [{ type: 'session_meta', payload: { id: 'child', cwd: '/work', forked_from_id: 'source' } }]);
  writeJsonl(codexFile('rewrite'), [{ type: 'session_meta', payload: { id: 'rewrite', cwd: '/work', forked_from_id: 'old' } }]);
  writeJsonl(codexFile('outside'), [{ type: 'session_meta', payload: { id: 'outside', cwd: '/other' } }]);
  writeJsonl(codexFile('dev-only'), [{ type: 'session_meta', payload: { id: 'dev-only', cwd: '/dev-work' } }]);
  writeJsonl(codexFile('dev-parent'), [{ type: 'session_meta', payload: { id: 'dev-parent', cwd: '/dev-work' } }]);
  for (const file of ['source', 'child', 'rewrite', 'outside', 'dev-only', 'dev-parent'].map(codexFile)) fs.utimesSync(file, old, old);

  const claudeFile = path.join(claudeHome, 'projects', '-work', 'claude-1.jsonl');
  writeJsonl(claudeFile, [
    { type: 'mode', sessionId: 'claude-1' },
    { type: 'user', sessionId: 'claude-1', cwd: '/work', message: { content: 'First useful prompt' } },
  ]);
  fs.utimesSync(claudeFile, old, old);
  const claudeBackup = path.join(claudeHome, 'projects', '-work', 'claude-1.jsonl.before-repair');
  writeJsonl(claudeBackup, [
    { type: 'user', sessionId: 'claude-1', cwd: '/work', message: { content: 'backup' } },
  ]);
  fs.utimesSync(claudeBackup, old, old);
  const toolResult = path.join(claudeHome, 'projects', '-work', 'claude-1', 'tool-results', 'result.txt');
  fs.mkdirSync(path.dirname(toolResult), { recursive: true });
  fs.writeFileSync(toolResult, 'tool-result-bytes');

  const sqlite = fakeSqlite({
    tabs: [{ name: 'Open fork', cwd: '/work', command_type: 'codex', codex_session_id: 'child', claude_session_id: null, claude_task_count: 7, project_name: 'Project' }],
    history: [{ name: 'Edited history', cwd: '/work', command_type: 'codex', codex_session_id: 'rewrite', claude_session_id: null, closed_at: Math.floor(old.getTime() / 1000), message_count: 12, project_name: 'Project' }],
    events: [
      {
        provider: 'codex',
        child_session_id: 'child',
        source_session_id: 'source',
        fork_mode: 'direct-virtual',
        lineage_manifest_json: JSON.stringify({ sourceSegments: [{ physicalSessionId: 'source' }] }),
      },
      { provider: 'codex', child_session_id: 'rewrite', source_session_id: 'old', fork_mode: 'history_edit', lineage_manifest_json: null },
    ],
  });
  const developmentSqlite = fakeSqlite({
    tabs: [{ name: 'Dev tab', cwd: '/dev-work', command_type: 'codex', codex_session_id: 'dev-only', claude_session_id: null, claude_task_count: 2, project_name: 'Dev project' }],
    events: [{ provider: 'codex', child_session_id: 'dev-only', source_session_id: 'dev-parent', fork_mode: 'direct-virtual', lineage_manifest_json: JSON.stringify({ sourceSegments: [{ physicalSessionId: 'dev-parent' }] }) }],
  });
  const inventory = await scanStorageInventory({
    sqlite,
    codexHome,
    claudeHome,
    projectRoot: null,
    appDataDir,
    currentEnvironment: 'production',
    relationDatabases: [{ environment: 'development', sqlite: developmentSqlite }],
    settings: { enabled: true, retentionDays: { regular: 1, fork: 1, rewrite: 1, subagent: 1, development: 1, outside: 1, recovery: 1 } },
    nowMs: Date.now(),
  });
  const bySession = new Map(inventory.items.filter((item) => item.sessionId && !item.recoveryCopy).map((item) => [item.provider + ':' + item.sessionId, item]));

  assert.equal(bySession.get('codex:child').group, 'open');
  assert.equal(bySession.get('codex:child').protectedReason, 'Open in Noted Terminal');
  assert.equal(bySession.get('codex:source').group, 'open');
  assert.equal(bySession.get('codex:source').protectedReason, 'Required by an open session');
  assert.equal(bySession.get('codex:rewrite').group, 'rewrite');
  assert.equal(bySession.get('codex:rewrite').eligible, true);
  assert.equal(bySession.get('codex:outside').group, 'outside');
  assert.equal(bySession.get('codex:dev-only').group, 'open');
  assert.equal(bySession.get('codex:dev-only').protected, true);
  assert.equal(bySession.get('codex:dev-only').eligible, false);
  assert.equal(bySession.get('codex:dev-parent').group, 'open');
  assert.equal(bySession.get('claude:claude-1').group, 'outside');
  assert.equal(bySession.get('claude:claude-1').title, 'First useful prompt');
  assert.ok(bySession.get('claude:claude-1').sizeBytes > fs.statSync(claudeFile).size);
  assert.equal(inventory.items.find((item) => item.path === claudeBackup).group, 'recovery');
  assert.equal(inventory.summary.codexItems, 6);
  assert.equal(inventory.summary.claudeItems, 2);
});

test('retention settings are bounded and preserve explicit Never', () => {
  const settings = normalizeStorageRetentionSettings({
    enabled: false,
    provider: 'claude',
    retentionDays: { regular: 3, fork: null, outside: 99999, build: -5 },
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.provider, 'claude');
  assert.equal(settings.retentionDays.regular, 3);
  assert.equal(settings.retentionDays.fork, null);
  assert.equal(settings.retentionDays.outside, 3650);
  assert.equal(settings.retentionDays.build, 0);
});

test('development inventory never authorizes deletion of production-referenced sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-storage-prod-protection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex');
  const filePath = path.join(codexHome, 'sessions', '2026', '08', '24', 'rollout-prod-session.jsonl');
  writeJsonl(filePath, [{ type: 'session_meta', payload: { id: 'prod-session', cwd: '/prod' } }]);
  const productionSqlite = fakeSqlite({
    history: [{ name: 'Production history', cwd: '/prod', command_type: 'codex', codex_session_id: 'prod-session', claude_session_id: null, closed_at: 1, message_count: 1, project_name: 'Production' }],
  });
  const inventory = await scanStorageInventory({
    sqlite: fakeSqlite(),
    codexHome,
    claudeHome: path.join(root, 'claude'),
    appDataDir: path.join(root, 'app'),
    currentEnvironment: 'development',
    relationDatabases: [{ environment: 'production', sqlite: productionSqlite }],
    nowMs: Date.now(),
  });
  const item = inventory.items.find((candidate) => candidate.sessionId === 'prod-session');
  assert.equal(item.protected, true);
  assert.equal(item.deletable, false);
  assert.equal(item.protectedReason, 'Referenced by production Noted Terminal');
});

test('scan generation ignores live protected growth but changes for deletable targets', () => {
  const settings = normalizeStorageRetentionSettings({});
  const protectedItem = { id: 'open', sizeBytes: 10, modifiedAt: 10, protected: true, deletable: false, group: 'open' };
  const deletableItem = { id: 'closed', sizeBytes: 20, modifiedAt: 20, protected: false, deletable: true, group: 'outside' };
  const baseline = inventoryGeneration([protectedItem, deletableItem], settings);
  assert.equal(inventoryGeneration([{ ...protectedItem, sizeBytes: 99, modifiedAt: 99 }, deletableItem], settings), baseline);
  assert.notEqual(inventoryGeneration([protectedItem, { ...deletableItem, sizeBytes: 21 }], settings), baseline);
  assert.notEqual(inventoryGeneration([protectedItem, { ...deletableItem, protected: true, deletable: false }], settings), baseline);
});
