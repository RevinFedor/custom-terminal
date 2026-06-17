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
    - **CSP prerequisite:** Иконки хранятся как `data:image/png;base64,...`, поэтому renderer CSP обязан разрешать `img-src 'self' data: blob:`. Симптом отсутствующего `img-src`: в SQLite поле `projects.icon` непустое и PNG валиден, но `<img>` показывает broken-image placeholder, `naturalWidth=0`, а DevTools Security пишет `Refused to load the image 'data:image/...' because it violates default-src 'self'`. Для production одной правки DB недостаточно: установленный `app.asar` должен быть пересобран/переустановлен с новым `index.html`, иначе старый CSP продолжит блокировать data URL.
- **Explorer (Sidebar):** Автоматически открывается в CWD активного терминала. Портирован из gt-editor (PragmaticFileTree + Sidebar.jsx). Ключевые адаптации при портировании:
    - `onPointerDown` → `onClick` для file selection — иначе drag (Atlaskit) вызывает open file. Браузер отменяет `click` при pointer movement > 3px (drag threshold), что естественно разделяет click и drag.
    - Drop на файл отключён (`return` вместо "fallback to parent") — gt-editor перемещал файл в родительскую папку при drop на файл, что приводило к неожиданным перемещениям. Оставлен только drop на папку.
    - `window.electronAPI` bridge создаётся в renderer (nodeIntegration: true) вместо preload, т.к. custom-terminal не использует contextIsolation.
    - ПКМ по файлу содержит `Link File` submenu со списком текущих Claude/Codex/SDK-вкладок. Выбор не открывает editor внутри дерева, а создаёт `tabType='file'` рядом с выбранной вкладкой и связывает его через `visualParentTabId`. Это сделано для рабочего просмотра “нужный файл рядом с сессией”: пользователь не должен каждый раз открывать `Cmd+B`, если файл нужен как постоянный референс. Детали tab-side поведения — [`fact-tabs.md::Файловые вкладки как visual-child`](fact-tabs.md).
    - `Link File` submenu — nested floating surface: root context menu clamp'ится к viewport, а submenu отдельно считает доступную высоту до нижней границы и при нехватке места раскрывается вверх/влево. Не полагайся на z-index как фикс обрезки — если пункт у нижнего края окна, нужна геометрия, а не слой.
- **Empty State:** Если в проекте нет вкладок, отображаются быстрые кнопки (Claude, Gemini, New Tab).

## User Flow: Dashboard

Dashboard является стартовым экраном приложения, ориентированным на быстрый доступ к проектам и глобальный мониторинг AI-активности.

- **Project Selection:** Клик по карточке проекта загружает его контекст (терминалы, вкладки). ProjectCard компактная: первая строка держит иконку, имя и маленький счётчик вкладок; счётчик показывается всегда, даже если активных процессов нет. Вторая строка — короткий path более светлым серым, без лишней третьей строки.
- **Card Actions:** destructive/delete и settings живут в правом верхнем углу поверх названия и не резервируют ширину в layout. У них приоритет над текстом при hover, потому что это редкие точечные действия; основной клик по карточке остаётся открытием проекта.
- **Reserved Directories удалены:** отдельной сущности Bookmarks/Reserved Directories на Dashboard больше нет. Не возвращать `Add Directory` / `Reserved Directories` как быстрый способ создания проекта без нового продуктового решения.
- **Electron Dev processes:** сразу после Projects показываются лаконичные одно-строчные карточки dev Electron-приложений. Stop должен убивать root process + descendants, но не текущий `process.pid`; основной кейс — закрыть зависший Electron dev-процесс, чей parent terminal уже умер и который сам показывает бесконечные error modal.
- **Process Monitoring:** ниже идут Claude, Gemini и Codex секциями. Каждая секция ограничивает высоту и scroll локально; раскрытие показывает ограниченное число процессов, а не растягивает весь Dashboard. Protected процессы другого dev/prod instance видны с owner badge, но batch action помечен `external only` и не трогает их.
- **MCP servers:** список MCP ограничен по ширине и высоте, счётчик процессов читаемый. Orphan-логика связана с ownership всех живых custom-terminal instance, а не только текущего окна.
- **Cleanup:** Из Dashboard удалены все вкладки (Prompts, Quick Commands), так как управление ими перенесено в настройки приложения.
