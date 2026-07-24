# Fix: Rewind Navigation Logic

### Симптомы
При попытке восстановить сессию из Timeline (Rewind) курсор в меню истории Claude начинает быстро прыгать вверх, но "промахивается" мимо нужного сообщения. В результате либо восстанавливается неверная точка истории, либо (в старых версиях) сессия ошибочно откатывалась в самый верх (к первому сообщению).

Проблема навигации по меню истории Claude Code (Rewind) и переход к "Visual Search".

## Второй Codex Rewind терял writer после успешного handoff

Пользовательский симптом: первый Rewind A→B проходил, но немедленный второй отвечал
`Codex writer is not ready for Rewind`, хотя вкладка продолжала работать в B. Первый
commit правильно менял SQLite binding и потреблял durable handoff journal, однако
следующая generic-проверка снова видела A и B открытыми writable и требовала уже
удалённый одноразовый journal. Просто доверять текущему binding опасно: sibling или
чужой rollout тогда можно принять за продолжение ветки.

Writer после commit доказывается отдельным settled proof только внутри того же
PTY/run/action generation. Все остальные writable candidates обязаны быть
доказанными предками выбранного child; новая ветка, append в source, Stop/relaunch
или смена поколения инвалидируют proof. Ещё одна гонка была между observer и
public reconciliation одного commit: второй callback приходил после удаления
journal и отзывал уже доказанного writer. Теперь он принимается только как exact
replay source+child+generation+terminal+run+SQLite binding; обычная последующая
reconciliation наследует lineage из settled proof, а не перезаписывает её пустыми
source/action. Направленный A→B→C подтвердил два последовательных Rewind без
`writer not ready`.

## Актуальность после native `/rewind` flow (2026-06)

Этот файл описывает safety/fallback-логику навигации, а не основной путь Timeline Rewind. Текущий default action в Timeline отправляет Claude slash-команду `/rewind`, выбирает target в родном picker'е, затем переносит восстановленный prompt из terminal composer в History textarea через тот же `grab-input` path, которым пользуется `+ clear`; terminal composer после этого должен остаться пустым. AI compact-варианты включаются только отдельными кнопками. Visual Search Strategy ниже остаётся защитой для ситуаций, когда позиционное сопоставление меню не сработало, но не должна снова становиться primary-моделью и не должна автоматически нажимать Enter при не найденной цели.

## Claude native `/rewind`: slash-команды в picker и малый viewport

Открытый шрам 2026-06-17: Claude native picker показывает не только user prompts, но и slash-command wrappers из TUI/JSONL (`/effort max`, `/model ...`). Наш Timeline эти записи скрывает tag-filter'ом, поэтому `rewindableCount`/`targetIndex` из Timeline не обязаны совпадать с числом строк в picker. На маленькой высоте терминала picker может показывать только несколько строк и строку `↑ N more above`; пользовательский симптом — после запуска обычного Rewind виден список почти из одних `/effort max`, target prompt не попадает в видимый фрейм, автоматика уходит в самый верх и висит.

Нельзя чинить это сменой формулы направления по чтению кода. Перед любым `Enter` должен быть доказательный лог текущего picker-frame: нормализованные видимые строки, какая строка выделена (`RGB`/`❯`), `more above/below`, нажатая клавиша, `targetPrefix`, `skipDuplicates`, и результат match. Если текущие логи не доказывают, почему выбранная строка не target, следующий шаг — добавить такие логи или прогнать воспроизводимый тест, а не менять `ArrowUp/ArrowDown` эвристику. До доказанного совпадения target операция обязана закрыть picker через `Escape` и вернуть failure; успешный UI-state без подтверждённой выбранной строки снова превращает старый баг в «откат в начало истории».

Отдельный шрам 2026-06-17: `matchedTarget=true` на визуально выделенной строке Claude picker ещё не доказывает, что `Enter` закоммитит именно этот prompt. В сессии `3879da40-f983-4063-9145-bcc327ddb057` target `"Это нам нужно..."` был выделен, но следующий prompt `1212` получил `parentUuid` предыдущего user-turn `"Это четырьмя..."`: Claude commit-position оказалась строкой над текущим выделением. Для такого layout success-условие перед `Enter` — доказанная commit-позиция `targetBeforeSelected=true` (target immediately above active row), а не просто `matchedTarget=true`. Same-prefix prompts нельзя различать коротким prefix-ключом: первые 40/180 символов годятся для читаемого лога, но identity для `skipDuplicates` и post-grab verification — полный normalized text/hash. Если `grab-input` после commit даёт другой text/hash или пусто, возвращай `claude_rewind_restored_input_mismatch` / `claude_rewind_restored_input_empty` с `rollbackMayHaveApplied:true`; History перечитывает source of truth, но не рисует OK.

Шрам 2026-06-20: Claude может рисовать другой commit-frame, где target prompt сам является выбранной строкой: `› сообщение 2` подсвечено цветом, а не строка ниже/выше. Это не отменяет старый `targetBeforeSelected`, а добавляет второй доказанный layout. Parser обязан сохранять `rawText` строки до normalize, потому что normalize стирает `›` и после этого невозможно доказать, что marker стоял именно у target. Допустимый pre-Enter proof теперь dual: `selectedMatchesTarget=true` для `›`/style-selected target row ИЛИ `targetBeforeSelected=true` для старого layout. Это не loosening success-критерия: после commit всё равно обязателен `grab-input` с полным normalized `targetFullText`/hash; mismatch/empty остаётся ошибкой с `rollbackMayHaveApplied:true`.

Дополнение 2026-06-21b: Claude marker/RGB действительно могут быть selected-proof, но не в момент первого PTY chunk. `selectionSignalRe` ловит цвет или `›` раньше полного sync-frame, поэтому после каждой стрелки нужен короткий quiet-drain перед чтением xterm snapshot; raw RGB-кандидат используется только как fallback, когда scoped snapshot недоступен. Это тот же класс бага, что у Codex stale-frame, но с другим proof: для Claude `›` валиден только если он стоит на selected row внутри scoped `/rewind` picker, а не как composer-ready или отдельный текстовый сигнал.

Дополнение 2026-06-20: старый `targetBeforeSelected` валиден только если selected row сама является history item. В production после restart selected row была `/model haiku`, а target `сообщение 2` стоял строкой выше; прежнее правило нажимало `Enter`, Claude коммитил slash-command row, и post-grab возвращал mismatch уже с восстановленным `/model haiku`. Поэтому `targetBeforeSelectedRaw=true && selectedIsSlashCommand=true` — это не proof, а danger-frame: скан продолжается или операция падает до `Enter`.

Дополнение 2026-06-21: repeated startup settings (`/model haiku`, `/effort low`) могут забить видимый picker так, что target из середины истории находится ниже текущего окна, а сканер, начавший с `ArrowUp`, упирается в верхний служебный блок и продолжает нажимать вверх до deadline. Пользовательский симптом: API/iOS/History Rewind «ничего не делает» или возвращает `Target not found`, хотя нужный prompt есть в родном меню Claude. Чтение visible buffer должно сначала вырезать именно область `/rewind` picker'а между заголовком/`more above|below` и footer'ом; stale highlighted slash-команды выше меню нельзя считать выбранной строкой. Если скан вверх дошёл до первого item без `more above`, надо переключиться на `ArrowDown`; если вниз дошёл до последнего item без `more below`, переключиться обратно. После разворота от верхней границы `skipDuplicates` очищается: первый target, найденный с этой стороны, уже относится к старшей ветке, а не к свежему дублю у хвоста. Regression-тест обязан включать цепочку `сообщение → несколько /model+/effort подряд → ещё сообщения → stop/resume → Rewind из середины`, а не только чистую историю из user prompts.

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

Шрам 2026-07-02: `inputReady=true` не является причинным доказательством, что Codex готов именно к Rewind. В dev-сессии `019f21ad` обычный input был ready, но первый `Escape` вернул только фрагмент `q`, transcript overlay не открылся, и старый код ошибочно переводил сессию в `starting`. Это неверная модель: отсутствие Rewind-prime доказывает только сбой протокола Rewind, а не потерю готовности Codex к обычному вводу. `codex:open-history-menu` сначала проверяет текущий visible-state: если виден старый rewind overlay/protocol chrome, закрывает его через `q` и пробует заново; если чистый старт не доказан или первый `Escape` не дал `esc again to edit previous message`/transcript overlay, операция возвращает `codex_rewind_start_state_not_clean`/`codex_rewind_prime_hint_not_observed` с `rollbackMayHaveApplied:false` и не публикует `starting`.

Шрам 2026-06-20b: успешный Rewind тоже может кратко показать startup-like frame после confirm. Production log: `[Codex:Rewind] confirm exposed startup frame ... preview="Update available! 0.140.0 -> 0.141.0"` → сразу `[WebBcast:SEND] ... status=starting`, но затем `Grab restored input ... success=true` и сервер вернул `active`. Это ложный статус-переход, не реальная потеря readiness: confirm-frame внутри Rewind recoverable до исхода grab. Фикс — не публиковать `starting` из `confirm exposed startup frame` сразу; сначала ждать `grabRestoredCodexRewindInput`. Только если grab/failure не восстановил composer, можно чистить ready и surface'ить not-ready/error.

Правильный порядок для диагностики: сначала добиться `prime initial timedOut=false hint=true`, потом увидеть transcript overlay, после каждого `←` дождаться quiet/stable frame, прочитать текущий overlay-frame и xterm visible-snapshot, сравнить target prompt с активной prompt-строкой и только после доказанного совпадения нажимать `Enter`. Grab здесь не способ открыть rewind, а verification/transfer step после rollback: доказать что Codex префиллил именно выбранный prompt и что terminal composer очищен перед передачей текста в History input. Для prompt'ов с картинками post-grab proof не должен требовать буквального равенства `[Image #1]` / `[imagePath: ...]` / `imageError`: сравнивается текстовая часть + позиция image slot, а recoverable draft берётся из rollout metadata (`local_images` / `text_elements`). Логовая цепочка успешного случая: `[Codex:Rewind] prime initial ... hint=true` → `[Codex:Rewind:ActiveSnapshot] ... matched=true` → `[Codex:Rewind] selected target before Enter` → `thread_rolled_back` в `codex:get-timeline/full-history` → `[Codex:Rewind] Terminal input grabbed+cleared ... matchedTarget=true mode=image-slot-with-rollout-path`.

Шрам 2026-06-18c: текстовый frame сам по себе не доказывает активный prompt в Codex transcript overlay. В 3-message flow target `2 сообщение` был виден рядом с другими prompt'ами, а символ `›` стоял у prompt-строк как marker, не как proof выбранной строки. Поэтому перед `Enter` Rewind запрашивает renderer visible-buffer snapshot и читает xterm cell-style prompt rows: активной считается строка, которую Codex подсветил background/inverse style. Если активная строка не совпала с target или style-parser не смог доказать активную строку, операция закрывает overlay через `q` и возвращает `codex_rewind_target_not_selected_before_enter` с `rollbackMayHaveApplied:false`. Видимый текст/порядок строк не может сам доказать commit; row-order допустим только как correction hint к соседней target-row, после reverse-step всё равно нужен новый style-proof target. Это fail-closed до commit: JSONL ещё не изменён, History не должна рисовать успешный Rewind.

Шрам 2026-07-02b: похожие prompt'ы нельзя матчить по общей середине текста. В dev-сессии `019f217f` target был `Короткий тест стриминга: ...`, а Codex overlay подсветил более поздний `Короткий тест стриминга 2: ...`; общий anchor внутри текста совпал, старый matcher нажал `Enter`, rollback применился, и только post-grab поймал `codex_rewind_restored_input_mismatch`. Теперь active snapshot проверяет начало подсвеченного prompt: если видимый префикс активной строки достаточно длинный и не является префиксом target, это `active-prefix-contradicts-target`, а не match. Общие средние фразы остаются только навигационным hint'ом, не commit-proof.

Диагностические логи для этого класса бага должны отвечать на style-вопрос, а не просто повторять visible text: prompt rows пишут `hasInverse`, `hasNonDefaultBg`, `activeByInverse`, а Rewind пишет `targetRows` со строками, которые совпали с target или имеют признаки выделения/фона. Если снова прилетает `codex_rewind_target_not_selected_before_enter`, следующий вопрос по логам — белый/активный фон вообще не приходит в xterm snapshot или приходит как `hasNonDefaultBg=true`, но не как `inverse`. Это диагностика, не ослабление proof: принимать raw text match как selected prompt всё равно нельзя.

Шрам 2026-06-21b: второй `Escape` уже открывает overlay на последнем prompt; если именно он target, стрелки не нужны — нужен style-proof выбранной строки и `Enter`. В iOS Project API target `323` был виден между latest prompt и `сообщение 2`, но `left#1` снял stale/intermediate кадр с прежней выбранной строкой, `left#2` уже показал `сообщение 2`, а text-hint потерял `›` и не включил correction; desktop retry прошёл только потому, что correction `target below selected row -> Right` вернула выделение на `323`. Контракт: `›` вообще не участвует в selected-proof, row-order берётся из xterm cell-style snapshot (`background/inverse` active row + matching target prompt row). Если target row виден рядом с selected row, допускается один reverse-step с повторной проверкой; если после reverse target не получил background/inverse, закрыть `q` и вернуть failure до `Enter`.

Перед `Enter` main всё ещё обязан вырезать chrome overlay'я/футер/статус из PTY-frame, построить якоря target prompt и применить `skipDuplicates` к совпадающим target'ам, а не к любому похожему тексту. Но этот text-frame теперь только помогает найти candidate и объяснить навигацию в логах; commit-proof даёт xterm style snapshot. Если Codex поменяет способ подсветки и style-parser перестанет видеть активную строку, правильный результат — ошибка до `Enter`, а не silent rollback на ближайший похожий prompt.

Шрам 2026-06-21: single-entry Codex Rewind через Project API падал `codex_rewind_target_not_selected_before_enter`, хотя target был единственной подсвеченной prompt-строкой в overlay. Причина была не в навигации, а в форме snapshot: активная xterm-строка отдавала только первую visual row multiline prompt, а target из rollout содержал полный текст. Фикс не ослабляет contract до «любой видимый текст подходит»: active row всё ещё доказывается cell-style, но длинный visible prefix полного target принимается как `active-visible-prefix`; короткие/общие prefix-ы остаются failure до `Enter`.

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
