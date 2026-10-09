const crypto = require('crypto');
const { buildPromptOutline } = require('../shared/prompt-outline.cjs');
const { resolveSavedPromptComposition } = require('./saved-prompt-resolution');

const PROMPT_LIBRARY_READ_CAPABILITY = Object.freeze({
  version: 1, readOnly: true,
  catalogEndpoint: '/api/prompt-library', outlineProjection: 'outline-v1',
  readEndpoint: '/api/prompt-library/read', resolvedProjection: 'steps-v1',
  resolvedMode: 'resolved', selectedPromptLimit: 1,
  coherentLibrarySnapshot: true, expectedLibraryRevision: true,
  fileSnapshot: 'read-time', sourceKey: 'prompt:<id>',
});

function fail(message, statusCode, code, extra = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...extra });
}

function revisionFor(prompt) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: String(prompt.id || ''), title: String(prompt.title || ''), content: String(prompt.content || ''),
    position: prompt.position ?? null, group_id: prompt.group_id ?? null,
    file_paths: Array.isArray(prompt.file_paths) ? prompt.file_paths : [],
    visual_parent_id: prompt.visual_parent_id ?? null,
  })).digest('hex').slice(0, 24);
}

function groupRevisionFor(group) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: String(group.id), name: String(group.name || ''), position: group.position ?? null,
    description: String(group.description || ''), is_collapsed: !!group.is_collapsed,
  })).digest('hex').slice(0, 24);
}

function publicPrompt(prompt) { return prompt ? { ...prompt, revision: revisionFor(prompt) } : null; }
function publicGroup(group) { return group ? { ...group, revision: groupRevisionFor(group) } : null; }
const asId = (value) => String(value ?? '').trim();
const asGroupId = (value) => value == null || value === '' ? null : Number(value);
const cleanPaths = (value) => {
  if (!Array.isArray(value) || value.some((path) => typeof path !== 'string')) {
    throw fail('filePaths must be an array of strings', 400, 'saved_prompt_file_paths_invalid');
  }
  return [...value];
};

function compactCatalog(state) {
  return {
    groups: state.groups.map(publicGroup),
    prompts: state.prompts.map(prompt => ({
      id: prompt.id, title: prompt.title, group_id: prompt.group_id ?? null,
      visual_parent_id: prompt.visual_parent_id ?? null, position: prompt.position ?? null,
      fileCount: Array.isArray(prompt.file_paths) ? prompt.file_paths.length : 0,
      ownTextLength: String(prompt.content || '').length, revision: revisionFor(prompt),
    })),
  };
}

function readEvidence(state, requestId) {
  if (requestId != null && (typeof requestId !== 'string' || !requestId || requestId.length > 200)) {
    throw fail('requestId must be a non-empty string of at most 200 characters', 400, 'saved_prompt_read_id_invalid');
  }
  // Array order is significant for the canonical stable tie order. Revisions
  // cover the definitions/paths, NOT a claim that attached file bytes are frozen.
  const libraryRevision = crypto.createHash('sha256').update(JSON.stringify({
    prompts: state.prompts.map(prompt => [prompt.id, revisionFor(prompt)]),
    groups: state.groups.map(group => [group.id, groupRevisionFor(group)]),
  })).digest('hex');
  return { version: 1, readId: crypto.randomUUID(), requestId: requestId ?? null, libraryRevision };
}

function presentOutline(nodes, revisions, promptDepth = 0, parentPrompt = null) {
  return nodes.map(node => {
    const isPrompt = node.entityType === 'prompt';
    return {
      id: node.id, kind: node.kind, label: node.label,
      collapsible: node.collapsible, expanded: node.expanded,
      hasChildren: node.children.length > 0,
      ...(isPrompt ? {
        promptId: node.promptId, sourceKey: `prompt:${node.promptId}`,
        revision: revisions.get(node.promptId),
        groupId: node.rawPrompt.group_id ?? null,
        inheritanceDepth: promptDepth,
        inheritanceParentPromptId: parentPrompt?.promptId ?? null,
        inheritanceParentLabel: parentPrompt?.label ?? null,
      } : { groupId: node.groupId, revision: groupRevisionFor(node.rawGroup) }),
      children: presentOutline(node.children, revisions, isPrompt ? promptDepth + 1 : 0, isPrompt ? node : null),
    };
  });
}

function validateLibrary(state) {
  const groups = new Set(state.groups.map((group) => String(group.id)));
  for (const group of state.groups) {
    if (typeof group.name !== 'string' || !group.name.trim()) {
      throw fail('group name must be a non-empty string', 400, 'prompt_group_name_invalid');
    }
    if (!Number.isInteger(group.position) || group.position < 0) {
      throw fail('group position must be a non-negative integer', 400, 'prompt_group_position_invalid');
    }
  }
  const prompts = new Map();
  for (const prompt of state.prompts) {
    const id = asId(prompt.id);
    if (!id || prompts.has(id)) throw fail('prompt stable ids must be unique', 409, 'saved_prompt_id_conflict');
    if (typeof prompt.title !== 'string' || !prompt.title.trim()) throw fail('title must be a non-empty string', 400, 'saved_prompt_title_invalid');
    if (typeof prompt.content !== 'string') throw fail('text must be a string', 400, 'saved_prompt_text_invalid');
    if (!Number.isInteger(prompt.position) || prompt.position < 0) {
      throw fail('position must be a non-negative integer', 400, 'saved_prompt_position_invalid');
    }
    cleanPaths(prompt.file_paths || []);
    if (prompt.group_id != null && !groups.has(String(prompt.group_id))) {
      throw fail('prompt group not found', 409, 'saved_prompt_group_not_found');
    }
    prompts.set(id, prompt);
  }
  for (const prompt of state.prompts) {
    const parentId = prompt.visual_parent_id == null ? '' : asId(prompt.visual_parent_id);
    if (!parentId) continue;
    const parent = prompts.get(parentId);
    if (!parent) throw fail('prompt parent not found', 409, 'saved_prompt_parent_not_found');
    if (parent === prompt) throw fail('prompt cannot parent itself', 409, 'saved_prompt_cycle');
    if ((parent.group_id ?? null) !== (prompt.group_id ?? null)) {
      throw fail('prompt parent must be in the same group', 409, 'saved_prompt_cross_group_parent');
    }
    const seen = new Set([asId(prompt.id)]);
    let cursor = parent;
    let depth = 1;
    while (cursor) {
      const cursorId = asId(cursor.id);
      if (seen.has(cursorId)) throw fail('prompt parent relation has a cycle', 409, 'saved_prompt_cycle');
      seen.add(cursorId);
      cursor = cursor.visual_parent_id == null ? null : prompts.get(asId(cursor.visual_parent_id));
      depth += 1;
      if (depth > 5) throw fail('prompt nesting is limited to four levels', 409, 'saved_prompt_max_depth');
    }
  }
}

function createSavedPromptService({ projectManager, onUpdated, onChanged } = {}) {
  if (!projectManager) throw new Error('saved prompt service requires projectManager');
  const library = () => projectManager.getPromptLibrary();
  const readSnapshot = () => structuredClone(library());
  const findPrompt = (state, stableId) => {
    const id = asId(stableId);
    const prompt = state.prompts.find((item) => asId(item.id) === id);
    if (!prompt) throw fail('saved prompt not found: ' + id, 404, 'saved_prompt_not_found');
    return prompt;
  };
  const findGroup = (state, groupId) => {
    const id = asGroupId(groupId);
    const group = state.groups.find((item) => Number(item.id) === id);
    if (!group) throw fail('prompt group not found: ' + String(groupId), 404, 'saved_prompt_group_not_found');
    return group;
  };
  const assertPromptRevision = (prompt, revision) => {
    const current = publicPrompt(prompt);
    if (typeof revision !== 'string' || !revision) throw fail('revision required', 400, 'saved_prompt_revision_required');
    if (revision !== current.revision) throw fail('saved prompt was changed by another client', 409, 'saved_prompt_stale', { revision: current.revision, prompt: current });
  };
  const assertGroupRevision = (group, revision) => {
    const current = publicGroup(group);
    if (typeof revision !== 'string' || !revision) throw fail('revision required', 400, 'prompt_group_revision_required');
    if (revision !== current.revision) throw fail('prompt group was changed by another client', 409, 'prompt_group_stale', { revision: current.revision, group: current });
  };
  const emit = (result) => {
    const ids = [...new Set(result.changedPromptIds || [])];
    for (const id of ids) {
      const prompt = result.library.prompts.find((item) => asId(item.id) === id);
      if (prompt) onUpdated?.(publicPrompt(prompt));
    }
    onChanged?.({
      promptIds: ids,
      groupIds: result.changedGroupIds || [],
      removedPromptIds: result.removedPromptIds || [],
      removedGroupIds: result.removedGroupIds || [],
      library: result.library,
    });
  };
  const mutate = (change) => {
    const result = projectManager.mutatePromptLibrary((state) => {
      const detail = change(state) || {};
      validateLibrary(state);
      return detail;
    });
    emit(result);
    return result;
  };
  const read = (stableId) => publicPrompt(findPrompt(library(), stableId));
  const collectSubtreeIds = (state, rootId) => {
    const descendants = new Set([asId(rootId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const prompt of state.prompts) {
        if (prompt.visual_parent_id != null && descendants.has(asId(prompt.visual_parent_id)) && !descendants.has(asId(prompt.id))) {
          descendants.add(asId(prompt.id));
          changed = true;
        }
      }
    }
    return descendants;
  };
  const normalizeScopePositions = (state, groupId) => {
    const scope = state.prompts.filter((prompt) => (prompt.group_id ?? null) === (groupId ?? null));
    const byId = new Map(scope.map((prompt) => [asId(prompt.id), prompt]));
    const childrenOf = (parentId) => scope
      .filter((prompt) => (prompt.visual_parent_id ?? null) === parentId)
      .sort((left, right) => left.position - right.position || asId(left.id).localeCompare(asId(right.id)));
    const ordered = [];
    const visit = (prompt) => {
      ordered.push(prompt);
      for (const child of childrenOf(asId(prompt.id))) visit(child);
    };
    for (const root of childrenOf(null)) visit(root);
    // The caller validates the whole graph after mutation. Keep any temporary
    // invalid orphan visible here so it receives a deterministic position too.
    for (const prompt of scope) if (!ordered.includes(prompt) && !byId.has(asId(prompt.visual_parent_id))) ordered.push(prompt);
    ordered.forEach((prompt, index) => { prompt.position = index; });
    return ordered.map((prompt) => asId(prompt.id));
  };
  const insertAtSiblingPosition = (state, root, position) => {
    if (!Number.isInteger(position) || position < 0) throw fail('position must be a non-negative integer', 400, 'saved_prompt_position_invalid');
    const parentId = root.visual_parent_id ?? null;
    const siblings = state.prompts
      .filter((prompt) => (prompt.group_id ?? null) === (root.group_id ?? null)
        && (prompt.visual_parent_id ?? null) === parentId && prompt !== root)
      .sort((left, right) => left.position - right.position || asId(left.id).localeCompare(asId(right.id)));
    const target = Math.min(position, siblings.length);
    siblings.splice(target, 0, root);
    siblings.forEach((prompt, index) => { prompt.position = index; });
  };
  const insertGroupAtPosition = (state, group, position) => {
    if (!Number.isInteger(position) || position < 0) throw fail('group position must be a non-negative integer', 400, 'prompt_group_position_invalid');
    const groups = state.groups
      .filter((item) => item !== group)
      .sort((left, right) => left.position - right.position || Number(left.id) - Number(right.id));
    groups.splice(Math.min(position, groups.length), 0, group);
    groups.forEach((item, index) => { item.position = index; });
    return groups.map((item) => item.id);
  };
  const moveInState = (state, { stableId, revision, groupId, parentPromptId, position }) => {
    const root = findPrompt(state, stableId);
    assertPromptRevision(root, revision);
    const oldGroupId = root.group_id ?? null;
    const parentWasSpecified = parentPromptId !== undefined;
    const groupWasSpecified = groupId !== undefined;
    const currentParent = root.visual_parent_id == null ? null : findPrompt(state, root.visual_parent_id);
    const parent = !parentWasSpecified
      ? (groupWasSpecified && asGroupId(groupId) !== oldGroupId ? null : currentParent)
      : (parentPromptId === null || parentPromptId === '' ? null : findPrompt(state, parentPromptId));
    const targetGroupId = parent ? (parent.group_id ?? null) : (groupWasSpecified ? asGroupId(groupId) : oldGroupId);
    if (targetGroupId != null) findGroup(state, targetGroupId);
    if (parent && groupId !== undefined && targetGroupId !== asGroupId(groupId)) {
      throw fail('parent and target group identify different locations', 409, 'saved_prompt_cross_group_parent');
    }
    const descendants = collectSubtreeIds(state, root.id);
    if (parent && descendants.has(asId(parent.id))) throw fail('prompt cannot move under its own subtree', 409, 'saved_prompt_cycle');
    root.visual_parent_id = parent ? asId(parent.id) : null;
    for (const id of descendants) findPrompt(state, id).group_id = targetGroupId;
    if (position !== undefined) insertAtSiblingPosition(state, root, position);
    const normalized = new Set(normalizeScopePositions(state, targetGroupId));
    if (oldGroupId !== targetGroupId) normalizeScopePositions(state, oldGroupId).forEach((id) => normalized.add(id));
    return [...new Set([...descendants, ...normalized])];
  };

  return {
    get: read,
    list() { return library().prompts.map(publicPrompt); },
    catalog({ projection, requestId } = {}) {
      if (projection != null && projection !== 'outline-v1') throw fail('unsupported prompt outline projection', 400, 'saved_prompt_projection_invalid');
      const state = readSnapshot(), result = compactCatalog(state);
      if (!projection) return result;
      return { ...result, read: readEvidence(state, requestId),
        outline: { version: 1, roots: presentOutline(buildPromptOutline(state.prompts, state.groups),
          new Map(state.prompts.map(prompt => [prompt.id, revisionFor(prompt)]))) } };
    },
    async readMany({ promptIds, mode = 'own', resolveText } = {}) {
      if (!Array.isArray(promptIds) || promptIds.length === 0) throw fail('promptIds must be a non-empty array', 400, 'saved_prompt_ids_required');
      if (!['own', 'resolved'].includes(mode)) throw fail('mode must be own or resolved', 400, 'saved_prompt_read_mode_invalid');
      const state = readSnapshot();
      const selected = promptIds.map((id) => findPrompt(state, id));
      if (mode !== 'resolved') return selected.map(publicPrompt);
      if (typeof resolveText !== 'function') throw fail('resolved prompt reader unavailable', 503, 'saved_prompt_resolver_unavailable');
      return Promise.all(selected.map(async (prompt) => ({ ...publicPrompt(prompt), resolvedText: await resolveText(prompt, state.prompts) })));
    },
    async readResolvedSteps({ promptIds, mode, projection, requestId, expectedLibraryRevision, resolvePart } = {}) {
      if (projection !== 'steps-v1' || mode !== 'resolved') throw fail('steps-v1 requires resolved mode', 400, 'saved_prompt_projection_invalid');
      if (!Array.isArray(promptIds) || promptIds.length !== 1) throw fail('steps-v1 requires exactly one selected prompt', 400, 'saved_prompt_selection_invalid');
      if (expectedLibraryRevision != null && (typeof expectedLibraryRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedLibraryRevision))) {
        throw fail('invalid library revision', 400, 'saved_prompt_library_revision_invalid');
      }
      const state = readSnapshot(), read = readEvidence(state, requestId);
      const selected = findPrompt(state, promptIds[0]);
      read.selectedPromptId = selected.id; read.selectedRevision = revisionFor(selected);
      if (expectedLibraryRevision != null && expectedLibraryRevision !== read.libraryRevision) {
        throw fail('prompt library changed since the outline read', 409, 'saved_prompt_library_stale', { read });
      }
      if (typeof resolvePart !== 'function') throw fail('resolved prompt reader unavailable', 503, 'saved_prompt_resolver_unavailable', { read });
      const outline = buildPromptOutline(state.prompts, state.groups);
      try {
        const composed = await resolveSavedPromptComposition(selected, state.prompts, resolvePart, { outline });
        const steps = composed.steps.map(({ prompt, parts, files }, depth) => ({
          promptId: prompt.id, sourceKey: `prompt:${prompt.id}`, label: prompt.title,
          // Keep the stored definition revision, even if the outline normalized
          // an orphan group for presentation. No repaired relation is persisted.
          revision: revisionFor(findPrompt(state, prompt.id)),
          text: parts.join('\n\n'), files,
          inheritanceDepth: depth,
          inheritanceParentPromptId: depth ? composed.chain[depth - 1].id : null,
          inheritanceParentLabel: depth ? composed.chain[depth - 1].title : null,
        }));
        return { read, prompts: [{ ...publicPrompt(selected), resolvedText: composed.parts.join('\n\n') }],
          composition: { version: 1, selectedPromptId: selected.id, steps } };
      } catch (error) { error.read = read; throw error; }
    },
    createPrompt({ stableId, title, text = '', filePaths = [], groupId = null, parentPromptId = null, position = 0 } = {}) {
      const id = asId(stableId) || `prompt-${crypto.randomUUID()}`;
      const result = mutate((state) => {
        if (state.prompts.some((prompt) => asId(prompt.id) === id)) throw fail('saved prompt id already exists', 409, 'saved_prompt_id_conflict');
        const parent = parentPromptId ? findPrompt(state, parentPromptId) : null;
        const targetGroupId = parent ? (parent.group_id ?? null) : asGroupId(groupId);
        if (parent && groupId != null && targetGroupId !== asGroupId(groupId)) {
          throw fail('parent and target group identify different locations', 409, 'saved_prompt_cross_group_parent');
        }
        const prompt = { id, title, content: text, file_paths: cleanPaths(filePaths), group_id: targetGroupId, visual_parent_id: parent ? asId(parent.id) : null, position };
        state.prompts.push(prompt);
        insertAtSiblingPosition(state, prompt, position);
        return { changedPromptIds: normalizeScopePositions(state, targetGroupId) };
      });
      return publicPrompt(findPrompt(result.library, id));
    },
    update({ stableId, revision, title, text, filePaths, position } = {}) {
      const result = mutate((state) => {
        const prompt = findPrompt(state, stableId);
        assertPromptRevision(prompt, revision);
        if (title === undefined && text === undefined && filePaths === undefined && position === undefined) throw fail('prompt patch required', 400, 'saved_prompt_patch_required');
        if (title !== undefined) prompt.title = title;
        if (text !== undefined) prompt.content = text;
        if (filePaths !== undefined) prompt.file_paths = cleanPaths(filePaths);
        const changedPromptIds = position === undefined
          ? [asId(prompt.id)]
          : (insertAtSiblingPosition(state, prompt, position), normalizeScopePositions(state, prompt.group_id ?? null));
        return { changedPromptIds };
      });
      return publicPrompt(findPrompt(result.library, stableId));
    },
    movePrompt(args = {}) {
      const result = mutate((state) => ({ changedPromptIds: moveInState(state, args) }));
      return publicPrompt(findPrompt(result.library, args.stableId));
    },
    deletePrompt({ stableId, revision } = {}) {
      const result = mutate((state) => {
        const prompt = findPrompt(state, stableId);
        assertPromptRevision(prompt, revision);
        const id = asId(prompt.id);
        const detachedChildren = [];
        for (const child of state.prompts) {
          if (asId(child.visual_parent_id) !== id) continue;
          child.visual_parent_id = null;
          detachedChildren.push(asId(child.id));
        }
        state.prompts = state.prompts.filter((item) => asId(item.id) !== id);
        return { changedPromptIds: detachedChildren, removedPromptIds: [id] };
      });
      return { deleted: true, promptId: asId(stableId), remaining: result.library.prompts.length };
    },
    createGroup({ name, description = '', position = 0, isCollapsed = false } = {}) {
      const temporaryId = `new-group:${crypto.randomUUID()}`;
      const result = mutate((state) => {
        const group = { id: temporaryId, name, description, position, is_collapsed: !!isCollapsed };
        state.groups.push(group);
        return { changedGroupIds: insertGroupAtPosition(state, group, position) };
      });
      return publicGroup(findGroup(result.library, result.groupIdMap[temporaryId]));
    },
    getGroup(groupId) { return publicGroup(findGroup(library(), groupId)); },
    updateGroup({ groupId, revision, name, description, position, isCollapsed } = {}) {
      const result = mutate((state) => {
        const group = findGroup(state, groupId);
        assertGroupRevision(group, revision);
        if (name === undefined && description === undefined && position === undefined && isCollapsed === undefined) throw fail('group patch required', 400, 'prompt_group_patch_required');
        if (name !== undefined) group.name = name;
        if (description !== undefined) group.description = description;
        const changedGroupIds = position === undefined
          ? [group.id]
          : insertGroupAtPosition(state, group, position);
        if (isCollapsed !== undefined) group.is_collapsed = !!isCollapsed;
        if (typeof group.name !== 'string' || !group.name.trim()) throw fail('group name must be a non-empty string', 400, 'prompt_group_name_invalid');
        return { changedGroupIds };
      });
      return publicGroup(findGroup(result.library, groupId));
    },
    deleteGroup({ groupId, revision } = {}) {
      const result = mutate((state) => {
        const group = findGroup(state, groupId);
        assertGroupRevision(group, revision);
        const ungroupedPromptIds = [];
        for (const prompt of state.prompts) {
          if (Number(prompt.group_id) !== Number(group.id)) continue;
          prompt.group_id = null;
          ungroupedPromptIds.push(asId(prompt.id));
        }
        state.groups = state.groups.filter((item) => Number(item.id) !== Number(group.id));
        return { changedGroupIds: [group.id], changedPromptIds: ungroupedPromptIds, removedGroupIds: [group.id] };
      });
      return { deleted: true, groupId: Number(groupId), remaining: result.library.groups.length };
    },
  };
}

module.exports = { createSavedPromptService, revisionFor, groupRevisionFor, PROMPT_LIBRARY_READ_CAPABILITY };
