import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { historyFileActionMenuPayload, dispatchHistoryFileActionContextMenu } from './historyFileActionContextMenu.mjs';

const cwd = '/Users/example/Desktop/custom-terminal';
const environment = { path, pathToFileURL, homeDir: '/Users/example' };
const target = action => {
  const payload = historyFileActionMenuPayload(action, cwd, environment);
  return payload ? fileURLToPath(payload.href) : null;
};

for (const toolName of ['Read', 'Edit', 'Write', 'MultiEdit', 'Update']) {
  test(`${toolName}: menu uses the original path, never the abbreviated headline`, () => {
    const action = { toolName, args: { file_path: 'docs/tmp/хранилище-и-очистка-диска.md' },
      headline: { subject: 'other.md' } };
    assert.equal(target(action), cwd + '/docs/tmp/хранилище-и-очистка-диска.md');
    assert.equal(historyFileActionMenuPayload(action, cwd, environment).editorFirst, true);
  });
}

test('exact paths preserve spaces, #, percent, dollar and parentheses through file URL encoding', () => {
  const file = '/tmp/Папка с пробелом/file # 100% $money (draft).md';
  assert.equal(target({ toolName: 'Read', args: { file_path: file } }), file);
});

test('native relative path has no target without its own absolute cwd', () => {
  assert.equal(historyFileActionMenuPayload({ toolName: 'Read', args: { path: 'a.md' } }, '', environment), null);
  assert.equal(historyFileActionMenuPayload({ toolName: 'Read', args: { path: '/tmp/a.md' } }, '', environment).href,
    pathToFileURL('/tmp/a.md').href);
});

test('shell Read and Git reuse the existing grammar and their explicit workdir', () => {
  assert.equal(target({ toolName: 'Bash', family: 'read', args: {
    command: "sed -n '35,55p' docs/tmp/хранилище-и-очистка-диска.md",
  } }), cwd + '/docs/tmp/хранилище-и-очистка-диска.md');
  assert.equal(target({ toolName: 'Bash', family: 'read', args: {
    command: "cat 'docs/file name.md'", workdir: '/tmp/other-owner',
  } }), '/tmp/other-owner/docs/file name.md');
  assert.equal(target({ toolName: 'Bash', family: 'git', args: {
    command: 'git diff --check -- docs/tmp/хранилище-и-очистка-диска.md docs/tmp/other.md',
  } }), cwd + '/docs/tmp/хранилище-и-очистка-диска.md');
  assert.equal(target({ toolName: 'Bash', family: 'read', args: {
    command: 'cat docs/a.md', workdir: '~/other-owner',
  } }), '/Users/example/other-owner/docs/a.md');
});

test('literal shell mutation keeps its existing Edit target', () => {
  assert.equal(target({ toolName: 'Bash', args: { command: "printf x > docs/output.md" } }), cwd + '/docs/output.md');
});

test('jq filter/options are not files, but explicit file operands including dotfiles are', () => {
  for (const command of ["jq '.items'", "jq --arg key '.items' '.'", "jq -L './lib' '.items'"])
    assert.equal(target({ toolName: 'Bash', family: 'read', args: { command } }), null);
  assert.equal(target({ toolName: 'Bash', family: 'read', args: { command: "jq '.items' data.json" } }), cwd + '/data.json');
  assert.equal(target({ toolName: 'Bash', family: 'read', args: { command: "jq '.items' '.items'" } }), cwd + '/.items');
});

test('globs, unresolved variables, streams and labels are not executable file targets', () => {
  for (const action of [
    { toolName: 'Bash', family: 'git', args: { command: 'git status --short -- src/main/process-metrics*' } },
    { toolName: 'Bash', family: 'read', args: { command: 'cat "$UNKNOWN/file.md"' } },
    { toolName: 'Bash', family: 'read', args: { command: "jq '.items'" } },
    { toolName: 'Bash', args: { command: 'echo docs/a.md' } },
    { toolName: 'Read', args: {}, headline: { subject: 'docs/a.md' } },
    { toolName: 'mcp__knowledge__docs_search', args: { query: 'docs/a.md' } },
    { toolName: 'Read', args: { file_path: 'untitled://document' } },
    { toolName: 'Read', args: { file_path: 'bad\0path' } },
  ]) assert.equal(target(action), null, JSON.stringify(action));
});

test('relative shell paths after cd are not resolved against an unrelated tab directory', () => {
  assert.equal(target({ toolName: 'Bash', family: 'read', args: { command: 'cd /tmp/other && cat docs/a.md' } }), null);
  assert.equal(target({ toolName: 'Bash', family: 'read', args: { command: 'cd /tmp/other && cat /tmp/other/docs/a.md' } }), '/tmp/other/docs/a.md');
});

test('right click dispatches the old native menu once, without changing payload or requesting output', () => {
  const calls = [], action = { toolName: 'Edit', args: { file_path: 'docs/a.md', old_string: 'unchanged transport' } };
  const before = structuredClone(action);
  const event = { preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') };
  assert.equal(dispatchHistoryFileActionContextMenu(event, action, cwd, {
    ...environment, send: (...args) => calls.push(args),
  }), true);
  assert.deepEqual(action, before);
  assert.deepEqual(calls, [['show-markdown-link-context-menu', {
    href: pathToFileURL(cwd + '/docs/a.md').href, editorFirst: true,
  }], 'prevent', 'stop']);
});

test('a non-file action leaves the parent context menu and native event untouched', () => {
  const calls = [];
  assert.equal(dispatchHistoryFileActionContextMenu({ preventDefault: () => calls.push('prevent'),
    stopPropagation: () => calls.push('stop') }, { toolName: 'Bash', args: { command: 'echo hello' } }, cwd,
  { ...environment, send: () => calls.push('send') }), false);
  assert.deepEqual(calls, []);
});

test('unavailable native IPC leaves the old menu available instead of swallowing the click', () => {
  const events = [];
  assert.equal(dispatchHistoryFileActionContextMenu({ preventDefault: () => events.push('prevent'),
    stopPropagation: () => events.push('stop') }, { toolName: 'Read', args: { file_path: '/tmp/a.md' } }, cwd,
  { ...environment, send: () => { throw Error('unavailable IPC'); } }), false);
  assert.deepEqual(events, []);
});
