# Feature: Settings & Prompts Management

## Intro
Модальное окно настроек (`Cmd+,`) является единым центром управления конфигурацией приложения, включая шрифты, цвета, горячие клавиши и параметры AI-агентов.

## User Flow: Настройка AI
1. Пользователь переходит на вкладку **"AI"**.
2. В левой колонке выбирает промпт из списка компактных карточек.
3. В правой колонке открывается **полноэкранный редактор** (Side Panel) на всю высоту окна.
4. **Behavior (Auto-save):** Изменения сохраняются мгновенно при:
    - Переключении на другой промпт в левой колонке.
    - Потере фокуса (`onBlur`) из полей "Название" или "Текст промпта".
    - Закрытии модального окна настроек.
5. **Visual Feedback:** При сохранении через `onBlur` рамка соответствующего инпута кратковременно мигает зелёным цветом (`#22c55e`).

## Claude Extended Thinking
Поддержка режима размышления для API Claude (версия 2025-04-15) с тремя уровнями интенсивности.

### Уровни
- **Low:** 5K токенов (быстрые размышления, ~30% увеличение latency)
- **Medium:** 16K токенов (сбалансированные размышления, ~60% latency)
- **High:** 50K токенов (глубокий анализ, ~120% latency, максимальный бюджет)

### Применение
Уровень Thinking выбирается в Settings → AI → Claude для каждого промпта и применяется при вызове Claude API (например, в Update API пайплайне).

## Behavior Specs
- **Static dimensions (900×85vh):** Размер модалки фиксирован для всех табов. Раньше ширина прыгала 900↔560px при переходе на/с AI-таба, что вызывало layout shift и сбивало позицию мыши. На 900px у лёгких табов (Шрифты/Цвета/Горячие) хватает места под двухколоночные сетки.
- **Двухколоночная сетка в Шрифтах:** `grid-template-columns: 1fr 1fr` (≈410px на колонку). Три колонки тестировали — описания типа «Cmd+/- для быстрой настройки» начинают переноситься/обрезаться.
- **Прочие шрифты UI в сетке:** Терминал, Сайдбар, Табы, Проекты, Превью файла, Prompt picker, Таймлайн (+ строки таймлайна). `Prompt picker` (`useUIStore.promptPickerFontSize`, default 12, 9-20) — управляет шрифтом Opt+V picker'а; паддинги и ширины панелей внутри picker'а скейлятся пропорционально, см. `fact-prompt-picker.md`.
- **Live-apply шрифтов без перезапуска:** изменение font-size в Settings должно сразу менять уже открытую поверхность после закрытия модалки и даже во время её открытия. Для React-поверхностей нельзя читать значение через `useUIStore.getState()` прямо в render/props: компонент не подпишется на поле, и пользователь увидит старый шрифт до случайного re-render или перезапуска вкладки. Для xterm canvas простого `term.options.fontSize = N` недостаточно: после записи option нужен принудительный measure/render clear/refresh и `safeFit()` в rAF, иначе canvas может сохранить старые метрики до remount. Пользовательский симптом: «настройка шрифта сохранилась, но видимый терминал/сайдбар меняется только после полного перезапуска».
- **Таймлайн (шрифт + строки) — нюансы.** «Таймлайн» (font-size 10-18, default 12, ключ `noted-terminal-timeline-font-size`) и «Таймлайн — строки» (line-clamp 1-10, default 3, ключ `noted-terminal-timeline-line-clamp`) применяются **только в expanded mode** (раскрытый chip+preview формат, через bывшую `treeMode`-кнопку в InfoPanel — см. [`fact-timeline.md::Expanded mode`](fact-timeline.md)). Font-size прокидывается каскадно через `style={{ fontSize: Npx }}` на root Timeline, потомки используют `em`. Line-clamp идёт в CSS `WebkitLineClamp` для текста превью **и** в формулу `containIntrinsicSize: auto ${lineHeight × clamp × fontSize + 12}px` для `content-visibility: auto` — иначе при clamp > 3 виртуализация неверно оценивает высоту off-screen entries и scrollbar дёргается. Контрол «Таймлайн — строки» использует тот же `FontSizeSlider` с опциональным параметром `suffix=""` (вместо «px»): добавлен специально потому что число строк — не px-значение, и `13px` рядом с line-count выглядел бы абсурдно. Когда `suffix=""` — отображается просто число.
- **Заметки вкладки (объединённая секция):** один блок с настройками всего что про `tab.notes`. Шрифт раздельный **по плотности контекста**: «Шрифт в сайдбаре» (inline в InfoPanel — компактное окружение), «Шрифт раскрытый» (slide-out — просторный редактор), «Шрифт в превью» (CMD+hover popover — отдельная балансировка над курсором). Padding X/Y общие (визуальный отступ редактора).
    - **Два независимых toggle «Номера строк» — по поверхности, не глобально.** В секции «Заметки» — toggle для **редактора** (`notesEditorShowLineNumbers` → `TabNotesSlideout`); в подсекции «Превью CMD+hover» — toggle для **превью** (`notesPreviewShowLineNumbers` → `TabPreviewPopover`, оба mount'а — hidden probe + visible). Оба default `true` (= прежнее поведение, package-дефолт `showLineNumbers=true`), персист в `localStorage` (`noted-terminal-notes-editor-line-numbers` / `noted-terminal-notes-preview-line-numbers`), setter'ы в `useUIStore`. Визуал — компонент `LineNumbersToggle` (green-pill геометрия, зеркалит `SidebarBehaviorToggles`), standalone-ряд под grid'ом своей секции, не ячейка `SettingsGrid4`. Раздельность обязательна: номера полезны в раскрытом редакторе (ссылаться на строку из чата, навигация по длинной заметке), но в тесном CMD+hover превью съедают горизонталь — юзер хочет регулировать их независимо. **Превью-toggle входит в deps `notesBox`-measure** в `TabPreviewPopover` (gutter меняет ширину контента → без пере-замера popover не подстроится). Редактор (slide-out) и превью — две из трёх density-поверхностей одного `tab.notes`; третья (inline в InfoPanel) сейчас не рендерит editor (мёртвый импорт). См. [`fact-notes.md::Номера строк`](fact-notes.md). CMD+hover превью: «Макс. ширина [resize]» (120-900px, default 200) — **disabled read-only** в Settings, задаётся перетаскиванием правого края превью (resize-ручка), отражается тут по факту; «Макс. высота» (80-900px, default 250) — обычный editable, до неё растёт высота, дальше scroll. Модель: **ширина фиксирована (resize), высота динамическая под контент**; короткий текст ужимается до natural-width (нет пустоты справа), длинный переносится в заданную ширину. Пропорция (RatioRow) удалена — autobalance по target-ratio душил ширину (см. `fact-tab-preview-popover.md::Sizing` graveyard). Принцип per-density шрифтов — `fix-notes-font-fragmentation.md::Постскриптум` + `methodology/переносимый-дизайн.md::Один контент в нескольких density-контекстах`. Sizing — `fact-tab-preview-popover.md::Sizing`, переносимый принцип — `methodology/переносимый-дизайн.md::Popover sizing переменного контента`.
- **Run after (шрифты + строки) — тоже density-поверхность.** «Шрифт чипа» (`noted-terminal-prompt-queue-chip-font-size`, 9-18, default 12) применяется к компактному списку карточек справа; «Шрифт раскрытый» (`noted-terminal-prompt-queue-editor-font-size`, 10-24, default 13) применяется к floating editor surface при клике/hover по чипу; «Строки в чипе» (`noted-terminal-prompt-queue-chip-line-clamp`, 1-10, suffix empty) управляет только line-clamp списка. Не сводить это к одному font-size: список — scan-density, редактор — edit-density, у них разные оптимальные размеры. Конкретика UI — `fact-prompt-queue.md::Editor surface: hover-preview + blur-save`.
- **Editable input в Stepper:** Контрол числа — `[−] 13px [+]` с **редактируемым inline-input**. На focus убирает suffix (`13px` → `13`) и делает select-all (юзер сразу пишет новое значение поверх). Enter / blur коммитят clamped число; Escape откатывает. Кнопки +/− по бокам для нудж'ей в единицу. Старый read-only `<div>13px</div>` заставлял использовать только +/− — для перехода с 10 на 30 это 20 кликов. Slider (`<input type="range">`) занимал ~90px высоты и был бесполезен для ±1px настроек.
- **Built-in metadata prompts:** `Tab Title`, `Run After Title`, `Prompt Summary` и utility prompt `Git Commit` живут в Settings → AI как обычные built-in prompts, но `showInContextMenu=false`: пользователь настраивает prompt/model/thinking, а контекстное меню ими не засоряется. Runtime выбирает их по stable id (`tab-title`, `run-after-title`, `prompt-summary`, `git-commit`), а не по display name: пользователь может переименовать строку как угодно, например `Заголов вкладки`, и auto-title не должен сломаться. Миграции для существующих БД только вставляют отсутствующую строку (`ensureTabTitlePrompt`, `ensureRunAfterTitlePrompt`, `ensurePromptSummaryPrompt`, `ensureGitCommitPrompt`) и не перезаписывают уже существующий name/content/model — эти prompts user-owned после первого появления. `Run After Title`, `Prompt Summary` и `Git Commit` default model = `gemini-3.1-flash-lite`, потому что это короткие metadata/utility-задачи для label/summary/commit message, не reasoning-turn.
- **AI usage stats для metadata/utility prompts и embedding:** правая колонка Settings → AI показывает локальный журнал вызовов `tab-title`, `run-after-title`, `prompt-summary`, `git-commit` и embedding-операций semantic search: totals, by prompt, by model и history за 7d/30d/all. Это **не billing-источник** и не retroactive parser старых JSONL; история начинается с момента логирования вызовов. Журнал пишет both success/error, чтобы failure API тоже объяснял "почему нет названия/пересказа/commit message/индекса". Gemini `usageMetadata` сохраняется раздельно: `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`; totals/by-model UI показывает input, output и thinking отдельными числами, не одним непрозрачным total. `thoughtsTokenCount` нельзя сливать в output: Gemini может вернуть thinking usage даже для короткого metadata prompt'а, и пользователь отдельно просил видеть расход thinking по моделям. Embedding-вызовы (`gemini-embedding-001`) попадают в **history** и **by model**, но не в **by prompt**, потому что у них нет пользовательски настраиваемого prompt'а; одна индексация логируется одной агрегированной строкой, а не пачкой batch-запросов.
- **Раскрывающиеся usage-карточки:** history row — сначала compact scan-card, по клику раскрывает проект, вкладку, iteration и `sourceChars`. Это debug surface для metadata-пайплайна, а не отчёт биллинга: старые строки до расширения схемы не backfill'ятся и честно показывают неизвестный project/tab/iteration. Клик по названию вкладки копирует `tabId`, потому что именно id связывает карточку с логами `[Timeline:Summary]` / `[TabTitle]`, а человекочитаемый title мог измениться после вызова. Для `Prompt Summary` `sourceChars` означает длину текущего user prompt'а, а не полный Gemini request с предыдущим контекстом; иначе пользователь видел бы рост символов от настройки контекста и не понимал бы вес собственного запроса.
- **Prompt Summary previous-context setting:** Settings → AI для built-in `Prompt Summary` содержит отдельный runtime slider «Предыдущие user-сообщения» (`0..10`, default `1`). Это не часть user-owned текста prompt'а: фиксированная системная обёртка сама объясняет Gemini, что предыдущие сообщения — только контекст, а текущий user prompt — цель пересказа. Настройка живёт рядом с prompt editor, потому что пользователь управляет точностью пересказа там же где model/prompt, но не должна сохраняться внутрь content prompt'а и ломать ручные формулировки при миграциях.
- **Gemini model list is shared:** Settings/API/Actions/Research/Edit surfaces используют один canonical list, соответствующий фактическому меню провайдера: `Flash 3.5` (`gemini-3.5-flash`), `Flash-Lite 3.1` (`gemini-3.1-flash-lite`), `Pro 3.1` (`gemini-3.1-pro-preview`), `Flash 3` (`gemini-3-flash-preview`). Не возвращай локальные двухэлементные массивы в отдельных компонентах: они уже дрейфовали, из-за чего часть prompt-поверхностей не видела новые модели.
- **Stale State Protection:** Использование локального React-стейта для всех 6 полей промпта предотвращает гонки при асинхронной записи в SQLite.
- **Persistence:** Последняя выбранная вкладка сохраняется в рамках сессии. При повторном открытии пользователь возвращается туда, где остановился.
- **Порядок табов:** `AI → Шрифты → Системные → Горячие клавиши → Проекты`. Горячие клавиши остаются справочной вкладкой в конце базовых настроек; «Проекты» добавлен последним как редкая metadata-операция над project entities, а не ежедневная настройка UI. Таб «Системные» (исторически назывался «Цвета») держит цветовую легенду + рантайм-настройки (сейчас — параллелизм семантической индексации, зеркала `CLAUDE.md`, Claude→Codex skills sync, дальше сюда же будут уходить аналогичные host-локальные knobs). Skills sync — host-local операция над `~/.claude/skills` и `~/.codex/skills`, не project state; детали copy/watch/YAML-нормализации в [`fact-skills-sync.md`](fact-skills-sync.md).
- **Auto-index для ProjectHome:** в Settings → Системные → «Семантическая индексация» есть два независимых toggle: `Auto Title` и `Auto Iterations`. Оба persist через `app_state`, потому что close/archive side-effect выполняет main process и не должен зависеть от renderer `localStorage`. При включении пишется `since` timestamp; auto-index обрабатывает только history-записи, закрытые после включения. `Auto Iterations` не создаёт live watcher активной вкладки: текущий Home index keyed by `tab_history.history_id`, поэтому корректная v1-точка — archive after close.
- **Уведомления вкладки / Системный звук:** в табе «Системные» отдельный toggle включает разовый системный звук при срабатывании уведомления завершения вкладки. По умолчанию включён, хранится как app-state `tabCompletionNotificationSound`, не в SQLite таба. Toggle гейтит только звук: native Notification и красный fired-state вкладки живут по контракту `fact-tabs.md::Уведомление о завершении вкладки`.
- **Вкладка «Проекты»:** Surface для project icons. Активный блок показывает открытые проекты в том же порядке, что titlebar; остальные проекты раскрываются через `Показать еще (N)`. Иконка выбирается как image/SVG file, затем обрезается через `IconCropper`; конкретика project-level поведения — `fact-workspace.md::Project Icons`.
- **Программное открытие на конкретный табе:** `window.dispatchEvent(new CustomEvent('settings:open', { detail: { tab: 'colors' } }))` — App.tsx слушает событие, выставляет `settingsInitialTab` и открывает SettingsModal. Используется ПКМ-ом на SemanticIndexButton; project context menu тем же механизмом открывает `tab: 'projects'` для пункта `Иконка проекта`. Сам Cmd+, продолжает уважать `lastActiveTab`.

## Auto-apply Toggle
Мини-тогл (22x12px) в секции System рядом с иконкой настроек (⚙). Управляет автоматическим применением изменений в Update API → Haiku пайплайне.

- **OFF (по умолчанию):** Haiku ждёт ручного ввода пользователя после загрузки анализа
- **ON:** Handshake автоматически отправляет `Ответь на промпт выше.` после `/model haiku` — Haiku начинает применение без ожидания
- **Персистентность:** `localStorage('noted-terminal-auto-apply-docs')`
- **Store:** `useUIStore.autoApplyDocs` / `setAutoApplyDocs()`

## Post-check Toggle
Второй тогл в поповере настроек (⌘+hover на ⚙). Лёгкая верификация плана после основного анализа — 3-строчный промпт, ловящий два слепых пятна:

1. **Шрамы формата данных:** Места в сессии где разработчик получил пустой ответ / ошибку парсинга, а потом выяснил, что формат данных отличался от ожидаемого.
2. **Засорение CLAUDE.md:** Проверяет, не предлагает ли план изменения в CLAUDE.md, которые не являются guard rail / anti-pattern / инфраструктурная инструкцией (фичи находятся через семантический поиск knowledge-файлов).

### Поведение по режимам
- **API режим (claude-api, gemini-api, gemini-cli):** Два последовательных API-запроса. Второй запрос содержит план из первого + промпт верификации. Результат post-check дописывается к основному ответу.
- **Gemini CLI режим:** После основного ответа `waitForGeminiSettled` ждёт IDLE, затем `terminal:paste` вставляет промпт верификации.

### Gemini CLI Response Detection (Buffer Inspection)
Для Post-check в режиме Gemini CLI используется `waitForGeminiResponse` с инспекцией буфера xterm.js.
- **Проблема:** Дебаунс PTY-потока (тишины) ненадежен, так как Gemini может мелькать спиннером на <1с или замирать на 5-10с при тяжелых расчетах.
- **Решение:** При получении события IDLE от Main-процесса, Renderer проверяет физическое наличие спиннера (Braille-символов) на экране через `terminalRegistry.hasSpinnerOnScreen(tabId)`.
- **Логика:** Если спиннер виден — ответ продолжается, система переходит в режим поллинга буфера (каждые 2с) до его полного исчезновения. Только после этого вставляется Post-check промпт.
- **Персистентность:** `localStorage('noted-terminal-post-check-docs')`
- **Store:** `useUIStore.postCheckDocs` / `setPostCheckDocs()`
- **Индикатор:** Фиолетовая точка (6px) в хедере System рядом с зелёной точкой auto-apply.

---

## Custom Drag-and-Drop (Pointer Events)

### Motivation (Invisible Intent)
Почему отказались от нативного HTML5 Drag-and-Drop API:
1. **Неуправляемый Ghost:** Браузер сам решает, как выглядит «призрак» элемента, что часто приводит к мерцанию или низкому качеству изображения на Retina-экранах.
2. **Snap-back анимация:** Нативный API принудительно проигрывает анимацию возврата элемента на исходное место при неудачном дропе, что визуально конфликтует с реактивным обновлением стейта в React.
3. **Layout Race:** При использовании анимированных gap-слотов нативный DnD часто ошибочно считает, что элемент «вышел» из зоны дропа из-за смещения координат под курсором.

### Техническая реализация
Для полной управляемости DnD переведен на **Pointer Events** (`onPointerDown` -> `window.onPointerMove` -> `window.onPointerUp`).
Для Prompt editor используется общий кросс-проектный паттерн
`~/Global-Templates/🧩 Code-Patterns/docs-projects/ux-паттерны/drag-and-drop.md`:
base-state + snapshot геометрии на старте drag, resolver считает цель по статичным
зонам. Общая нормализованная модель, resolver и pointer-session живут в
`packages/structured-dnd`; UI и SQLite остаются адаптерами приложения. Legacy rows
получают persistent `stable_id` (`prompt-<legacy id>`), поэтому reorder меняет position,
но не identity сущности.

`visual_parent_id` задаёт отдельную visual-иерархию prompt→prompt внутри одного
`group_id`; она не заменяет физическую группу. Вправо — один attach к предыдущему
peer той же глубины, влево — один outdent, вертикальный reorder сохраняет parent и
переносит descendants source как поддерево. При переходе между группами несовместимая
parent-связь очищается только у корня, descendants остаются вместе. Перед построением
дерева элементы обязательно сортируются по persisted `position`: после вертикальной
перестановки backing array может остаться в старом порядке, и чтение массива делало
следующий шаг вправо disabled либо выбирало не того предыдущего peer.

#### 1. Floating Clone Pattern (только не для grouped prompt editor)
При зажатии grip-иконки (6 точек):
- В `document.body` через Portal или прямой append создается физический клон ноды (`cloneNode(true)`).
- Клон получает `position: fixed` и следует за курсором через `top/left` или `transform`.
- Оригинальный элемент в списке скрывается (`display: none`), но сохраняет свое место в массиве.

Этот подход оставлен как исторический вариант для простых flat-list DnD, но в grouped
prompt editor он ретайрнут: пользователь видел две сущности одновременно — карточку
рядом с курсором и inline preview в списке. Для текстовых вставок должен жить только
inline preview внутри списка; сама перетаскиваемая карточка подсвечивается на месте.

#### 2. Static Midpoints (Фикс джиттера)
Ключевой «шрам» разработки: расчет целевой позиции ломался, так как preview переставлял
карточки прямо под курсором, вызывая циклическое переключение flat/group target.
Решение: snapshot всех зон (`midY`, header/body/nested rows) фиксируется один раз на
старте drag, а все последующие расчёты индекса используют эти статические координаты,
игнорируя реальное движение элементов в DOM.

#### 3. Атомарный Drop (Sync State Batching)
Live preview оказался неверным именно для пустой группы: после первого target группа
раскрывалась, физически уезжала из-под неподвижного курсора, и следующий move менял
решение обратно на flat-list. Поэтому prompt editor держит base geometry и последний
semantic target неизменными на протяжении жеста и применяет pending-state один раз на
`pointerup`. Это не отсутствие preview, а запрет использовать собственную layout mutation
как новый input; визуальная подсветка source/target не должна переставлять target DOM.
Выход за валидную геометрию одновременно снимает подсветку и очищает pending-state,
поэтому mouseup снаружи не применяет последнюю виденную цель.

## Prompt Groups (Группировка текстовых вставок)

Текстовые вставки (context menu prompts) поддерживают группировку. В контекстном меню терминала группа отображается как вложенный submenu.

### Shared Position Namespace
Группы и ungrouped промпты используют **единое пространство позиций**. Поле `position` в `prompt_groups` и `position` в `prompts` (для ungrouped) определяют порядок в одном плоском списке. Это позволяет свободно перемежать группы и промпты: `[Group A, Prompt X, Group B, Prompt Y]`.

**Важно:** поле `position` на промптах имеет **двойное назначение** в зависимости от `group_id`:
- `group_id = NULL` → `position` = позиция в плоском списке (shared namespace с группами)
- `group_id != NULL` → `position` = порядок внутри группы (intra-group, не участвует в flat ordering)

При сохранении (`savePrompts`, `savePromptGroups`) обе функции используют `p.position != null ? p.position : index` — если позиция задана явно, она сохраняется. Иначе fallback на array index. Шрам: ранее `savePromptGroups` всегда использовал array index, игнорируя `g.position`, что сбрасывало flat-порядок при каждом сохранении.

### Collapse Persistence
Состояние сворачивания (`is_collapsed`) группы сохраняется в БД, а не в React state. Переживает перезапуск приложения.

### Bulk Copy export
Кнопка `Copy` в шапке списка текстовых вставок копирует всю библиотеку как один markdown-документ, а не только названия. Формат намеренно повторяет mental model контекстного меню: `# Text Insertions`, затем `## Group: <name>` / `## Ungrouped`, внутри `### Prompt: <title>`, `Definition:` и fenced body. Если prompt привязан к файлам, export добавляет `Files:` и для каждого пути `#### File: <path>` + fenced содержимое файла; это не ссылка на файл, а тот же текстовый payload, который пользователь ожидает увидеть при вставке prompt'а с файлом. Если файл не прочитан, в export остаётся явная заглушка `(file could not be read)`, чтобы copy не выглядела полной.

UI-кнопка резервирует ширину под `Copy` / `Copied` / `Copying`, поэтому success-state не двигает соседние `Группа` / `Промпт`. Зелёный `Copied` живёт коротко как acknowledgement, без отдельного toast: пользователь просил быстрый bulk-copy рядом с количеством prompt'ов, а не вторую текстовую вставку в этом же блоке.

### Group Click Behavior (UX)
Обычный клик по всей строке группы сразу переключает collapse/expand; стрелка делает
то же локальное действие. Редактирование имени и описания открывается только правым
кликом, поэтому single-click не ждёт окна double-click и не имеет двух разных исходов
в зависимости от прошлого selection-state.

Вся строка draggable после movement-threshold, отдельной иконки из шести точек нет.
Внутри раскрытой пустой группы остаётся только прозрачная drop hit-area минимальной
высоты: текст «Перетащите сюда промпт» и кнопка «+ промпт в группу» удалены как
дублирование общего DnD и верхней команды создания prompt'а.

### Flat DnD: Gap Height для развёрнутых групп
Развёрнутая группа перемещается как один flat-container: header и все видимые
дочерние prompt'ы образуют source block, хотя в persisted flat-order группа остаётся
одной сущностью. Preview и crossing-zone используют высоту всего блока; отдельный
floating clone не рисуется. Иначе длинная группа пересекает соседа одним header'ом,
а дочерние строки визуально остаются на старом месте.

## Sidebar Behavior (Cmd+B)

Два toggle в Settings → Шрифты → блок «Сайдбар». Управляют поведением file explorer'а, открываемого через `Cmd+B`.

### Восстанавливать файл при открытии
- **OFF (по умолчанию):** При закрытии sidebar `openFilePath` обнуляется в БД и в store. Следующий `Cmd+B` открывает только дерево, без восстановления последнего просмотренного файла.
- **ON:** Старое поведение — путь сохраняется, при reopen файл подгружается.
- **Мотивация дефолта OFF:** Sidebar используется как быстрый picker, не как long-running view. Восстановление файла при каждом открытии — лишний шаг (закрыть файл → выбрать другой). Если нужен дольгий просмотр одного файла — toggle включается.
- **Store:** `useUIStore.sidebarPersistFile` / `localStorage('noted-terminal-sidebar-behavior')`.

### Закрывать кликом вне (overlay-режим)
- **ON (по умолчанию):** Sidebar работает как overlay — клик в любом месте вне самого `[data-sidebar-portal]` закрывает дерево. Клик по FilePreview справа тоже считается outside-click: пользователь уже ушёл из дерева в просмотр/редактор, поэтому дерево не должно оставаться поверх терминала.
- **DOM + rect guard для самого дерева:** из-за Portal/z-index/canvas layering нельзя полагаться только на `target.closest('[data-sidebar-portal]')`. Guard дополнительно проверяет координаты `mousedown` внутри `getBoundingClientRect()` сайдбара; иначе клик по строке дерева может быть классифицирован как outside-click, и пользователь видит «внутри дерева файлы тупо не открываются».
- **Capture-phase listener:** `mousedown` навешен с `useCapture=true`. Без capture canvas terminal (xterm) ловит событие первым через `pointer-events`, и обработчик на window не срабатывает. Известный pattern для overlay'ев поверх xterm — см. `methodology/сценарии-багов-design.md::6.3. UI поверх canvas: Portal или Layering Pattern`.
- **Store:** `useUIStore.sidebarOverlayCloseOnClickOutside`.

### Связанная логика в Workspace
- При `sidebarPersistFile=false` И закрытии sidebar — не только скрывается preview, но и `setOpenFilePath(activeProjectId, null)` пишется в БД. Без этого следующее открытие подтянуло бы старый путь из персиста.
- `sidebarPersistFile=false` **не** означает “закрывать любой sidebar preview пока дерево открыто”. Это только запрет auto-restore на следующем reopen. Прямой клик по файлу должен открыть и удержать preview; иначе логи показывают `SidebarFileOpen read-result success`, а следующий sync-effect сразу делает `closeFilePreview()` и пользователь видит чёрную область/ничего не открылось.
- `sidebarOpenForRender` toggle через `Cmd+B`. Слот `Cmd+E` исторически переходил: file-sidebar → prompt picker alias → toggle Tab Notes Slideout (с 16.05.2026). См. `fact-notes.md`.

## Close Button Identity
Кнопки закрытия панелей редактирования выделены в отдельный визуальный класс:
- **Стиль:** Фон `#2a2a2a`, тонкая граница `#393939`, паддинги `1px 7px`.
- **Семантика:** Это решение отделяет кнопку «Закрыть панель» от обычных кнопок «Очистить поле», которые часто располагаются справа от текстовых инпутов. Визуальный вес (border + background) сигнализирует о том, что это действие влияет на структуру окна, а не на содержимое поля.
