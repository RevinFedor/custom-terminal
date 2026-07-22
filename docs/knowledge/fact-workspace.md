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
3. **Файлы:** Пользователь открывает Sidebar (`Cmd+B`) — общий Noted file explorer, не компонент GT Editor.
   - Проводник открывается поверх терминала через React Portal (см. `methodology/сценарии-багов-design.md::6.3. UI поверх canvas: Portal или Layering Pattern`).
   - Поддержка: общий structured DnD файлов и иерархии, rename, create, delete, context menu, multi-select (Cmd/Shift+Click).
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
- **Inbox system workspace:** `Inbox` закреплён между Home и обычными проектами как project-like workspace, а не как отдельная Home-страница. Это дефолтный контейнер для API-созданных и «непривязанных» agent-вкладок: он использует ту же поверхность Workspace/ProjectHome/Timeline/History/Run after, чтобы tabs/groups/status не расходились во второй модели. Отличается только chrome: нет файлового sidebar, browser/editor/index/docs-кнопок, rename/delete/close как у обычного проекта. Перетаскивание live-вкладок в Inbox — это перенос владения через существующий cross-project move, не clone/copy PTY/SDK-сессии; безопасного клона live-сессии в проекте нет.
- **Project Icons:** Иконка проекта — metadata самого project record (`projects.icon`), а не правило по basename/path как в gt-editor directory icons. В custom-terminal один и тот же путь может быть открыт как несколько независимых project identity, а переименование проекта не должно менять иконку; поэтому источник истины — `project.id` + SQLite metadata. Flow выбора скопирован по модели gt-editor: image/SVG file → cropper → 64×64 data URL → `updateProject({ icon })`; верхняя project tab читает это поле и показывает иконку перед именем.
    - **Settings order:** Редактирование иконок живёт в Settings → Проекты. Список сначала показывает только открытые проекты в порядке `openProjects` Map, то есть ровно как titlebar слева направо, но вертикально сверху вниз. Остальные проекты спрятаны за `Показать еще (N)`, чтобы текущий рабочий контекст не тонул в архиве БД. Не сортировать active-блок по имени/updated_at — это разрушит ментальное соответствие с верхним баром.
    - **Project order ownership:** Порядок открытых проектов принадлежит renderer `openProjects` Map, а не SQLite `updated_at`. Drag reorder вызывает `reorderProjects`, сохраняет session order и шлёт `project:order-changed` для native clients. Mobile/iOS после этого заново читает `/api/projects`; он не должен выводить порядок из project-activity runtime списка.
    - **CSP prerequisite:** Иконки хранятся как `data:image/png;base64,...`, поэтому renderer CSP обязан разрешать `img-src 'self' data: blob:`. Симптом отсутствующего `img-src`: в SQLite поле `projects.icon` непустое и PNG валиден, но `<img>` показывает broken-image placeholder, `naturalWidth=0`, а DevTools Security пишет `Refused to load the image 'data:image/...' because it violates default-src 'self'`. Для production одной правки DB недостаточно: установленный `app.asar` должен быть пересобран/переустановлен с новым `index.html`, иначе старый CSP продолжит блокировать data URL.
- **Explorer (Sidebar):** Автоматически открывается в CWD активного терминала. Renderer и DnD приходят из нейтрального `../noted-shared`; локальных PragmaticFileTree-копий и re-export shims больше нет. Custom Terminal оставляет у себя filesystem IPC, file-tab и `Link File` как адаптеры продукта.
    - Ручной порядок и visual-parent связи синхронизируются с GT Editor через `~/.noted-terminal/shared/file-layout.db`, keyed по абсолютному корню проекта. CAS revision защищает одновременные записи двух Electron-процессов; focus/visible polling подхватывает чужое изменение. Expansion, selection, focus и scroll намеренно локальны — это состояние конкретного viewport, а не проекта.
    - Shared DB может иметь непустую revision с пустым payload после очистки/E2E restore. Это не ручная сортировка: manual mode включается только при реальном order/visual-parent entry.
    - Каждый consumer явно принимает одну версию `noted-shared`; build прекращается при несовпадении либо возвращении app-local копии. Renderer-код бандлится Vite из нейтрального checkout, а main-process layout/atomic-move модули копируются в production resources явно. React, `lucide-react` и `react-icons` резолвятся из consumer: общий source не может принести второй React или случайный minor UI-runtime.
    Ключевые адаптации приложения:
    - Pending `pointerdown` не захватывает pointer до movement-threshold, поэтому обычный click доходит до файла/папки и вложенных контролов. После доказанного drag общий слой подавляет только post-drag click.
    - Файл и папка используют тот же outline-контракт: файл может быть visual-parent, папка остаётся физическим parent. Общий preview показывает будущую иерархию до release, а host решает, нужен ли layout-only commit или filesystem batch.
    - `window.electronAPI` bridge создаётся в renderer (nodeIntegration: true) вместо preload, т.к. custom-terminal не использует contextIsolation.
    - Базовые пункты ПКМ, их порядок, viewport-clamp и Rename pencil принадлежат общему menu shell; наличие action callback является capability. `Open in Finder` остаётся OS reveal через host callback, а не открытием file preview. Для файла Finder выделяет сам файл; для папки — саму папку в родителе. Та же операция должна быть доступна у прикреплённой file-tab, чтобы “найти файл в Finder” не требовало возвращаться в дерево.
    - ПКМ по файлу содержит `Link File`, который открывает тот же AI-tab inventory picker, что `Run after` / `Restart after`, но в context-row режиме. Выбор не открывает editor внутри дерева, а создаёт `tabType='file'` рядом с выбранной Claude/Codex/SDK-вкладкой и связывает его через `visualParentTabId`. Это сделано для рабочего просмотра “нужный файл рядом с сессией”: пользователь не должен каждый раз открывать `Cmd+B`, если файл нужен как постоянный референс. Детали tab-side поведения — [`fact-tabs.md::Файловые вкладки как visual-child`](fact-tabs.md).
    - `Link File` является host-only extension общего меню и больше не имеет собственного списка/геометрии submenu. Он зависит от `RunAfterTabPicker`: проекты/группы/порядок вкладок должны совпадать с остальными AI-target picker'ами, а outside-click root menu обязан игнорировать клики внутри picker portal. В GT Editor этой команды нет по контракту, а не потому что она вручную скрыта стилями.
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
