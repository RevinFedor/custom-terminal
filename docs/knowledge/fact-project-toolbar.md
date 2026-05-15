# Feature: ProjectToolbar (per-project top bar)

## Intro
30px-полоса в самом верху workspace'а активного проекта (`src/renderer/components/Workspace/ProjectToolbar.tsx`). Содержит per-project actions, которые не относятся к конкретному табу. Порядок слева направо фиксирован — пользовательский muscle memory строится на нём.

## Layout

| Кнопка | Иконка | Действие |
|---|---|---|
| Home | `Home` (lucide) | Toggle между Project Home view и terminal view. Подсвечена когда `currentView === 'home'`. |
| Compress | `Minimize2` (lucide) | Сжать логи из буфера обмена (см. `utils/compressLogs.ts`). |
| Browser | `Globe` (lucide) | Открыть в-проектный browser-таб. |
| VS Code | `VscVscode` (`react-icons/vsc`) | `exec('code .', { cwd })` — cwd активного таба или fallback на `project.path`. |
| SemanticIndex | переменная (см. ниже) | Статус `.semantic-index.json`; клик = переиндексация. |
| Resume All | `RotateCcw` + badge | Появляется ТОЛЬКО если `interruptedTabs.length > 0` для текущего проекта. |

**Что было до и почему изменилось:** до этой сессии VS Code был привязан к хоткею `Cmd+.` без UI-кнопки. Хоткей был неоткрываемым (юзер на него натыкался случайно), плюс конфликтовал с системными окнами, которые тоже слушают `Cmd+.`. Решение — снять хоткей полностью (в `src/renderer/App.tsx` весь блок удалён, в `SettingsModal::SHORTCUTS` строка `⌘ + \` снята; реальный хоткей вообще был на `.`, не `\` — там в любом случае было расхождение текста и кода) и добавить видимую кнопку. Cmd+. больше нигде не висит.

## SemanticIndex visual language

Цвет = sentiment, не информация. Информация — цифры справа от иконки.

| Состояние | Иконка | Цвет | Текст |
|---|---|---|---|
| Idle, всё актуально | `CircleCheck` зелёный | `#22c55e` | `<fresh>` (одно число) |
| Idle, есть устаревшие/новые | `CircleCheck` зелёный + `AlertTriangle` амбер | `#22c55e` + `#d97706` | `<fresh>` ⚠ `<stale+new>` |
| Idle, индекса нет | `AlertTriangle` амбер | `#d97706` | `no index` |
| Running | `Loader2` амбер (вращение) | `#d97706` | `<done>/<outdated_total>` |

**Янтарный, не жёлтый** — `#d97706` (`amber-600` в Tailwind palette). По правилу из CLAUDE.md секция «AI-Optimized UI & Video Forensics»: чистый жёлтый плохо читается на тёмной теме, янтарь сохраняет читаемость и в скринкастах.

**Почему cached не считается в running-счётчике** — см. `methodology/design.md::Прогресс-индикатор показывает active work, не total volume`. Кратко: cached пролетают за миллисекунды, и `5/90` создаёт иллюзию «осталось много» там, где реально осталось 5.

**Tooltip разбивка** — показывает все три числа отдельно (`fresh / stale / new`) плюс `docsTotal` / `indexedTotal` для отладки. В running-режиме — `currentFile` (последний файл, который скрипт начал индексировать).

## Watcher lifecycle (main)

Один `fs.watch`-treeset на каждый открытый проект, **не только на активный**. Это контринтуитивно (кнопка-то рендерится в ProjectToolbar активного проекта), но необходимо для двух сценариев:

1. **Пользователь правит docs в IDE с открытым проектом A**, потом переключается на проект B и обратно — должен сразу увидеть актуальные числа на A без задержки на recompute при возврате.
2. **Mobile bridge / sub-agent** в другом проекте триггерит правку — индикатор обновляется в реальном времени, юзер не должен дёргать кнопку «обновить статус».

Lifecycle:
- App.tsx подписан на `useWorkspaceStore` + `useProjectsStore` (Zustand subscribe, не useEffect — иначе теряется реактивность на mid-cycle add/remove). При появлении нового projectId в `openProjects` keys → IPC `semantic-index:watch`. При исчезновении → `semantic-index:unwatch`.
- В main `startWatching` рекурсивно walk'ает `docs/` (исключая `tmp/`, `.dot-папки`) и навешивает `fs.watch` на каждую директорию + ещё один на корень проекта (ловит ре-запись `.semantic-index.json` атомарным `>` из build-index.sh).
- Debounce 300ms перед recompute (избегает 90 пересчётов когда индексатор переписывает индекс одним write).
- При quit'е процесса — `process.on('exit', cleanupAll)` снимает все watcher'ы.

**Trade-off:** одновременно 5 проектов = 5 × N директорий watcher'ов. У `fs.watch` на macOS лимит FSEvents практически бесконечный (тысячи), для 5-10 проектов с 3-5 поддиректориями каждая — это десятки, не сотни.

## Rebuild validation

`build-index.sh` всегда экзитит **0**, даже если внутри половина файлов упали (haiku 429, malformed JSON, timeout). Поэтому success-валидация в `semantic-index-status.js::rebuildIndex` собирает 6 сигналов:

```
success = code===0
       && !signal
       && sawSummary
       && summaryErrors===0
       && summaryWarnings===0
       && perFileBad===0
```

Где:
- `sawSummary` — поймали строку `Files indexed: X/Y (cached: ..., err: N)`. Если её нет — скрипт прервался посреди процесса (типичная причина: `CLAUDE.md.bak уже существует` early exit).
- `summaryErrors` — `err:` поле в summary.
- `summaryWarnings` — `warn:` поле (это «wrapped» — Claude отдал не-JSON, файл записан с пустыми `implicit:[]`, де-факто бесполезен для роутера).
- `perFileBad` — счётчик `error|missing|wrapped` событий из stdout (дублирует summary, страховка от случая, когда summary врёт о собственных полях).

См. `methodology/design.md::Success ≠ exit code: валидация по содержимому, не по факту завершения`.

**Pre-flight гарда:** перед spawn'ом проверяем `CLAUDE.md.bak` в корне. Если существует — отказываемся стартовать с тостом «delete it before rebuilding (previous run crashed)». Без этой проверки скрипт сам бы вышел с `exit 1` (там есть свой check), но в UI это бы выглядело как «короткий лоадер → красный тост `exit code 1`» без понятной причины — пользователь не должен открывать лог чтобы выяснить почему.

## stdout-маркеры скрипта

Прогресс парсится из stdout по 4 regex-ам — это публичный контракт между `build-index.sh` и main. Менять формат строк нельзя без синхронной правки regex-ов:

| stdout-строка | Используется для |
|---|---|
| `Found <N> files to index[...]` | Установить `total` (общий объём). |
| `[launched <i>/<N>] <relpath>` | `outdatedTotal++`, добавить файл в `launchedFiles` Set. |
| `<kind> <relpath> [<time>]` где kind ∈ {`ok`,`cached`,`wrapped`,`error`,`missing`} | Если kind ≠ `cached` И файл был в launchedFiles → `outdatedCompleted++`. |
| `Files indexed: <X>/<Y> (cached: <C>, skip: <S>, warn: <W>, err: <E>)` | `sawSummary=true`, `summaryWarnings=W`, `summaryErrors=E`. |

ANSI escape codes (`\x1b[0;32m` и т.п.) стрипаются регексом перед матчингом.
