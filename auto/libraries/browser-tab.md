# BrowserTab — Тестирование встроенного браузера

## Специфика структуры

BrowserTab — это составной компонент, объединяющий `webview` и встроенный `Terminal`.

### ID и адресация
- `tabId`: ID основной вкладки браузера.
- `terminalId`: ID встроенного терминала (обычно совпадает с `tabId` или передается явно). 
При поиске в `terminalRegistry` или подписке на IPC `terminal:command-*` важно использовать правильный ID.

## Управление состоянием (activeView)

Вкладка имеет два режима: `browser` и `terminal`. Переключение происходит через `useWorkspaceStore.setBrowserActiveView`.

### Тестирование переключения:
1. Клик по кнопке "Term" → `activeView` должен стать `terminal`.
2. Проверка видимости: `webview` должен получить `visibility: hidden`, а терминал — `inherit`.
3. **Ловушка фокуса:** Webview удерживает фокус ввода даже будучи невидимым. Тест должен проверять, что `webview.blur()` был вызван при переходе в режим терминала.

## Навигация и Ссылки

### Внутренний переход (Link Interception)
Cmd+клик по ссылке во встроенном терминале должен:
1. Вызвать `onLinkClick` в родительском `BrowserTab`.
2. Обновить URL в `webview`.
3. Переключить `activeView` на `browser`.

### Refresh Logic
Клик по кнопке "Refresh" в UI браузера должен:
1. Переключить вид на `browser` (если пользователь был в терминале).
2. Вызвать `webview.reload()`.

## Ожидания (Assertions)

### Webview Readiness
`webview` — это отдельный процесс. Playwright не всегда видит его содержимое напрямую.
Для проверки загрузки использовать события:
```javascript
await page.waitForSelector('webview[src="http://localhost:3000"]');
```

### URL Sync
При навигации внутри `webview` (клики по ссылкам на сайте), адресная строка в приложении должна обновляться через `did-navigate`.
```javascript
// Проверка синхронизации store
await page.waitForFunction(() => {
  const tab = useWorkspaceStore.getState().getActiveTab();
  return tab.url === 'http://localhost:3000/new-page';
});
```
