'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createSystemPromptService } = require('./system-prompt-service');
const { handleSystemPromptApi } = require('./system-prompt-api');
const { DEFAULT_TAB_TITLE_PROMPT, LEGACY_TAB_TITLE_PROMPT } = require('../shared/tab-title-prompt.cjs');
const { RUN_AFTER_LOOP_PROMPT_ID } = require('../shared/prompt-loop.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-system-prompt-api-'));
const electronPath = require.resolve('electron');
const previous = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => root } } };
const DatabaseManager = require('./database');
if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath];
test.describe('System Prompt HTTP API', () => {
let db, service, server, base;
const events = [];
test.before(async () => {
  db = new DatabaseManager();
  service = createSystemPromptService({ projectManager: { db,
    getAIPrompts: () => db.getAIPrompts(), saveAIPrompt: p => db.saveAIPrompt(p), deleteAIPrompt: id => db.deleteAIPrompt(id),
  }, onChanged: event => events.push(event) });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://test');
    await handleSystemPromptApi({ req, res, parsed: { pathname: url.pathname, query: Object.fromEntries(url.searchParams) }, service,
      readBody: async req => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); },
      sendJson: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
async function call(route, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(base + '/api/system-prompts' + route, { method, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' } }, res => {
      let text = ''; res.on('data', part => { text += part; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(payload);
  });
}

test('compact catalog and addressed reads use real system records, separate from text insertions', async () => {
  const catalog = await call('?query=tab-title');
  assert.equal(catalog.status, 200); assert.equal(catalog.data.prompts.length, 1);
  assert.equal(catalog.data.prompts[0].content, undefined);
  const detail = (await call('/tab-title')).data.prompt;
  assert.equal(detail.content, DEFAULT_TAB_TITLE_PROMPT);
  assert(detail.usage.includes('tab-title'));
  assert.equal((await call('/not-existing')).status, 404);
});

test('all editor fields round-trip, stale API writes cannot overwrite Settings changes', async () => {
  const created = await call('', 'POST', { id: 'test-custom', name: 'custom' });
  assert.equal(created.status, 201);
  const p = created.data.prompt;
  const fields = { name: 'review / UX', content: 'specific instruction', model: 'gemini-3.5-flash-lite',
    thinkingLevel: 'LOW', color: '#123abc', position: 33, showInContextMenu: false, filePaths: ['/tmp/not-read-or-created.md'] };
  const saved = await call('/test-custom', 'PATCH', { revision: p.revision, ...fields });
  assert.equal(saved.status, 200);
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(saved.data.prompt[key], value);
  service.saveContent('test-custom', 'new Settings edit');
  const stale = await call('/test-custom', 'PATCH', { revision: saved.data.prompt.revision, content: 'obsolete external edit' });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'system_prompt_stale');
  assert.equal(service.get('test-custom').content, 'new Settings edit');
  const current = service.get('test-custom');
  const nameOnly = await call('/test-custom', 'PATCH', { revision: current.revision, name: 'renamed' });
  assert.equal(nameOnly.data.prompt.content, 'new Settings edit');
  assert.deepEqual(nameOnly.data.prompt.filePaths, fields.filePaths);
  assert(events.some(e => e.prompts.some(p => p.id === 'test-custom')));
});

test('bindings use revision, reject Loop and guard deletion of assigned or built-in prompts', async () => {
  const settings = (await call('/settings')).data.settings;
  const assigned = await call('/settings', 'PATCH', { revision: settings.revision, rewindPromptId: 'test-custom' });
  assert.equal(assigned.status, 200); assert(service.get('test-custom').usage.includes('rewind'));
  assert.equal((await call('/test-custom', 'DELETE', { revision: service.get('test-custom').revision })).status, 409);
  assert.equal((await call('/settings', 'PATCH', { revision: settings.revision, rewindPromptId: 'rewind' })).status, 409);
  assert.equal((await call('/settings', 'PATCH', { revision: assigned.data.settings.revision, rewindPromptId: RUN_AFTER_LOOP_PROMPT_ID })).status, 400);
  const title = service.get('tab-title');
  assert.equal((await call('/tab-title', 'DELETE', { revision: title.revision })).status, 409);
  await call('/settings', 'PATCH', { revision: assigned.data.settings.revision, rewindPromptId: 'rewind' });
  assert.equal((await call('/test-custom', 'DELETE', { revision: service.get('test-custom').revision })).status, 200);
  assert.equal((await call('/test-custom')).status, 404);
});

test('invalid fields and Loop-only constraints fail before any write', async () => {
  assert.equal((await call('', 'POST', { id: 'settings', name: 'reserved' })).status, 409);
  const before = service.get('tab-title');
  for (const patch of [{ thinkingLevel: 'ULTRA' }, { filePaths: ['relative.md'] }, { isBuiltIn: false }, { position: -1 }, { color: 'red' }]) {
    assert.equal((await call('/tab-title', 'PATCH', { revision: before.revision, ...patch })).status, 400);
  }
  assert.equal(service.get('tab-title').revision, before.revision);
  const loop = service.get(RUN_AFTER_LOOP_PROMPT_ID);
  assert.equal((await call('/' + loop.id, 'PATCH', { revision: loop.revision, filePaths: ['/tmp/file'] })).status, 400);
});

test('Settings blur and field saves merge disjoint edits but reject an externally replaced dirty field', () => {
  const base = service.get('tab-title');
  service.saveFromSettings({ ...base, editBase: base, content: 'local edited instructions' });
  service.saveFromSettings({ ...base, editBase: base, color: '#abcdef' });
  assert.equal(service.get('tab-title').content, 'local edited instructions');
  assert.equal(service.get('tab-title').color, '#abcdef');
  service.saveFromSettings({ ...base, editBase: base, content: 'local edited instructions' });
  assert.throws(() => service.saveFromSettings({ ...base, editBase: base, content: 'conflicting new instructions' }), { code: 'system_prompt_stale' });
  const deleted = service.create({ name: 'deleted while editing' });
  service.remove(deleted.id, deleted.revision);
  assert.throws(() => service.saveFromSettings({ ...deleted, editBase: deleted, content: 'unsaved text' }), { code: 'system_prompt_not_found' });
});

test('title migration updates only the exact old instruction and preserves custom fields and custom text', () => {
  const original = service.get('tab-title');
  db.saveAIPrompt({ ...original, name: 'Заголовок вкладки', color: '#123456', content: LEGACY_TAB_TITLE_PROMPT });
  db.ensureTabTitlePrompt();
  let current = service.get('tab-title');
  assert.equal(current.content, DEFAULT_TAB_TITLE_PROMPT);
  assert.equal(current.name, 'Заголовок вкладки'); assert.equal(current.color, '#123456');
  db.saveAIPrompt({ ...current, content: 'user custom title rules' }); db.ensureTabTitlePrompt();
  assert.equal(service.get('tab-title').content, 'user custom title rules');
});

test('actual Settings IPC and HTTP API share records, revisions and conflict protection', async () => {
  const handlers = new Map();
  const electronBefore = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
    exports: { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, dialog: {}, BrowserWindow: {} } };
  let settings;
  try { settings = require('./ipc/settings'); }
  finally { if (electronBefore) require.cache[electronPath] = electronBefore; else delete require.cache[electronPath]; }
  settings.register({ projectManager: { db }, systemPromptService: service });
  const result = await handlers.get('ai-prompts:get')();
  const title = result.data.find(p => p.id === 'tab-title');
  const saved = await handlers.get('ai-prompts:save')({}, { ...title, editBase: title, content: 'Settings via IPC' });
  assert.equal(saved.success, true);
  assert.equal((await call('/tab-title')).data.prompt.content, 'Settings via IPC');
  const conflict = await handlers.get('ai-prompts:save')({}, { ...title, editBase: title, content: 'stale Settings text' });
  assert.equal(conflict.success, false);
  assert.equal(conflict.code, 'system_prompt_stale');
  await handlers.get('ai-prompts:set-rewind')({}, 'description');
  assert.equal((await call('/settings')).data.settings.rewindPromptId, 'description');
});
});
