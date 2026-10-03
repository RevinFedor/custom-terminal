'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LEGACY_DEFAULT_LOOP_PROMPT, DEFAULT_LOOP_PROMPT, RUN_AFTER_LOOP_PROMPT_ID } = require('../shared/prompt-loop.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-loop-db-test-'));
const electronPath = require.resolve('electron');
const previous = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => root } } };
const DatabaseManager = require('./database');
if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath];
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('real DB seeds Loop, migrates custom text once, preserves edits and saves content without metadata', (t) => {
  let db;
  try { db = new DatabaseManager(); } catch (error) {
    if (/NODE_MODULE_VERSION/.test(error.message || '')) { t.skip('run with ELECTRON_RUN_AS_NODE for the SQLite ABI'); return; }
    throw error;
  }
  t.after(() => db.close());
  const loop = () => db.getAIPrompts().find((p) => p.id === RUN_AFTER_LOOP_PROMPT_ID);
  assert.equal(loop().content, DEFAULT_LOOP_PROMPT);
  assert.equal(loop().isBuiltIn, true);
  // Simulate an existing pre-migration database, not the user's live storage.
  db.db.prepare('DELETE FROM ai_prompts WHERE id = ?').run(RUN_AFTER_LOOP_PROMPT_ID);
  db.setAppState('promptQueueSharedLoopPrompt', JSON.stringify('my custom Loop'));
  db.ensureRunAfterLoopPrompt();
  assert.equal(loop().content, 'my custom Loop');
  db.saveAIPrompt({ ...loop(), name: 'Custom Loop name', color: '#ef4444', content: 'Settings edit' });
  db.setAppState('promptQueueSharedLoopPrompt', JSON.stringify('obsolete mirror'));
  db.ensureRunAfterLoopPrompt();
  assert.equal(loop().content, 'Settings edit');
  db.saveAIPromptContent(RUN_AFTER_LOOP_PROMPT_ID, 'pencil edit');
  assert.equal(loop().content, 'pencil edit');
  assert.equal(loop().name, 'Custom Loop name');
  assert.equal(loop().color, '#ef4444');
  db.deleteAIPrompt(RUN_AFTER_LOOP_PROMPT_ID);
  assert.ok(loop(), 'built-in Loop cannot be deleted');
  db.db.prepare('DELETE FROM ai_prompts WHERE id = ?').run(RUN_AFTER_LOOP_PROMPT_ID);
  db.setAppState('promptQueueSharedLoopPrompt', JSON.stringify(LEGACY_DEFAULT_LOOP_PROMPT + '\n\n'));
  db.ensureRunAfterLoopPrompt();
  assert.equal(loop().content, DEFAULT_LOOP_PROMPT);
});
