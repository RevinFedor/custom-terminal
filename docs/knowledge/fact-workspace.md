# Feature: Workspace & Project Tools

## Intro
Инструменты управления проектами, навигации по файлам и работы с заметками.

## User Flow: Управление проектами
1. **Переключение:** Пользователь видит список открытых проектов в самом верху окна (Project Tabs).
   - Активный проект имеет белый фон.
   - **Quick Rename:** Двойной клик по названию проекта в Title Bar позволяет мгновенно изменить имя без захода в настройки.
2. **Редактирование (Edit Modal):**
   - Можно изменить не только имя, но и системный **путь** проекта.
   - **System Picker:** Кнопка выбора папки открывает нативный диалог ОС.
   - **Live Validation:** Статус пути проверяется в реальном времени (✅ существует / ⚠️ не найден).
3. **Dashboard:** Отображает все проекты из БД.
   - **Compact Paths:** В карточках отображаются только последние две папки пути (например, `vs-code/my-app`).
   - **Instant Tooltip:** При наведении на сокращенный путь мгновенно всплывает полный адрес.
3. **Файлы:** Пользователь открывает Sidebar (`Cmd+B`) — полноценный file explorer из gt-editor.
   - Проводник открывается поверх терминала через React Portal (см. `methodology/сценарии-багов-design.md::6.3. UI поверх canvas: Portal или Layering Pattern`).
   - Поддержка: drag-and-drop файлов (Atlaskit), rename, create, delete (в корзину с undo), context menu, multi-select (Cmd/Shift+Click).
   - Ширина sidebar ресайзится drag handle (min 180px, max 500px), сохраняется в localStorage глобально.
   - Пользователь делает `Cmd+Click` по пути файла в терминале -> файл открывается в **File Preview**.
4. **Заметки:** Пользователь открывает заметку текущей вкладки в slide-out (`Cmd+E` или иконка `StickyNote` справа в активной вкладке TabSidebar). Подробнее: [`knowledge/fact-notes.md`](notes.md).

## Behavior Specs
- **Two-Column Layout:** `TabSidebar` (вертикальные вкладки + drag-resize ширины) слева + Terminal-колонка справа. Раньше была третья правая колонка `NotesPanel` (InfoPanel + Resizer) — удалена. Project tools поднялись наверх в `ProjectToolbar` (full-width 30px), Claude-контролы (Provider/Model/Effort/Think + Continue/Stop/Fork) переехали в `ClaudeControlBar` под Terminal (см. [`fact-claude-control-bar.md`](fact-claude-control-bar.md)), заметки переехали в slide-out (Cmd+E).
- **Sidebar Stability:** `TabSidebar` (левая колонка) остаётся смонтированной при переключении между Терминалом и Home. Компоненты (Timeline) не удаляются из DOM, а скрываются через `visibility`, что предотвращает Layout Shifts.
- **Persistent Mounting:** Workspace остается смонтированным всегда после первого открытия. Переход Dashboard ↔ Workspace осуществляется через CSS-скрытие. См. `knowledge/fact-terminal-rendering.md` (раздел 2).
- **Navigation History:** При закрытии активного проекта система не выбрасывает пользователя на Dashboard, а переключает на предыдущий проект из истории (Stack-based navigation).
- **Project Focus:** При активации области проектов (`activeArea`), панель получает подсветку `bg-white/[0.05]`, а активный проект — скругленную рамку `ring-1 ring-white/50`.
- **VSCode-style Creation:**
    - При `Cmd+T` или двойном клике создается проект "Новый проект".
    - Если пользователь отменяет ввод (`Esc`, клик мимо) или оставляет имя дефолтным — проект **автоматически удаляется** из БД и закрывается.
    - Система запоминает `previousProjectId` и возвращает пользователя назад при отмене.
- **Project Tabs UI:** Высота 40px, шрифт регулируется в настройках. Убраны лишние отступы и скругления для строгого вида.
- **Project Icons:** Иконка проекта — metadata самого project record (`projects.icon`), а не правило по basename/path как в gt-editor directory icons. В custom-terminal один и тот же путь может быть открыт как несколько независимых project identity, а переименование проекта не должно менять иконку; поэтому источник истины — `project.id` + SQLite metadata. Flow выбора скопирован по модели gt-editor: image/SVG file → cropper → 64×64 data URL → `updateProject({ icon })`; верхняя project tab читает это поле и показывает иконку перед именем.
    - **Settings order:** Редактирование иконок живёт в Settings → Проекты. Список сначала показывает только открытые проекты в порядке `openProjects` Map, то есть ровно как titlebar слева направо, но вертикально сверху вниз. Остальные проекты спрятаны за `Показать еще (N)`, чтобы текущий рабочий контекст не тонул в архиве БД. Не сортировать active-блок по имени/updated_at — это разрушит ментальное соответствие с верхним баром.
- **Explorer (Sidebar):** Автоматически открывается в CWD активного терминала. Портирован из gt-editor (PragmaticFileTree + Sidebar.jsx). Ключевые адаптации при портировании:
    - `onPointerDown` → `onClick` для file selection — иначе drag (Atlaskit) вызывает open file. Браузер отменяет `click` при pointer movement > 3px (drag threshold), что естественно разделяет click и drag.
    - Drop на файл отключён (`return` вместо "fallback to parent") — gt-editor перемещал файл в родительскую папку при drop на файл, что приводило к неожиданным перемещениям. Оставлен только drop на папку.
    - `window.electronAPI` bridge создаётся в renderer (nodeIntegration: true) вместо preload, т.к. custom-terminal не использует contextIsolation.
- **Empty State:** Если в проекте нет вкладок, отображаются быстрые кнопки (Claude, Gemini, New Tab).

## User Flow: Dashboard

Dashboard является стартовым экраном приложения, ориентированным на быстрый доступ к проектам и глобальный мониторинг AI-активности.

- **Project Selection:** Клик по карточке проекта загружает его контекст (терминалы, вкладки).
- **Process Monitoring:** В нижней части отображается панель активных процессов, разделенная на две колонки:
    - **Active Claude Processes:** Процессы `claude-code`. Подсветка оранжевым приглушенным фоном.
    - **Active Gemini Sessions:** Процессы `gemini`. Подсветка синим приглушенным фоном.
- **Stop Button Redesign:** Кружок статуса в карточке процесса (зеленый для In-App, dashed для External) при наведении на блок карточки превращается в красную кнопку остановки (квадрат). Это позволяет быстро гасить зависшие сессии.
- **Cleanup:** Из Dashboard удалены все вкладки (Prompts, Quick Commands), так как управление ими перенесено в настройки приложения.


