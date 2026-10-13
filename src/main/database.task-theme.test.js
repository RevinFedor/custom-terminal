'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-task-theme-db-'));
const key = require.resolve('electron'), previous = require.cache[key];
require.cache[key] = { id: key, filename: key, loaded: true, exports: { app: { isPackaged: false, getPath: () => root } } };
const DatabaseManager = require('./database');
if (previous) require.cache[key] = previous; else delete require.cache[key];
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('new task prompt is distinct and migration preserves API-created/user-edited fields and other roles', () => {
  let db = new DatabaseManager();
  try {
    const roles = db.getAIPrompts().filter(p => p.id !== 'task-theme');
    const prompt = db.getAIPrompts().find(p => p.id === 'task-theme');
    assert.equal(prompt.name, 'Тема задачи'); assert.equal(prompt.isBuiltIn, true);
    assert.equal(prompt.model, 'gemini-3.5-flash-lite');
    assert.match(prompt.content, /shortTitle/); assert.match(prompt.content, /title/);
    const edited = { ...prompt, name: 'Мои темы', content: 'Моя инструкция', model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', position: 39, isBuiltIn: false };
    db.saveAIPrompt(edited); db.close(); db = new DatabaseManager();
    assert.deepEqual(db.getAIPrompts().filter(p => p.id !== 'task-theme'), roles);
    const reopened = db.getAIPrompts().find(p => p.id === 'task-theme');
    for (const field of ['name', 'content', 'model', 'thinkingLevel', 'position']) assert.equal(reopened[field], edited[field]);
    assert.equal(reopened.isBuiltIn, true);
  } finally { db.close(); }
});
