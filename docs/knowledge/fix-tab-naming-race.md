# Fix: Tab Naming Race Condition (docs-XX → claude)

## Problem
При создании таба обновления документации через `createTabAfterCurrent` с опциями `{ nameSetManually: true, name: 'docs-01' }` флаг `nameSetManually` терялся при конструировании объекта Tab. Когда пользователь запускал Claude в этом табе, функция `setTabCommandType` перезаписывала имя на `claude`, игнорируя intentional naming.

## Symptoms
- Таб создается с именем `docs-01` ✓
- Пользователь видит в InfoPanel: **"docs-01"** ✓
- Вводит `claude` → запускается Claude CLI
- Имя автоматически меняется на **"claude-01"** ✗ (не должно!)

## Root Cause
В функции `createTabAfterCurrent` (or `createTab`) параметры `options` не полностью передавались в конструктор класса Tab. Флаг `nameSetManually` остался `undefined`, что привело к тому, что `setTabCommandType` трактовал это как "имя задано автоматически" и перезаписал его.

## Solution
Исправление конструктора Tab в `useWorkspaceStore.ts`:
```typescript
const tab = new Tab({
  ...options,  // Явная передача всех опций, включая nameSetManually
  id: options.id || generateId(),
  projectId,
  cwd,
  // ...
});
```

Гарантирует, что `nameSetManually: true` пробивается через весь стек создания.

## Reference
- `knowledge/fact-tabs.md` — паттерны именования.
- `src/renderer/store/useWorkspaceStore.ts` — реализация `createTabAfterCurrent`.
