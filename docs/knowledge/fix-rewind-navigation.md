# Fix: Rewind Navigation Logic

## 04.10 — Resume34: recovery не читала response-only user carriers

Exact send `project-send:6b2c4f0d…`03.10,18:55:58UTC был not-submitted,
paste/Enter=false. Resume19:03:47 снова получил codex_rewind_recovery_pending.
В shell процесса уже не было; блокировал journal native Rewind29.09
`mumcjbkq-codex-us`, phase confirm-enter-boundary, source01a05364, target1772.

Target действительно существовал: public History вернула UUID1772/offset22455757
и прежний137char hash. Но физический carrier — response_item/message(user).
Native target admission поддерживала эту форму, тогда как stable-source scanner
и recovery projector читали только event_msg/user_message. Следующий реальный
source turn1778→1780 также был response-only, поэтому recovery ложно сообщала
source-target-proof-mismatch и не могла увидеть продолжение исходной сессии.

SOURCE scanner/projector принимают обе структурные формы через прежние audit/
presentation helpers. Exact source line/UUID/hash сохраняются. Для submit proof
только первый logical user после task_started и его единственный response/event
companion допустимы; pairing использует прежнюю grammar. Steering, terminal
boundary, environment/project/aborted/Goal service carriers не подтверждают send.
Response target hash строится тем же formatter, что его pre-Enter admission;
raw audit hash/length остаются отдельным proof-доменом.

На real source read-only проверены полный no-child scan, прежний target hash,
новые task1778 и authored response1780 после action, unchanged binding. По ранее
разрешённому SQL выполнен existing DatabaseManager.resolvePendingCodexStableSourceFromTranscript
в exact raw-value CAS: удалён только блокирующий journal, source/history не
переписывались. Backup — `/private/tmp/noted-rewind34-20261004.9eAH4t/original-journal-backup.json`.
Resume через Terminal MCP вернул ту же source session active/inputReady/
writerConfirmed=true, process found; старый failed prompt не переотправлялся.
Это proof разрешения старого handoff на continued source, не ложное заявление
о выполненном rollback и не успешный post-Enter draft capture задним числом.

75 focused tests и main/renderer build4541/syntax/diff PASS. Generic source repair
ещё не установлен; production37537 не перезапускался. Результат/границы —
`/private/tmp/noted-rewind34-20261004.9eAH4t/RESULT.md`. Отдельная геометрия
side-terminal/overflow передана владельцу4196, не чинится recovery-флагом.

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

Позднее живые прогоны обнаружили обратный порядок успешного handoff. Observer успевал
durably привязать exact child и потребить journal до того, как основной сценарий
забирал восстановленный prompt из TUI. Откат уже был применён, но post-grab шаг
пытался заново доказать commit по исчезнувшему одноразовому состоянию и показывал
failure после фактического успеха.

Первый ремонт принимал exact replay по оставшимся watcher/intent. Production-инцидент
2026-08-02 доказал, что этого всё ещё недостаточно: source
`019fbcbe-0dbe-7bf3-88f8-0011d0b556d5` имел 189 turns, committed child
`019fc039-fd7a-7371-b531-4ee70b194ec0` — 187 при `rollbackTurns=2`, prompt с
картинкой уже вернулся в input, но observer и intent штатно закрылись до позднего
callback. UI поэтому ложно показал `codex_rewind_stable_source_proof_invalid`.

После grab допустимы три взаимоисключающих результата. Exact child уже committed
и в той же SQLite-транзакции оставил commit-квитанцию; source получил физический
`thread_rolled_back` с точной depth и только после этого journal проходит
`rollback-applied → stable-source-settled`; либо provider пока лишь вернул target
как редактируемый draft (`branch-draft-restored`). Сам возврат exact текста в
composer не является сохранённым rollback. Квитанция child связывает renderer
operation, внутренний request, action generation, исходный и текущий project,
tab, source+child, PTY lifecycle/run и точную цель/depth. Поздний callback не
требует watcher/intent, но повторно проверяет все эти поля и текущую SQLite-
привязку. Чужой child, callback другой операции, stale generation или новая
привязка fail-closed. После успешного ответа квитанция закрывается идемпотентно;
restart и перенос вкладки между проектами сохраняют исходную identity операции.
Само отсутствие journal или появление любого нового writer успеха не доказывает.

Физический acceptance теперь пройден на изолированной копии реального большого
rollout: native Rewind выбрал target по UUID, создал exact child, атомарно сменил
writer binding, перенёс target в History input один раз и пережил Stop → Resume
на том же child без `codex_rewind_recovery_pending`. Исходный production-файл
проверен по SHA-256 и не менялся. Отдельные отрицательные
operation/generation/child/CAS cases остаются unit/integration регрессиями.

Ошибка до подтверждающего `Enter` закрывает только доказанно открытый native
backtrack через `q`. Слепой cleanup через `Escape` запрещён: на idle composer
эта клавиша сама открывает Rewind и превращает исходный отказ в новый скрытый
protocol-state. После возможного `Enter` автоматика вообще не посылает
догадочную клавишу — дальнейший cleanup разрешён только свежим proof кадра.

## Codex: новый composer ещё запускается после подтверждённого Rewind (09.09.2026)

На изолированном Inbox target confirm Enter уже восстановил443-символьный
context-file prompt, но новый composer параллельно запускал MCP. Первый Grab
получил `codex_input_not_ready` ещё до Ctrl+G. Старый цикл сразу вышел, finally
отозвал разрешение операции, а журнал остался `confirm-enter-boundary`.
Позже истёк watcher, хотя сам процесс и настоящий draft продолжали жить.
Старые функции воспроизведены постоянным before-fixture, а первоначальная
операция физически восстановлена без нового Rewind/Enter/Send или restart.

После Enter временная неготовность — ожидание незавершённой операции, а не
доказательство её отмены. Main ждёт текущий committed initialized composer по
событиям, затем делает один owned Ctrl+G. Capture сохраняет полный helper payload
до разрешения clear и его exact applied outcome до удаления временных файлов.
Поздний результат читается по исходным operation/request/action generation;
новая клавиша не отправляется. Собственный input revision0→1 разрешён только
через exact armed capture. Смена процесса, lifecycle, run, source или чужой
input остаётся отказом. Истёкшее наблюдение можно восстановить по сохранённому
intent и оригинальному terminal object; новый action generation не создаётся,
отозванное разрешение на Enter не оживляется. Новые written native operations
уже не теряют watcher по обычному TTL; явный Stop/restart сохраняет свой cleanup.

`GET /api/terminal-tabs/:id/rewind-recovery` читает сохранённый результат;
`POST` продолжает только заданную старую операцию. Обязательны `operationId`
и `generation`/`actionGeneration`. Pending не является success. Полный target
в draft не доказывает сохранённого child: остаются прежние три исхода — exact
child+atomic lineage CAS, exact source rollback либо `branch-draft-restored`
до следующей настоящей отправки. В physical incident доказан последний исход,
byte-exact443, пустой composer, неизменные PID/run и один Ctrl+G.

Регрессии: `codex-rewind-post-enter*.test.js`,
`codex-rewind-recovery-http.test.js`, commit-receipt/SQLite/capture suites.
Source и установленная версия различаются; source-only фиксы не считать
установленными по одному этому документу.

## Актуальность после native `/rewind` flow (2026-06)

Этот файл описывает safety/fallback-логику навигации, а не основной путь Timeline Rewind. Текущий default action в Timeline отправляет Claude slash-команду `/rewind`, выбирает target в родном picker'е, затем переносит восстановленный prompt из terminal composer в History textarea через тот же `grab-input` path, которым пользуется `+ clear`; terminal composer после этого должен остаться пустым. AI compact-варианты включаются только отдельными кнопками. Visual Search Strategy ниже остаётся защитой для ситуаций, когда позиционное сопоставление меню не сработало, но не должна снова становиться primary-моделью и не должна автоматически нажимать Enter при не найденной цели.

## Claude native `/rewind`: slash-команды в picker и малый viewport

Дополнение 2026-08-02: полный transport-текст и строка native picker — разные
проекции одного хода. Для сообщения вида
`<pasted_content>…</pasted_content>\n\nобычный текст` History хранит полное тело и
рисует из него chip, а Claude `/rewind` показывает строку с обычного текста.
Сценарий теперь строит обе проекции одним parser'ом: `targetMenuText` используется
только для поиска и подсчёта видимых дублей, `targetFullText` остаётся точным
proof для post-Enter grab/hash. Paste-only ход без наблюдённой native-проекции
не угадывается и остаётся fail-closed.

Fallback-badge `REWIND DRAFT` появляется только пока provider вернул draft, но
ещё не создал child/rollback. Он считает старые пользовательские ходы, а не сырые
строки History/JSONL, и прямо говорит, что они всё ещё сохранены: один ход с
сотнями assistant/tool records показывается как `1 old turn still saved`.

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

Шрам 2026-08-23: тот же разрыв существовал в ручном `Escape → Escape → Enter`. Main перехватывает подтверждающий Enter, чтобы до destructive boundary сохранить exact target/writer journal. У многострочного сообщения prompt-glyph стоит только на первой visual row, а Codex рисует остальные строки отдельными inverse-highlighted рядами. Для paste первая строка могла быть всего лишь `<pasted_content>`, для Opt+V — `<saved_prompt name="…">`; старый parser сравнивал только эту строку с полным source и молча поглощал даже физический Enter как `selected-prompt-not-in-source`. Короткий тег сам по себе proof не становится. Headless snapshot теперь собирает весь непрерывный inverse-блок до первой невыделенной строки, снимает только TUI-indent/soft-wrap и затем сверяет полный нормализованный текст вместе с доказанной navigation depth. Механика общая для обычного текста, `<pasted_content>` и `<saved_prompt>` — marker-specific fallback запрещён.

Post-Enter proof также не должен зависеть от уже очищенного transient observer. Короткий composer по-прежнему подтверждается новым committed headless-frame. Если многострочный draft невозможно восстановить из cursor-row, main выполняет exact external-editor `copy` (не `grab`): текст остаётся в composer, операция допускается только при неизменных terminal/lifecycle/run/input revision. Любой новый ручной символ отменяет probe. Exact child завершается существующей durable commit receipt после source→child handoff; stable-source допускается только после физического `thread_rolled_back`, а просто восстановленный composer остаётся `branch-draft-restored`. Это закрывает одновременно ложный timeout на длинном prompt и `rewind-restored-observer-scope-changed` после уже принятого child.

Шрам 2026-08-24a: bounded launch-watcher оказался ошибочно равен capability ручного Rewind. После app restart Resume-процесс оставался idle дольше десятиминутного TTL; `Escape → Escape` открывал и точно распознавал native transcript, но подтверждающий Enter поглощался как `rewind-observer-unavailable`, а Timeline показывала ложное «дождись отправки» при фактическом `busy=false`. Файловый watcher вправе завершиться, но его точное наблюдение source остаётся до смены terminal token, lifecycle generation, runSeq, launch или persisted source. Это только read/Rewind admission: writer authority всё равно заново доказывается перед мутацией.

Шрам 2026-08-24b: physical и composite Codex History нельзя проверять одним неполным tuple. Renderer всегда передавал `viewOwnerSessionId`; main принимал само наличие этого поля за composite view и требовал `entryRef + contentRevision`, которых у обычной физической session по определению нет. Поэтому ПКМ-Rewind падал `ambiguous_entry_identity` до первого TUI-write, хотя UUID реально существовал. Physical target теперь допускается только при совпадении view owner с доказанным writer и идёт по direct UUID; composite target принимает только полный all-or-nothing tuple и повторно проверяет revision. Ошибка затем роняла History вторично: callback закрытия failed-card был объявлен у user-row, а использован у rewind-row. Глобальный regex-тест видел имя в обоих местах и ложно проходил; регрессия должна вырезать и проверять конкретный `HistoryEntry` component scope.

Шрам 2026-08-24c: не каждая видимая `user_message` является точкой ветвления Codex. В production `tab-3314` сообщение строки `20415` было отправлено во время уже активного provider turn: перед ним не было нового `task_started`. Rollout и transcript overlay его показывали, но native branch ответил `selected prompt was not found in the persisted thread`. Старый main считал любую user-строку branchable, создал durable handoff перед Enter, а после upstream-отказа не увидел ни child, ни stable-source submit и навсегда заблокировал Resume как `codex_rewind_recovery_pending`.

Источник branchability теперь причинный: первый `user_message` после нового `task_started` является turn-boundary; следующие user carrier до следующего task — steering/queued input внутри того же хода. Такой target оставляет overlay открытым и блокируется до Enter с явным предупреждением; legacy rollout без `task_started` сохраняет прежнюю capability. Для уже принятого Enter recovery различает неизвестный исход и доказанный нулевой исход. Только если процесс точно отсутствует, descendant scan завершён без child, binding всё ещё source, target/hash неизменны и после action нет ни `thread_rolled_back`, ни нового `task_started`, ни нового `user_message`, журнал удаляется compare-and-delete без изменения истории. `found/unknown`, новый writer или любая durable mutation по-прежнему сохраняют журнал.

Шрам 2026-08-24d: ручной Rewind повторно сделал presentation владельцем identity. В `tab-4196` exact native `TRANSCRIPT` был открыт, оба Escape и Enter дошли до main, но выделенная длинная карточка была прокручена так, что viewport показывал tool-output. Pre-Enter matcher не нашёл восстановленный экранный текст среди `event_msg.user_message` и сам поглотил Enter как `selected-prompt-not-in-source`; Codex мутацию не получал. Добавление очередного parser'а для кавычек/tool-output/XML не закрывает класс.

Ручной target теперь выбирается только causal ordinal нативного selector: начальная позиция — newest visible user cell, каждый `Escape/←` сдвигает к старому, `→` — к новому. Source UUID/line/hash и rollback depth берутся из этой позиции; экранный text match хранится только как `screenConsistency` для диагностики и не может выбрать другой index либо veto'ить Enter. Exact title + adjacent footer с `enter to edit message` достаточно для protocol proof, даже если leading `›`/inverse row длинной selected-карточки выше viewport. Writer, terminal/lifecycle/run generation, durable journal, branchability и post-Enter child/stable-source receipt остаются обязательными; обычный composer от этого не получает право на destructive Enter.

Физический isolated E2E открыл второй конец того же контракта. Codex 0.147 в одном запуске ответил `Failed to branch before the selected prompt…` и вернул prompt в composer; старый post-frame код счёл сам возврат текста доказательством rollback и ложно публиковал source как settled writer. В другом запуске upstream показал `You’re continuing from this point in a new conversation`, но новый rollout появился только после следующего Enter. Эти кадры нельзя объединять в «draft вернулся = success».

Теперь exact newer provider-error frame завершает action как rejected, очищает journal, повторно доказывает прежний writer и не меняет History. Exact continuation frame сохраняет отдельную фазу `branch-draft-restored`: она не выдаёт source за откатанную историю, но разрешает один следующий submit только при том же terminal/lifecycle/run/source, exact composer и durable audit. Следующий Enter создал в E2E child `01a033de-42d6-7ba2-a371-27ab422ee24a`; journal исчез, binding/read/writer перешли на child, `writerUsableForMutation=true`. Настоящий stable-source success требует физического `thread_rolled_back` с точной depth. Restart до branch submit разрешает потерянный draft как no-mutation, а не как rollback.

Шрам 2026-08-25: History-native Rewind мог вернуть exact target в input, сразу
объявить source «стабильно откатанным» и записать фазу `rollback-applied`, хотя в
rollout не появлялись ни child, ни `thread_rolled_back`. History временно скрывала
старое будущее, а следующий Stop → Resume навсегда упирался в
`codex_rewind_recovery_pending`: recovery принимал `rollback-applied` за durable
успех, но одновременно не умел доказать для него ни rollback, ни no-mutation.
Теперь programmatic и manual пути используют одну proof-таксономию: сначала exact
child, затем exact `thread_rolled_back`, иначе pending `branch-draft-restored`.
Legacy `rollback-applied` после доказанного process exit, complete no-child scan,
неизменной binding/target и отсутствия новых source events очищается как
no-mutation; если точный rollback event всё же существует, recovery завершает
stable-source транзакцию. Старый xterm scrollback может содержать уже нарисованные
строки source — это не текущая история child; active composer/footer и
History/Timeline принадлежат принятому writer.

Saved-history Rewind остаётся отдельной фиолетовой операцией рядом с amber native
Rewind: он не открывает picker, а владеет `stop → delete tail → copy-on-write
child/source binding → resume`. В History две кнопки стоят вертикально у user-row
и вызывают разные сценарии. Перед удалением durable target раскладывается обратно
на editable text, saved-prompt/pasted-content chips и только доказанные image refs;
image-looking текст внутри paste не становится вложением. После commit этот
snapshot prepend-merge'ится с тем, что пользователь успел набрать во время
операции, поэтому JSONL Rewind не уничтожает новый draft.

Native и saved-history Rewind не могут вести две независимые незавершённые
транзакции одной вкладки. После Stop saved-history path сначала повторно
сверяет старый native journal, пока source binding ещё не заменена: exact
no-mutation/rollback/child закрывает его, unresolved состояние блокирует новый
JSONL write до мутации. Если copy-on-write child уже успел сохраниться до этого
контракта, recovery принимает его только по app-owned `history_delete/edit`
lineage и тому же byte-level target-prefix proof; время файла или один факт новой
binding не являются доказательством. Rewrite-lineage остаётся в базе для
History/ownership, но не рисуется синей Fork-полосой. Ошибки и успех этого
сценария всегда tab-scoped; успешный `tui-ready` убирает старую inline-плашку
неудачного Resume, не стирая отдельное закрываемое уведомление о прошлой попытке.

Same-source recovery также не заканчивается вместе с ранней фазой journal. После
точного stable-source submit durable intent закономерно переходит в
`stable-source-submit-written`; restart в этой точке не должен превращать уже
сохранённый ход в вечный `codex_rewind_recovery_pending`. Такая фаза завершается
только по всей исходной submit identity: тот же source/action/submitId,
length+transport hash, прежняя файловая граница и runSeq, затем собственный
`task_started` и первый точный `user_message` после этой границы при неизменной
binding и полном no-descendant scan. `submit-armed`, другой prompt/path/binding
или неполная запись остаются fail-closed; journal удаляется атомарным
compare-and-delete, а не отдельной очисткой.

Для старых v2/v1 receipts без `originPhase` требуется совместимое чтение
прежней stable-source формы, а не TTL-clear или синтез нового receipt. Полная
submit/target/byte proof остаётся той же; см. `fact-codex.md::Старый Rewind после
обновления приложения`.

Presentation заканчивает ту же транзакцию на первом новом точном provider
`user_message`, а не на shell `command-started`: Codex TUI остаётся одним
долгоживущим процессом, поэтому следующий AI turn не создаёт нового shell-event.
С этого события `REWIND DRAFT` снимается даже когда upstream оставил старый
source-future физически сохранённым; иначе History скрывает реальный UUID, а
Timeline продолжает по нему переходить и получает `uuid-not-in-display`.
Timeline одновременно подписан на canonical live-message stream: ручной Enter
без History receipt сразу даёт лёгкую точку с exact UUID/source aliases во время
busy, а полный snapshot после `task_complete` заменяет её без дубля. Тяжёлые
AI-действия над bounded live-point остаются выключены до полной материализации.
Служебный Codex preamble (`AGENTS.md`/`CLAUDE.md`) проходит тем же live-stream с
явным `serviceCarrier=project-instructions`: History показывает его чипом перед
связанным prompt, Timeline не создаёт вторую точку. Rewind/JSONL rewrite по
единственной точке настоящего prompt владеет всем turn-пакетом, включая этот
preamble; отдельной пользовательской координаты у файла инструкций нет.

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
