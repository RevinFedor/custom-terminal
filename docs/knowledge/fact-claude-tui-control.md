# Факт: Управление Claude Code TUI из приложения

## Проблема
Claude Code CLI работает на базе Ink (React TUI) в raw mode с включённым **bracketed paste mode**. Это означает:
- `\r` (CR) и `\n` (LF), отправленные через PTY → **не сабмитят ввод**, а создают новую строку
- Обычный `\t` (Tab) → не переключает thinking mode (нужен `meta+t`)
- Slash-команды (`/model`, `/compact` и т.д.) — обычный текстовый ввод, парсится после Enter

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

См. также `methodology/design.md::Воспринимаемая задержка UI-команд` — пустой инпут ощущается «лагающим» на тех же 80ms, на которых заполненный инпут визуально «мгновенный»; именно поэтому drain'ы свели до минимума event-driven путём.

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
4. **Список effort-уровней меняется между релизами Claude.** В мае 2026 `auto` был удалён, добавлен `xhigh` между `high` и `max`. Хардкод массивов `['auto','low','medium','high','max']` рассыпан по 4 файлам не пережил апдейт — UI показывал несуществующий `auto`, новый `xhigh` отсутствовал. Решение: **один canonical-файл** `src/renderer/constants/claudeLevels.ts` экспортирует `CLAUDE_EFFORT_LEVELS`, `CLAUDE_EFFORT_TOGGLE_OFF`, `CLAUDE_MODELS`. Все use sites импортируют оттуда. Legacy migration `'auto' → 'low'` для persisted values. Принцип переносимый — см. `methodology/design.md::Single source of truth для third-party shipping values`.

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
| **Compact** | Отправляет `/compact` через `claude:send-command` (тот же Stash flow что Model/Effort: Ctrl+S → bracketed paste → Enter, ~400ms). Никакого матчинга TUI-вывода — `/compact` встроенная slash-команда Claude, ввести+Enter достаточно. | Всегда нейтральный (нет «активного» состояния, разовое действие). |

**Дефолт «Think всегда ON при перезапуске» (важная invariant):**
- `thinkActive` хранится в `useState<Record<string, boolean>>({})` в InfoPanel.
- Когда `thinkActive[tabId]` === `undefined` → UI рендерит как активный.
- Хендлер `terminal:command-finished` (OSC 133 D, на любой shell-exit) **удаляет ключ** `tabId` из map → следующий запуск Claude снова покажет Think tinted. Это совпадает с реальным поведением `alwaysThinkingEnabled` — он применяется при каждом старте.
- Корнер-кейс: если юзер выключил Think через TUI вручную (`meta+t` напрямую в терминале) — наш UI этого не узнает (bridge не транслирует). При перезапуске опять покажем ON, и это совпадёт с реальностью. Рассинхрон mid-session — invisible intent, см. секцию про Effort.

**Почему Compact не использует `claude:toggle-thinking`-style picker:** `/compact` не открывает выбор — он просто сжимает контекст и продолжает разговор. Поэтому достаточно `safePasteAndSubmit` со стандартным `stashFirst: true` (защищает user prompt в инпуте).

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

### Auto-confirm «Change effort level?» dialog
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

**Решение** (`main.js::ptyProcess.onData` после Session ID detection): отдельный детектор смотрит на `stripVTControlCharacters(data).includes('Change effort level')` → через 120мс шлёт `\r` в PTY. Cooldown `claudeEffortDialogCooldown` 2с защищает от двойного срабатывания при Ink re-render. Cleanup при `ptyProcess.onExit`.

**Шрам: текст в Ink-меню рендерится без литеральных пробелов.** Первая версия матча была `'Change effort level' && 'Yes, switch'`. Падала: Ink TUI заменяет пробелы внутри строки меню на `\x1b[1C` (cursor-forward) — после `stripVTControlCharacters` получается `Yes,switchtolow`. Плюс диалог приходит в **3-5 отдельных PTY-чанках** (заголовок жёлтый, описание серое, опции синие — каждый блок отдельным write), поэтому матч из двух подстрок в пределах одного chunk вообще не имеет шансов. Финальный матч — только на уникальном `Change effort level` (это всегда самостоятельный chunk с жёлтым `[1m...[22m`).

**Задержка 120мс перед `\r`:** ранее было 80 — Ink не успевал дорисовать остаток меню до прихода Enter, и Enter иногда попадал в неопределённое состояние (то срабатывал, то «съедал» prompt). 120мс — детерминированно после полного render.

**Принцип:** см. `methodology/design.md::Ink TUI: пробелы как ANSI-команды, текст разорван по чанкам`. Любой будущий парсер TUI-вывода для Claude должен матчить **минимальные уникальные подстроки** (одно слово или короткая фраза), не комбинацию из двух — Ink почти гарантированно разнесёт их по чанкам.

### Auto-inject `/effort` при запуске Claude

В StatusBar справа — pill `Effort: max` (default per-app, не per-tab). При каждом запуске Claude процесса значение шлётся как `/effort <level>` через event-chain:

```
bridge видит новый PID → claude:process-started fires
→ Terminal.tsx handler читает useUIStore.getState().defaultClaudeEffort
→ если ≠ 'none' → ipcRenderer.invoke('claude:send-command', tabId, '/effort max')
```

**Почему `claude:process-started`, а не `claude:session-detected`:** session-detected fires на каждом bridge re-sync (раз в 1-2 секунды); session_id остаётся прежним при `claude --resume`, guard всегда false → /effort инжектится только однажды на жизнь таба. Process-started fires ровно один раз на спавн binary (новый PID). См. `fact-claude-stop-hook.md::Fresh-process detection`.

**Почему без setTimeout:** `safePasteAndSubmit` сам ждёт sync-marker `\x1b[?2026l` от Ink. Если инпут ещё не готов — ждёт **внутри** функции (event-driven). Возвращается за 8-30ms на happy path. Раньше был paranoid `setTimeout(800ms)` обёртка — это "timeout как safety net вместо причины", антипаттерн (см. `methodology/design.md::Воспринимаемая задержка UI-команд`).

**`max` нельзя задать в settings.json:** Claude CLI silently downgrades `effortLevel: "max"` до null при первом запуске. Максимум что settings.json держит — `high`. Из-за этого инжекция через `/effort max` — **единственный** способ стартовать сессию в max effort.

**Persistence — SQLite, не localStorage.** `defaultClaudeEffort` сохраняется через `app:setState` IPC. Раньше был localStorage — но vite-dev меняет порт (5181 → 5182 → 5183) когда есть orphan Electron'ы, и каждый порт это **отдельный origin** → отдельное localStorage хранилище. Юзер видел "max сбрасывается после рестарта", думал что не сохраняется — на самом деле сохранялось, но на другом origin'е. См. `fix-localstorage-origin.md`.

### Click-toggle-off на effort кнопке

Повторный клик на уже-активный effort → выбор сбрасывается на `auto` (DeepSeek: `off`). Это **переносимый UX-принцип** (см. `methodology/design.md::Click-toggle-off на single-select`) — для filter pills, tag selectors, любых toggle-эквивалентных кнопок.

Реализация: `const targetLevel = isActive ? (isDeepSeek ? 'off' : 'auto') : level;` — один тернарник в onClick, остальная логика без изменений. Tooltip меняется на `Click again to deselect (→ auto)` когда `isActive`.

## Stop button — SIGTERM по PID, не keystroke в TUI

InfoPanel `SessionActionChip` hover → "Stop" → клик. Реализация **должна** вызывать `terminal:stop-ai-process` (SIGTERM по PID Claude process), **не** слать `\x03` (Ctrl+C) в PTY.

**Почему Ctrl+C не работает:** Claude TUI обрабатывает одиночный Ctrl+C как **"clear input"** (если в input есть текст) или **"взвести danger zone"** (Press Ctrl-C again to exit). Юзер кликает Stop → Claude не умирает, никаких ошибок → недоумение.

**SIGTERM по PID детерминированный:** `terminal:stop-ai-process` находит дочерний PID через `ps -eo pid,ppid,command | grep claude` где `ppid === ptyProcess.pid`, шлёт `SIGTERM` через `process.kill`. Через 800ms escalate в `SIGKILL` если процесс не умер. Тот же IPC использует split-button "Stop Claude" в TabBar — если split-button работает, InfoPanel Stop должна работать так же.

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

InfoPanel содержит **две зависимые строки** — Provider row и Model row — плюс Effort и Think. Принцип двухуровневого селектора (Provider → Model) описан в `methodology/design.md::Two-tier hierarchical selectors`. Здесь — конкретика поведения и **разные backend'ы для одинаковых UI-контролов** в зависимости от выбранного провайдера.

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

