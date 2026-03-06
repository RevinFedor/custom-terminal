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

### Затронутые методы
| Метод | `set()` | Guard | Статус |
|-------|---------|-------|--------|
| `setClaudeSessionId` | `set({})` | ✅ | Исправлен |
| `setGeminiSessionId` | `set({})` | ✅ | Исправлен |
| `setTabNotes` | `set({})` | ✅ | Исправлен |
| `updateTabUrl` | `set({})` | ✅ | Исправлен |
| `markAllSessionsInterrupted` | `set({})` | — | Исправлен (shutdown + future-proof) |

## Правило

> **Любая мутация в Zustand store, которую должны видеть другие компоненты, ОБЯЗАНА вызывать `set()`.**
> Если мутация частая (polling, Bridge), добавляй guard `if (old === new) return` перед `set()`.

## Ловушка: `set({})` + стабильные селекторы

**`set({})` сам по себе НЕ гарантирует re-render!** Zustand v5 создаёт shallow-copy top-level state (`Object.assign({}, state, {})`), но если ВСЕ селекторы компонента возвращают стабильные ссылки (функции, строки, те же объекты), `useSyncExternalStore` / `Object.is` не находит разницы и React bail-аутит.

### Пример: Workspace.tsx до фикса
```tsx
const getActiveProject = useWorkspaceStore((s) => s.getActiveProject); // function ref — stable
const activeProject = getActiveProject(); // call in render, NOT selector
const claudeSessionId = effectiveTab?.claudeSessionId; // derived from object — stale!
```

Tab мутируется in-place → `set({})` fires → селекторы возвращают те же ссылки → **нет re-render** → `claudeSessionId` остаётся stale.

### Решение: Fine-grained Primitive Selectors
Для мутаций через `set({})` компоненты-потребители **ОБЯЗАНЫ** иметь селекторы, возвращающие **примитивы** (string/number/null), а не объекты:
```tsx
const effectiveClaudeSessionId = useWorkspaceStore((s) => {
  const p = s.openProjects.get(s.activeProjectId!);
  if (!p) return null;
  const tabId = p.viewingSubAgentTabId || p.activeTabId;
  const tab = tabId ? p.tabs.get(tabId) : null;
  return tab?.claudeSessionId || null; // primitive — Zustand can detect change
});
```

Селектор проходит по тому же in-place мутированному объекту, но возвращает **новый примитив**, который `Object.is` сравнивает и находит разницу → re-render.

## Связанные файлы
- `src/renderer/store/useWorkspaceStore.ts` — все методы store
- `src/renderer/components/Workspace/Workspace.tsx` — fine-grained селекторы `effectiveClaudeSessionId`, `effectiveGeminiSessionId`, `effectiveCommandType`
- `src/renderer/components/Workspace/Timeline.tsx` — `sessionId` prop из Workspace
- `src/renderer/components/Workspace/panels/InfoPanel.tsx:147` — polling workaround (500ms setInterval)
