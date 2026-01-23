# Feature: Tab Management

## Intro
Система вкладок в стиле VSCode с разделением на зоны (Main/Utils), поддержкой интеллектуального именования и автоматического окрашивания.

## User Flow: Жизненный цикл таба
1. **Создание:** Пользователь нажимает `Cmd+T` или делает двойной клик на пустом месте TabBar.
   - Система ищет первое свободное число для имени (`tab-1`, `tab-2`).
   - Новый таб наследует `cwd` текущего активного таба. См. `knowledge/fact-osc7-cwd.md`.
2. **Запуск процесса:** Пользователь вводит `npm run dev`.
   - Таб мгновенно переименовывается в `run-dev`.
   - Цвет таба меняется на зеленый (если не был задан вручную).
   - Появляется кнопка **Smart Restart (↻)** в левой части таба (Restart Zone).
3. **AI Сессия:** Пользователь вводит `claude`.
   - Таб становится оранжевым (`#DA7756`).
   - Кнопка Restart скрывается, так как для AI она не актуальна.
4. **Управление:** 
   - Пользователь делает правый клик (ПКМ). Открывается меню: **Close Tab** -> **Rename** -> **Color** (подменю).
   - Подменю Color открывается плавно благодаря "мостику" наведения.
   - Пользователь может закрыть таб колесиком мыши.

## Behavior Specs
- **Smart Naming:** 
    - Первый: `run-dev`, `claude`, `tab-1`.
    - Повторные: `run-dev-02`, `claude-03`.
- **Auto-color:** 
    - `devServer` -> Green.
    - `claude` -> #DA7756.
    - `gemini` -> #4E86F8.
    - Флаг `colorSetManually` предотвращает автоматическую смену цвета, если пользователь сам выбрал цвет.
- **Restart Zone:** Левая часть таба (32px). Клик выполняет `SIGINT` -> `!! + Enter`. Доступно только для `devServer`.
- **Utils Zone:** Всплывающее меню слева. Открывается мгновенно при наведении, закрывается с задержкой 100мс. См. `knowledge/fix-ui-stability.md` (раздел 2).

## Code Map
- **UI:** `src/renderer/components/Workspace/TabBar.tsx` — логика меню и `RestartZone`.
- **Logic:** `src/renderer/store/useWorkspaceStore.ts` — функции `getNextAvailableName` и `setTabCommandType`.
- **Terminal:** `src/renderer/components/Workspace/Terminal.tsx` — перехват команд для детекции типа процесса.