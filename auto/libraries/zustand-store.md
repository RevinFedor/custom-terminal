# Zustand Store — Чтение состояния из тестов

## Доступ к store

Store доступен через `window.useWorkspaceStore` в renderer:

```javascript
const state = await page.evaluate(() => {
  return window.useWorkspaceStore?.getState?.()
})
```

## Получение активного таба

```javascript
const tab = await page.evaluate(() => {
  const store = window.useWorkspaceStore?.getState?.()
  const proj = store?.openProjects?.get?.(store?.activeProjectId)
  return proj?.tabs?.get?.(proj?.activeTabId)
})
```

### Ключевые поля таба

| Поле | Тип | Описание |
|---|---|---|
| `id` | string | ID таба (напр. `new_project_...-tab-10`) |
| `name` | string | Отображаемое имя (`claude`, `tab-1`) |
| `cwd` | string | Текущая директория (обновляется через OSC 7) |
| `claudeSessionId` | string? | UUID сессии Claude (null если не запущен) |
| `geminiSessionId` | string? | UUID сессии Gemini |
| `commandType` | string? | `'claude'` / `'gemini'` / undefined |
| `wasInterrupted` | boolean | Была ли сессия прервана |

## Event-driven ожидание

Вместо таймаута — polling через `waitForFunction`:

```javascript
// Ждём Claude session ID
await page.waitForFunction(() => {
  const store = window.useWorkspaceStore?.getState?.()
  const proj = store?.openProjects?.get?.(store?.activeProjectId)
  const tab = proj?.tabs?.get?.(proj?.activeTabId)
  return tab?.claudeSessionId?.length > 10
}, { timeout: 30000 })
```

Готовые хелперы в `core/launcher.js`:
- `waitForClaudeSessionId(page, timeout)`
- `waitForGeminiSessionId(page, timeout)`
