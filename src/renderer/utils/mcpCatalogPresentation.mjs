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

export function externalMcpServers(catalog) {
  return (catalog?.servers || []).filter(server => !server.hubServer);
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
