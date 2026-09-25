'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-gemini-model-defaults-'));
const electronPath = require.resolve('electron');
const previousElectron = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => tempRoot } },
};
const DatabaseManager = require('./database');
if (previousElectron) require.cache[electronPath] = previousElectron;
else delete require.cache[electronPath];
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('new system prompts use current Gemini defaults; an existing saved legacy choice survives reopen', (t) => {
  let db;
  try { db = new DatabaseManager(); } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI');
      return;
    }
    throw error;
  }
  const byId = id => db.getAIPrompts().find(prompt => prompt.id === id);
  assert.equal(byId('rewind').model, 'gemini-3.8-flash');
  for (const id of ['run-after-title', 'prompt-summary', 'timeline-grouping', 'git-commit']) {
    assert.equal(byId(id).model, 'gemini-3.5-flash-lite', id);
  }
  const custom = { ...byId('rewind'), name: 'My preserved Rewind',
    model: 'gemini-3.5-flash', thinkingLevel: 'HIGH' };
  db.saveAIPrompt(custom);
  db.close();

  db = new DatabaseManager();
  t.after(() => db.close());
  assert.equal(byId('rewind').name, custom.name);
  assert.equal(byId('rewind').model, custom.model);
  assert.equal(byId('rewind').thinkingLevel, custom.thinkingLevel);
});
