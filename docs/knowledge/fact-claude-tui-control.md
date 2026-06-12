# Факт: Управление Claude Code TUI из приложения

## Проблема
Claude Code CLI работает на базе Ink (React TUI) в raw mode с включённым **bracketed paste mode**. Это означает:
- `\r` (CR) и `\n` (LF), отправленные через PTY → **не сабмитят ввод**, а создают новую строку
- Обычный `\t` (Tab) → не переключает thinking mode (нужен `meta+t`)
- Slash-команды (`/model`, `/compact` и т.д.) — обычный текстовый ввод, парсится после Enter

**Поисковые симптомы:** startup default model висит на `❯ 1. Yes, switch to Haiku`; после успешного model switch не вводится `/effort max`; `/effort` уходит в период `Switch model?` confirmation; model/effort dialogs подавляют друг друга cooldown'ом; return из `safePasteAndSubmit` наступил, но Claude TUI ещё не применил настройку.

## Решение: Bracketed Paste + Delayed Enter

### Отправка команд (IPC `claude:send-command`)
Выполняется через универсальный механизм `safePasteAndSubmit` (см. ниже).

**Почему именно так:**
- Ctrl+C безопаснее Ctrl+U — очищает многострочный ввод, одиночное нажатие не выходит из Claude
- Paste brackets нужны потому что Ink в raw mode иначе обрабатывает каждый символ как keypress
- `\r` внутри paste brackets → новая строка. `\r` **после** paste end → submit
- Delay между paste и Enter нужен чтобы Ink успел обработать paste event в React render cycle

### Переключение модели

#### Default vs Opus (Model Detection)
Claude Code поддерживает три модели: `default`, `sonnet`, `haiku`. Однако `default` — это не имя модели, а алиас для текущей рекомендуемой модели Claude (в 2026-03 это Opus).

**Детекция в bridge-данных:**
Bridge-скрипт (`~/.claude/statusline-bridge.sh`) вернет строку `model: "Opus 4.6 (1M context)"` (текстовый маркер), если пользователь явно выбрал режим default.

**Логика UI:**
- **Default:** Подсвечивается (оранжевый), когда bridge-строка содержит маркер `1m context`.
- **Opus:** Подсвечивается, когда строка содержит `opus`, но НЕ содержит `1m context`. Это позволяет различать стандартный Opus (200K) от Default (1M).
- **Sonnet/Haiku:** Прямое соответствие через `includes(model)`.

**Переключение:**
```js
ipcRenderer.invoke('claude:send-command', tabId, '/model sonnet');
// Aliases: default, sonnet, opus, haiku — работают мгновенно, без рестарта
```

Текущая модель определяется из bridge-данных (`claude:bridge-update` → `data.model`).

## Синхронизация с UI: Serialization & Command Guard

### Блокировка кнопок (isControlBusy)
Когда пользователь отправляет команду (смена модели, effort, think toggle), система устанавливает флаг `isControlBusy = true`. Это **блокирует** все кнопки управления в секции «Контроль» до завершения операции.

**Мотивация (Invisible Intent):** Изначально guard защищал от «двойного Ctrl+C exit» (двойной клик → два `\x03` подряд → Claude видит `again to exit` → процесс умирает). После перехода на Stash flow (Ctrl+S вместо Ctrl+C) этот риск исчез, но guard остался важным: предохраняет от ситуации когда второй клик отправляет Ctrl+S **после** первого paste но **до** Enter первого сабмита — второй Ctrl+S попнул бы первую команду (Claude в этом state видит `input=/model X, stash=user_prompt` → Ctrl+S сначала запихнул бы команду в stash поверх user_prompt) → user prompt теряется навсегда.

**Синхронный IPC (`claude:send-command`):**
Команда отправляется через `ipcRenderer.invoke()` (синхронный вызов), что позволяет интерфейсу дождаться завершения `term.write()` и только после этого разблокировать кнопки.

### Двух-уровневая защита: per-term mutex + claude:paste-busy

Локальный `isControlBusy` защищает только от **двойного клика по той же кнопке**. Он не виден другим источникам команд — queue runner, MCP-handlers, /effort auto-inject, кнопки в других панелях. Если параллельно с UI-кликом Compact в InfoPanel запустился queue runner с большим prompt'ом, оба попадали в `safePasteAndSubmit` на одном `ptyProcess` → bytes интерлевились, команды терялись (сессия `bb95e71d`, 16:01 MSK 2026-05-16).

Фикс — двух-уровневый:
1. **Server-side mutex** в `safePasteAndSubmit` (WeakMap `pasteInflight: term → Promise`). Любой второй caller чейнится на хвост первого через `prev.then(...)`. Покрывает все 14 callsites автоматически.
2. **Broadcast `claude:paste-busy { tabId, busy }`** main → renderer на enter/exit `safePasteAndSubmit`. InfoPanel слушает и через derived `isControlBusy = isControlBusyLocal || isPasteBusy` отключает кнопки, пока чужой paste идёт. Кнопка не дойдёт до `ipcRenderer.invoke` если ANY caller активен на active tab.

См. [`fix-claude-paste-race.md`](fix-claude-paste-race.md).

## Stash Flow для slash-команд (Ctrl+S вместо Ctrl+C)

### Симптом (что видел пользователь)
В обновлённом Claude Code (2026-Q2) клик по кнопке Model/Effort в InfoPanel приводил к двум проблемам:
1. Команда (`/model sonnet`) появлялась в инпуте, но **Enter не сабмитил** — нужно нажать пробел или любой символ, чтобы команда «активировалась».
2. Если в инпуте уже был user prompt, он **терялся** при клике (Ctrl+C стирал).

### Решение: Ctrl+S (Claude stash) вместо Ctrl+C
`Ctrl+S` (0x13) в Claude TUI = chat:stash binding (см. `packages/claude-code-src/keybindings/defaultBindings.ts`). Пушит текущий ввод в `stashedPrompt` state, чистит инпут. После сабмита **slash-команды** stash сохраняется (REPL.tsx особый кейс для slash-cmd); на **следующем** обычном сабмите — Claude автоматически восстанавливает stash в инпут.

Flow в `safePasteAndSubmit` опцией `stashFirst: true`:
1. `\x13` (Ctrl+S) → push stash, clear input
2. `drainPtyData(20)` — даём Ink проглотить байт до прихода нашего paste
3. bracketed paste команды (`\x1b[200~` + cmd + `\x1b[201~`)
4. `waitForRender` ловит sync marker (типично 8-30ms)
5. `drainPtyData(50)` — settle для tail re-renders
6. `\r` — submit

**Корнер-кейс:** если инпут пуст И в Claude уже есть stash, Ctrl+S **попнет** stash обратно в инпут (`handleStash` в PromptInput.tsx::1357 двунаправленный). Наша команда тогда дописывается к восстановленному тексту. На практике это происходит редко (только сразу после нашего же предыдущего slash-cmd, до того как user успел отправить что-то своё) и сабмит всё равно работает — slash-команда уйдёт как обычный prompt. Альтернатива — детект через PTY-buffer строки `Stashed (auto-restores after submit)` — добавляет 200-300ms; не стоит.

### Cmd+\ History send preflight: draft переносится, отправка останавливается

HistoryPanel send для обычного user prompt не должен вести себя как slash-command stash-flow. Если в живом Claude composer уже есть ручной draft, новый prompt из правой панели нельзя «аккуратно склеить и отправить»: пользователь писал текст в терминале с другим намерением, и auto-send превратит два независимых ввода в один неожиданный запрос. Preflight делает `grab-input`, атомарно забирает и очищает TUI composer, добавляет найденный текст в конец History textarea, показывает compact warning `Send stopped · draft moved` рядом со статусом и **не** вызывает `sendClaudePtyPrompt`.

Это намеренно отличается от `⎘ prompt | + clear`: там пользователь явно просит забрать текст из TUI. В History send `grab-input` — guard перед отправкой, а не основное действие. Симптом нарушения: пользователь набрал текст в терминале, нажал Send в `Cmd+\`, и старый terminal draft оказался дописан к новому prompt'у и ушёл в Claude.

Ручная стрелка «Pull terminal draft» в той же панели — отдельное явное действие. Если Claude composer пуст, она не должна показывать warning `Send stopped`: ничего не переносилось и отправка не останавливалась. Правильный feedback — короткий нейтральный `Terminal input empty` рядом с `READY`, без жёлтого треугольника.

### Кладбище идей: Esc после paste
**Попытка №1** — в flow добавили `\x1b` (Esc) перед Enter, чтобы закрыть slash-autocomplete dropdown. Логика: при пасте `/model haiku` сначала появляется autocomplete, и `PromptInput.onSubmit` имеет early-return guard на `suggestionsState.suggestions.length > 0` (PromptInput.tsx::1074). Без закрытия dropdown — `\r` молча игнорируется.

**Почему не нужно:** в живой проверке (PTY-trace через `terminal:data` IPC) обнаружено, что для команд **с аргументом** (`/model haiku`, `/effort low`) autocomplete закрывается **сам** в момент paste — после пробела+аргумента нет префиксного матча со списком команд (PromptInput.tsx::980-1075). К моменту нашего `\r` `suggestions.length === 0`. Симптом «нужно нажать пробел» был не от dropdown'а, а от **stale sync marker** (см. ниже).

Побочка Esc: Claude рендерил под инпутом текст «Esc again to clear» и съедал ~130ms на drain после Esc. Удалено.

### Stale sync marker — главная причина задержки (фикс)
В первой реализации `safePasteAndSubmit` ждал sync marker до 8 секунд (`safetyTimeoutMs`), потому что **наш же** marker от paste прилетал за 8-12ms и попадал в 15ms stale-окно `waitForRender` → отбрасывался → ждали timeout. Подробности — `fix-stale-sync-markers.md::markWriteTime`.

После фикса (`markWriteTime()` сбрасывает baseline ПОСЛЕ `term.write()`, threshold снижен до 3ms) sync marker от paste проходит cleanly за 8-30ms.

### Измеренные тайминги (через electron-mcp + dev.log)
- `/effort low`, `/model sonnet`, `/model haiku`, `/model opus`, `/model default` — стабильно **400-450ms** total на коротких командах (11-14 байт).
- Внутри: ~20ms drain после Ctrl+S, ~250ms ожидание sync marker от paste, ~50ms tail drain, ~5ms Enter.
- До фиксов: 8-9 секунд (timeout race).

См. также `methodology/переносимый-дизайн.md::Воспринимаемая задержка UI-команд` — пустой инпут ощущается «лагающим» на тех же 80ms, на которых заполненный инпут визуально «мгновенный»; именно поэтому drain'ы свели до минимума event-driven путём.

## Управление Effort Level

### Введение
Effort Level (уровень интенсивности размышлений) контролирует глубину анализа Claude. Поддерживаются уровни: `auto`, `low`, `medium`, `high`, `max`.

### Особенность: Затемненная индикация (Invisible Intent)
В отличие от модели, Claude **не транслирует текущий уровень Effort** через bridge-скрипт (ограничение текущей версии CLI).

- **Локальный трекинг:** Приложение запоминает последний выбор пользователя по `tabId`.
- **Затемненная индикация:** Активная кнопка Effort отображается с приглушенным фоном (`bg-[#DA7756]/20`), в отличие от ярко-оранжевого цвета моделей.
- **Смысл:** Это визуально сигнализирует: «это предполагаемое состояние, а не подтвержденный статус от Claude». При перезапуске или ручном вводе команды в терминале индикация сбросится или станет неактуальной.

## Шрамы формата данных (Claude CLI)

В ходе разработки были выявлены неочевидные ограничения форматов данных Claude Code:

1. **`ANTHROPIC_MODEL="default"` в env:** Установка этого значения в переменных окружения (`.zshrc`) приводит к повреждению отображения в TUI (показывается `[default] 0%`). Для использования модели по умолчанию с 1M контекстом через env-переменные необходимо использовать формат `opus[1m]`.
2. **`effortLevel: "max"` в settings.json:** Попытка прописать уровень `max` напрямую в файл настроек приводит к его **тихому сбросу** (null) при следующем запуске Claude. Уровень `max` не является персистентным; максимальное значение, которое сохраняет CLI между сессиями — `high`.
3. **`1m context` маркер:** Единственный надежный способ отличить модель `default` от явно выбранной `opus` в потоке данных — наличие подстроки `(1M context)` в имени модели.
4. **Список effort-уровней меняется между релизами Claude.** В мае 2026 `auto` был удалён, добавлен `xhigh` между `high` и `max`. Хардкод массивов `['auto','low','medium','high','max']` рассыпан по 4 файлам не пережил апдейт — UI показывал несуществующий `auto`, новый `xhigh` отсутствовал. Решение: **один canonical-файл** `src/renderer/constants/claudeLevels.ts` экспортирует `CLAUDE_EFFORT_LEVELS`, `CLAUDE_EFFORT_TOGGLE_OFF`, `CLAUDE_MODELS`. Все use sites импортируют оттуда. Legacy migration `'auto' → 'low'` для persisted values. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Single source of truth для third-party shipping values`.

## Реактивное управление TUI через синхронизацию

### Особенности парсинга Claude Code TUI
1. **Sync Markers (\x1b[?2026h/l):** Современные TUI (включая Claude) используют эти маркеры для обозначения границ кадра отрисовки. 
    - **Правило:** Любой парсинг буфера (меню истории, пикер модели) должен начинаться только ПОСЛЕ детекции `\x1b[?2026l` (конец кадра).
2. **Проблема исчезновения пробелов:** Claude TUI не всегда использует `0x20` (пробел). Вместо этого часто шлется `\x1b[NC` (cursor forward). 
    - **Правило:** Перед очисткой VT-символов необходимо заменять `\x1b[(\d*)C` на соответствующее количество пробелов. Иначе текст склеится (`каксейчасработает`).
3. **Детекция готовности инпута:** После выполнения команд (например, `/model` или откат), нужно ждать отрисовки промпт-бокса. Признак готовности — появление в кадре символов `╰` (низ бокса), `⏵` или `>`.

## Rewind Automation (Откат истории)

### Симптомы (при сбоях)
При восстановлении истории слова могут слипаться в одну строку без пробелов (`каксейчасработает`), либо курсор навигации в TUI-меню "промахивается" мимо нужной записи, из-за чего сессия откатывается не в ту точку или закрывается с ошибкой.

Для программного отката используется IPC `claude:open-history-menu`.

**Алгоритм навигации:**
1. **Открытие:** Отправить `\x03` (Ctrl+C) → `\x1b` (Esc) → `\x1b` (Esc).
2. **Парсинг:** Ждать sync marker, извлечь список записей.
3. **Сопоставление (Text Match):** Найти нужную запись по префиксу текста сообщения.
4. **Синхронная навигация:** Каждое нажатие `Arrow Up` верифицируется — система ждет новый кадр и проверяет, что курсор `❯` переместился на нужную строку.
5. **Подтверждение:** Отправить `\r` (Enter) для выбора точки отката.

**Очистка и вставка:**
После отката Claude часто сохраняет старое сообщение в инпуте.
1. **Wait for prompt:** Ждем полной отрисовки промпта (sync marker + `╰`).
2. **Clear:** Отправить `\x03` (Ctrl+C).
3. **safePasteAndSubmit:** Вставить сжатое резюме чанками по 900 байт, дожидаясь подтверждения отрисовки каждого чанка через sync marker.
4. **Submit:** Отправить `\r`.

## Решение: safePasteAndSubmit (Programmatic Chunked Paste)

**⚠️ КРИТИЧЕСКОЕ ПРАВИЛО: macOS TTYHOG = 1024 bytes.**
Ядро macOS режет любой `term.write()` > 1024 байт. Это создает три уровня проблем:
1. **Kernel Split:** Escape-последовательность `\x1b[201~` может быть разорвана между вызовами `read()`.
2. **Ink Parsing:** Ink не имеет полноценного стейт-машины для bracketed paste. Он парсит байты через `parseKeypress()` и при разрыве последовательности может проигнорировать её или интерпретировать как обычный текст.
3. **React Batching Race:** Даже если paste дошел целиком, React батчит обновления стейта. Если `\r` (Enter) приходит слишком быстро после paste (в том же микротаске), обработчик `onSubmit` увидит **старый (пустой) стейт**, так как ре-рендер еще не произошел.

### ⚠️ ВАЖНО: safePasteAndSubmit ≠ user paste (Ctrl+V)

`safePasteAndSubmit` — это функция **только для программных операций**, где наш код отправляет текст напрямую в PTY (минуя xterm.js) и сразу шлёт Enter. Она **НЕ используется** в обработчике `terminal:input` (user paste).

**Два разных пути:**

| | User Paste (Ctrl+V) | Programmatic Paste |
|---|---|---|
| **Путь** | xterm.js (добавляет brackets) → `terminal:input` → simple chunking | Наш код → `safePasteAndSubmit` → `term.write()` напрямую |
| **xterm.js** | В цепи (сам добавляет brackets) | Не участвует |
| **Enter** | Человек жмёт (секунды спустя) | Код шлёт (миллисекунды) |
| **Sync markers** | Не нужны | Обязательны |

**Почему в `terminal:input` нельзя было использовать `safePasteAndSubmit`:**
1. Обычные терминалы (bash/zsh) не шлют sync markers → 5-сек таймаут на каждый чанк.
2. xterm.js уже добавил brackets → `safePasteAndSubmit` создавала второй слой → двойное обрамление.

Подробнее: `knowledge/fact-fact-terminal-core.md` (секция "Двухуровневая система вставки").

### Алгоритм `safePasteAndSubmit`:
1. **Chunking:** Контент делится на чанки по ~900 байт.
2. **Bracketed Wrap:** Каждый чанк оборачивается в ПОЛНЫЙ `\x1b[200~` + chunk + `\x1b[201~`. Итоговый размер каждого `term.write()` < 1024 байт, что гарантирует атомарную доставку в PTY.
3. **Sync Marker Verification:** После каждого чанка система слушает PTY и ждёт `\x1b[?2026l` (sync marker). Это подтверждает, что Ink обработал вставку, React выполнил стейт-апдейт и отрендерил кадр.
4. **Submit:** `\r` отправляется только после подтверждения последнего чанка. Это гарантирует, что `onSubmit` прочитает уже зафиксированный в стейте текст.

### Где используется
- **Handshake:** Автоотправка default prompt при запуске Claude.
- **send-command:** `/model sonnet`, `/compact` и др. из UI.
- **Rewind:** Вставка compact-резюме после отката.

## Think row — две кнопки: Think + Compact

В ряду «Think» (InfoPanel секция КОНТРОЛЬ) сидят две равных по ширине кнопки вместо одной `toggle`.

| Кнопка | Что делает | Стиль |
|---|---|---|
| **Think** | Локальный тогл `thinkActive[tabId]`. Дефолт `undefined ⇒ true` (orange-tinted активный вид), потому что Claude стартует с `alwaysThinkingEnabled: true` в `~/.claude/settings.json`. Параллельно вызывает `claude:toggle-thinking` (meta+t picker в PTY) — при успехе reconcile из его `result.thinking`. | Активный = `bg-[#DA7756]/20 text-white font-medium` (та же приглушённая индикация что и Effort — local invisible intent, не подтверждённый bridge'ом). Неактивный = `bg-[#2d2d2d] text-[#888]`. |
| **Compact** | Отправляет `/compact` через `claude:send-command` (тот же Stash flow что Model/Effort: Ctrl+S → bracketed paste → Enter, ~400ms), затем main открывает local-command watcher. `/compact` не является model-turn'ом: Stop hook может не прийти, поэтому loader bracket'ится отдельным `claude:busy-state reason:'local-command'`. | Всегда нейтральный (нет «активного» состояния, разовое действие). |

**Дефолт «Think всегда ON при перезапуске» (важная invariant):**
- `thinkActive` хранится в `useState<Record<string, boolean>>({})` в InfoPanel.
- Когда `thinkActive[tabId]` === `undefined` → UI рендерит как активный.
- Хендлер `terminal:command-finished` (OSC 133 D, на любой shell-exit) **удаляет ключ** `tabId` из map → следующий запуск Claude снова покажет Think tinted. Это совпадает с реальным поведением `alwaysThinkingEnabled` — он применяется при каждом старте.
- Корнер-кейс: если юзер выключил Think через TUI вручную (`meta+t` напрямую в терминале) — наш UI этого не узнает (bridge не транслирует). При перезапуске опять покажем ON, и это совпадёт с реальностью. Рассинхрон mid-session — invisible intent, см. секцию про Effort.

**Почему Compact не использует `claude:toggle-thinking`-style picker:** `/compact` не открывает выбор — он просто сжимает контекст и продолжает разговор. Поэтому для ввода достаточно `safePasteAndSubmit` со стандартным `stashFirst: true` (защищает user prompt в инпуте). Для окончания команды этого уже недостаточно: визуальный loader должен пережить локальную работу Claude по сжатию, но не должен выглядеть как обычный assistant turn.

### `/compact` local-command watcher

`startClaudeLocalCommandWatcher(tabId, '/compact')` взводится после успешного `claude:send-command` и сразу эмитит `claude:busy-state {busy:true, reason:'local-command'}`. Completion ловится по нескольким независимым признакам:
- JSONL compact boundary (`type:'compact'` / compact summary markers);
- wrapper stdout в transcript (`<local-command-stdout>...Compacted...`);
- PTY-текст Claude (`Compacting conversation`, `Conversation compacted`);
- guard-timeout как error cleanup, а не как источник истины.

Pure `Escape` или `Ctrl+C` во время local-command отменяет watcher через `cancelClaudeLocalCommandFromInput` и гасит loader тем же `reason:'local-command'`. Это сознательно **не** `reason:'interrupt'`: отменённая slash-команда не равна прерванному assistant turn'у, поэтому PromptQueueRunner должен игнорировать edge, а не disarm'ить RunAfter как после настоящего `InterruptStop`. Multi-byte ESC sequences (стрелки, F-keys) не считаются отменой — они остаются обычной навигацией TUI.

Teardown обязан быть симметричным: manual Stop, bridge clear, PTY exit/kill тоже закрывают watcher и эмитят busy false, если local-command был активен. Иначе пользовательский симптом — `/compact` отменён, Claude idle, но vertical loader на вкладке/проекте продолжает крутиться.

**Почему обе кнопки блокируются `isControlBusy`:** Та же мотивация что у Model/Effort — пока `safePasteAndSubmit` или `toggle-thinking` идёт, второй клик может попасть между `Ctrl+S` и `\r`, что **попнет stash** и затрёт сохранённый prompt. См. секцию «Stash Flow» выше.

**Почему не Text Echo:** Ink коллапсирует большие вставки в строку вида `[Pasted text #N +M lines]`, поэтому проверять наличие самого текста в выводе невозможно. Только sync markers гарантируют успех.

## Управление Effort Level

### Введение
Effort Level (уровень интенсивности размышлений) контролирует глубину анализа Claude при решении задач. В 2026-03 добавлена UI-панель для переключения между тремя уровнями: Low (5K токенов думания), Medium (16K), High (50K max).

### Команда `/effort`
```js
ipcRenderer.send('claude:send-command', tabId, '/effort medium');
// Aliases: low, medium, high
```

### Особенность: Затемненная индикация (Invisible Intent)
В отличие от переключения модели или think mode, Claude **не транслирует текущий уровень Effort** через bridge-скрипт. Это означает:

- **Локальный трекинг:** Приложение помнит, какой уровень был установлен последний раз, но **не может подтвердить** из bridge, что Claude действительно его принял.
- **Затемненная индикация:** Кнопка/индикатор Effort отображается с приглушенным стилем (dimmed, меньше яркости), в отличие от ярко-подсвеченной кнопки модели.
- **Мотивация:** Это визуально сигнализирует пользователю: "это локальное состояние, а не подтвержденный статус от Claude". Если пользователь вернется к приложению через час, кнопка Effort может не отражать реальный уровень в Claude (если он был перезапущен).

### Защита от двойного срабатывания (Command Guard)
Как и при переключении модели, Effort отправляется через `safePasteAndSubmit`. Во время отправки команды кнопки Effort, Model и Think **блокируются** флагом `isCommandRunning`. Это предотвращает отправку нескольких команд подряд.

### Auto-confirm settings dialogs: effort и model
В **новой директории** (нет сохранённого разрешения) после `/effort N` Claude TUI показывает 2-pos меню:
```
Change effort level?
Your next response will be slower and use more tokens

This conversation is cached for the current effort level. Switching to <X> means
the full history gets re-read on your next message.

❯ 1. Yes, switch to <X>
  2. No, go back
```
Дефолт стоит на «Yes» — Enter подтверждает. Симптом: юзер нажимает «Effort → max» в UI, ничего не происходит, в терминале висит этот диалог; следующий ввод Enter в инпуте уходит в TUI и интерпретируется как подтверждение/отказ непредсказуемо.

`/model <X>` показывает тот же класс confirmation menu с заголовком `Switch model?` и highlighted option `❯ 1. Yes, switch to <X>`. Симптом: startup default model доходит до меню, курсор стоит на `Yes`, но процесс визуально «зависает» на подтверждении; при повторном запуске model может пройти, а следующий `/effort max` уже не вводится.

**Решение** (`main.js::ptyProcess.onData` после Session ID detection): detector классифицирует `Change effort level` как `EffortDialog`, `Switch model` как `ModelDialog`, а highlighted строку `❯ 1. Yes, switch to ...` как model fallback. Через 120мс шлёт `\r` в PTY. Cooldown 2с защищает от двойного срабатывания при Ink re-render, но ключ cooldown'а — `${tabId}:${dialogType}`: model-dialog и effort-dialog могут легально идти подряд в одной startup-chain, и общий cooldown на tab подавит второе подтверждение. Cleanup при `ptyProcess.onExit`.

**Шрам: текст в Ink-меню рендерится без литеральных пробелов и не всегда приходит заголовком.** Первая версия effort-матча была `'Change effort level' && 'Yes, switch'`. Падала: Ink TUI заменяет пробелы внутри строки меню на `\x1b[1C` (cursor-forward) — после `stripVTControlCharacters` получается `Yes,switchtolow`. Плюс диалог приходит в **3-5 отдельных PTY-чанках** (заголовок жёлтый, описание серое, опции синие — каждый блок отдельным write), поэтому матч из двух подстрок в пределах одного chunk вообще не имеет шансов. Для effort финальный матч — уникальный `Change effort level`; для model дополнительно нужен strict fallback по highlighted `❯ 1. Yes, switch to`, потому что в одном реальном запуске в логах был виден только option chunk. Не матчить generic `Yes, switch` без `❯`: такой текст может появиться в assistant output.

**Задержка 120мс перед `\r`:** ранее было 80 — Ink не успевал дорисовать остаток меню до прихода Enter, и Enter иногда попадал в неопределённое состояние (то срабатывал, то «съедал» prompt). 120мс — post-detection settle после конкретного TUI-события, не primary readiness source. Cooldown — duplicate/error guard, не способ упорядочить startup-chain.

**Принцип:** см. `methodology/переносимый-дизайн.md::Ink TUI: пробелы как ANSI-команды, текст разорван по чанкам`. Любой будущий парсер TUI-вывода для Claude должен матчить **минимальные уникальные подстроки** (одно слово или короткая фраза), не комбинацию из двух — Ink почти гарантированно разнесёт их по чанкам.

### Startup defaults `/model` + `/effort` при запуске Claude

В StatusBar справа — pills `Model: haiku` / `Effort: max` (defaults per-app, не per-tab). При каждом запуске Claude процесса значения шлются как slash-команды в TUI. Сигнал запуска — **самый ранний детерминированный признак готовности TUI к вводу**, не появление bridge-файла:

```
Claude рисует prompt-символ ⏵ в PTY → main эмитит claude:tui-ready (~0.8с после старта)
→ Terminal.tsx handler читает useUIStore.getState().defaultClaudeModel/defaultClaudeEffort
→ если model ≠ 'none': ставит _modelSentForTab и шлёт /model haiku
→ ждёт claude:bridge-update, где bridge model совпала с target
→ если effort ≠ 'none': ставит _effortSentForTab и шлёт /effort max
→ sentinels гасят дубли между tui-ready, Bridge:Fresh и ручными кликами
```

`claude:tui-ready` эмитится из того же места `main.js`, где Handshake детектит prompt-символ (`stripVTControlCharacters(data).includes('⏵' | '>')` в state `WAITING_PROMPT`). Это момент когда Claude **готов принять ввод**, а не просто «процесс жив». Принцип «liveness ≠ readiness, бери ранний сигнал» — `methodology/переносимый-дизайн.md::Liveness ≠ readiness`.

**Bridge:Fresh (`claude:process-started`) — теперь fallback, не главный путь.** Раньше инжект висел на нём, но `Bridge:Fresh` лагает: bridge.json должен *появиться* → *пережить DeadTranscript-guard* (у свежей сессии JSONL ещё не на диске, guard «ignoring forever» отбрасывает первый bridge) → *PID зарезолвиться в таб*. В проде измерено **3-6 секунд** после старта Claude (сессии tab-2933 `3c4712b9`, tab-2986). `handleProcessStarted` остался как fallback на случай если ⏵ не распарсился (новая версия TUI / кастомный шрифт) — он проверяет sentinel и молчит если tui-ready уже отработал.

**`/model` completion barrier — bridge-update, не return из `safePasteAndSubmit`.** `safePasteAndSubmit` сериализует paste и ждёт sync-marker render'а; это доказывает что `/model haiku` вставлен и Enter отправлен, но не доказывает что Claude TUI завершил локальную смену модели. Реальный лог tab-3234 (`6f26c93d`, 2026-06-07): `/model haiku` send-command вернулся, через ~4мс стартовал `/effort max`, а `ModelDialog` появился только через ~349мс. Итог: effort paste попадает в период model confirmation и может быть проглочен/направлен не туда. Поэтому цепочка ждёт `claude:bridge-update` с matching model; timeout 6с — только fallback, normal path event-driven.

**Graveyard — Bridge:Fresh как единственный сигнал → двойной `/effort`.** Пока инжект висел только на `Bridge:Fresh`, юзер видел нарисованный prompt без эффекта (3-6с лага), решал что «эффект не выставился», кликал `/effort` руками в ControlBar → улетал **первый** `/effort`, потом запоздавший Bridge:Fresh догонял **вторым**. В JSONL/scrollback копилось два `/effort max` подряд. Детерминированно подтверждено счётчиками `[EffortDiag][HANDLER-ENTRY] callN` / `[INVOKE-FIRE] invokeN` — handler входил один раз, но первая команда уходила за 391мс **до** него (это был ручной клик). Чинится связкой ранний-сигнал + sentinel ниже.

**Once-per-process sentinels `_modelSentForTab` и `_effortSentForTab`.** Maps `tabId → {at, via}` экспонируются на `window.__modelSentForTab` / `window.__effortSentForTab` для доступа из ControlBar. Любой источник slash-setting (ранний `tui-ready`, fallback `Bridge:Fresh`, ручной клик ControlBar/mobile) первым делом ставит метку; остальные видят её и делают early-return. Сброс — НЕ на `process-started`: tui-ready fires раньше Bridge:Fresh, и если сбрасывать на process-started — затрётся метка раннего пути и fallback пошлёт дубль. Это та же ловушка «liveness как reset-триггер», что и в выборе сигнала.

**Сброс sentinel'а — на смерти Claude (`command-finished`), не только на смерти shell (`terminal:exit`).** Первая версия чистила `_effortSentForTab` **только** в `handleExit` (PTY exit = shell умер). Но `claude-c` (Continue/restart) **переиспользует тот же shell PTY** — shell не выходит, `terminal:exit` не fires, sentinel от **первого** запуска в жизни таба живёт вечно. Каждый последующий рестарт Claude: `tui-ready` fires → `_effortSentForTab.has(tabId)` → `true` → early-return → `/effort` **молча не отправляется**. Эффект: `/effort` инжектится ровно один раз за всю жизнь вкладки, при рестартах — никогда. Юзер: *«сессию я перезапускал, при перезапуске почему-то автоматически /effort не срабатывал, хотя он установлен системой»*.

Прод-подтверждение (tab-283, `ea2ae02c`, 2026-06-03): на 4 рестартах подряд лог `[Terminal:EffortInject] … SKIP — already sent via tui-ready` (callN=2,3,4,5), и **ни одной** строки `[Terminal:TuiReady] … /effort max` после первой. Сигнал смерти Claude при живом shell — **OSC 133 D** (`terminal:command-finished`, тот же что гасит `claudeProcessAlive`). Фикс: `_effortSentForTab.delete(tabId)` в `Terminal.tsx::onFinished` (handler `terminal:command-finished`). `handleExit` сброс оставлен как belt-and-braces для настоящего shell-exit. Принцип: **once-per-process sentinel должен сбрасываться на смерти ТОГО процесса, к которому привязан (Claude), а не на смерти контейнера (shell)** — иначе reuse контейнера навсегда залипит метку.

**Почему без setTimeout:** `safePasteAndSubmit` сам ждёт sync-marker `\x1b[?2026l` от Ink. Если инпут ещё не готов — ждёт **внутри** функции (event-driven). Возвращается за 8-30ms на happy path. Раньше был paranoid `setTimeout(800ms)` обёртка — это "timeout как safety net вместо причины", антипаттерн (см. `methodology/переносимый-дизайн.md::Воспринимаемая задержка UI-команд`).

**`max` нельзя задать в settings.json:** Claude CLI silently downgrades `effortLevel: "max"` до null при первом запуске. Максимум что settings.json держит — `high`. Из-за этого инжекция через `/effort max` — **единственный** способ стартовать сессию в max effort.

**Persistence — SQLite, не localStorage.** `defaultClaudeEffort` сохраняется через `app:setState` IPC. Раньше был localStorage — но vite-dev меняет порт (5181 → 5182 → 5183) когда есть orphan Electron'ы, и каждый порт это **отдельный origin** → отдельное localStorage хранилище. Юзер видел "max сбрасывается после рестарта", думал что не сохраняется — на самом деле сохранялось, но на другом origin'е. См. `fix-localstorage-origin.md`.

**Post-inject поведение: wrapper остаётся в JSONL, Timeline его скрывает фильтром.** Каждый спавн Claude в табе → `process-started` → инжект `/effort <level>`. Claude TUI синхронно пишет в JSONL пару записей:

```
{type:'user', content:'<command-name>/effort</command-name>...<command-args>max</command-args>', uuid, parentUuid, ...}
{type:'user', content:'<local-command-stdout>Set effort level to max ...</local-command-stdout>', parentUuid: <предыдущая>}
```

**Мы их НЕ стираем.** Timeline render (`claude-data.js::parseTimelineEntries`) пропускает любые записи с тегами `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-stderr>`, `<bash-notification>` — это существующий tag-filter, который и так покрывает `/compact`, `/clear`, `/status`, любые slash-команды. `/effort` попадает под тот же фильтр автоматически. В Timeline у юзера wrapper-карточки **не появляются**. parentUuid цепочка через wrapper проходит насквозь — `recordMap` его держит, render просто пропускает.

**Graveyard №1 — busy-state trigger.** До artifact-side `fs.watch` пробовали слушать `claude:busy-state` edge true→false как сигнал окончания /effort turn'а. **Не сработало**: `/effort` это slash-команда, обрабатывается inline в Claude TUI **без вызова model API** → Stop hook никогда не fires (`query.ts:1062::handleStopHooks` срабатывает только после `model.complete()`, для slash-команд этого пути нет) → `claude:busy-state` остаётся false весь pendulum → safety timeout 5s срабатывал на каждом инжекте, cleanup пропускался. В логах юзера было видно три подряд `/effort max` в JSONL и три `busy-state timeout — Claude turn never finished, skip cleanup`.

**Graveyard №2 — full-file rewrite после artifact-side fs.watch.** Перешли на `fs.watch` JSONL + tail-read дельты + match wrapper → batch-delete + relink parentUuid детей. Первая реализация делала `fs.readFile(filePath)` целиком → `JSON.parse` каждой строки → batch-relink всех parentUuid в targets set → `JSON.stringify` обратно → atomic tmp+rename. Корректно работало, но на сессии с 115 MB JSONL занимало **3 секунды CPU-блока main process** — за это время `provider:switch` / `provider:set-options` IPC handlers стояли в очереди, ClaudeControlBar показывал залипший shimmer-overlay, юзер не мог переключить модель. Юзер: *«вертикальная черта идёт очень долго»*, *«мы всё равно не можем редактировать историю до последнего юзер-сообщения, можем только с конца»*.

**Graveyard №3 — tail-mode rewrite.** Свели полный rewrite к **только последним 16 KB** файла: `fs.open` + `read(buf, 0, 16K, fileSize - 16K)` → split на строки → найти самый правый `<command-name>/effort` wrapper в хвосте → `truncate(filePath, wrapper.startOffset)` + `appendFile(остатки)`. На тех же 115 MB занимало 4 ms вместо 3 секунд. Релинк parentUuid не делался — расчёт был на то что запись только что инжектнута, у неё ещё нет детей.

**Graveyard №4 (final) — tail-mode создавал phantom parentUuid race.** Расчёт «у wrapper'а ещё нет детей» был неверен. Cleanup отрабатывал через 0.5-1с после inject'а (как только `fs.watch` ловил появление wrapper'а), но **первый user prompt в новой сессии** Claude TUI писал через 5-60 секунд (юзер шёл за кофе, читал предыдущий контекст, формулировал вопрос). К моменту prompt'а wrapper уже стёрт → Claude TUI пишет prompt с `parentUuid: <deleted-wrapper>` → orphan → красная зона в Timeline. Конкретный repro 2026-05-23: на 4 сессиях подряд (`8f0a0b48`, `cb2e4c26`, `09351b71`, `e4be2fe0`) phantom создавался ровно этим путём, лог `[DeleteEffortEntries] removed=2 relinked=0` — relink-pass всегда проходил вхолостую, потому что дети ещё не существовали. Юзер на 5-й сессии получил предупреждение «Обрыв UUID в JSONL», стал замечать паттерн: *«при смене effort у меня осталось предупреждение что сессия потеряна UUID»*.

**Live cleanup удалён полностью (2026-05-23).** `startEffortCleanupWatcher` / `stopEffortCleanupWatcher` / Map `claudeEffortCleanupWatchers` / IPC `claude:arm-effort-cleanup` / вызов из `Terminal.tsx::handleProcessStarted` — всё удалено. Wrapper остаётся в JSONL, Timeline и так его не рендерит через tag-filter. Принцип переносимый — см. [`methodology/переносимый-дизайн.md::Не модифицируй чужой shared append-only файл во время работы владельца`](../methodology/переносимый-дизайн.md).

### On-restart trailing /effort trim (безопасный наследник cleanup'а)

После удаления live cleanup'а `/effort` записи стали копиться: каждый перезапуск Claude инжектит новую пару, в Claude TUI scrollback и rewind-меню скапливается стопка `/effort max` подряд (в нашем Timeline их не видно — tag-filter). Юзер: *«я просто перезапускаю сессию несколько раз, и при новом запуске старый effort через JSONL не очищается»*.

Решение — `_trimTrailingEffortEntries(sessionId, cwd)` в `claude-data.js`, вызывается **синхронно** из `main.js::case 'claude-c'` **до** `term.write('claude --resume')`. Ключевое отличие от удалённого live-cleanup'а: чистка идёт когда **предыдущий Claude процесс уже мёртв** → никто не допишет ребёнка к удаляемой записи → phantom-parentUuid race **физически невозможен**. Это тот же инвариант что в [`methodology/переносимый-дизайн.md::Не модифицируй чужой shared append-only файл`](../methodology/переносимый-дизайн.md): мутируем чужой файл только когда owner не активен.

**Строгий suffix-match (цикл по блокам), plain truncate, без relink.** Алгоритм читает последние 16 KB, идёт от конца **в цикле**, отслаивая `/effort` блоки один за другим. Один блок (от конца): `[trailing meta]* → effort-stdout → effort-wrapper → [один caveat]?`. После блока — снова может идти meta и ещё блок (юзер перезапустил сессию N раз подряд **без сообщений между** — каждый рестарт инжектит свежий `/effort`, в хвосте копится `/effort, /effort, /effort` вплотную). Цикл съедает **все** подряд идущие блоки за один проход и **останавливается на первой реальной записи** (user/assistant). Если после `/effort` есть реальное сообщение — этот `/effort` не трогается (у него появился потомок, резать = порвать parentUuid chain → phantom).

Граничный случай (реальная сессия `dfa77496`): `/effort #1 → ответ Claude → /effort #2`. Срезается **только** #2 (хвост), #1 остаётся навсегда — у него потомок (ответ). Юзер видит в Claude TUI scrollback два `/effort` и думает что trim не дорезал; на деле #1 неприкосновенен by design. Только **подряд** идущие (без ответа между) схлопываются полностью.

Поскольку режем строго непрерывный хвост и после него ничего не остаётся — релинк не нужен, никакая оставшаяся запись не ссылается на удалённые (parentUuid всегда указывает назад). Чистый `truncateSync(filePath, byteStart)`, без re-append.

**Шрам — байты vs символы (поймано в тестах до прода).** Первая версия делала split через `tailText.indexOf('\n')` (строковый индекс) и truncate на `startOffset + charIndex`. На сессии с кириллицей (`5fbdb1d9`) это резало **в середине записи** — `trimmed:6` рапортовалось, реально удалялось 13 строк, последняя оставшаяся = битый JSON. Корень: UTF-8 кириллица многобайтовая, character-index ≠ byte-offset, а `fs.truncateSync` работает в байтах. Фикс: split через `buf.indexOf(0x0A)` в Buffer, все offset'ы байтовые (`startOffset + p`), не строковые. Тот же класс ловушки что [`methodology/переносимый-дизайн.md::Ink TUI`](../methodology/переносимый-дизайн.md) (bytes ≠ chars при работе с PTY/файлами). Verified: на 455 сессиях срабатывает на 3, `corruptBefore == corruptAfter` (не вносит новой порчи), `trimmed == actualLineDiff`.

Лог: `[TrimEffort] session=<sid> trimmed trailing /effort block (N lines) at offset <byteOffset>`. `_deleteEffortEntries` (старая re-append версия) оставлена мёртвым кодом — НЕ переиспользована, потому что она re-append'ит хвост после удаляемого без relink (создала бы phantom если бы после `/effort` была реальная запись). Новая функция избегает этого через строгий suffix-match.

### EffortInject kill-switch (`effort=none`) + resume-guard

В StatusBar `Effort` chip поддерживает значение `none` — это **полный kill-switch** для EffortInject: `/effort` paste **не отправляется** на `process-started`. Эффект: при `effort=none` наш main process **ничего не пишет в Claude TUI** автоматически. С момента удаления live cleanup (см. Graveyard №4 выше) этот kill-switch стал почти ритуальным — даже при `effort=max` мы пишем только один paste-keystroke, не модифицируем JSONL. Сохранён для юзеров которые хотят 100% «приложение не вмешивается».

**Resume-guard — только на process-started/Bridge:Fresh пути, НЕ на tui-ready.**

**Граветярд ложной предпосылки (горело tab-3234 `6f26c93d`, 2026-06-07).** Первая версия guard'а **полностью** skip'ала инжект на `--resume` под предлогом «при resume Claude TUI восстанавливает effort из in-memory state предыдущей сессии». **Это фактически неверно.** `claude --resume` — это **свежий процесс**, у мёртвого предшественника нет «памяти» которая бы пережила. По декомпилированному исходнику Claude Code (`main.tsx`): `effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting()`. Мы `--effort` флаг не передаём → fallback на `getInitialEffortSetting()` → `toPersistableEffort(settings.effortLevel)`, который **strip'ает `'max'` на чтении** (комментарий в исходнике: *«filters 'max' for non-ants on read»*). Итог: resumed-сессия **молча теряет max** (и любой session-scoped уровень) — падает на то что лежит в settings.json, а туда `max` не сохраняется (CLI downgrade'ит, см. ниже). Юзер: *«в той сессии effort max не подставлялся при перезапуске, хотя по умолчанию выбран max»*. В логах его сессии: fresh start `isResume=false` → `/effort max` инжектнут, дальше **каждый** рестарт → `SKIP — resume in flight` (и `[Terminal:TuiReady] SKIP — resume in flight` тоже).

**Что guard РЕАЛЬНО защищал.** Incident 2026-05-21 15:09:34 был **paste-race**, не «resume preserves effort»: Bridge:Fresh event и `Terminal:EffortInject` сработали в одну и ту же миллисекунду на `--resume`, `safePasteAndSubmit`'s Ctrl+S stash race'нулся с paste — `[PasteAudit:MISMATCH]` поймал что вместо 11 байт `/effort max` в композер влетели 303 байта старого user prompt'а из buffer. Гонка была на **Bridge:Fresh / process-started** пути — он fires **во время** resume-handshake (bridge.json только появился, PTY ещё может дописывать).

**Фикс — guard остаётся ТОЛЬКО на process-started, снят с tui-ready.** `tui-ready` fires когда Claude **нарисовал `⏵` prompt** = resume-handshake завершён, инпут idle/ready. Это не racer (он позже handshake'а по определению). Поэтому re-inject на resume идёт через tui-ready безопасно. Sentinel `_effortSentForTab` гарантирует **один** инжект: tui-ready ставит метку за 2-6с до Bridge:Fresh, тот видит метку → no-op. Если `⏵` не распарсился (новая версия TUI) — fallback Bridge:Fresh, но он по-прежнему skip'ается на resume (там paste-race), так что в этом редком случае max на resume не применится — приемлемо, лучше потеря max чем порча prompt'а.

Детекция resume: через renderer-side `getPendingResume(tabId)` из `utils/pendingResume.ts`. `markPendingResume` ставится при `claude --resume <sid>` (в AutoResume и любом другом code path запускающем resume), `clearPendingResume` в `handleSessionDetected` после bridge confirmation.

Полная таблица поведения:

| Условие | `/effort` paste | Путь | Лог |
|---|---|---|---|
| `effort='none'` | NO | — | `SKIP — effort=none` |
| `effort=max/.../low` + resume + tui-ready | **YES** | tui-ready | `/effort max (early path)` |
| `effort=max/.../low` + resume + только Bridge:Fresh | NO | process-started | `SKIP — resume in flight` |
| `effort=max/.../low` + fresh claude | YES | tui-ready | (обычный flow) |

### Click-toggle-off на effort кнопке

Повторный клик на уже-активный effort → выбор сбрасывается на `auto` (DeepSeek: `off`). Это **переносимый UX-принцип** (см. `methodology/переносимый-дизайн.md::Click-toggle-off на single-select`) — для filter pills, tag selectors, любых toggle-эквивалентных кнопок.

Реализация: `const targetLevel = isActive ? (isDeepSeek ? 'off' : 'auto') : level;` — один тернарник в onClick, остальная логика без изменений. Tooltip меняется на `Click again to deselect (→ auto)` когда `isActive`.

## Stop button — SIGTERM по PID, не keystroke в TUI

InfoPanel `SessionActionChip` hover → "Stop" → клик. Реализация **должна** вызывать `terminal:stop-ai-process` (SIGTERM по PID Claude process), **не** слать `\x03` (Ctrl+C) в PTY.

**Почему Ctrl+C не работает:** Claude TUI обрабатывает одиночный Ctrl+C как **"clear input"** (если в input есть текст) или **"взвести danger zone"** (Press Ctrl-C again to exit). Юзер кликает Stop → Claude не умирает, никаких ошибок → недоумение.

**SIGTERM по PID детерминированный:** `terminal:stop-ai-process` находит дочерний PID через `ps -eo pid,ppid,command | grep claude` где `ppid === ptyProcess.pid`, шлёт `SIGTERM` через `process.kill`. Через 800ms escalate в `SIGKILL` если процесс не умер. Тот же IPC использует split-button "Stop Claude" в TabBar — если split-button работает, InfoPanel Stop должна работать так же.

### Mobile preserve-shell Stop (SIGTERM по PID, тот же `terminal:stop-ai-process`)

Mobile-web `stopClaudeTab` bridge action в `src/renderer/App.tsx::handleWebBridge` зовёт `ipcRenderer.invoke('terminal:stop-ai-process', tabId)` — тот же handler что и desktop Stop-кнопка. Найдёт claude child-PID через `ps -eo pid,ppid` под shell-PID, шлёт SIGTERM, через 800ms эскалирует в SIGKILL если жив. Shell PTY не трогается — Resume в этом же табе пишет `claude --resume <id>\r` в живой shell.

**Graveyard: Ctrl+C × 2 через `terminal:input` с задержкой 250ms.** Жил до 2026-05-28, отброшен после детерминированной диагностики: `CtrlC-DangerZone` в `main.js:6711` сработал **дважды** в логах (на каждый Ctrl+C), значит Ink TUI **перерисовал prompt** между ними и второй Ctrl+C трактовался как **новый первый** ("Press Ctrl-C again to exit" опять) — Claude не выходил, через 42 сек desktop ещё видел `isCommandRunning=true`. Это явно отмечено в `fix-claude-busy-detection.md::4` как rejected approach (0ms = Ink merges, 500ms = Ink redraws). 250ms попало ровно в зону redraws. Любая фиксированная задержка ненадёжна — Ink реагирует за разное время в зависимости от content density текущего экрана.

Дополнительный side-effect Ctrl+C×2-подхода: если Claude не умирал — не срабатывал PTY-exit cleanup в `main.js:7029-7031` (`_webBroadcast 'busy=false, sessionStatus=inactive'`), и mobile composer **залипал в busy навсегда** — нет ни turn-end, ни exit-event'а. SIGTERM-путь чинит это попутно: kill → PTY exit handler → broadcast inactive → mobile сбрасывает busy.

Ctrl+D (`\x04`) **категорически нельзя** на mobile — после убийства Claude EOF закрыл бы shell → PTY exits → таб умрёт целиком. SIGTERM по PID этой проблемы не создаёт: kernel доставляет сигнал ровно child-процессу claude, shell не получает ничего. См. `fact-mobile-claude-pty.md::Resume guard rails`, `fix-claude-busy-detection.md::4`.

## Реактивное управление Think Mode

### Почему не просто отправить команду
Think mode переключается через `meta+t` (`\x1bt` = ESC + t), но это открывает **TUI пикер** с двумя опциями:
1. Enabled ✔ / Disabled
2. "Enter to confirm · Esc to exit"

При переключении mid-conversation Claude показывает **второй диалог** подтверждения: "Do you want to proceed?"

### Реактивный алгоритм (IPC `claude:toggle-thinking`)
```
1. Отправить \x1bt (meta+t)                  — открыть пикер
2. Слушать PTY, копить буфер
3. Детект \x1b[?2026l (synchronized output end)  — пикер готов
4. stripVTControlCharacters(buffer)           — получить чистый текст
5. Найти позиции "Enabled", "Disabled", "✔"  — определить текущее состояние
6. Отправить стрелку (\x1b[B вниз или \x1b[A вверх) — перейти на другую опцию
7. Слушать PTY → первый ответ = Ink перерисовал  — стрелка обработана
8. Отправить \r                               — подтвердить выбор
9. Слушать PTY → если "proceed" в тексте       — второй диалог подтверждения
10. Отправить \r                              — подтвердить proceed
```

**Ключевые маркеры PTY:**
- `\x1b[?2026h` — начало synchronized output (Ink рисует)
- `\x1b[?2026l` — конец synchronized output (Ink закончил, можно парсить)
- `✔` (U+2714) — галочка активной опции
- `❯` — курсор выбора в пикере
- "proceed" — маркер второго диалога подтверждения

**Определение текущего состояния:**
```
enabledIdx  = clean.indexOf('Enabled')
disabledIdx = clean.indexOf('Disabled')
checkIdx    = clean.indexOf('✔')
wasEnabled  = |checkIdx - enabledIdx| < |checkIdx - disabledIdx|
```

### UI отображение
Кнопка "toggle" в InfoPanel. После переключения показывает "think on" / "think off" фиолетовым цветом (#b4b9f9) на 3 секунды.

## Per-provider behavior: Model, Effort, Think

InfoPanel содержит **две зависимые строки** — Provider row и Model row — плюс Effort и Think. Принцип двухуровневого селектора (Provider → Model) описан в `methodology/переносимый-дизайн.md::Two-tier hierarchical selectors`. Здесь — конкретика поведения и **разные backend'ы для одинаковых UI-контролов** в зависимости от выбранного провайдера.

### Model row vs реальный target запроса

Model row для **Anthropic** показывает Claude TUI выбор модели (default/sonnet/opus/haiku), который читается из `bridge.sh`. При смене провайдера на Zen/DeepSeek **bridge продолжает показывать Claude-модель** — это не правда о реальной цели запроса. Реальный target — в Provider row + бейдж в Timeline footer (см. `fact-provider-proxy.md::Bridge врёт про active provider` и `fact-timeline.md::Provider badge`).

Соответственно клик по модели имеет разный эффект:
- **Anthropic:** отправляет `/model haiku` через `claude:send-command` в PTY — Claude TUI переключает модель внутри своей сессии
- **Zen / DeepSeek:** обновляет `providerState.model` через `provider:switch` IPC. Claude TUI про это ничего не знает, его собственная модель остаётся прежней (но в реальных запросах model переписывается в proxy)

### Effort: три пути за одним UI

Одна и та же Effort row рассылает команды в **разные backend'ы** в зависимости от Provider'а текущего таба:

| Provider | Backend | Механизм | Уровни |
|---|---|---|---|
| Anthropic | Claude TUI | `/effort high` через `claude:send-command` (PTY) | `auto/low/medium/high/max` |
| DeepSeek | Proxy body inject | IPC `provider:set-options { effort }` → proxy дописывает `output_config.effort` | `off/low/medium/high` |
| Zen | (не поддерживается) | UI dim, кнопки `disabled` | — |

**Почему такой mapping:** Anthropic effort — это поведение **внутри** Claude (как долго думать), управляется через TUI команду. DeepSeek effort — это поле в **request body** к их API. PTY-команда `/effort high` для DeepSeek-режима бессмысленна, потому что её эффект не доходит до DeepSeek API (proxy перехватит body раньше). Zen в текущей версии API не описывает аналога.

### DeepSeek: Think folded into Effort

Думаешь, что Think и Effort — независимые контролы? Для DeepSeek это **не так**. API DeepSeek возвращает HTTP 400 если в body одновременно `thinking:{type:'disabled'}` и `output_config.effort`. См. constraint в `fact-provider-proxy.md::DeepSeek режим`.

**Решение в UI:** для DeepSeek Effort row становится 4-значным селектором `[off][low][medium][high]`:
- `off` — proxy шлёт `thinking:{type:'disabled'}` БЕЗ `output_config`
- low/medium/high — `thinking:{type:'enabled'}` + соответствующий `output_config.effort`

**Think row для DeepSeek скрыта целиком** — её включает/выключает значение `off` в Effort. Дублирующий toggle = source of conflicts.

### Per-tab state vs локальный effortLevel

Для **Anthropic** effort хранится в `effortLevel: Record<tabId, string>` в InfoPanel local state — потому что bridge не транслирует обратно (Claude не подтверждает что принял `/effort high`). Это локальный «invisible intent».

Для **DeepSeek** effort живёт в `providerStates: Map<tabId, state>` в main process (`fact-provider-proxy.md::Per-tab routing`) и каждый запрос proxy читает оттуда. Backend подтверждает применение фактом успешного ответа.

## Handshake (Prompt Injection при запуске)

### Текущая версия (упрощённая)
```
WAITING_PROMPT → DEBOUNCE_PROMPT → send prompt → done
```

Thinking mode при запуске **не отправляется** через Handshake — это делает `alwaysThinkingEnabled: true` in `~/.claude/settings.json` глобально.

### Шаги
1. **WAITING_PROMPT:** Ждёт prompt-символа (`⏵` или `>`) в PTY output через `stripVTControlCharacters()`
2. **DEBOUNCE_PROMPT:** 300ms тишины (Ink рисует UI, может быть несколько чанков)
3. **Send prompt:** Bracketed paste + delayed `\r` (тот же паттерн что и `claude:send-command`)

### Что убрано (v2 → v3)
- **TAB_SENT / DEBOUNCE_TAB** — отправка `\t` для thinking mode. Стало ненужным с `alwaysThinkingEnabled: true`
- Было 4 состояния, стало 2
