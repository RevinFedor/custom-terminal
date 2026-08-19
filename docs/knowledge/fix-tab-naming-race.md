# Fix: Tab Naming Race Condition (заданное имя → claude)

> Исходный случай — вкладки `docs-XX` пайплайна обновления документации,
> удалённого 2026-08-18. Правило живо для любого программного создания вкладки
> с заранее заданным именем.

## Problem
При создании вкладки через `createTabAfterCurrent` с опциями `{ nameSetManually: true, name: 'docs-01' }` флаг `nameSetManually` терялся при конструировании объекта Tab. Когда пользователь запускал Claude в этом табе, функция `setTabCommandType` перезаписывала имя на `claude`, игнорируя intentional naming.

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

## Codex bootstrap-инструкции как ложный первый prompt

**Симптом:** прод-вкладка Codex `019ecf86-c525-7340-9012-bb8fef436701` получила название `лаги навигации терминала`, хотя первый реальный user prompt в rollout был про вход в аккаунт и пароль. Пользователь видел это как «в этой сессии мы не решали лаги навигации терминала».

**Корень:** перед первым `event_msg.user_message` Codex пишет большой bootstrap-блок `# AGENTS.md instructions for ...` как `response_item role=user`. В текущем parser'е Timeline строится из `event_msg.user_message`, но prod/legacy путь уже успел протащить bootstrap как обычный user-entry в auto-title candidate. Gemini честно назвал вкладку по тексту инструкций проекта.

**Фикс:** eligibility auto-title фильтрует `AGENTS.md/GEMINI.md instructions for ...` независимо от upstream parser'а. Это defense-in-depth: даже если Codex parser, manual refresh или cache снова принесут такой блок с `type='user'`, он не станет источником названия. Реальный первый prompt остаётся `event_msg.user_message`; bootstrap-инструкции — среда выполнения, не намерение пользователя.
