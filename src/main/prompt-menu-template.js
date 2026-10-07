function buildProjectPromptRows(projectCatalog, onPick) {
  const rows = [];
  let previousSource = null;
  for (const prompt of projectCatalog?.prompts || []) {
    const sourceName = String(prompt.sourceName || 'Документы');
    if (sourceName !== previousSource) {
      if (rows.length > 0) rows.push({ type: 'separator' });
      rows.push({ label: sourceName, enabled: false });
      previousSource = sourceName;
    }
    rows.push({
      label: prompt.title,
      click: () => onPick(prompt),
    });
  }
  return rows;
}

function buildGlobalPromptRows(prompts, groups, onPick) {
  const rows = [];
  const flatItems = [];
  for (const group of groups || []) flatItems.push({ type: 'group', group, pos: group.position });
  for (const prompt of prompts || []) {
    if (prompt.group_id == null || prompt.group_id === '') {
      flatItems.push({ type: 'prompt', prompt, pos: prompt.position });
    }
  }
  flatItems.sort((a, b) => Number(a.pos || 0) - Number(b.pos || 0));
  for (const item of flatItems) {
    if (item.type === 'group') {
      const groupPrompts = (prompts || []).filter((prompt) => String(prompt.group_id) === String(item.group.id));
      rows.push({
        label: item.group.name,
        submenu: groupPrompts.length > 0
          ? groupPrompts.map((prompt) => ({ label: prompt.title, click: () => onPick(prompt) }))
          : [{ label: '(empty)', enabled: false }],
      });
      continue;
    }
    rows.push({ label: item.prompt.title, click: () => onPick(item.prompt) });
  }
  return rows;
}

function buildPromptMenuTemplate({ prompts = [], groups = [], projectCatalog = null, onPick }) {
  const rows = [];
  if ((projectCatalog?.project || projectCatalog?.tabId) && projectCatalog.prompts?.length > 0) {
    rows.push({
      label: projectCatalog.project?.name || 'Документы вкладки',
      submenu: buildProjectPromptRows(projectCatalog, onPick),
    });
  }
  const globalRows = buildGlobalPromptRows(prompts, groups, onPick);
  if (rows.length > 0 && globalRows.length > 0) rows.push({ type: 'separator' });
  rows.push(...globalRows);
  return rows;
}

module.exports = {
  buildGlobalPromptRows,
  buildProjectPromptRows,
  buildPromptMenuTemplate,
};
