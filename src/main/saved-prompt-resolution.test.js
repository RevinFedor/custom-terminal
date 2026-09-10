const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveSavedPromptComposition, resolveSavedPromptInheritanceChain } = require('./saved-prompt-resolution');

test('resolved saved prompt inheritance is root-to-leaf and ignores invalid visual parent links', () => {
  const root = { id: 'root', group_id: 4, visual_parent_id: null };
  const child = { id: 'child', group_id: 4, visual_parent_id: 'root' };
  const leaf = { id: 'leaf', group_id: 4, visual_parent_id: 'child' };
  assert.deepEqual(resolveSavedPromptInheritanceChain(leaf, [root, child, leaf]).map((prompt) => prompt.id), ['root', 'child', 'leaf']);
  assert.deepEqual(resolveSavedPromptInheritanceChain({ ...leaf, group_id: null }, [root, child, leaf]).map((prompt) => prompt.id), ['leaf']);
  assert.deepEqual(resolveSavedPromptInheritanceChain({ id: 'cycle-a', group_id: null, visual_parent_id: 'cycle-b' }, [
    { id: 'cycle-a', group_id: null, visual_parent_id: 'cycle-b' },
    { id: 'cycle-b', group_id: null, visual_parent_id: 'cycle-a' },
  ]).map((prompt) => prompt.id), ['cycle-a']);
});

test('resolved composition includes each root-to-leaf instruction and linked file in order', async () => {
  const root = { id: 'root', group_id: 4, visual_parent_id: null, content: 'root text', file_paths: ['/root.md'] };
  const leaf = { id: 'leaf', group_id: 4, visual_parent_id: 'root', content: 'leaf text', file_paths: ['/leaf.md'] };
  const result = await resolveSavedPromptComposition(leaf, [root, leaf], async (prompt) => [
    prompt.content,
    ...(prompt.file_paths || []).map((path) => 'file:' + path),
  ]);
  assert.deepEqual(result.chain.map((prompt) => prompt.id), ['root', 'leaf']);
  assert.deepEqual(result.parts, ['root text', 'file:/root.md', 'leaf text', 'file:/leaf.md']);
});

test('resolved composition rejects a whitespace-only ancestor with no readable file parts', async () => {
  const root = { id: 'root', title: 'Empty root', group_id: 4, visual_parent_id: null, content: '   ', file_paths: ['/missing.md'] };
  const leaf = { id: 'leaf', title: 'Leaf', group_id: 4, visual_parent_id: 'root', content: 'leaf text', file_paths: [] };
  await assert.rejects(
    resolveSavedPromptComposition(leaf, [root, leaf], async (prompt) => prompt.id === 'root' ? ['', '   '] : [prompt.content]),
    (error) => error.code === 'saved_prompt_empty' && error.promptId === 'root',
  );
});

test('reparenting changes only the inherited resolved chain, not the leaf own payload', () => {
  const oldRoot = { id: 'old-root', group_id: 4, visual_parent_id: null, content: 'old root' };
  const newRoot = { id: 'new-root', group_id: 4, visual_parent_id: null, content: 'new root' };
  const leaf = { id: 'leaf', group_id: 4, visual_parent_id: 'old-root', content: 'leaf own' };
  assert.deepEqual(resolveSavedPromptInheritanceChain(leaf, [oldRoot, newRoot, leaf]).map((prompt) => prompt.content), ['old root', 'leaf own']);
  const reparented = { ...leaf, visual_parent_id: 'new-root' };
  assert.deepEqual(resolveSavedPromptInheritanceChain(reparented, [oldRoot, newRoot, reparented]).map((prompt) => prompt.content), ['new root', 'leaf own']);
  assert.equal(reparented.content, 'leaf own');
});

test('inheritance chain conforms to promptOutlineModel for valid, cross-group, and cyclic parents', async () => {
  const { buildPromptOutline } = await import('../renderer/components/UI/promptOutlineModel.mjs');
  const groups = [{ id: 4, name: 'Base', position: 0, is_collapsed: false }];
  const root = { id: 'root', title: 'Root', group_id: 4, visual_parent_id: null, position: 0 };
  const child = { id: 'child', title: 'Child', group_id: 4, visual_parent_id: 'root', position: 1 };
  const cross = { id: 'cross', title: 'Cross', group_id: null, visual_parent_id: 'root', position: 2 };
  const cycleA = { id: 'cycle-a', title: 'A', group_id: null, visual_parent_id: 'cycle-b', position: 3 };
  const cycleB = { id: 'cycle-b', title: 'B', group_id: null, visual_parent_id: 'cycle-a', position: 4 };
  const outline = buildPromptOutline([root, child, cross, cycleA, cycleB], groups);
  const groupRoot = outline.find((node) => node.entityType === 'group');
  assert.equal(groupRoot.children[0].promptId, 'root');
  assert.equal(groupRoot.children[0].children[0].promptId, 'child');
  assert.deepEqual(resolveSavedPromptInheritanceChain(child, [root, child, cross, cycleA, cycleB]).map((prompt) => prompt.id), ['root', 'child']);
  assert.deepEqual(resolveSavedPromptInheritanceChain(cross, [root, child, cross, cycleA, cycleB]).map((prompt) => prompt.id), ['cross']);
  assert.deepEqual(resolveSavedPromptInheritanceChain(cycleA, [root, child, cross, cycleA, cycleB]).map((prompt) => prompt.id), ['cycle-a']);
});
