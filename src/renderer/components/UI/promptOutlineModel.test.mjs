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

test('prompt groups stay root-level and prompt depth is capped by host policy', () => {
  assert.equal(promptOutlineHorizontalPolicy({ sourceNode: { entityType: 'group' }, result: { ok: true } }).ok, false);
  assert.equal(promptOutlineHorizontalPolicy({ sourceNode: { entityType: 'prompt' }, result: { ok: true, depth: 5 } }).reason, 'max-depth');
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
