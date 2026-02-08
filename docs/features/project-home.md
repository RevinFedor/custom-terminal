# Feature: Project Home View

## Intro
Центральный экран управления текущим проектом, отображающий все активные терминалы в виде наглядных карточек и историю закрытых вкладок. Позволяет быстро ориентироваться в сложной структуре открытых вкладок и восстанавливать прошлые AI-сессии.

## User Flow
1. **Активация:** Пользователь нажимает кнопку «Home» в правой верхней части (`ProjectToolbar`) или закрывает все вкладки терминала.
2. **Обзор:** Открывается сетка карточек всех вкладок проекта.
3. **Навигация:** Клик по карточке переключает интерфейс в режим терминала (`currentView: 'terminal'`) и делает выбранную вкладку активной.
4. **Управление:** В конце списка всегда отображается кнопка «New Tab» для быстрого создания нового терминала.

## History (Closed Tabs)
Под секцией Active Tabs отображается история закрытых вкладок, сгруппированная по времени (Today, Yesterday, This Week, This Month, Older).

### User Flow
1. **Закрытие вкладки:** При закрытии таб архивируется в SQLite через IPC `project:archive-tab`. Сохраняются все метаданные: `name`, `cwd`, `color`, `commandType`, `claudeSessionId`, `geminiSessionId`, `notes`.
2. **Просмотр:** В Home View записи появляются в секции History с группировкой по дате `closed_at`.
3. **Hover Popover:** При наведении на запись появляется попап с деталями (notes, даты, path, type). Используется паттерн "Невидимого мостика" (см. `knowledge/ui-ux-stability.md`).
4. **Restore:** Клик по записи восстанавливает вкладку:
   - Создаётся новый таб через `createTab()` с **полными** метаданными из БД.
   - Для AI-вкладок формируется `pendingAction`:
     - С `sessionId` → `claude-continue` / `gemini-continue` (resume старой сессии).
     - Без `sessionId` → `claude-new` / `gemini-new` (новый запуск).
   - Запись удаляется из History через `project:delete-tab-history-entry`.
   - View переключается на `terminal`.
5. **Clear:** Кнопка «Clear» очищает всю историю проекта (`project:clear-tab-history`).

### Критическое правило: Immediate Injection при Restore
При восстановлении AI-вкладки `claudeSessionId` / `geminiSessionId` передаются в `createTab()` через `options`. Это гарантирует, что InfoPanel **мгновенно** видит ID сессии, без ожидания PTY или Sniper Watcher. См. `knowledge/ui-ux-stability.md`.

### Данные History Entry (SQLite)
```
id, project_id, name, cwd, color, notes,
command_type, tab_type, url,
created_at, closed_at,
claude_session_id, gemini_session_id
```

## Behavior Specs
- **Visual Overlay:** Project Home рендерится как полноэкранный оверлей (`z-50`) внутри левой колонки. Он полностью перекрывает область терминала и **вкладки терминалов (TabBar)**, но оставляет видимым правый сайдбар.
- **Real-time Sync:** При редактировании названия проекта в табе (шапка), заголовок в Project Home обновляется мгновенно (через событие `project:name-sync`).
- **Auto-Redirect:** Если в проекте не осталось вкладок, система автоматически переключает вид на Home.
- **Visuals:** Карточки имеют размер 150x50px и окрашиваются в цвет вкладки. На карточке отображается имя таба и текущая директория (CWD).
- **History Refetch:** История автоматически обновляется при изменении `tabs.length` (закрытие таба → refetch).

## Code Map
- `ProjectHome.tsx`: Рендеринг сетки карточек, History секции и логика `restoreTab()`.
- `Workspace.tsx`: Управление состоянием `currentView` и автоматический редирект через `useEffect`.
- `useUIStore.ts`: Хранение текущего вида (`currentView`).
- `main.js`: IPC-хендлеры `project:archive-tab`, `project:get-tab-history`, `project:delete-tab-history-entry`, `project:clear-tab-history`.
