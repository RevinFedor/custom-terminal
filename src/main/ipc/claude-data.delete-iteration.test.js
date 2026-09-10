'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadClaudeDataWithFixtureHome(fixtureHome) {
  const sourcePath = require.resolve('./claude-data');
  delete require.cache[sourcePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain: { handle() {} } };
    }
    if (request === 'os' || request === 'node:os') {
      return { ...os, homedir: () => fixtureHome };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(sourcePath);
  } finally {
    Module._load = originalLoad;
  }
}

function record(uuid, parentUuid, type, content, timestamp) {
  if (type === 'system') {
    return { uuid, parentUuid, type, subtype: 'turn_duration', timestamp };
  }
  return {
    uuid,
    parentUuid,
    type,
    timestamp,
    message: {
      role: type === 'assistant' ? 'assistant' : 'user',
      content,
    },
  };
}

test('Claude one-point delete removes the prompt response chain and stops before the next prompt', async (t) => {
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-claude-delete-iteration-'));
  t.after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
  const cwd = '/fixture-project';
  const sessionId = 'delete-iteration-session';
  const projectDir = path.join(fixtureHome, '.claude', 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, sessionId + '.jsonl');
  const records = [
    record('u0', null, 'user', 'keep first prompt', '2026-09-10T00:00:00.000Z'),
    record('a0', 'u0', 'assistant', [{ type: 'text', text: 'keep first answer' }], '2026-09-10T00:00:01.000Z'),
    record('u1', 'a0', 'user', 'remove this prompt', '2026-09-10T00:00:02.000Z'),
    record('a1', 'u1', 'assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], '2026-09-10T00:00:03.000Z'),
    record('r1', 'a1', 'user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }], '2026-09-10T00:00:04.000Z'),
    record('a2', 'r1', 'assistant', [{ type: 'text', text: 'remove this answer' }], '2026-09-10T00:00:05.000Z'),
    record('s1', 'a2', 'system', null, '2026-09-10T00:00:06.000Z'),
    record('u2', 's1', 'user', 'keep next prompt', '2026-09-10T00:00:07.000Z'),
    record('a3', 'u2', 'assistant', [{ type: 'text', text: 'keep next answer' }], '2026-09-10T00:00:08.000Z'),
  ];
  fs.writeFileSync(filePath, records.map((value) => JSON.stringify(value)).join('\n') + '\n');

  const claudeData = loadClaudeDataWithFixtureHome(fixtureHome);
  claudeData.register({ projectManager: {}, formatToolAction: () => null });
  const result = await claudeData._api.deleteRange({
    sessionId,
    cwd,
    startUuid: 'u1',
    endUuid: 'u1',
  });

  assert.equal(result.success, true);
  assert.equal(result.removedUsers, 1);
  assert.equal(result.removedAssistants, 2);
  const remaining = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(remaining.map((value) => value.uuid), ['u0', 'a0', 'u2', 'a3']);
  assert.equal(remaining.find((value) => value.uuid === 'u2').parentUuid, 'a0');
});
