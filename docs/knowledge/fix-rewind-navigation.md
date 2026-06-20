# Fix: Rewind Navigation Logic

### Симптомы
При попытке восстановить сессию из Timeline (Rewind) курсор в меню истории Claude начинает быстро прыгать вверх, но "промахивается" мимо нужного сообщения. В результате либо восстанавливается неверная точка истории, либо (в старых версиях) сессия ошибочно откатывалась в самый верх (к первому сообщению).

Проблема навигации по меню истории Claude Code (Rewind) и переход к "Visual Search".

## Актуальность после native `/rewind` flow (2026-06)

Этот файл описывает safety/fallback-логику навигации, а не основной путь Timeline Rewind. Текущий default action в Timeline отправляет Claude slash-команду `/rewind`, выбирает target в родном picker'е, затем переносит восстановленный prompt из terminal composer в History textarea через тот же `grab-input` path, которым пользуется `+ clear`; terminal composer после этого должен остаться пустым. AI compact-варианты включаются только отдельными кнопками. Visual Search Strategy ниже остаётся защитой для ситуаций, когда позиционное сопоставление меню не сработало, но не должна снова становиться primary-моделью и не должна автоматически нажимать Enter при не найденной цели.

## Claude native `/rewind`: slash-команды в picker и малый viewport

Открытый шрам 2026-06-17: Claude native picker показывает не только user prompts, но и slash-command wrappers из TUI/JSONL (`/effort max`, `/model ...`). Наш Timeline эти записи скрывает tag-filter'ом, поэтому `rewindableCount`/`targetIndex` из Timeline не обязаны совпадать с числом строк в picker. На маленькой высоте терминала picker может показывать только несколько строк и строку `↑ N more above`; пользовательский симптом — после запуска обычного Rewind виден список почти из одних `/effort max`, target prompt не попадает в видимый фрейм, автоматика уходит в самый верх и висит.

Нельзя чинить это сменой формулы направления по чтению кода. Перед любым `Enter` должен быть доказательный лог текущего picker-frame: нормализованные видимые строки, какая строка выделена (`RGB`/`❯`), `more above/below`, нажатая клавиша, `targetPrefix`, `skipDuplicates`, и результат match. Если текущие логи не доказывают, почему выбранная строка не target, следующий шаг — добавить такие логи или прогнать воспроизводимый тест, а не менять `ArrowUp/ArrowDown` эвристику. До доказанного совпадения target операция обязана закрыть picker через `Escape` и вернуть failure; успешный UI-state без подтверждённой выбранной строки снова превращает старый баг в «откат в начало истории».

Отдельный шрам 2026-06-17: `matchedTarget=true` на визуально выделенной строке Claude picker ещё не доказывает, что `Enter` закоммитит именно этот prompt. В сессии `3879da40-f983-4063-9145-bcc327ddb057` target `"Это нам нужно..."` был выделен, но следующий prompt `1212` получил `parentUuid` предыдущего user-turn `"Это четырьмя..."`: Claude commit-position оказалась строкой над текущим выделением. Для такого layout success-условие перед `Enter` — доказанная commit-позиция `targetBeforeSelected=true` (target immediately above active row), а не просто `matchedTarget=true`. Same-prefix prompts нельзя различать коротким prefix-ключом: первые 40/180 символов годятся для читаемого лога, но identity для `skipDuplicates` и post-grab verification — полный normalized text/hash. Если `grab-input` после commit даёт другой text/hash или пусто, возвращай `claude_rewind_restored_input_mismatch` / `claude_rewind_restored_input_empty` с `rollbackMayHaveApplied:true`; History перечитывает source of truth, но не рисует OK.

Шрам 2026-06-20: Claude может рисовать другой commit-frame, где target prompt сам является выбранной строкой: `› сообщение 2` подсвечено цветом, а не строка ниже/выше. Это не отменяет старый `targetBeforeSelected`, а добавляет второй доказанный layout. Parser обязан сохранять `rawText` строки до normalize, потому что normalize стирает `›` и после этого невозможно доказать, что marker стоял именно у target. Допустимый pre-Enter proof теперь dual: `selectedMatchesTarget=true` для `›`/style-selected target row ИЛИ `targetBeforeSelected=true` для старого layout. Это не loosening success-критерия: после commit всё равно обязателен `grab-input` с полным normalized `targetFullText`/hash; mismatch/empty остаётся ошибкой с `rollbackMayHaveApplied:true`.

Дополнение 2026-06-20: старый `targetBeforeSelected` валиден только если selected row сама является history item. В production после restart selected row была `/model haiku`, а target `сообщение 2` стоял строкой выше; прежнее правило нажимало `Enter`, Claude коммитил slash-command row, и post-grab возвращал mismatch уже с восстановленным `/model haiku`. Поэтому `targetBeforeSelectedRaw=true && selectedIsSlashCommand=true` — это не proof, а danger-frame: скан продолжается или операция падает до `Enter`.

## Claude Rewind из остановленной сессии: defaults before `/rewind`

Шрам 2026-06-18: обычный `Откатиться` из Timeline должен работать и когда Claude process уже закрыт. Rewind-кнопка не должна быть disabled только из-за inactive process: действие сначала восстанавливает session (`claude --resume`), затем ждёт startup defaults gate, затем открывает native `/rewind`. Симптом нарушения был двоякий: сначала пункт `Rewind` был серым в History/Timeline при закрытой сессии; после разблокировки клик запускал Claude, но `/rewind` либо не стартовал, либо шёл до завершения `/effort max`.

Корень задержки `~6s` между `/effort` и `/rewind` был не в Claude, а в нашем fallback ожидания prompt boundary. `/effort` не всегда создаёт spinner-phase, поэтому boundary state не переходил в busy и marker не инжектился. После запрета fallback цепочка стала падать правильно, но вскрылся второй слой: при выходе Claude main сбрасывал `promptBoundarySeq`, а renderer в xterm-buffer всё ещё помнил старые markers. Новый `prompt:1` после restart игнорировался как уже существующий, gate снова висел. Фикс: seq lifetime = tab/xterm buffer; service slash-command arms boundary manually; timeout = failure.

Не возвращать поведение «если boundary не пришёл — через N секунд всё равно запускаем `/rewind`». Это снова создаёт старый класс багов: `/rewind` попадает в model/effort confirmation, commit идёт не в тот prompt, или пользователь видит “ничего не произошло”. Правильная диагностика — логи `tui-ready`, `send-command`, `bridge model match`, `BoundaryMarker prompt:<seq>`, `waitForClaudeStartupDefaultsReady`.

Шрам 2026-06-19: после фикса defaults-gate остановленная сессия уже корректно проходила `claude --resume` → `/model` → `/effort` → prompt boundary (`waitForClaudeStartupDefaultsReady passed`), но Rewind всё равно падал. Доказательный кадр был `[Claude:Rewind:SlashAfterEnter] slashHelpOpen=true menuLooksOpen=false`: первый Enter не открыл picker, а оставил Claude в slash-help на строке `/rewind Restore the code...`. Это не чинится увеличением ожидания defaults и не является поводом возвращать timeout fallback.

Финальный guard: после первого `/rewind` Enter всегда читается visible snapshot. Если виден slash-help и нет menu-proof, main шлёт один confirm Enter и логирует `[Claude:Rewind:SlashConfirmEnter]`; дальше снова требуется `menuReadyRe`/menu frame. Если menu frame не доказан, операция fail-closed до навигации. Этот confirm относится только к `claude:open-history-menu`, поэтому покрывает все Rewind entrypoints, которые идут через native Rewind, но не меняет обычный send prompt.

## Codex native backtrack: prime first, grab only as verification

Codex откатывается не через `/rewind`, а через native backtrack: первый `Escape` должен показать hint `esc again to edit previous message`, второй `Escape` открывает transcript overlay, дальше к старым prompt'ам двигается `←` (footer Codex прямо пишет `esc/← to edit prev`, но для автоматики после открытия overlay безопаснее считать `Escape` не cancel-клавишей, а соседним жестом редактирования). Выход из открытого overlay без выбора — `q`, не `Escape`. Не переносить сюда Claude/Gemini slash-command модель и не начинать с `Ctrl+G` как preflight. External-editor grab до первого prime-кадра сам меняет composer/TUI state и маскирует root cause: потом в логах видно только `codex_rewind_prime_hint_not_observed`, хотя реальная проблема в том что backtrack даже не был корректно открыт.

Шрам 2026-06-18: stopped-session Rewind для Codex нельзя считать готовым по факту spawn'а процесса. В первые секунды Codex может показывать `Starting MCP servers ... esc to interrupt`; если в этот момент автоматика шлёт первый `Escape`, он отменяет MCP startup, после чего Codex пишет `MCP startup interrupted`, а Rewind висит или падает уже в загрязнённом состоянии. Поэтому `codex:tui-ready` отвергает MCP startup/update/trust/directory frames, ждёт quiet-window и проверяет видимый buffer; сам `codex:open-history-menu` отказывается с `codex_not_input_ready`, если ready marker ещё не доказан.

Шрам 2026-06-18b: цепочка `Update available` → `Choose working directory to resume this session` ломала cold Rewind без явной ошибки: update prompt прожимался, но следующий chooser приходил в raw PTY как рваный кадр, detector не видел полный `Session/Current/Press enter`, а visible xterm buffer уже показывал корректный экран. Решение — кормить startup detector не только raw onData, но и quiet-snapshot видимого buffer'а; Rewind всё равно ждёт доказанный `codex:tui-ready`, а не продолжает по таймауту или по факту живого процесса.

Шрам 2026-06-20: failed Rewind на iOS оказался не iOS-багом. В логах `/status` до Rewind возвращал `active` для старой session, а desktop startup уже жил вокруг новой Codex-сессии; `Codex:Rewind readiness before prime` показывал `inputReady=true`, `readySource=raw`, но `readyPreview` всё ещё содержал MCP startup (`MCP servers (8/9)` / update prompt). После первого Escape Codex не отдал fresh raw (`rawBytes=0`, `hint=false`), операция упала `codex_rewind_prime_hint_not_observed`, и только затем SSE сменил статус на `starting`. Контракт: Rewind не должен доверять stale raw-ready и старому API session-binding; если current frame не доказал чистый composer текущей session, операция падает до backtrack и чинится в main/API readiness, не в native клиенте.

Шрам 2026-06-20b: успешный Rewind тоже может кратко показать startup-like frame после confirm. Production log: `[Codex:Rewind] confirm exposed startup frame ... preview="Update available! 0.140.0 -> 0.141.0"` → сразу `[WebBcast:SEND] ... status=starting`, но затем `Grab restored input ... success=true` и сервер вернул `active`. Это ложный статус-переход, не реальная потеря readiness: confirm-frame внутри Rewind recoverable до исхода grab. Фикс — не публиковать `starting` из `confirm exposed startup frame` сразу; сначала ждать `grabRestoredCodexRewindInput`. Только если grab/failure не восстановил composer, можно чистить ready и surface'ить not-ready/error.

Правильный порядок для диагностики: сначала добиться `prime initial timedOut=false hint=true`, потом увидеть transcript overlay, после каждого `←` читать текущий overlay-frame и xterm visible-snapshot, сравнить target prompt с активной prompt-строкой и только после доказанного совпадения нажимать `Enter`. Grab здесь не способ открыть rewind, а verification/transfer step после rollback: доказать что Codex префиллил именно выбранный prompt и что terminal composer очищен перед передачей текста в History input. Логовая цепочка успешного случая: `[Codex:Rewind] prime initial ... hint=true` → `[Codex:Rewind:ActiveSnapshot] ... matched=true` → `[Codex:Rewind] selected target before Enter` → `thread_rolled_back` в `codex:get-timeline/full-history` → `[Codex:Rewind] Terminal input grabbed+cleared ... matchedTarget=true`.

Шрам 2026-06-18c: текстовый frame сам по себе не доказывает активный prompt в Codex transcript overlay. В 3-message flow target `2 сообщение` был виден рядом с другими prompt'ами, а символ `›` стоял у prompt-строк как marker, не как proof выбранной строки. Поэтому перед `Enter` Rewind запрашивает renderer visible-buffer snapshot и читает xterm cell-style prompt rows: активной считается строка, которую Codex подсветил background/inverse style. Если активная строка не совпала с target или style-parser не смог доказать активную строку, операция закрывает overlay через `q` и возвращает `codex_rewind_target_not_selected_before_enter` с `rollbackMayHaveApplied:false`; никакого fallback'а по порядку строк/видимому тексту нет. Это fail-closed до commit: JSONL ещё не изменён, History не должна рисовать успешный Rewind.

Перед `Enter` main всё ещё обязан вырезать chrome overlay'я/футер/статус из PTY-frame, построить якоря target prompt и применить `skipDuplicates` к совпадающим target'ам, а не к любому похожему тексту. Но этот text-frame теперь только помогает найти candidate и объяснить навигацию в логах; commit-proof даёт xterm style snapshot. Если Codex поменяет способ подсветки и style-parser перестанет видеть активную строку, правильный результат — ошибка до `Enter`, а не silent rollback на ближайший похожий prompt.

Если после `Enter` rollback уже применился, а grab вернул пусто/другой текст, это не «почти успех». Возвращай `codex_rewind_restored_input_mismatch` / `codex_rewind_restored_input_empty` с `rollbackMayHaveApplied: true`: History должна перечитать rollout как durable source, но UI не имеет права утверждать что target prompt безопасно перенесён в textarea. Пользовательский симптом нарушения — справа история уже усечена или JSON поменялся, а в живом терминале prompt не появился/не очистился; это выглядит как рассинхрон terminal vs History.

Не возвращать старые fallback-пути «prime hint не увидели → попробуем `grab-input` и ещё один Escape» или «rollback применился, grab mismatch → всё равно вставим AI compact». Такие fallback'и меняют состояние Codex без доказанного target/composer и скрывают настоящий сбой под поздним side effect'ом. Если fallback участвовал бы в дальнейшей цепочке, вся операция должна падать, а не продолжать Rewind.

Шрам 2026-06-17: regression `skipDuplicates is not defined` сработал уже после успешного открытия transcript overlay. Пользователь видел «открыл Esc и завис», а в dev-log была точная цепочка `Starting native backtrack` → `open Esc timedOut=false` → `Error: skipDuplicates is not defined`. Фикс был не по чтению кода «похоже тут баг», а по детерминированному логу; catch-path после открытого overlay теперь закрывает `q`, потому что `Escape` в этом состоянии может перейти к предыдущему prompt'у вместо отмены.

## Codex AI Rewind: tail-only paste is not JSONL truncation

Симптом: после AI Rewind в Codex Gemini-сводка генерируется полностью, но новый prompt в Codex/rollout начинается с середины текста — например видны только пункты 4-5 списка, а первые пункты исчезли. В той же операции Claude принимает сводку целиком. Это не обрезка JSONL writer'ом: rollout сериализует уже тот `user_message`, который успел оказаться в composer'е Codex к моменту submit.

Отброшенный подход: разбить fast paste на UTF-8-safe чанки до 900 байт. Это правильно для защиты кириллицы от разрыва внутри code point, но не решает race Codex composer ↔ Enter: fast path всё ещё пишет start/chunks/end подряд и затем жмёт Enter по задержке, без подтверждения что crossterm/React state увидели весь logical paste. Поэтому хвостовой prompt может сохраниться даже когда байтовые границы корректны.

Финальный контракт для `codex-rewind-ai`: использовать TUI-safe `safePasteAndSubmit(..., fast:false)`, то есть одна complete bracketed paste, ожидание sync/render marker после закрывающего `\x1b[201~`, короткий drain и только потом Enter. Перед Enter staging `CodexPasteAudit` обязателен: следующая запись rollout `event_msg.user_message` должна совпасть по длине/hash с Gemini result. Если audit показывает mismatch, сначала чинить paste/composer path; Gemini prompt и формат summary здесь вторичны.

Архитектурная граница: это всё ещё PTY fallback. `codex app-server` и его `thread/rollback` + `turn/start` существуют, но для текущей архитектуры Noted Terminal это нежелательный внешний experimental control-plane, не наша локальная JSONL/PTY-модель. Не переводить Rewind/Edit на app-server без явного разрешения пользователя: middle-history действия должны оставаться локальными (rollout JSONL + TUI-safe paste/backtrack) до отдельного архитектурного решения.

## Проблема
Изначально использовалась формула: `Steps = CurrentCursor - TargetIndex`.
Это приводило к критическим ошибкам (`Steps = -17`), когда целевое сообщение находилось за пределами видимой области прокрутки (Virtual Scroll). TUI не знает о существовании элементов выше видимого окна.

## Boundary Awareness (Ограничения TUI)
Критически важно понимать, что TUI-меню истории Claude Code отображает записи только **после последней очистки контекста** (события Compact или Plan Mode Clear Context). 
- Все сообщения, отправленные до этой границы, физически стерты из терминала и не появляются в меню Rewind.
- Попытка отката к таким сообщениям заблокирована в UI.

## Решение: Visual Search Strategy
Вместо попытки предсказать количество шагов, мы используем алгоритм "слепого поиска с проверкой зрения":

1. **Check Visibility:** Если текст уже на экране — используем точный расчет шагов.
2. **Fallback:** Если текста нет — ставим лимит **50 нажатий**.
3. **Normalization:** Текст цели и текст, считанный с экрана, подвергаются **`.trim()`**. Это критично, так как Claude Code может добавлять или убирать отступы в меню TUI по сравнению с сырым JSONL.
4. **Loop:** Нажимаем `Arrow UP`.
5. **Detect:** После каждого нажатия анализируем сырой PTY-вывод.
6. **Match:** Ищем строку, окрашенную в **Lavender RGB** (`\x1b[38;2;177;185;249m`), и сравниваем нормализованный текст.
7. **Skip Duplicates:** Счетчик дубликатов (`skipDuplicates`) теперь учитывает только те записи, которые находятся **после последней границы** (Compact/Plan Mode). Это предотвращает ложные пропуски, если идентичные сообщения (например, разделители `========`) существовали в стертой части истории.
8. **Stop:** Как только текст совпал и нужное количество дубликатов пропущено — останавливаемся.

## Safety Guard (Защита от сброса)
**Критическое изменение:** Если после 50 нажатий цель НЕ найдена, алгоритм **не нажимает Enter**.
*   **Раньше:** Если текст не совпадал, цикл заканчивался и нажимался Enter на текущей позиции (обычно это начало истории). Сессия откатывалась в самый верх.
*   **Сейчас:** Если `found === false`, приложение шлет `Escape`, чтобы закрыть меню без выбора, и возвращает ошибку. Это гарантирует, что сессия не будет испорчена из-за сбоя навигации.

## Почему RGB, а не `❯`?
Символ `❯` часто отсутствует в инкрементальных обновлениях (diffs) PTY, которые приходят от `node-pty`. Цвет фона или текста (Lavender) присутствует в ANSI-кодах всегда при перерисовке активной строки.

## Ссылки
*   `docs/knowledge/fact-claude-tui-mechanics.md` — детали о цветах и Ink.
