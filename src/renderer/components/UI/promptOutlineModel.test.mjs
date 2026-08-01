import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPromptOutline,
  buildPromptOutline,
  promptOutlineHorizontalPolicy,
  promptOutlineVerticalSlotPolicy,
} from './promptOutlineModel.mjs';

const prompt = (id, options = {}) => ({ id, title: id, content: '', position: 0, ...options });
const group = (id, options = {}) => ({ id, name: String(id), description: '', position: 0, is_collapsed: false, ...options });

test('prompt outline reconstructs prompt hierarchy inside and outside groups', () => {
  const outline = buildPromptOutline([
    prompt('root', { position: 0 }),
    prompt('child', { visual_parent_id: 'root', position: 1 }),
    prompt('inside', { group_id: 1, position: 0 }),
  ], [group(1, { position: 2 })]);
  assert.equal(outline[0].promptId, 'root');
  assert.equal(outline[0].children[0].promptId, 'child');
  assert.equal(outline[1].groupId, 1);
  assert.equal(outline[1].children[0].promptId, 'inside');
});

test('prompt commit carries a complete visual subtree into a group', () => {
  const state = {
    prompts: [prompt('root'), prompt('child', { visual_parent_id: 'root', position: 1 })],
    promptGroups: [group(1, { position: 2 })],
  };
  const outline = buildPromptOutline(state.prompts, state.promptGroups);
  const preview = [{ ...outline[1], children: [outline[0]] }];
  const next = applyPromptOutline(state, preview);
  assert.equal(next.ok, true);
  assert.equal(next.prompts[0].group_id, 1);
  assert.equal(next.prompts[1].group_id, 1);
  assert.equal(next.prompts[1].visual_parent_id, 'root');
});

test('cyclic ungrouped parents are repaired as visible roots instead of dropping prompts', () => {
  const state = {
    prompts: [
      prompt('a', { position: 0, visual_parent_id: 'b' }),
      prompt('b', { position: 1, visual_parent_id: 'a' }),
    ],
    promptGroups: [],
  };
  const outline = buildPromptOutline(state.prompts, state.promptGroups);

  assert.deepEqual(outline.map(node => node.promptId), ['a', 'b']);
  const next = applyPromptOutline(state, outline);
  assert.equal(next.ok, true);
  assert.deepEqual(next.prompts.map(item => item.visual_parent_id), [null, null]);
});

test('empty prompt group keeps its interleaved position through outline commit', () => {
  const state = {
    prompts: [
      prompt('before', { position: 0 }),
      prompt('after', { position: 2 }),
    ],
    promptGroups: [group(1, { position: 1 })],
  };
  const outline = buildPromptOutline(state.prompts, state.promptGroups);

  assert.deepEqual(outline.map(node => node.entityType === 'group' ? `group:${node.groupId}` : `prompt:${node.promptId}`), [
    'prompt:before',
    'group:1',
    'prompt:after',
  ]);
  const next = applyPromptOutline(state, outline);
  assert.equal(next.ok, true);
  assert.equal(next.promptGroups[0].position, 1);
  assert.deepEqual(next.prompts.map(item => item.position), [0, 2]);
});

test('root prompt group moves past another group without flattening either subtree', () => {
  const state = {
    prompts: [
      prompt('a-root', { group_id: 1, position: 1 }),
      prompt('a-child', { group_id: 1, visual_parent_id: 'a-root', position: 2 }),
      prompt('b-root', { group_id: 2, position: 4 }),
      prompt('b-child', { group_id: 2, visual_parent_id: 'b-root', position: 5 }),
    ],
    promptGroups: [group(1, { position: 0 }), group(2, { position: 3 })],
  };
  const outline = buildPromptOutline(state.prompts, state.promptGroups);
  const next = applyPromptOutline(state, [outline[1], outline[0]]);

  assert.equal(next.ok, true);
  assert.deepEqual(next.promptGroups.map(item => [item.id, item.position]), [[1, 3], [2, 0]]);
  assert.deepEqual(next.prompts.map(item => [item.id, item.group_id, item.visual_parent_id, item.position]), [
    ['a-root', 1, null, 4],
    ['a-child', 1, 'a-root', 5],
    ['b-root', 2, null, 1],
    ['b-child', 2, 'b-root', 2],
  ]);
});

test('moving a prompt subtree out of a group clears every descendant assignment', () => {
  const state = {
    prompts: [
      prompt('parent', { group_id: 1, position: 1 }),
      prompt('child', { group_id: 1, visual_parent_id: 'parent', position: 2 }),
      prompt('remaining', { group_id: 1, position: 3 }),
    ],
    promptGroups: [group(1, { position: 0 })],
  };
  const outline = buildPromptOutline(state.prompts, state.promptGroups);
  const groupNode = outline[0];
  const source = groupNode.children[0];
  const next = applyPromptOutline(state, [source, { ...groupNode, children: groupNode.children.slice(1) }]);

  assert.equal(next.ok, true);
  assert.deepEqual(next.prompts.map(item => [item.id, item.group_id, item.visual_parent_id]), [
    ['parent', null, null],
    ['child', null, 'parent'],
    ['remaining', 1, null],
  ]);
});

test('prompt groups stay root-level and prompt depth is capped by host policy', () => {
  assert.equal(promptOutlineHorizontalPolicy({ sourceNode: { entityType: 'group' }, result: { ok: true } }).ok, false);
  const sourceNode = { id: 'prompt:source', entityType: 'prompt' };
  assert.equal(promptOutlineHorizontalPolicy({
    sourceNode,
    result: {
      ok: true,
      depth: 5,
      tree: [{
        id: 'prompt:p1', entityType: 'prompt', children: [{
          id: 'prompt:p2', entityType: 'prompt', children: [{
            id: 'prompt:p3', entityType: 'prompt', children: [{
              id: 'prompt:p4', entityType: 'prompt', children: [sourceNode],
            }],
          }],
        }],
      }],
    },
  }).reason, 'max-depth');
});

test('vertical slots keep groups at root and cap prompt visual depth', () => {
  const groupNode = { id: 'prompt-group:1', entityType: 'group', children: [] };
  const promptNode = { id: 'prompt:root', entityType: 'prompt', children: [] };
  const groupedOutline = [{ ...groupNode, children: [{ ...promptNode }] }];
  assert.equal(promptOutlineVerticalSlotPolicy({
    sourceNode: groupNode,
    slot: { parentId: 'prompt:root', depth: 2 },
    baseOutline: groupedOutline,
  }).reason, 'group-must-stay-root');
  assert.equal(promptOutlineVerticalSlotPolicy({
    sourceNode: promptNode,
    slot: { parentId: 'prompt:root', depth: 5 },
    baseOutline: [promptNode],
  }).reason, 'max-depth');
  assert.equal(promptOutlineVerticalSlotPolicy({
    sourceNode: promptNode,
    slot: { parentId: 'prompt:root', depth: 5 },
    baseOutline: groupedOutline,
  }).ok, true);
});

test('horizontal depth cap excludes a containing group', () => {
  const sourceNode = { id: 'prompt:deep', entityType: 'prompt' };
  const tree = [{
    id: 'prompt-group:1',
    entityType: 'group',
    children: [{
      id: 'prompt:p1',
      entityType: 'prompt',
      children: [{
        id: 'prompt:p2',
        entityType: 'prompt',
        children: [{
          id: 'prompt:p3',
          entityType: 'prompt',
          children: [{
            id: 'prompt:p4',
            entityType: 'prompt',
            children: [{ id: 'prompt:deep', entityType: 'prompt', children: [] }],
          }],
        }],
      }],
    }],
  }];
  assert.equal(promptOutlineHorizontalPolicy({
    sourceNode,
    result: { ok: true, depth: 5, tree },
  }).ok, true);
});
