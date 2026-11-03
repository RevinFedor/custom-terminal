'use strict';
// Claude settles a queued prompt it consumed as mid-turn steering with its own
// `remove` record and never writes a canonical user row for it. The row used to
// fall back to plain SENT, whose badge fades after seconds, so the feed showed a
// block of the user's own prompts with no answer under any of them (Fedor,
// 02.11). It also used to let a non-settings `<command-name>` echo through as an
// ordinary user bubble.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const load = Module._load;
Module._load = function stubElectron(request, ...rest) {
  if (request === 'electron') {
    return { ipcMain: { handle() {}, on() {}, removeHandler() {} }, app: { getPath: () => os.tmpdir() } };
  }
  return load.call(this, request, ...rest);
};
const claudeData = require('./claude-data');
Module._load = load;
try {
  claudeData.register({ projectManager: { getProjectPath: () => null }, formatToolAction: () => '',
    getClaudeEditableLastPromptState: () => null, recoverManagedHistoryImageRef: () => null,
    getClaudeRuntimeSettingsScope: () => null, resolveTimelineNoteAnchor: () => null });
} catch { /* only the _api assignments are needed here */ }

const SESSION = '11111111-2222-3333-4444-555555555555';
const at = (seconds) => new Date(Date.UTC(2026, 10, 2, 12, 0, seconds)).toISOString();

function writeFixture(records) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-queue-steering-'));
  const dir = path.join(os.homedir(), '.claude', 'projects', '-' + cwd.replace(/^\//, '').replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION + '.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { cwd, file, dir };
}

test('a queue row settled by Claude\'s own remove is marked as mid-turn steering', async (t) => {
  const steered = 'доставлен во время уже идущего ответа';
  const fixture = writeFixture([
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: SESSION, timestamp: at(1),
      message: { role: 'user', content: 'первый вопрос' } },
    { type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, timestamp: at(2), content: steered },
    { type: 'queue-operation', operation: 'remove', sessionId: SESSION, timestamp: at(3), content: steered },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: SESSION, timestamp: at(4),
      message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] } },
  ]);
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const rows = (await claudeData._api.getFullHistory({ sessionId: SESSION, cwd: fixture.cwd, last: 50 })).entries || [];
  const queued = rows.filter((row) => row.role === 'queued');
  assert.equal(queued.length, 1, 'the queued prompt stays visible: it really was delivered');
  assert.equal(queued[0].content, steered);
  assert.equal(queued[0].queueSettledBy, 'remove',
    'without this the row renders as a bare SENT message that looks unanswered');
});

test('a canonical user record still replaces the queue row entirely', async (t) => {
  const delivered = 'обычная доставка через очередь';
  const fixture = writeFixture([
    { type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, timestamp: at(1), content: delivered },
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: SESSION, timestamp: at(2),
      message: { role: 'user', content: delivered } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: SESSION, timestamp: at(3),
      message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] } },
  ]);
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const rows = (await claudeData._api.getFullHistory({ sessionId: SESSION, cwd: fixture.cwd, last: 50 })).entries || [];
  assert.equal(rows.filter((row) => row.role === 'queued').length, 0, 'the canonical record owns the row');
  const user = rows.filter((row) => row.role === 'user' && row.content === delivered);
  assert.equal(user.length, 1, 'exactly one row, not a queued copy plus a user copy');
  assert.equal(user[0].queueSettledBy, undefined, 'a real delivery is not steering');
});

test('a command echo never reaches the feed as a user message', async (t) => {
  // A recognised command keeps its own compact `slash` row (`/model`, `/effort`,
  // `/ide`, …). What must never happen is the raw `<command-name>…` envelope
  // appearing as if the user had typed it into the conversation — the shape
  // that produced the "my messages nobody answered" block.
  const fixture = writeFixture([
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: SESSION, timestamp: at(1),
      message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' } },
    { type: 'user', uuid: 'u2', parentUuid: 'u1', sessionId: SESSION, timestamp: at(2),
      message: { role: 'user', content: '<command-name></command-name>\n<command-args>broken</command-args>' } },
    { type: 'user', uuid: 'u3', parentUuid: 'u2', sessionId: SESSION, timestamp: at(3),
      message: { role: 'user', content: 'настоящее сообщение' } },
  ]);
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const rows = (await claudeData._api.getFullHistory({ sessionId: SESSION, cwd: fixture.cwd, last: 50 })).entries || [];
  assert.deepEqual(rows.filter((row) => row.role === 'slash').map((row) => row.content), ['/model opus'],
    'the settings command keeps its compact row');
  assert.ok(!rows.some((row) => String(row.content || '').includes('<command-name>')),
    'a malformed echo is dropped instead of becoming a user bubble');
  assert.deepEqual(rows.filter((row) => row.role === 'user').map((row) => row.content), ['настоящее сообщение'],
    'ordinary user text is the only user row left');
});
