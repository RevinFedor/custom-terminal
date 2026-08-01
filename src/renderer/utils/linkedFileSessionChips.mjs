const SESSION_KINDS = new Set(['claude', 'codex', 'gemini'])

function sessionKindForTab(tab) {
  if (tab?.tabType === 'claude-sdk') return 'claude'
  const candidates = [tab?.commandType, tab?.color]
  return candidates.find(value => SESSION_KINDS.has(value)) || 'default'
}

export function collectLinkedFileSessionChips(tabs) {
  const tabList = Array.from(tabs?.values ? tabs.values() : (tabs || []))
  const tabsById = new Map(tabList.map(tab => [tab?.id, tab]))
  const seen = new Set()

  return tabList
    .filter(tab => tab?.tabType === 'file' && tab.filePath && tab.visualParentTabId)
    .flatMap(fileTab => {
      const sessionTab = tabsById.get(fileTab.visualParentTabId)
      if (!sessionTab || sessionTab.tabType === 'file') return []
      const identity = `${fileTab.filePath}\u0000${sessionTab.id}`
      if (seen.has(identity)) return []
      seen.add(identity)
      return [{
        filePath: fileTab.filePath,
        fileTabId: fileTab.id,
        sessionTabId: sessionTab.id,
        sessionName: sessionTab.name || 'Session',
        sessionKind: sessionKindForTab(sessionTab),
      }]
    })
    .sort((a, b) => (
      a.filePath.localeCompare(b.filePath)
      || a.sessionName.localeCompare(b.sessionName)
      || a.sessionTabId.localeCompare(b.sessionTabId)
    ))
}

export function linkedFileSessionChipSnapshot(tabs) {
  return JSON.stringify(collectLinkedFileSessionChips(tabs))
}

