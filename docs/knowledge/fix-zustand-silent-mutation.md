# Fix: Zustand Silent Mutation Anti-Pattern

## Проблема

В `useWorkspaceStore.ts` несколько методов мутируют `tab.*` свойства напрямую **без вызова `set()`**.
Zustand не нотифицирует subscribers → компоненты не re-рендерятся → UI показывает stale data.

### Симптомы
- `setClaudeSessionId`: InfoPanel видит новый session ID (через polling), но Workspace/Timeline — нет
- Replace Session кнопка (✎) обновляла store, но Timeline продолжал показывать старую сессию
- `setGeminiSessionId`, `setTabNotes`, `updateTabUrl` — те же потенциальные баги

### Причина
Исторически `set()` избегался из-за комментария:
```
// NOTE: Not calling set() here to avoid re-render that breaks terminal
```
Это создало "silent updates" — данные меняются в памяти, но Zustand subscribers не получают notification.

## Решение

### Паттерн: Guard + set({})
```typescript
setClaudeSessionId: (tabId, sessionId) => {
  const { openProjects } = get();
  for (const [, workspace] of openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      // GUARD: skip if unchanged (Bridge polls every 2s with same ID)
      if (tab.claudeSessionId === sessionId) return;

      tab.claudeSessionId = sessionId;
      saveTabs(workspace.projectId, workspace.tabs);
      // TRIGGER: notify subscribers only on actual change
      set({});
      return;
    }
  }
}
```

### Почему guard обязателен
Без guard'а `set({})` вызывался бы на КАЖДОМ Bridge poll (каждые 2с), вызывая ненужные re-render всех subscribers. Guard `if (tab.prop === value) return` гарантирует, что `set({})` fires только при реальном изменении.

### Затронутые методы (на момент фикса)
| Метод | `set()` | Guard | Статус |
|-------|---------|-------|--------|
| `setClaudeSessionId` | `set({})` | ✅ | Исправлен |
| `setGeminiSessionId` | ❌ | ❌ | TODO |
| `setTabNotes` | ❌ | ❌ | TODO |
| `updateTabUrl` | ❌ | ❌ | TODO |

## Правило

> **Любая мутация в Zustand store, которую должны видеть другие компоненты, ОБЯЗАНА вызывать `set()`.**
> Если мутация частая (polling, Bridge), добавляй guard `if (old === new) return` перед `set()`.

## Связанные файлы
- `src/renderer/store/useWorkspaceStore.ts` — все методы store
- `src/renderer/components/Workspace/Workspace.tsx:268` — `claudeSessionId` из `activeTab` (зависит от Zustand re-render)
- `src/renderer/components/Workspace/Timeline.tsx` — `sessionId` prop из Workspace
- `src/renderer/components/Workspace/panels/InfoPanel.tsx:147` — polling workaround (500ms setInterval)
