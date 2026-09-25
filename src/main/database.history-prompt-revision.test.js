'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-prompt-revision-'));
const electronPath = require.resolve('electron');
const previous = require.cache[electronPath];
require.cache[electronPath] = { exports: { app: { isPackaged: false, getPath: () => root } } };
const DatabaseManager = require('./database');
if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath];

test('revision reuse preserves the exact provider-wide hash through writes, rollback, second connection and reopen', t => {
  let manager = new DatabaseManager();
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const oracle = tool => {
    const rows = manager.db.prepare(`SELECT session_id, audit_timestamp, transport_hash, entry_uuid, schema_version, chips_json
      FROM history_prompt_presentations WHERE tool_type = ? ORDER BY session_id ASC, audit_timestamp ASC, transport_hash ASC`).all(tool);
    return rows.length ? crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 24) : 'none';
  };
  const read = (tool = 'codex') => manager.getHistoryPromptPresentationRevision(tool, 'any-child');
  const save = (session = 'source', text = 'one', toolType = 'codex') => manager.saveHistoryPromptPresentation({
    toolType, sessionId: session, auditTimestamp: 'same-time', transportHash: 'same-hash',
    chips: [{ kind: 'prompt', text }],
  });
  assert.equal(read(), 'none');
  save();
  const token = read(); assert.equal(token, oracle('codex'));

  // Count actual payload SELECTs, not clock speed or private cache fields.
  const prepare = manager.db.prepare.bind(manager.db);
  let payloadReads = 0;
  manager.db.prepare = sql => {
    if (/SELECT session_id, audit_timestamp, transport_hash, entry_uuid, schema_version, chips_json/.test(sql)) payloadReads++;
    return prepare(sql);
  };
  assert.equal(read(), token);
  manager.db.prepare("INSERT INTO app_state (key,value) VALUES ('unrelated','one')").run();
  assert.equal(read(), token);
  save('claude-source', 'other', 'claude');
  assert.equal(read(), token);
  assert.equal(payloadReads, 0, 'unrelated state/provider changes must not rehash every prompt body');
  manager.db.prepare = prepare;

  // Updating bookkeeping alone did not change the old hash either.
  manager.db.prepare("UPDATE history_prompt_presentations SET updated_at = updated_at + 1 WHERE tool_type = 'codex'").run();
  assert.equal(read(), token);

  save('source', 'two');
  const changed = read(); assert.notEqual(changed, token); assert.equal(changed, oracle('codex'));
  save('ancestor', 'ancestor change');
  assert.notEqual(read(), changed, 'a child token still covers its ancestor metadata');
  const beforeBind = read();
  manager.bindHistoryPromptPresentationEntry({ toolType: 'codex', sessionId: 'source', auditTimestamp: 'same-time', transportHash: 'same-hash', entryUuid: 'uuid' });
  assert.notEqual(read(), beforeBind); assert.equal(read(), oracle('codex'));
  const committed = read();
  assert.throws(() => manager.db.transaction(() => {
    save('source', 'aborted');
    assert.notEqual(read(), committed);
    assert.equal(read(), oracle('codex'));
    throw Error('rollback');
  })(), /rollback/);
  assert.equal(read(), committed, 'uncommitted revisions cannot escape rollback');
  save('source', 'committed again');
  assert.equal(read(), oracle('codex'));
  const beforeOtherConnection = read();
  const SQLite = require('better-sqlite3');
  const other = new SQLite(manager.db.name);
  try { other.prepare("UPDATE history_prompt_presentations SET chips_json = ? WHERE session_id = 'ancestor'").run('[{"text":"external"}]'); }
  finally { other.close(); }
  assert.notEqual(read(), beforeOtherConnection); assert.equal(read(), oracle('codex'));
  const oldClaude = read('claude');
  manager.db.prepare("UPDATE history_prompt_presentations SET tool_type = 'claude' WHERE session_id = 'ancestor'").run();
  assert.equal(read(), oracle('codex'));
  assert.notEqual(read('claude'), oldClaude); assert.equal(read('claude'), oracle('claude'));
  manager.db.prepare("DELETE FROM history_prompt_presentations WHERE session_id = 'source'").run();
  const afterDelete = read(); assert.equal(afterDelete, oracle('codex'));
  manager.close(); manager = new DatabaseManager();
  assert.equal(read(), afterDelete);
  manager.db.prepare("DELETE FROM history_prompt_presentations WHERE tool_type = 'codex'").run();
  assert.equal(read(), 'none');
});
