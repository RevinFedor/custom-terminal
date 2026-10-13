import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return source.slice(from, to);
}

test('new tab promises resolve only after their durable project snapshot commits', () => {
  const createTab = between('createTab: async (projectId, name, cwd, options)', '\n\n  createTabAfterCurrent:');
  const createAfter = between('createTabAfterCurrent: async (projectId, name, cwd, options)', '\n\n  closeTab:');

  for (const implementation of [createTab, createAfter]) {
    const queueAt = implementation.indexOf('commitCreatedTabSnapshot({');
    const candidateAt = implementation.indexOf('buildCandidateTabs:');
    const persistAt = implementation.indexOf('persist:');
    const publishAt = implementation.indexOf('publish:');
    const rejectAt = implementation.indexOf('if (creationSnapshot?.success === false)');
    const rollbackAt = implementation.indexOf('rollbackUnmaterializedCreatedTab(projectId, tabId)');
    const killAt = implementation.indexOf("ipcRenderer.send('terminal:kill', tabId)");
    const errorAt = implementation.indexOf('error.code =');
    const returnAt = implementation.lastIndexOf('return tabId;');
    assert.ok(queueAt >= 0, 'same-project tab creation must use one commit lane');
    assert.ok(candidateAt > queueAt, 'the candidate Map must be built inside the commit lane');
    assert.ok(persistAt > candidateAt, 'the candidate Map must persist inside the commit helper');
    assert.ok(publishAt > persistAt, 'publication must be owned by the commit helper');
    assert.ok(rejectAt > publishAt, 'a negative persistence ACK must be handled after the helper');
    assert.ok(rollbackAt > rejectAt, 'a failed create must remove its exact unmaterialized DB row');
    assert.ok(killAt > rollbackAt, 'PTY cleanup must wait for exact DB rollback');
    assert.ok(errorAt > rejectAt, 'the caller must receive an explicit persistence failure');
    assert.match(implementation.slice(errorAt, returnAt), /tab_persistence_failed/);
    assert.ok(returnAt > errorAt, 'tabId must not escape after a negative persistence ACK');
  }
});

test('the creation lane is distinct from the full-snapshot IO queue', () => {
  assert.match(source, /import \{ commitCreatedTabSnapshot \} from '\.\.\/utils\/tabCreationCommit\.mjs'/);
  assert.match(source, /const projectTabCreationQueue = createProjectTabSaveQueue\(\)/);
  assert.match(source, /const projectTabSaveQueue = createProjectTabSaveQueue\(\)/);
});
