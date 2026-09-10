const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-saved-prompt-db-'));
const electronModulePath = require.resolve('electron');
const previousElectronModule = require.cache[electronModulePath];
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => tempRoot } },
};
const DatabaseManager = require('./database');
const { createSavedPromptService } = require('./saved-prompt-service');
if (previousElectronModule) require.cache[electronModulePath] = previousElectronModule;
else delete require.cache[electronModulePath];
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function openOrSkip(t) {
  try {
    return new DatabaseManager();
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run this test with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
}

test('point update changes one stable prompt without rewriting neighbours or prompt metadata', (t) => {
  const manager = openOrSkip(t);
  if (!manager) return;
  t.after(() => manager.close());
  manager.savePrompts([
    { id: 'prompt-11286', title: 'MINI документация', content: 'old', group_id: 4, position: 7, file_paths: ['/tmp/rules.md'] },
    { id: 'prompt-other', title: 'Other', content: 'keep', group_id: null, position: 8, file_paths: [] },
  ]);
  const otherRowBefore = manager.db.prepare('SELECT id, stable_id FROM prompts WHERE stable_id = ?').get('prompt-other');

  const updated = manager.updatePromptByStableId('prompt-11286', {
    title: 'mini docs \\ clear tmp',
    content: 'new text',
  });

  assert.equal(updated.title, 'mini docs \\ clear tmp');
  assert.equal(updated.content, 'new text');
  assert.equal(updated.group_id, 4);
  assert.equal(updated.position, 7);
  assert.deepEqual(updated.file_paths, ['/tmp/rules.md']);
  assert.deepEqual(manager.db.prepare('SELECT id, stable_id FROM prompts WHERE stable_id = ?').get('prompt-other'), otherRowBefore);
  assert.deepEqual(manager.getPromptByStableId('prompt-other').file_paths, []);
  assert.equal(manager.updatePromptByStableId('missing', { title: 'x', content: 'x' }), null);
});

test('prompt-library service commits create, subtree move, CAS, and Settings deletion semantics atomically', (t) => {
  const manager = openOrSkip(t);
  if (!manager) return;
  t.after(() => manager.close());
  manager.savePromptGroups([{ id: 4, name: 'Base', description: '', position: 0, is_collapsed: false }]);
  manager.savePrompts([
    { id: 'root', title: 'Root', content: 'root', group_id: 4, position: 1, file_paths: ['/root.md'], visual_parent_id: null },
    { id: 'child', title: 'Child', content: 'child', group_id: 4, position: 2, file_paths: [], visual_parent_id: 'root' },
    { id: 'other', title: 'Other', content: 'keep', group_id: null, position: 3, file_paths: [], visual_parent_id: null },
  ]);
  const service = createSavedPromptService({ projectManager: manager });
  const createdGroup = service.createGroup({ name: 'Target', position: 4 });
  const rootBefore = service.get('root');
  service.movePrompt({ stableId: 'root', revision: rootBefore.revision, groupId: createdGroup.id, position: 5 });
  assert.equal(service.get('root').group_id, createdGroup.id);
  assert.equal(service.get('child').group_id, createdGroup.id);

  const childBefore = service.get('child');
  const changed = service.update({ stableId: 'child', revision: childBefore.revision, title: 'Child / edited', filePaths: ['/child.md'] });
  assert.equal(changed.title, 'Child / edited');
  assert.deepEqual(changed.file_paths, ['/child.md']);
  assert.throws(
    () => service.update({ stableId: 'child', revision: childBefore.revision, text: 'lost update' }),
    (error) => error.code === 'saved_prompt_stale',
  );
  assert.equal(service.get('other').content, 'keep');

  const rootCurrent = service.get('root');
  service.deletePrompt({ stableId: 'root', revision: rootCurrent.revision });
  assert.equal(service.get('child').visual_parent_id, null);
  const targetCurrent = service.getGroup(createdGroup.id);
  service.deleteGroup({ groupId: createdGroup.id, revision: targetCurrent.revision });
  assert.equal(service.get('child').group_id, null);
  assert.equal(service.get('other').group_id, null);
});

test('SQLite prompt-library writes insertion order for prompts and groups without touching another group', (t) => {
  const manager = openOrSkip(t);
  if (!manager) return;
  t.after(() => manager.close());
  manager.savePromptGroups([
    { id: 1, name: 'A', description: '', position: 0, is_collapsed: false },
    { id: 2, name: 'B', description: '', position: 1, is_collapsed: false },
    { id: 3, name: 'C', description: '', position: 2, is_collapsed: false },
    { id: 9, name: 'Untouched', description: '', position: 9, is_collapsed: false },
  ]);
  manager.savePrompts([
    { id: 'a', title: 'A', content: 'a', group_id: null, position: 0 },
    { id: 'b', title: 'B', content: 'b', group_id: null, position: 1 },
    { id: 'c', title: 'C', content: 'c', group_id: null, position: 2 },
    { id: 'g9', title: 'G9', content: 'g9', group_id: 9, position: 0 },
  ]);
  const service = createSavedPromptService({ projectManager: manager });
  service.movePrompt({ stableId: 'c', revision: service.get('c').revision, position: 0 });
  assert.deepEqual(service.list().filter((prompt) => prompt.group_id == null).sort((x, y) => x.position - y.position).map((prompt) => prompt.id), ['c', 'a', 'b']);
  service.updateGroup({ groupId: 3, revision: service.getGroup(3).revision, position: 0 });
  assert.deepEqual(service.catalog().groups.sort((x, y) => x.position - y.position).map((group) => group.name), ['C', 'A', 'B', 'Untouched']);
  assert.equal(service.get('g9').position, 0);
});
