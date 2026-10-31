'use strict';
// E28-as-Node: real private SQLite + actual runtime/role/archive reader. No
// BrowserWindow, provider, PTY, send, Stop, or session mutation.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const Database = require('better-sqlite3'), Manager = require('../src/main/database');
const { GLOBAL_EXECUTION_NAMESPACE: NS } = require('../src/shared/workflow-organization.cjs');
const { createSystemPromptService } = require('../src/main/system-prompt-service');
const { createMiniOrchestratorRuntime } = require('../src/main/mini-orchestrator-runtime');
const profileFile = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/ready-v2/PROFILE.json');
const folder = path.dirname(profileFile);
const p = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
const connection = new Database(path.join(p.root, 'data/noted-terminal-dev.db'), { readonly: true, fileMustExist: true });
const db = new Manager({ existingConnection: connection });
const service = createSystemPromptService({ projectManager: { db, getAIPrompts: () => db.getAIPrompts() } });
const role = service.get('mini-orchestrator-review');
assert.ok(role.usage.includes('mini-orchestrator-review'));
assert.match(role.content, /Только чтение/);
let reviews = 0, sends = 0;
const runtime = createMiniOrchestratorRuntime({ db, systemPromptService: service, readOwner: () => null,
  loadPresentation: id => db.getAppState('mini-orchestrator-archive:' + id),
  review: () => { reviews++; throw Error('must_not_run'); }, sendCorrection: () => { sends++; throw Error('must_not_send'); } });
const results = [];
for (const c of p.cases) {
  const row = db.getExecutionTabV2({ executionNamespace: NS, tabId: c.tabId }).row;
  assert.equal(row.codex_session_id, c.sessionId); assert.equal(row.cwd, c.cwd);
  const bytes = fs.readFileSync(c.sessionFile);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), c.initialSha256);
  const state = runtime.get(c.tabId);
  assert.equal(state.enabled, false); assert.equal(state.phase, 'complete');
  assert.equal(state.reviewSource.archived, true); assert.equal(state.reviewSource.sessionId, c.sessionId);
  assert.equal(state.entries.filter(e => e.type === 'request').length, 1);
  assert.equal(state.entries.filter(e => e.type === 'review').length, 1);
  assert.equal(state.entries.filter(e => e.type === 'tool' && e.name === 'read_review_iteration').length, 1);
  assert.ok(runtime.guard({ tabId: c.tabId, handoffId: 'mini-orchestrator:' + state.reviewSource.jobId }));
  assert.equal(state.settings.model, 'gemini-3.8-flash'); assert.equal(state.settings.thinkingLevel, 'HIGH');
  results.push({ tabId: c.tabId, sessionId: c.sessionId, bytes: bytes.length, enabled: false, phase: 'complete',
    archive: true, sourceCurrentWriterAuthority: false, actualReview: true });
}
assert.equal(reviews, 0); assert.equal(sends, 0); runtime.dispose(); db.close();
const result = { at: new Date().toISOString(), cases: results, realPrivateSqlite: true, realRuntime: true,
  realSystemPromptService: true, reviews, sends, GUI: 'NOTRUN', appLaunched: false };
fs.writeFileSync(path.join(folder, 'OFFLINE-VERIFICATION.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
console.log('[MiniReady] offline verified two real archives, runtime actions=0');
