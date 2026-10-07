'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('actual Claude Timeline retains edit targets across tool results, not reads or the next user', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-claude-timeline-files-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = '/fixture-project';
  const sessionId = 'timeline-file-session';
  const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const records = [];
  const append = (type, content) => {
    const uuid = 'row-' + records.length;
    records.push({ uuid, type, parentUuid: records.at(-1)?.uuid || null, sessionId, cwd,
      timestamp: new Date(1780000000000 + records.length).toISOString(), message: { role: type, content } });
  };
  const tool = (name, input) => ({ type: 'tool_use', id: 'tool-' + records.length, name, input });
  append('user', 'Update the working file');
  append('assistant', [tool('Edit', { file_path: '/private/linked-work/status.md', old_string: 'old', new_string: 'new' })]);
  append('user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'updated' }]);
  append('assistant', [tool('Bash', { command: 'cat >> work/log.md <<EOF\nnew\nEOF', cwd: '/fixture-project' })]);
  append('user', 'Only read now');
  append('assistant', [tool('Read', { file_path: '/private/linked-work/status.md' }),
    tool('Bash', { command: 'cat /private/linked-work/status.md' }),
    { type: 'text', text: 'Example: Edit /private/linked-work/status.md' }]);
  append('user', 'Update docs');
  append('assistant', [tool('Write', { file_path: '/fixture-project/docs/notes.md', content: 'new' })]);
  fs.writeFileSync(path.join(projectDir, sessionId + '.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');

  const sourcePath = require.resolve('./claude-data');
  delete require.cache[sourcePath];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle() {} } };
    if (request === 'os' || request === 'node:os') return { ...os, homedir: () => home };
    return originalLoad.call(this, request, parent, isMain);
  };
  let data;
  try { data = require(sourcePath); } finally { Module._load = originalLoad; }
  data.register({ projectManager: {}, formatToolAction: () => null });
  const result = await data._api.getTimeline({ sessionId, cwd });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.entries.map(e => e.uuid), ['row-0', 'row-4', 'row-6']);
  assert.deepEqual(result.entries[0].fileEdits, ['/private/linked-work/status.md', '/fixture-project/work/log.md']);
  assert.equal(result.entries[0].docsEdited, undefined);
  assert.equal(result.entries[1].fileEdits, undefined);
  assert.deepEqual(result.entries[2].docsEdited, ['docs/notes.md']);
  assert.deepEqual(result.entries[2].fileEdits, ['/fixture-project/docs/notes.md']);
  const unchanged = await data._api.getTimeline({ sessionId, cwd, ifRevision: result.revision });
  assert.equal(unchanged.unchanged, true, 'warm reads retain the same metadata witness');
});
