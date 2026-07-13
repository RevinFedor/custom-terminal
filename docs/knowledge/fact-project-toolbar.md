# Feature: ProjectToolbar (per-project top bar)

## Intro
30px-полоса в самом верху workspace'а активного проекта (`src/renderer/components/Workspace/ProjectToolbar.tsx`). Левая часть содержит per-project actions; правый кластер может показывать явно session-owned действия активной AI-вкладки. Порядок слева направо фиксирован — пользовательский muscle memory строится на нём.

## Layout

| Кнопка | Иконка | Действие |
|---|---|---|
| Home | `Home` (lucide) | Toggle между Project Home view и terminal view. Подсвечена когда `currentView === 'home'`. |
| Compress | `Minimize2` (lucide) | Сжать логи из буфера обмена (см. `utils/compressLogs.ts`). |
| Browser | `Globe` (lucide) | Открыть в-проектный browser-таб. |
| VS Code | `VscVscode` (`react-icons/vsc`) | `exec('code .', { cwd })` — cwd активного таба или fallback на `project.path`. |
| GT Editor | `FileEdit` (lucide) | `shell.openExternal('gteditor://open?folder=<cwd>')` — фокусирует уже запущенный GT Editor (или cold-launch'ит) через macOS LaunchServices URL scheme. Если cwd не зарегистрирована в `gt-directories` — gt-editor добавит молча. Внутри редактора `Ctrl+G` принимает `path:line:col` — паттерн «скопировал ссылку на ошибку из терминала → Cmd-кликнул сюда → Ctrl+G → paste → Enter». |
| SemanticIndex | переменная (см. ниже) | Статус `.semantic-index.json`; клик = переиндексация. |
| Resume All | `RotateCcw` + badge | Появляется ТОЛЬКО если `interruptedTabs.length > 0` для текущего проекта. |
| *— flex spacer —* |  | Дальнейшие кнопки прижаты к правому краю. |
| External run settings | `Settings` (lucide) | Появляется только на активной Inbox-вкладке, созданной внешним Codex run. Управляет видимостью бейджа, auto-stop процесса и auto-close вкладки. |
| Docs | `BookOpen` (lucide) | Popover с `ActionsPanel embedded` (Update Docs / Update API → Haiku pipeline). Раньше жил в InfoPanel-сайдбаре `КОМАНДЫ`-блоком — после удаления правой колонки переехал сюда. |
| Git | `GitBranch` (lucide) | Появляется только в Git-репозитории, показывает `branch + changed count`; клик открывает project-level панель commit/history/branches/push. Детали: [`fact-git-коммиты.md`](fact-git-коммиты.md). |
| Timeline AI cluster | `groups` / `AI` / `tab` / `all` | `groups` вручную пересобирает outline всей текущей Claude/Codex-сессии; `+N` показывает новые несгруппированные ходы. `AI` перегенерирует per-turn labels, `tab`/`all` задают auto-policy только для новых prompt'ов. |
| Copy session + chips | `Copy` + 9-chip row | `CopySessionButton` + ряд чипов выбора секций (👤/✦/answer/thinking/read/edit/bash/mcp/⑂fork/sub-pill) в **две** строки чтобы не растягивать toolbar по высоте. Рендерится ТОЛЬКО когда у активной вкладки есть Claude/Gemini-сессия — toolbar collapses gracefully на Home / browser-табах. |

Timeline-кластер стоит в project toolbar только как постоянная точка входа; owner всегда явно вычисляется из активной вкладки. Loader, error и `+N` привязаны к `toolType + sessionId`, а не к `activeProjectId`: переключение вкладки во время AI-запроса не должно применить поздний результ к новой сессии. Полная семантика — [`fact-группировка-таймлайна.md`](fact-группировка-таймлайна.md).

**Pair-aligned popover'ы.** Оба popover'а (Docs и Copy-session) открываются downward-right-aligned относительно триггера: `top: bRect.bottom + 6, right: window.innerWidth - bRect.right`. Это сохраняет одну нижнюю горизонталь между двумя popover'ами, и убирает зависимость от viewport-left-edge (раньше Copy popover открывался центр-влево от триггера — на правом краю окна он мог вылетать за viewport). Статичное правило, а не runtime-расчёт «куда умещается»: проще для предсказуемого muscle memory, минус один источник позиционных багов.

**Что было до и почему изменилось:** до этой сессии VS Code был привязан к хоткею `Cmd+.` без UI-кнопки. Хоткей был неоткрываемым (юзер на него натыкался случайно), плюс конфликтовал с системными окнами, которые тоже слушают `Cmd+.`. Решение — снять хоткей полностью (в `src/renderer/App.tsx` весь блок удалён, в `SettingsModal::SHORTCUTS` строка `⌘ + \` снята; реальный хоткей вообще был на `.`, не `\` — там в любом случае было расхождение текста и кода) и добавить видимую кнопку. Cmd+. больше нигде не висит.

## External Codex run settings

Кнопка настроек external run — локальный control активной Inbox-вкладки, а не общая настройка проекта. Внешний клиент (например Voice Record) владеет своим чатом, но Noted Terminal владеет видимой Codex-вкладкой, поэтому пользователю нужен быстрый доступ именно здесь: свернуть/развернуть бейдж external run, изменить stop процесса в секундах и закрытие вкладки в минутах.

Stop процесса и close вкладки — разные оси. Stop завершает Codex runtime после `done`, а close убирает визуальную вкладку после отдельного countdown, чтобы system Inbox не копил старые external runs. Collapsed badge оставляет маленький статусный маркер без захвата высоты терминала; развёрнутый badge показывает источник, process countdown и tab countdown.

Видимость кнопки не должна зависеть только от живой app-server metadata: при hot reload/restart renderer может восстановить вкладку раньше, чем external-run map снова появится. Поэтому `externalRun` сериализуется в SQLite, а для старых Inbox Codex-вкладок toolbar имеет fallback по признаку `Inbox + commandType=codex + name starts "Codex ·"`. Без этого пользователь видит выбранную `Codex · ...` вкладку на Home-виде, но кнопки настроек нет вообще.

## SemanticIndex visual language

Цвет = sentiment, не информация. Информация — цифры справа от иконки.

| Состояние | Иконка | Цвет | Текст |
|---|---|---|---|
| Idle, всё актуально | `CircleCheck` зелёный | `#22c55e` | `<fresh>` (одно число) |
| Idle, есть устаревшие/новые/удалённые | `CircleCheck` зелёный + `AlertTriangle` амбер | `#22c55e` + `#d97706` | `<fresh>` ⚠ `<stale+new+removed>` |
| Idle, индекса нет | `AlertTriangle` амбер | `#d97706` | `no index` |
| Running | `Loader2` амбер (вращение) + фиолетовый чип параллелизма | `#d97706` + `#a855f7` | `<done>/<outdated_total>` ×`<parallelism>` |

**Третий чип (фиолетовый ×N) появляется только в Running.** Стартует как `×1`, затем обновляется из live MCP progress (`active` воркеры). На scan-фазе `workerLimit` может быть больше 1, но чип не поднимается до `×2/×3`, пока MCP реально не запустил столько Codex-процессов одновременно. При смене настройки mid-rebuild чип остаётся привязан к текущему progress — новое N применится к следующему запуску.

**ПКМ на кнопке → открывает Settings на вкладке «Системные».** Реализовано через `window.dispatchEvent(new CustomEvent('settings:open', { detail: { tab: 'colors' } }))`; App.tsx слушает событие, выставляет `settingsInitialTab` и открывает модалку. Mechanism work for всех состояний кнопки (idle/no-index/running). Без этого юзеру пришлось бы помнить путь Cmd+, → таб «Системные».

**Янтарный, не жёлтый** — `#d97706` (`amber-600` в Tailwind palette). По правилу из CLAUDE.md секция «AI-Optimized UI & Video Forensics»: чистый жёлтый плохо читается на тёмной теме, янтарь сохраняет читаемость и в скринкастах.

**Почему cached не считается в running-счётчике** — см. `methodology/переносимый-дизайн.md::Прогресс-индикатор показывает active work, не total volume`. Кратко: cached пролетают за миллисекунды, и `5/90` создаёт иллюзию «осталось много» там, где реально осталось 5.

**Tooltip разбивка** — показывает числа отдельно (`fresh / stale / new / removed`) плюс `docsTotal` / `indexedTotal` для отладки. В running-режиме — `activeWorkers/workerLimit` и `currentFile` (последний файл, который MCP начал индексировать).

## Watcher lifecycle (main)

Один `fs.watch`-treeset на каждый открытый проект, **не только на активный**. Это контринтуитивно (кнопка-то рендерится в ProjectToolbar активного проекта), но необходимо для двух сценариев:

1. **Пользователь правит docs в IDE с открытым проектом A**, потом переключается на проект B и обратно — должен сразу увидеть актуальные числа на A без задержки на recompute при возврате.
2. **Mobile bridge / sub-agent** в другом проекте триггерит правку — индикатор обновляется в реальном времени, юзер не должен дёргать кнопку «обновить статус».

Lifecycle:
- App.tsx подписан на `useWorkspaceStore` + `useProjectsStore` (Zustand subscribe, не useEffect — иначе теряется реактивность на mid-cycle add/remove). При появлении нового projectId в `openProjects` keys → IPC `semantic-index:watch`. При исчезновении → `semantic-index:unwatch`.
- В main `startWatching` рекурсивно walk'ает `docs/` (исключая `tmp/`, `.dot-папки`) и навешивает `fs.watch` на каждую директорию + ещё один на корень проекта (ловит ре-запись `.semantic-index.json` после MCP `docs_reindex`).
- Debounce 300ms перед recompute (избегает 90 пересчётов когда индексатор переписывает индекс одним write).
- При quit'е процесса — `process.on('exit', cleanupAll)` снимает все watcher'ы.

**Trade-off:** одновременно 5 проектов = 5 × N директорий watcher'ов. У `fs.watch` на macOS лимит FSEvents практически бесконечный (тысячи), для 5-10 проектов с 3-5 поддиректориями каждая — это десятки, не сотни.

## Rebuild via MCP

SemanticIndexButton не запускает repo-local shell script. Клик идёт так:

```
SemanticIndexButton
  → ipcRenderer.invoke('semantic-index:rebuild', { projectId, parallelism })
  → semantic-index-status.js::rebuildIndex()
  → node ~/.claude/mcp/knowledge-server.mjs
  → MCP tools/call docs_reindex({ projectPath, parallel, provider: 'codex' })
```

Source of truth для индексации — knowledge MCP. Repo-local shell-индексатор удалён из проектов, чтобы не было второго индексатора с отдельными лимитами/моделями. MCP `docs_reindex` по умолчанию использует `codex exec` (`gpt-5.4-mini`, effort `low`) и при включённых kill-switch'ах коэрсит Gemini/Claude provider/model в Codex.

`semantic-index-status.js` сам является маленьким MCP JSON-RPC клиентом: спавнит `knowledge-server.mjs`, отправляет `initialize`, затем `tools/call docs_reindex`, парсит text-result как JSON и уже из `success/error/summary/failures` строит toast. Старый контракт stdout-regex'ов больше не используется. Live progress идёт отдельными строками stderr с marker `__KNOWLEDGE_REINDEX_PROGRESS__`; это side-channel, финальный JSON-RPC result остаётся source of truth.

**PATH augmentation для production spawn:** production `.app` запускается launchd'ом с минимальным PATH `/usr/bin:/bin:/usr/sbin:/sbin` — без Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) и user-local (`~/.local/bin`, `~/.codex/bin`). MCP path добавляет эти директории перед оригинальным PATH, чтобы найти `node` и `codex`.

**Failure semantics:** success берётся из результата `docs_reindex`, не из exit code MCP process. Если MCP вернул `success:false`, renderer получает красный toast с `result.error`; `.semantic-index.json` не должен перезаписываться частичным/битым индексом.

**Parallelism wiring (Settings → Системные → Параллельные воркеры):**

- `useUIStore.semanticIndexParallelism` (localStorage-only, 1..20, default 10).
- При клике на SemanticIndexButton renderer передаёт значение в `semantic-index:rebuild` IPC.
- `rebuildIndex(projectId, mw, { parallelism })` в main clamp'ит к [1, 20], сохраняет live snapshot и передаёт `parallel` в MCP `docs_reindex`.
- `rebuild-started` IPC payload сидит на `parallelism: 1` и `workerLimit`; renderer показывает `0/N ×1` сразу, без ожидания `get-status`.
- `semantic-index:progress` обновляет `outdatedCompleted`, `activeWorkers`, `workerLimit` и live `parallelism` по MCP marker'ам.
- `get-status` возвращает `rebuildParallelism` — переключение проекта mid-rebuild не теряет чип.
- Не доверяем raw значению из renderer (вдруг кто-то bypass'ит UI) — clamp на main-стороне обязателен.

ANSI escape codes (`\x1b[0;32m` и т.п.) стрипаются регексом перед матчингом.
