export function focusedMcpCwd(state) {
  const pane = state.splitPanes.length ? state.splitPanes[state.splitFocusedIndex] : null;
  const projectId = pane ? pane.projectId : (state.focusedProjectId || state.activeProjectId);
  const workspace = state.openProjects.get(projectId);
  if (!workspace) return null;
  if (pane ? !pane.tabId || pane.selectedSlotId || pane.displayHidden : workspace.currentView !== 'terminal') {
    return workspace.projectPath || null;
  }
  const child = workspace.viewingSubAgentTabId ? workspace.tabs.get(workspace.viewingSubAgentTabId) : null;
  const tabId = pane ? pane.tabId : child?.parentTabId === workspace.activeTabId ? child.id : workspace.activeTabId;
  return workspace.tabs.get(tabId)?.cwd || workspace.projectPath || null;
}

export function externalMcpServers(catalog, activeServers = null) {
  return (catalog?.servers || []).filter(server => !server.hubServer || server.enabled === false
    || (activeServers !== null && !activeServers.some(active => active.name === server.hubServer)));
}

export function hubConfigurationNotice(status, catalog) {
  const desired = status?.desiredConfiguration;
  const messages = [];
  if (desired?.error) messages.push('Профиль MCP не прочитан: ' + desired.error + '.');
  const unresolved = desired?.entries?.filter(entry => ['invalid', 'unconfigured'].includes(entry.state)) || [];
  if (unresolved.length) messages.push('Проверьте привязки: ' + unresolved.map(entry =>
    entry.name + (entry.error ? ' (' + entry.error + ')' : '')).join(', ') + '.');
  if (desired?.needsReview) messages.push('В ~/.noted-terminal/mcp-hub.json укажите точные команды или enabled:false; дополнительные пакеты не обязательны.');
  if (desired && !status?.down && status.configurationApplied !== true) {
    messages.push('Применение профиля к текущему поколению хаба не подтверждено. Перезапуск children не применяет профиль; смена поколения — только после согласованного завершения работ.');
  }
  const missing = [...new Set((catalog?.servers || []).filter(server => server.enabled && server.hubServer
    && !status?.servers?.some(active => active.name === server.hubServer)).map(server => server.hubServer))];
  if (missing.length) messages.push('Клиент запрашивает отсутствующие в хабе: ' + missing.join(', ') + '. URL не содержит команды запуска.');
  return messages.join(' ') || null;
}

export function mcpCatalogErrorMessage(code) {
  return ({
    codex_unavailable: 'Codex не найден. Проверьте его установку.',
    api_unsupported: 'Эта версия Codex не поддерживает чтение конфигурации MCP.',
    invalid_catalog: 'Codex вернул некорректную конфигурацию MCP.',
    timeout: 'Codex не ответил при чтении конфигурации MCP.',
    plugins_unsupported: 'Эта версия Codex не сообщает MCP из плагинов.',
    plugins_unavailable: 'Конфигурация MCP из плагинов не обновлена.',
    catalog_unavailable: 'Конфигурация MCP Codex не обновлена. Проверьте её через Codex.',
  })[code] || 'Конфигурация MCP Codex не обновлена.';
}
