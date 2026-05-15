# Feature: Clipboard & Pasted Blocks

## Intro
Инструменты для бесшовной передачи данных из буфера обмена в AI-исследователь.

## User Flow
1. Пользователь копирует произвольный текст/код.
2. **AI Research:** В панели Gemini нажимает кнопку **"Буфер"** → Research или Compact. Контент отправляется в чат.
3. **Log Compression:** В `ProjectToolbar` (справа вверху) нажимает кнопку **"Logs"**. 
   - Система читает буфер обмена.
   - Очищает логи (Grafana/Console) от мусора.
   - Записывает результат обратно в буфер.
   - Показывает Toast с информацией о проценте сжатия. См. `fact-log-compression.md`.

## Behavior Specs
- **:::pasted Syntax:** Для вставки в чат используется кастомный разделитель `:::pasted`.
- **Collapsible Blocks:** В чате блоки, помеченные как `pasted`, по умолчанию отображаются в свернутом виде с кнопкой Toggle. Это экономит место при работе с большими дампами кода.
- **Preprocessing:** `MarkdownRenderer` перехватывает `:::pasted` сегменты ДО парсинга основным Markdown-движком.

## Global Copy Settings
Настройки копирования сессии (`includeEditing`, `includeReading`, `fromStart`, + иерархические флаги ниже) вынесены в глобальное состояние (`useUIStore`) с персистенцией в `localStorage`.
- **Индикация:** Текущие настройки отображаются в виде цветных точек на иконке 📋 на самой кнопке Copy session (см. ниже).
- **Единый стандарт:** Любые операции копирования (кнопка Copy session, массовый экспорт, двойной клик по диапазону в Timeline, ПКМ-«Копировать» по одиночной точке) используют одни и те же правила фильтрации.

## Copy Session: размещение и UX
Кнопка переехала из ActionsPanel («жирная плашка» во вкладке Quick Actions) в `InfoPanel` под блок AI Session — компонент [`CopySessionButton.tsx`](../../src/renderer/components/Workspace/CopySessionButton.tsx). **Почему перенесли:** старая плашка занимала первый screen Quick Actions без частоты использования, который оправдал бы место; новое расположение контекстное — chip живёт рядом с источником данных (session-блоком), пользователь видит, что копирует **эту** сессию.

**Визуальная форма — сегментированный chip:** `[📋] | [Copy session]`. Две независимые hover-зоны, разделённые divider'ом 1px:
- **📋-половина** (settings): hover → accent-tinted фон + открывает Settings popup слева (тот же hierarchical-tree с тогглами).
- **Copy-половина** (label): hover → accent-tinted фон + текст белый + полужирный. Клик копирует сессию.

Каждая половина имеет собственный hover-state, не наследуется от другой — иначе непонятно, что именно сейчас будет нажато. См. [`methodology/design-bugs.md::7. Hover affordance`](../methodology/design-bugs.md).

**CMD+hover на chip → single-line input снизу для custom session ID.** Это замена развёрнутой textarea-«модалки» (раньше клик по `▶` открывал блок с textarea + кнопкой Copy). Сейчас:
- Просто `<input>` высотой 26px, без заголовка/описания/footer-кнопки. Enter = copy + close, Esc = close.
- Ширина **динамическая**: от `chipRect.left` до левого края Timeline-strip (`[data-timeline]`) минус 8px. Перемеряется на `window.resize`. Без этого статичные 320px клипались за сайдбар.
- Принцип «single-line input вместо модалки» см. [`methodology/design-bugs.md::Минимализм popup'ов`](../methodology/design-bugs.md).

**CSS-bridge между chip'ом и input'ом.** Wrapper позиционирован **вплотную** к низу кнопки (`top: chip.bottom`), визуальный 4px gap создаётся через `paddingTop: 4` ВНУТРИ wrapper'а. Если задать `top: chip.bottom + 4` — между chip'ом и wrapper'ом возникает 4px мёртвая зона, popup закрывается при движении курсора сверху вниз. См. [`methodology/design-bugs.md::2.3 Wrapper смещён вниз от триггера`](../methodology/design-bugs.md).

**Индикаторные точки на 📋** показывают только «не-дефолтные» флаги: красные — если User/Claude отключены, цветные — если Reading/Editing/Bash/Tools включены (по дефолту OFF), синий — если `fromStart=false`. Юзер видит «что в копии есть подозрительного» одним взглядом без открытия Settings.

### Hierarchical Copy Groups
UI настроек копирования организован в три верхних блока — **User**, **Claude**, **Subagent** — с дочерними фильтрами внутри Claude и Subagent. Это переход от плоских пяти тогглов к семантическому дереву.

**Структура флагов:**
| Уровень 1 | Уровень 2 (children) | Дефолт |
|---|---|---|
| `includeUser` | — | ON |
| `includeClaude` | `includeText`, `includeThinking`, `includeReading`, `includeEditing`, `includeBash`, `includeTools` | ON / ON,ON,prev,prev,OFF,OFF |
| Subagent (master) | `includeSubagentResult`, `includeSubagentHistory` | OFF, OFF |
| — | `fromStart` (range, не content) | true |

**Дефолты Bash/Tools = OFF.** Старые пользователи имели только Reading/Editing тогглы. После иерархического апгрейда Bash и Tools — новые группы с дефолтом OFF, чтобы существующие пайплайны не получили внезапно 200 KB Bash-логов в `clipboard.writeText()`. Если юзер явно включил Bash раньше через старый Editing (хак: до фикса Bash сидел внутри `includeEditing`), его поведение мигрирует не идеально — это сознательная цена за чистую семантику.

**Tool → group mapping (`getToolGroup` в `main.js`):**
- `reading` ← Read, Grep, Glob, NotebookRead
- `editing` ← Edit, Write, NotebookEdit
- `bash` ← Bash, **Monitor** — Monitor берёт shell-команду параметром и стримит её stdout, семантически это long-running Bash, не «tool». Отделение в Tools создало бы false dichotomy (один тоггл для Bash, второй для «Bash-как-tool» — пользователь не поймёт разницу).
- `subagent` ← Task
- `tools` ← всё остальное: `mcp__*`, WebFetch, WebSearch, Agent, Skill, Cron*, ScheduleWakeup, RemoteTrigger, PushNotification, EnterWorktree, ExitPlanMode, ListMcpResources*. Новые tools по умолчанию попадают сюда — safe bucket.

**Почему MCP/Web/Agent не разделены на отдельные toggle:** дробление по семантике даёт 4-5 категорий с 1-2 вызовами в каждой. UI-сложность не оправдана. Если в будущем какая-то группа явно понадобится отдельно (например, Web для копирования web-research контекста без MCP-шума) — добавится подтоггл, структура расширяется.

**Master-toggle + incremental cascade.**
- Parent OFF → все children рендерятся `disabled` (значение сохраняется в store, UI-клик блокируется). Восстановление parent ON возвращает прежний выбор children.
- `Subagent` master синтезирован: `active = result || history`. Клик по нему: если оба OFF → включает только Result (минимальный полезный набор); если хоть один ON → выключает оба.
- Subagent.History ON форсирует Subagent.Result ON (история без финального результата теряет анкер для отображения). Subagent.Result OFF форсирует History OFF (зеркально). Принцип «incremental» сформулирован пользователем дословно: *«вкл туго последнее → выкл туго вся история, и наоборот»*. Принцип в `methodology/design.md::Master toggle + incremental children`.

**UI-лейблы child-тогглов = реальные имена tool из JSONL.** Раньше child назывались абстрактно (`Bash`, `Tools`) — пользователь не понимал разницу. Теперь рендерятся как код в monospace: `<code>Read</code> · <code>Grep</code> · <code>Glob</code>` для reading; `<code>Bash</code> · <code>Monitor</code>` + хинт `shell`; `<code>mcp__*</code> · <code>Web</code> · <code>Agent</code>` + хинт `MCP и прочее`. См. `methodology/design.md::Категориальные toggle — имена сущностей, не абстракции`.

**Indicator dot-логика на 📋:** красные точки при отклонении от дефолта в сторону «меньше» (User/Claude OFF — пользователь что-то намеренно исключил, потенциально неожиданно при копировании), цветные при отклонении в сторону «больше» (Bash/Tools/Sub-agent ON — добавлен extra-контент). Дефолтное состояние = ни одной точки.

**Невидимый контекст: callsites.** В Timeline все 4 IPC-вызова `copy-range` спредят единый объект `copyFlags` — добавление нового флага не требует обхода всех callsites. Rewind-path (`Phase 1: copy → Gemini compact`) намеренно НЕ передаёт `copyFlags` — для compact-сводки нужен полный контекст диалога, не отфильтрованный пользовательскими настройками.

## Unified Formatting (main.js)
Для обеспечения консистентности данных, логика формирования текста (обработка `thinking` блоков, форматирование `diff` и `tool_use`) вынесена в общую функцию `formatToolAction` в Main-процессе. 
- **Range Copy:** При двойном клике в Timeline система теперь не просто копирует префикс, а выполняет полноценный Backtrace для поиска `tool_result` и вставляет полное содержание файлов/диффов, если это включено в глобальных настройках.
- **Actions Block:** Форматирование списка действий (`**Actions:**`) унифицировано для всех видов экспорта.

