const assert = require('node:assert/strict');
const test = require('node:test');
const { createSavedPromptService } = require('./saved-prompt-service');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function createManager(initial = null) {
  let state = initial || {
    groups: [{ id: 4, name: 'base', description: 'seed', position: 0, is_collapsed: false }],
    prompts: [
      { id: 'root', title: 'Root', content: 'root text', group_id: 4, position: 1, file_paths: ['/root.md'], visual_parent_id: null },
      { id: 'child', title: 'Child', content: 'child text', group_id: 4, position: 2, file_paths: [], visual_parent_id: 'root' },
      { id: 'other', title: 'Other', content: 'keep', group_id: null, position: 3, file_paths: [], visual_parent_id: null },
    ],
  };
  const read = () => clone(state);
  return {
    getPromptLibrary: read,
    getPrompts: () => read().prompts,
    getPromptByStableId: (id) => read().prompts.find((prompt) => prompt.id === id) || null,
    mutatePromptLibrary(mutator) {
      const draft = read();
      const result = mutator(draft) || {};
      const groupIdMap = {};
      let nextGroupId = Math.max(0, ...draft.groups.filter((group) => Number.isInteger(group.id)).map((group) => group.id)) + 1;
      for (const group of draft.groups) {
        if (typeof group.id !== 'string' || !group.id.startsWith('new-group:')) continue;
        groupIdMap[group.id] = nextGroupId;
        const oldId = group.id;
        group.id = nextGroupId++;
        for (const prompt of draft.prompts) if (prompt.group_id === oldId) prompt.group_id = group.id;
      }
      state = draft;
      return { ...result, groupIdMap, library: read() };
    },
  };
}

test('saved prompt lifecycle creates, reparents, moves a subtree, renames, changes files, and rejects stale writes', async () => {
  const manager = createManager();
  const updates = [];
  const service = createSavedPromptService({ projectManager: manager, onUpdated: (prompt) => updates.push(prompt.id) });
  const catalog = service.catalog();
  assert.equal('content' in catalog.prompts[0], false, 'catalog never exposes prompt bodies');
  let ownResolverCalled = false;
  const ownRows = await service.readMany({ promptIds: ['child', 'root'], mode: 'own', resolveText: async () => { ownResolverCalled = true; return 'must not run'; } });
  assert.deepEqual(ownRows.map((prompt) => prompt.id), ['child', 'root']);
  assert.equal(ownResolverCalled, false, 'own reads never resolve linked file bodies');
  assert.equal((await service.readMany({ promptIds: ['root'], mode: 'resolved', resolveText: async (prompt) => prompt.content + ' resolved' }))[0].resolvedText, 'root text resolved');
  await assert.rejects(service.readMany({ promptIds: ['root'], mode: 'all' }), (error) => error.code === 'saved_prompt_read_mode_invalid');

  const extraGroup = service.createGroup({ name: 'Extra', description: 'new', position: 4 });
  const extraBefore = service.getGroup(extraGroup.id);
  const renamedGroup = service.updateGroup({ groupId: extraGroup.id, revision: extraBefore.revision, name: 'Extra renamed' });
  assert.equal(renamedGroup.name, 'Extra renamed');
  assert.throws(
    () => service.updateGroup({ groupId: extraGroup.id, revision: extraBefore.revision, description: 'lost' }),
    (error) => error.code === 'prompt_group_stale' && error.statusCode === 409,
  );
  const rootBefore = service.get('root');
  const moved = service.movePrompt({ stableId: 'root', revision: rootBefore.revision, groupId: extraGroup.id, position: 9 });
  assert.equal(moved.group_id, extraGroup.id);
  assert.equal(service.get('child').group_id, extraGroup.id, 'moving a parent also moves its subtree');

  const created = service.createPrompt({ stableId: 'new-child', title: 'New child', text: 'new', parentPromptId: 'root', filePaths: ['/a.md'], position: 10 });
  assert.equal(created.group_id, extraGroup.id, 'new child inherits its parent group');
  const beforeUpdate = service.get('new-child');
  const updated = service.update({ stableId: 'new-child', revision: beforeUpdate.revision, title: 'new / title', text: 'edited', filePaths: ['/b.md'], position: 11 });
  assert.equal(updated.title, 'new / title');
  assert.deepEqual(updated.file_paths, ['/b.md']);
  assert.throws(
    () => service.update({ stableId: 'new-child', revision: beforeUpdate.revision, title: 'lost' }),
    (error) => error.code === 'saved_prompt_stale' && error.statusCode === 409,
  );
  assert.equal(service.get('other').content, 'keep', 'unrelated record is untouched');
  assert.ok(updates.includes('root') && updates.includes('child') && updates.includes('new-child'));
});

test('saved prompt relations reject missing parents, cross-group parents, and cycles', () => {
  const service = createSavedPromptService({ projectManager: createManager() });
  assert.throws(
    () => service.createPrompt({ stableId: 'bad-parent', title: 'Bad', parentPromptId: 'missing', position: 4 }),
    (error) => error.code === 'saved_prompt_not_found',
  );
  const other = service.get('other');
  assert.throws(
    () => service.movePrompt({ stableId: 'other', revision: other.revision, groupId: null, parentPromptId: 'root' }),
    (error) => error.code === 'saved_prompt_cross_group_parent',
  );
  const root = service.get('root');
  assert.throws(
    () => service.movePrompt({ stableId: 'root', revision: root.revision, parentPromptId: 'child' }),
    (error) => error.code === 'saved_prompt_cycle',
  );
  const depthService = createSavedPromptService({ projectManager: createManager({
    groups: [],
    prompts: Array.from({ length: 5 }, (_, index) => ({
      id: 'depth-' + index, title: 'Depth ' + index, content: 'x', group_id: null,
      position: index, file_paths: [], visual_parent_id: index === 0 ? null : 'depth-' + (index - 1),
    })),
  }) });
  assert.throws(
    () => depthService.createPrompt({ stableId: 'depth-5', title: 'Too deep', parentPromptId: 'depth-4', position: 0 }),
    (error) => error.code === 'saved_prompt_max_depth',
  );
});

test('moving or creating at a position inserts into the sibling order without detaching a child', () => {
  const manager = createManager({
    groups: [],
    prompts: [
      { id: 'a', title: 'A', content: 'a', group_id: null, position: 0, file_paths: [], visual_parent_id: null },
      { id: 'b', title: 'B', content: 'b', group_id: null, position: 1, file_paths: [], visual_parent_id: null },
      { id: 'c', title: 'C', content: 'c', group_id: null, position: 2, file_paths: [], visual_parent_id: null },
      { id: 'parent', title: 'Parent', content: 'p', group_id: null, position: 3, file_paths: [], visual_parent_id: null },
      { id: 'child', title: 'Child', content: 'child', group_id: null, position: 4, file_paths: [], visual_parent_id: 'parent' },
    ],
  });
  const service = createSavedPromptService({ projectManager: manager });
  const c = service.get('c');
  service.movePrompt({ stableId: 'c', revision: c.revision, position: 0 });
  assert.deepEqual(service.list().sort((left, right) => left.position - right.position).map((prompt) => prompt.id), ['c', 'a', 'b', 'parent', 'child']);
  const child = service.get('child');
  service.movePrompt({ stableId: 'child', revision: child.revision, position: 0 });
  assert.equal(service.get('child').visual_parent_id, 'parent', 'omitting parentPromptId preserves inheritance');
  service.createPrompt({ stableId: 'first', title: 'First', text: 'first', position: 0 });
  assert.deepEqual(service.list().filter((prompt) => prompt.visual_parent_id === null).sort((left, right) => left.position - right.position).map((prompt) => prompt.id), ['first', 'c', 'a', 'b', 'parent']);
});

test('group positions are insertion indexes and normalize neighbouring groups', () => {
  const service = createSavedPromptService({ projectManager: createManager({
    groups: [
      { id: 1, name: 'A', description: '', position: 0, is_collapsed: false },
      { id: 2, name: 'B', description: '', position: 1, is_collapsed: false },
      { id: 3, name: 'C', description: '', position: 2, is_collapsed: false },
    ], prompts: [],
  }) });
  const c = service.getGroup(3);
  service.updateGroup({ groupId: 3, revision: c.revision, position: 0 });
  assert.deepEqual(service.catalog().groups.sort((left, right) => left.position - right.position).map((group) => group.name), ['C', 'A', 'B']);
  service.createGroup({ name: 'D', position: 1 });
  assert.deepEqual(service.catalog().groups.sort((left, right) => left.position - right.position).map((group) => group.name), ['C', 'D', 'A', 'B']);
});

test('deleting a prompt detaches direct children and deleting a group preserves its now-ungrouped subtree', () => {
  const service = createSavedPromptService({ projectManager: createManager() });
  const root = service.get('root');
  assert.deepEqual(service.deletePrompt({ stableId: 'root', revision: root.revision }), { deleted: true, promptId: 'root', remaining: 2 });
  const child = service.get('child');
  assert.equal(child.visual_parent_id, null);
  const grouped = createSavedPromptService({ projectManager: createManager() });
  const group = grouped.getGroup(4);
  grouped.deleteGroup({ groupId: 4, revision: group.revision });
  assert.equal(grouped.get('root').group_id, null);
  assert.equal(grouped.get('child').group_id, null);
  assert.equal(grouped.get('child').visual_parent_id, 'root');
  assert.equal(grouped.get('other').group_id, null);
});
