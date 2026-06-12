# Факт: Codex CLI в Noted Terminal

Codex поддержан как третий PTY-agent рядом с Claude и Gemini. Это не SDK-интеграция: приложение запускает реальный `codex` в терминале, читает его JSONL из `~/.codex/sessions/`, а UI строит Timeline/History поверх этого файла. Главные пользовательские симптомы этой подсистемы: Codex запустился, но справа нет Timeline; кнопка копирования session id пуста; после Stop нет Continue; Codex-F стартует правильную сессию, но вкладка не подхватывает новый id; смена модели вводит `/model`, потом уходит в новую строку или показывает ошибку; loader правого кластера остаётся активным после неудачного picker-flow; `⎘ prompt` / `+ clear` открывает внешний редактор вместо копирования текущего composer'а.

## Источник session id

Авторитетный session id Codex берётся не из PTY-вывода, а из первой записи `session_meta.payload.id` в rollout JSONL. Файлы лежат по датам: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Парсер обязан игнорировать битую последнюю строку: Codex пишет append-only JSONL во время работы, и в момент чтения хвост может быть неполным.

Для `codex-c` с уже известным id watcher не нужен: renderer сразу получает `codex:session-detected` с тем же id, иначе кнопка Continue выглядит как новый запуск до тех пор, пока Codex что-то не допишет в файл. Для свежего `codex` watcher ищет самый новый rollout-файл по `mtime` и сверяет cwd. Для `codex-f` cwd-фильтр недостаточен: Codex может спросить «использовать текущую директорию или директорию исходной сессии», и если юзер выбирает директорию исходника, новый файл получает cwd исходного проекта, а вкладка была создана в другом. Поэтому watcher для fork принимает файл, если он либо совпал по cwd, либо внутри JSONL есть дополнительный `session_meta` с `sourceSessionId`; сам исходный id при этом надо пропустить, чтобы не привязать вкладку к старой сессии.

## Запуск и shell boundary

Команда запуска внутри приложения строится как `command codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox ...`, а не просто `codex`. Это намеренная граница с пользовательским zsh: если в `~/.zshrc` уже есть функция `codex() { command codex --dangerously-bypass-approvals-and-sandbox "$@"; }`, прямой вызов `codex --dangerously-bypass-approvals-and-sandbox` даст ошибку Codex про дублирующийся флаг. `command codex` обходит shell-function/alias и делает приложение владельцем полного набора аргументов.

Стартовые параметры модели и effort можно передавать сразу: `--model <id>` и `-c 'model_reasoning_effort="<effort>"'`. Это отличается от Claude: у Codex нет отдельного Think-toggle, а reasoning effort меняется через тот же `/model` flow, что и модель.

В ControlBar дефолты Codex (`gpt-5.5` / `xhigh`) — это per-tab UI state, а не скрытый глобальный override запуска. Если вкладка остаётся на дефолте, `codex:run-command` **не** передаёт ни `--model`, ни `model_reasoning_effort`: ожидается что такая пара задана в `~/.codex/config.toml` и принадлежит самому Codex. Аргументы добавляются только когда пользователь явно уводит конкретную вкладку от дефолта. Это защищает от «глобального эха»: настройка одной вкладки не должна молча становиться launch-параметром для всех последующих Codex-сессий.

## Timeline и History

`codex:get-timeline` строит точки из `event_msg.user_message`, дополняет их `turn_context` (model/effort) и `event_msg.token_count` (tokens/context%). `thread_rolled_back` откатывает последние turn'ы в уже построенном списке, compact-like события превращаются в compact marker. Это не Claude backtrace: у Codex сейчас нет нашего `parentUuid`-DAG, fork/plan markers, edit-range и token breakdown backend.

`codex:get-full-history` строит HistoryPanel из `response_item`: reasoning summary идёт в thinking, assistant message — в обычный ответ, `function_call` + `function_call_output` превращаются в raw tool card. Это даёт тот же визуальный слой HistoryPanel, но без Claude-only действий. Timeline для Codex использует text-search anchoring как Gemini, а не Claude OSC markers; если Timeline пуст при живом Codex, сначала проверяй session capture (`codexSessionId`), а не scroll/search-часть Timeline.

Codex compact надо читать из **top-level** записи `type: "compacted"`: именно там лежит `payload.replacement_history` — полный свёрнутый контекст. Соседний `event_msg.payload.type === "context_compacted"` полезен только как marker/telemetry и сам summary не содержит. Если парсер цепляется за `context_compacted`, HistoryPanel показывает пустую плашку `History Compacted`, а Timeline умеет только «здесь был compact», без содержимого. `preTokens` для плашки берётся из последнего предыдущего `event_msg.token_count.info.last_token_usage.total_tokens`, потому что сама compact-запись не несёт уже готового «237k tokens».

В отличие от Claude, Codex compact **не создаёт Old History Zone**. Pre-compact записи остаются доступны через rollout JSONL и `codex:get-full-history`, поэтому Timeline не должен выставлять `lastBoundaryIdx`, красный background или click gate для Codex. Оранжевый compact marker у Codex означает только «здесь Codex свёл контекст», а не «всё выше недоступно».

`replacement_history` может быть очень большим и содержать вложенные content-parts. В HistoryPanel его можно форматировать в полный текст, но Timeline polling не должен таскать это поле каждые 2 секунды: `codex:get-timeline` отдаёт короткое `Conversation compacted` + token count, а self-tooltip при Cmd-hover по compact marker лениво дёргает `codex:get-full-history`, достаёт `compactSummary` по uuid и кэширует. При форматировании пропускай/заменяй тяжёлые и нечитаемые части (`input_image`, `image_url`, `data:image`, encrypted compaction state) на короткие маркеры вроде `[image omitted]`, иначе один hover/copy может утащить base64 вместо полезной истории.

Docs-индикаторы для Codex собираются в `codex:get-timeline` из `response_item`, пока парсер стоит на текущем user-turn. `function_call` с `namespace: "mcp__knowledge"` и `name: "docs_search"` добавляет query в `docsSearchQueries`; `custom_tool_call` / `function_call` с `name: "apply_patch"` извлекает только patch headers `*** Add/Update/Delete File:` для `docs/` и `CLAUDE.md` в `docsEdited`. Не искать docs-события в `function_call_output` или stdout: там могут лежать большие Read-результаты, pasted docs-rules и diff'ы, что даёт ложные «документация обновлена» на Timeline. Цвета и precedence этих атрибутов описаны в `fact-timeline.md::Docs-индикаторы`.

## Usage limits

Codex лимиты берутся из того же rollout JSONL, не из отдельного внешнего `/usage` API. Авторитетная запись — `event_msg.payload.type === "token_count"` с `payload.rate_limits`: `primary` соответствует 5-hour бакету, `secondary` — weekly бакету; `resets_at` приходит epoch seconds и перед показом переводится в ISO/local time. Пока Codex не записал первый `token_count`, usage-чип обязан показывать пустое состояние, а не пытаться вычислять лимит из локальных токенов: формулу лимитов делает OpenAI, не приложение.

Это отличается от Timeline/context%: тот же `token_count` уже используется для точек Timeline, но usage-чипу нужен именно `rate_limits`, а не `last_token_usage.total_tokens`. Если в UI есть Timeline, но Codex usage пустой — сначала проверь, был ли в transcript хотя бы один `token_count.rate_limits`; session id и parser могут быть исправны.

## Loader и App Server

Для текущего продукта Codex App Server **не обязателен**: loader'у не нужны дробные состояния «пишет ответ», «ждёт approval», «выполняет команду». Нужен один high-level факт — turn ещё продолжается или уже завершён/прерван. Rollout JSONL уже даёт этот уровень через `task_started`, `task_complete` и `turn_aborted`; задержка до первой записи меньше секунды допустима, потому что пользовательские Codex-turn'ы обычно длятся минуты, а критичный риск — не поздний старт loader'а, а ложный обрыв посреди работы.

App Server остаётся future-path, если понадобится нативно вытаскивать approval/question UI, item-level tool lifecycle или официальный `turn/interrupt`. Не переносить Codex на App Server только ради loader'а, пока JSONL watcher стабильно держит busy=true на всём turn'е и сбрасывает его только по авторитетному завершению.

Prompt Queue / Run after использует тот же high-level слой: `task_complete` = штатный конец, можно отправлять следующий queued prompt; `turn_aborted` = ненатуральный конец, очередь надо disarm'ить. Дробные состояния «ждёт approval», «печатает ответ», «выполняет команду» для этой фичи не нужны — пользовательский инвариант один: пока Codex-turn не завершён, следующий prompt не уходит.

Граница `Escape`: приложение не считает raw `Escape`/`Ctrl+C` Codex-сигналом само по себе. Для Codex авторитетен только rollout JSONL: если после вмешательства появился `turn_aborted`, loader гасится и Run after disarm'ится. Claude-style fallback «нажали Escape → через короткую idle-проверку принудительно busy=false» пока не переносить на Codex без реального симптома, иначе можно получить ложный обрыв long-running turn'а.

### OSC 133 D→B debounce внутри Codex TUI

У Codex есть дополнительный shell-layer шум: PTY shell может эмитить OSC 133 `D` (`terminal:command-finished`) на короткой внутренней границе, а затем почти сразу приходит `B` и Codex продолжает тот же TUI lifecycle. Если на первый `D` сразу делать общий command-finished cleanup, приложение преждевременно чистит `codexKnownSessions`, закрывает turn watcher и гасит process state; пользователь видит микрофлап loader'а или Continue-state при живом Codex.

Для Codex-tab `parseOSC133AndEmit` задерживает `terminal:command-finished` на 250ms. Если за это окно приходит `B`, timer отменяется и логируется `[CodexTurn] suppress command-finished ... reason=osc-d-followed-by-b`. Если `B` не пришёл и `terminalCommandState` всё ещё idle — delayed cleanup выполняется. Это не заменяет rollout JSONL busy: `task_started/task_complete/turn_aborted` остаются источником turn-loader'а; debounce защищает только shell lifecycle cleanup.

## Модели и effort

Список моделей нужно брать из live `codex debug models`. Bundled catalog используется только fallback'ом: он может содержать hidden/internal/upgrade-only rows, которые интерактивный `/model` picker не примет. UI синхронизирует свои варианты обратно из реально распарсенного picker'а, потому что именно TUI является финальным источником «какие строки доступны этому аккаунту сейчас».

`/model` открывает два последовательных picker'а: сначала модель, потом effort. Парсер обязан:
- раскрывать `\x1b[<N>C` в реальные пробелы до `stripVTControlCharacters`, иначе строки слипаются;
- поддерживать узкий layout, где строка приходит как `2.` на одной строке, а `gpt-5.4` на следующей;
- матчить `xhigh` раньше `high`, потому что Codex может рендерить его как `Extra high`.

Открытие `/model` нельзя делать через фиксированную задержку. Проваленные варианты из этой сессии:
- `safePasteAndSubmit('/model', fast:true)` работал, но оставлял `/model` видимым в input около секунды из-за встроенного ожидания перед Enter;
- raw write `/model\r` мог трактовать Enter как перенос строки в composer;
- ожидание только sync marker давало ложную ошибку, когда Codex уже эхо-отрендерил `/model`, но маркер не пришёл в нужном окне.

Финальный сигнал для Enter: после bracketed paste `/model` ждать кадр, где либо чистый текст содержит `/model`, либо raw содержит sync marker `\x1b[?2026l`; только после этого слать отдельный `\r`. Таймаут здесь только error-path. Та же логика применяется к стрелкам: каждое движение по picker'у ждёт новый PTY frame, а не «спит N миллисекунд».

Сохранение draft'а при смене модели не должно идти через `Ctrl+G` external-editor. Этот путь правильный для явного `⎘ prompt | + clear`, но для picker'а он видимо меняет composer: пользователь видит `Save and Close`/очистку input'а, затем 5-секундный timeout и поздний restore. У Codex есть native stash: `Ctrl+C` на непустом composer'е очищает строку и кладёт draft в history, после picker'а его можно вернуть стрелкой вверх.

Перед любым `Ctrl+C` renderer обязан классифицировать xterm-buffer как `hasDraft=true/false/null`, потому что main видит PTY, но не знает состояние composer'а. `hasDraft=true` → `Ctrl+C`, затем `/model`; после успешной отправки `/model` восстановление делает `ArrowUp` два раза: первый элемент history — только что отправленный `/model`, второй — draft из `Ctrl+C`. Если `/model` не был отправлен, достаточно одного `ArrowUp`. `hasDraft=false` → не слать `Ctrl+C`, а открыть `/model` после очистки строки: на пустом Codex prompt raw Ctrl+C завершает TUI (`Shutting down...`), и следующий `/model` уходит уже в shell. `hasDraft=null` → fail closed с ошибкой вида `Cannot determine Codex input state safely`; speculative Ctrl+C запрещён.

Fail-closed live picker не должен означать «клик потерян». Пользовательский выбор модели/effort — tab-scoped намерение, а live `/model` — только попытка применить его к уже запущенному TUI. Если Codex сейчас busy (`task_started` уже пришёл и `task_complete`/`turn_aborted` ещё нет), если composer-state неизвестен (`hasDraft=null`), или если live `/model` flow вернул ошибку, ControlBar всё равно сохраняет `codexModel`/`codexEffort` на вкладке и показывает предупреждение. Текущий активный ответ не меняется посередине, зато пилюля не «откатывается» и следующий launch/non-default apply видит выбранное значение. Прод-шрам: в 15:43 MSK сессия уже была определена, но Codex был в активном turn; прежний код видел только живой процесс, не `task_started`, и клик по effort выглядел как неработающий.

Пустой Codex composer может показывать dim-placeholder (`Find and fix a bug in @filename`, `Explain this codebase`). Plain-text парсинг видит это как обычный текст, но xterm cell-style помечает подсказку как dim; такой кадр обязан классифицироваться как `hasDraft=false` с source вроде `cursor:*:dim-hint`. Не хардкодить конкретные фразы подсказок: они меняются версией Codex, а стиль остаётся единственным смысловым признаком «это hint, не draft». Реальный пользовательский draft содержит non-dim cells и идёт по `hasDraft=true` stash-path.

`Ctrl+G` / `codex:copy-input` нельзя использовать как preflight-истину перед `/model`. Этот путь нужен только для явного `⎘ prompt | + clear`: external-editor helper может вернуть пусто, пока xterm показывает dim-placeholder или draft, и сам заход в external-editor визуально меняет composer. Picker preflight читает только xterm-buffer; `Ctrl+G` остаётся пользовательской командой копирования/очистки, не диагностикой безопасности.

В dev-режиме Vite hot reload может перезагрузить модуль renderer-parser'а посреди живого терминала. Если реестр терминалов хранится в module-scope `Map`, ControlBar начинает видеть `no-terminal` при видимом Codex TUI и fail-closed пропускает live picker. Реестр xterm refs должен жить в process-wide singleton на `globalThis`; production reload стартует чисто, но dev/HMR иначе маскирует реальные picker-регрессии ложным `no-terminal`.

Диагностический контракт picker'а: пустой composer в логах выглядит как `hasDraft=false ... :dim-hint`; реальный draft — `draft-stash start` перед открытием `/model`, затем `draft-restore start arrowUp=2` после отправленной slash-команды (`arrowUp=1`, если `/model` не успел отправиться). При регрессе «с пустым input работает, с текстом не работает» сначала grep'ить эти маркеры, а не внешний editor-helper.

## Stop и ввод

Stop для Codex идёт через общий `terminal:stop-ai-process`: найти прямого child-процесса `codex` под shell PID и остановить его через controlled kill-ladder. Важно не путать это с «просто нажать Ctrl+C в UI»: raw Ctrl+C в Codex зависит от состояния input'а и может очистить строку, открыть danger-zone или выйти не тем путём. `terminal:stop-ai-process` сам владеет последовательностью graceful `\x03` → проверка живости → SIGTERM → SIGKILL fallback; если stop-кнопка «вводит codex» или не меняет Continue-state, значит commandType/session lifecycle разъехались, а не надо добавлять ещё один keystroke.

Close tab использует тот же stop-flow перед `terminal:kill`, даже когда confirmation dialog не показывается. Диалог завязан на busy/streaming loader, а не на `codexSessionId`: idle Codex с историей закрывается тихо, но live Codex foreground всё равно получает controlled stop, чтобы rollout JSONL успел дописать хвост. Cleanup `terminal:kill` обязан закрывать и session watcher, и turn watcher (`codexWatchers` + `codexTurnWatchers`); иначе после Esc/Stop/close вкладка может исчезнуть, а busy loader продолжит жить по старому watcher'у.

Codex не требует Claude-style `bridgeKnownSessions` / stale `~/.claude/bridge/*.json` guard'ов: у него нет statusline bridge, который может через секунду перезаписать вкладку древним sessionId. Его durable state — rollout JSONL в `~/.codex/sessions/`; `resume`/`fork` восстанавливаются из этого transcript, не из RAM процесса. Поэтому главный риск при резком убийстве другой: in-flight кусок ответа мог быть виден в терминале, но не успеть попасть в JSONL. Парсер уже игнорирует битый хвост, а UI должен считать историей только то, что записано в rollout. Пока реального симптома нет, не переносить на Codex весь Claude bridge/pendingResume слой «на всякий случай»; достаточно graceful-stop и диагностики SIGKILL как потери последнего незаписанного turn'а.

## Interrupted recovery и AutoResume

Codex участвует в том же interrupted-overlay / AutoResume flow, что Claude, но источник live-сессии другой. У Claude main берёт `bridgeKnownSessions`; у Codex нет bridge-файлов, поэтому main держит `codexKnownSessions` (`tabId -> codexSessionId`) из rollout watcher'а, ручного resume (`codex-c`) и fresh session detection. Shutdown помечает объединение `bridgeKnownSessions ∪ codexKnownSessions`; overlay Continue, AutoResume и Resume All восстанавливают Codex через `codex:run-command {command:'codex-c', sessionId, cwd}` и сразу эмитят `codex:session-detected`, не ждут новой записи в rollout.

Тонкий teardown-шрам: во время graceful quit `before-quit` сначала early-mark'ит активные AI, потом шлёт Ctrl+C живым CLI. Codex может успеть чисто выйти и сгенерировать OSC 133 D **до** `will-quit`. Если в этот момент `command-finished` очистит `codexKnownSessions`, финальный `will-quit` сделает clear stale `was_interrupted=1` и уже не re-mark'нет вкладку — после рестарта overlay пропадёт, хотя session была активна при закрытии. Поэтому `clearCodexKnownSession(tabId, 'command-finished')` запрещён пока `_gracefulShutdownInProgress=true`; map держится до финального clear+mark pass. Это Codex-аналог bridge lifecycle, но без stale-bridge takeover риска.

Микрофонная диктовка для Codex использует тот же PTY-путь, что Claude PTY: `terminal:paste` с `submit:false`, чтобы текст оказался в composer и юзер мог его отредактировать перед Enter. SDK-путь сюда не подходит: у Codex нет отдельного React composer'а внутри приложения.

`⎘ prompt | + clear` для Codex использует тот же external-editor flow, что Claude: UI триггерит Ctrl+G, helper `noted-code-grab.js` читает tempfile и либо копирует текст без очистки, либо атомарно копирует+truncates input в `grab` mode. Split-pill показывается только когда Codex PTY сейчас жив: старый `codexSessionId` означает историю/Continue, но без запущенного TUI composer'а нечего копировать или очищать.

Codex запускается двухслойным деревом процессов: shell → `node /opt/homebrew/bin/codex ...` wrapper → vendor binary `.../@openai/codex-*/bin/codex`. External-editor helper наследует `ppid` именно vendor binary, а не direct child wrapper. Поэтому main-side lock/socket registration должен обходить descendants под PTY shell и ставить `/tmp/noted-grab-<pid>.json` для всех Codex PID'ов, начиная с самого глубокого. Симптом неправильного lock'а: клик `⎘ prompt` или `+ clear` открывает пользовательский редактор (например Sublime), input не копируется и не чистится, а helper-log показывает `LOOK lockPath=/tmp/noted-grab-<vendorPid>.json existsBeforeRead=false` и `PASSTHROUGH mode=null`.

Та же wrapper-деталь важна для tab close warnings: `terminal:hasRunningProcess` должен отдавать full command-line, не только short `comm`, иначе direct child `node` будет выглядеть как обычный Node/script-процесс. Пользовательский симптом — Codex-tab с живым CLI получает warning как обычный процесс или, наоборот, обычный `node` внутри AI-typed tab закрывается без предупреждения.
