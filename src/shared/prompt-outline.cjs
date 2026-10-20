const GROUP_PREFIX = 'prompt-group:';
const PROMPT_PREFIX = 'prompt:';

const promptOutlineGroupId = id => `${GROUP_PREFIX}${id}`;
const promptOutlinePromptId = id => `${PROMPT_PREFIX}${id}`;

const childrenOf = node => Array.isArray(node?.children) ? node.children : [];

function buildPromptForest(prompts) {
  const byId = new Map(prompts.map(prompt => [prompt.id, prompt]));
  const validParent = new Map();
  for (const prompt of prompts) {
    const requested = prompt.visual_parent_id;
    const parent = requested ? byId.get(requested) : null;
    if (!parent || parent === prompt || String(parent.group_id ?? '') !== String(prompt.group_id ?? '')) {
      validParent.set(prompt.id, null);
      continue;
    }
    const seen = new Set([prompt.id]);
    let cursor = parent;
    let valid = true;
    while (cursor) {
      if (seen.has(cursor.id)) {
        valid = false;
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.visual_parent_id ? byId.get(cursor.visual_parent_id) : null;
    }
    validParent.set(prompt.id, valid ? parent.id : null);
  }

  const childrenByParent = new Map();
  const roots = [];
  for (const prompt of prompts) {
    const parentId = validParent.get(prompt.id);
    if (!parentId) roots.push(prompt.id);
    else {
      const children = childrenByParent.get(parentId) || [];
      children.push(prompt.id);
      childrenByParent.set(parentId, children);
    }
  }
  const makeNode = id => {
    const prompt = byId.get(id);
    return {
      id: promptOutlinePromptId(id),
      kind: 'prompt',
      collapsible: false,
      expanded: true,
      label: prompt?.title || '',
      entityType: 'prompt',
      promptId: id,
      rawPrompt: prompt,
      children: (childrenByParent.get(id) || []).map(makeNode),
    };
  };
  return roots.map(makeNode);
}

const byPosition = (a, b) => Number(a.position || 0) - Number(b.position || 0);

function buildPromptOutline(prompts = [], groups = []) {
  const sortedGroups = [...groups].sort(byPosition);
  const groupIds = new Set(sortedGroups.map(group => group.id));
  const normalizedPrompts = prompts.map(prompt => ({
    ...prompt,
    group_id: groupIds.has(prompt.group_id) ? prompt.group_id : null,
  }));
  const grouped = new Map();
  for (const group of sortedGroups) grouped.set(group.id, []);
  const ungrouped = [];
  for (const prompt of normalizedPrompts) {
    if (prompt.group_id == null) ungrouped.push(prompt);
    else grouped.get(prompt.group_id)?.push(prompt);
  }
  for (const list of grouped.values()) list.sort(byPosition);
  ungrouped.sort(byPosition);

  const ungroupedForest = buildPromptForest(ungrouped);
  const ungroupedRoots = new Map(ungroupedForest.map(node => [node.promptId, node]));

  const entities = [
    ...sortedGroups.map(group => ({ type: 'group', position: Number(group.position || 0), group })),
    ...ungroupedForest.map(node => ({
      type: 'prompt',
      position: Number(node.rawPrompt?.position || 0),
      prompt: node.rawPrompt,
    })),
  ].sort((a, b) => a.position - b.position);

  return entities.map(entity => {
    if (entity.type === 'prompt') return ungroupedRoots.get(entity.prompt.id);
    const members = grouped.get(entity.group.id) || [];
    return {
      id: promptOutlineGroupId(entity.group.id),
      kind: 'group',
      collapsible: true,
      expanded: !entity.group.is_collapsed,
      hasChildren: members.length > 0,
      label: entity.group.name || '',
      entityType: 'group',
      groupId: entity.group.id,
      rawGroup: entity.group,
      children: buildPromptForest(members),
    };
  }).filter(Boolean);
}

function applyPromptOutline(state, outline = []) {
  const promptsById = new Map(state.prompts.map(prompt => [prompt.id, { ...prompt }]));
  const groupsById = new Map(state.promptGroups.map(group => [group.id, { ...group }]));
  const seenPrompts = new Set();
  const seenGroups = new Set();
  let orderCursor = 0;

  const visitPrompt = (node, groupId, parentPromptId) => {
    if (!node || node.entityType !== 'prompt' || !promptsById.has(node.promptId)) {
      return { ok: false, reason: 'group-must-stay-root' };
    }
    if (seenPrompts.has(node.promptId)) return { ok: false, reason: 'duplicate-prompt' };
    seenPrompts.add(node.promptId);
    const prompt = promptsById.get(node.promptId);
    prompt.group_id = groupId;
    prompt.visual_parent_id = parentPromptId;
    prompt.position = orderCursor++;
    for (const child of childrenOf(node)) {
      const nested = visitPrompt(child, groupId, node.promptId);
      if (!nested.ok) return nested;
    }
    return { ok: true };
  };

  for (const root of outline) {
    if (root?.entityType === 'group') {
      if (!groupsById.has(root.groupId) || seenGroups.has(root.groupId)) {
        return { ok: false, reason: 'duplicate-group' };
      }
      seenGroups.add(root.groupId);
      groupsById.get(root.groupId).position = orderCursor++;
      for (const child of childrenOf(root)) {
        const nested = visitPrompt(child, root.groupId, null);
        if (!nested.ok) return nested;
      }
      continue;
    }
    const nested = visitPrompt(root, null, null);
    if (!nested.ok) return nested;
  }

  if (seenPrompts.size !== promptsById.size || seenGroups.size !== groupsById.size) {
    return { ok: false, reason: 'missing-entity' };
  }
  return {
    ok: true,
    prompts: state.prompts.map(prompt => promptsById.get(prompt.id)),
    promptGroups: state.promptGroups.map(group => groupsById.get(group.id)),
  };
}

function promptOutlineHorizontalPolicy({ sourceNode, result }) {
  if (sourceNode?.entityType === 'group') return { ok: false, reason: 'group-depth-locked' };
  if (result?.ok && promptVisualDepth({ sourceNode, result, outline: result.tree }) > 4) {
    return { ok: false, reason: 'max-depth' };
  }
  return { ok: true };
}

function outlineParentInfo(nodes, targetId, ancestors = []) {
  for (const node of nodes) {
    if (node.id === targetId) return { node, ancestors };
    const nested = outlineParentInfo(childrenOf(node), targetId, [...ancestors, node]);
    if (nested) return nested;
  }
  return null;
}

function promptVisualDepth({ sourceNode, result, outline }) {
  if (sourceNode?.entityType === 'group') return 0;
  if (!Array.isArray(outline)) return Number(result?.depth || 0);
  const location = outlineParentInfo(outline, sourceNode?.id);
  const containingGroup = location?.ancestors.find(node => node.entityType === 'group');
  return Math.max(0, Number(result?.depth || 0) - (containingGroup ? 1 : 0));
}

function promptOutlineVerticalSlotPolicy({ sourceNode, slot, baseOutline }) {
  if (sourceNode?.entityType === 'group') {
    return slot?.parentId == null ? { ok: true } : { ok: false, reason: 'group-must-stay-root' };
  }
  if (!slot || !Array.isArray(baseOutline)) return { ok: false, reason: 'invalid-slot' };
  const parent = slot.parentId == null ? null : outlineParentInfo(baseOutline, slot.parentId);
  const containingGroup = parent?.ancestors?.find(node => node.entityType === 'group')
    || (parent?.node?.entityType === 'group' ? parent.node : null);
  const visualDepth = Math.max(0, Number(slot.depth || 0) - (containingGroup ? 1 : 0));
  return visualDepth <= 4
    ? { ok: true }
    : { ok: false, reason: 'max-depth' };
}

// Select from the SAME validated outline used for rendering, including legacy
// orphans/cycles. This is a path lookup, not another relation validator.
function promptOutlineSelection(outline, promptId) {
  const location = outlineParentInfo(outline, promptOutlinePromptId(promptId));
  return location ? [...location.ancestors, location.node].filter(node => node.entityType === 'prompt') : [];
}

module.exports = { promptOutlineGroupId, promptOutlinePromptId, buildPromptOutline, applyPromptOutline, promptOutlineHorizontalPolicy, promptOutlineVerticalSlotPolicy, promptOutlineSelection, promptOutlineLocation: outlineParentInfo };
