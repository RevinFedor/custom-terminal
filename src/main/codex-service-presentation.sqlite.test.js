'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { makeServiceFixture } = require('../../scripts/fixtures/codex-service-presentation.cjs');
const { decorateHistoryPromptPresentations } = require('./history-prompt-presentations');

test('persisted response-carrier sidecar decorates canonical History after a database reopen without rewriting it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-service-presentation-db-'));
  const file = path.join(dir, 'private.db');
  let manager = new DatabaseManager({ existingConnection: new Database(file) });
  t.after(() => { manager.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  manager.initTables();
  const f = makeServiceFixture(manager);
  const persisted = manager.getHistoryPromptPresentations('codex', f.sessionId);
  assert.equal(persisted[0].entryUuid, `codex-user-${f.sessionId}-${f.response.__line}`);
  assert.equal(f.entries[0].semanticTags[0].runId, 'service-run');
  manager.close();
  manager = new DatabaseManager({ existingConnection: new Database(file) });
  const canonical = f.api.buildCodexFullHistory(f.records, f.sessionId);
  const entry = decorateHistoryPromptPresentations(manager, {
    toolType: 'codex', sessionId: f.sessionId, entries: canonical,
  })[0];
  assert.equal(entry.uuid, `codex-user-${f.sessionId}-${f.event.__line}`);
  assert.equal(entry.semanticTags[0].runId, 'service-run');
  assert.equal(entry.content, f.content);
  assert.deepEqual(manager.getHistoryPromptPresentations('codex', f.sessionId), persisted,
    'reading the canonical alias does not migrate or rewrite the original receipt binding');
});
