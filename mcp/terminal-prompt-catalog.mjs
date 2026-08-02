function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function groupNames(groups) {
  return new Map((Array.isArray(groups) ? groups : []).map((group) => [
    String(group?.id ?? ''),
    String(group?.name ?? ''),
  ]));
}

export function buildPromptCatalog(payload, query = '') {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const prompts = Array.isArray(payload?.prompts) ? payload.prompts : [];
  const names = groupNames(groups);
  const needle = normalized(query);

  const rows = prompts
    .map((prompt) => {
      const groupId = prompt?.group_id ?? null;
      const groupName = groupId == null ? '' : (names.get(String(groupId)) || '');
      return {
        id: String(prompt?.id ?? ''),
        title: String(prompt?.title ?? ''),
        groupId,
        groupName,
        parentPromptId: prompt?.visual_parent_id == null ? null : String(prompt.visual_parent_id),
        position: Number.isFinite(prompt?.position) ? prompt.position : null,
        fileCount: Array.isArray(prompt?.file_paths) ? prompt.file_paths.length : 0,
        ownTextLength: String(prompt?.content ?? '').length,
        resolvedTextLength: String(prompt?.resolvedText ?? '').length,
      };
    })
    .filter((prompt) => !needle || normalized(prompt.title).includes(needle) || normalized(prompt.groupName).includes(needle));

  return {
    etag: payload?.etag || null,
    count: rows.length,
    groups: groups.map((group) => ({
      id: group?.id ?? null,
      name: String(group?.name ?? ''),
      position: Number.isFinite(group?.position) ? group.position : null,
    })),
    prompts: rows,
  };
}

export function selectPrompt(payload, { promptId, title } = {}) {
  const prompts = Array.isArray(payload?.prompts) ? payload.prompts : [];
  const requestedId = String(promptId ?? '').trim();
  const requestedTitle = normalized(title);

  if (!requestedId && !requestedTitle) {
    throw new Error('Pass promptId or an exact title. Use list_prompts first when the prompt identity is unknown.');
  }

  if (requestedId) {
    const match = prompts.find((prompt) => String(prompt?.id ?? '') === requestedId);
    if (!match) throw new Error('Prompt not found: ' + requestedId);
    if (requestedTitle && normalized(match?.title) !== requestedTitle) {
      throw new Error('promptId and title identify different prompts. Use promptId alone or pass its exact title.');
    }
    return match;
  }

  const matches = prompts.filter((prompt) => normalized(prompt?.title) === requestedTitle);
  if (matches.length === 0) throw new Error('Prompt not found with exact title: ' + String(title).trim());
  if (matches.length > 1) {
    const choices = matches.map((prompt) => `${prompt.title} (${prompt.id})`).join(', ');
    throw new Error('Several prompts have this title. Repeat with promptId: ' + choices);
  }
  return matches[0];
}

export function buildPromptResult(payload, prompt, mode = 'resolved') {
  const requestedMode = mode === 'own' ? 'own' : 'resolved';
  const groups = groupNames(payload?.groups);
  const groupId = prompt?.group_id ?? null;
  const ownText = String(prompt?.content ?? '');
  const resolvedText = String(prompt?.resolvedText ?? ownText);

  return {
    id: String(prompt?.id ?? ''),
    title: String(prompt?.title ?? ''),
    groupId,
    groupName: groupId == null ? '' : (groups.get(String(groupId)) || ''),
    parentPromptId: prompt?.visual_parent_id == null ? null : String(prompt.visual_parent_id),
    filePaths: Array.isArray(prompt?.file_paths) ? prompt.file_paths : [],
    mode: requestedMode,
    text: requestedMode === 'own' ? ownText : resolvedText,
    resolutionNote: requestedMode === 'resolved' && Array.isArray(prompt?.file_paths) && prompt.file_paths.length > 0
      ? 'Resolved text is assembled by the live Prompt API. A linked file that cannot be read is omitted by that API; filePaths are returned for verification.'
      : null,
  };
}
