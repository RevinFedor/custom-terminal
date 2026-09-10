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
    if (request === 'electron') return { ipcMain: { handle() {} } };
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

const messageRecord = (uuid, parentUuid, type, content, timestamp, extra = {}) => ({
  uuid,
  parentUuid,
  type,
  timestamp,
  sessionId: 'background-tools-session',
  message: {
    role: type === 'assistant' ? 'assistant' : 'user',
    content,
  },
  ...extra,
});

test('Claude History projects Monitor and explicit background Bash from structural lifecycle', async (t) => {
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-claude-background-tools-'));
  t.after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
  const cwd = '/fixture-project';
  const sessionId = 'background-tools-session';
  const projectDir = path.join(fixtureHome, '.claude', 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, sessionId + '.jsonl');
  const records = [
    messageRecord('u0', null, 'user', 'start', '2026-09-10T11:00:00.000Z'),
    messageRecord('a-monitor-running', 'u0', 'assistant', [{
      type: 'tool_use', id: 'toolu-monitor-running', name: 'Monitor',
      input: { command: 'tail -f app.log', description: 'release progress', timeout_ms: 60000 },
    }], '2026-09-10T11:00:01.000Z'),
    messageRecord('r-monitor-running', 'a-monitor-running', 'user', [{
      type: 'tool_result', tool_use_id: 'toolu-monitor-running',
      content: 'Monitor started (task monitor-1, timeout 60000ms).',
    }], '2026-09-10T11:00:02.000Z', {
      toolUseResult: { taskId: 'monitor-1', timeoutMs: 60000, persistent: false },
    }),
    messageRecord('a-monitor-done', 'r-monitor-running', 'assistant', [{
      type: 'tool_use', id: 'toolu-monitor-done', name: 'Monitor',
      input: { command: 'tail -f other.log', description: 'finished monitor', timeout_ms: 60000 },
    }], '2026-09-10T11:00:03.000Z'),
    messageRecord('r-monitor-done', 'a-monitor-done', 'user', [{
      type: 'tool_result', tool_use_id: 'toolu-monitor-done',
      content: 'Monitor started (task monitor-2, timeout 60000ms).',
    }], '2026-09-10T11:00:04.000Z', {
      toolUseResult: { taskId: 'monitor-2', timeoutMs: 60000, persistent: false },
    }),
    messageRecord('n-monitor-done', 'r-monitor-done', 'user', [
      '<task-notification>',
      '<task-id>monitor-2</task-id>',
      '<tool-use-id>toolu-monitor-done</tool-use-id>',
      '<status>completed</status>',
      '<summary>Monitor "finished monitor" stream ended</summary>',
      '</task-notification>',
    ].join('\n'), '2026-09-10T11:00:05.000Z'),
    messageRecord('a-bash-background', 'n-monitor-done', 'assistant', [{
      type: 'tool_use', id: 'toolu-bash-background', name: 'Bash',
      input: { command: 'sleep 60', description: 'minute Bash', run_in_background: true },
    }], '2026-09-10T11:00:06.000Z'),
    messageRecord('r-bash-background', 'a-bash-background', 'user', [{
      type: 'tool_result', tool_use_id: 'toolu-bash-background',
      content: 'Command moved to the background (ID: bash-1).',
    }], '2026-09-10T11:00:07.000Z'),
    messageRecord('a-bash-foreground', 'r-bash-background', 'assistant', [{
      type: 'tool_use', id: 'toolu-bash-foreground', name: 'Bash',
      input: { command: 'echo done' },
    }], '2026-09-10T11:00:08.000Z'),
    messageRecord('r-bash-foreground', 'a-bash-foreground', 'user', [{
      type: 'tool_result', tool_use_id: 'toolu-bash-foreground', content: 'done',
    }], '2026-09-10T11:00:09.000Z'),
    messageRecord('a-final', 'r-bash-foreground', 'assistant', [{ type: 'text', text: 'finished' }], '2026-09-10T11:00:10.000Z'),
  ];
  fs.writeFileSync(filePath, records.map((value) => JSON.stringify(value)).join('\n') + '\n');

  const claudeData = loadClaudeDataWithFixtureHome(fixtureHome);
  claudeData.register({ projectManager: {}, formatToolAction: () => null });
  const result = await claudeData._api.getFullHistory({ sessionId, cwd });
  assert.equal(result.success, true);
  const rawTools = result.entries
    .flatMap((entry) => entry.actions || [])
    .filter((action) => action?.tool === '__raw__')
    .map((action) => action.rawTool);
  const byId = new Map(rawTools.map((tool) => [tool.toolUseId, tool]));
  assert.equal(byId.get('toolu-monitor-running').backgroundStatus, 'running');
  assert.equal(byId.get('toolu-monitor-done').backgroundStatus, 'completed');
  assert.match(byId.get('toolu-monitor-done').result, /Monitor "finished monitor" stream ended/);
  assert.equal(byId.get('toolu-bash-background').backgroundStatus, 'running');
  assert.equal(byId.get('toolu-bash-foreground').backgroundStatus, undefined);
});
