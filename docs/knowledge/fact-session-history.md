# Feature: Cross-session history tools

## Intro
History-tools единого Terminal MCP позволяют **любой полноценной вкладке читать историю любой другой Claude/Codex-сессии** поверх тех же JSONL-парсеров, что Timeline. Это peer-доступ к транскриптам, а не отдельный управляющий процесс. Публичный `overseer MCP` удалён; старое имя `/overseer/*` пока остаётся только у внутренних HTTP-маршрутов.

Редактирование истории остаётся **Claude-only**. Claude JSONL имеет `parentUuid`-цепочку и существующий edit-range/fork pipeline, поэтому `fork_session` / `propose_edit` / `apply_edit` идут через Timeline IPC. Codex rollout читается для discovery/stats/turn pull, но не переписывается: файл append-only принадлежит живому Codex CLI и не имеет Claude edit-range модели.

Процедура выбора методов находится в глобальном skill `~/.claude/skills/terminal/SKILL.md`; отдельный prompt со списком endpoint'ов больше не нужен.

## Почему peer-доступ не равен делегации

Четыре параллельных JSONL в четырёх процессах нельзя слить в один turn без потери временной нити, поэтому нужен адресуемый read/edit чужой истории. Полноценная делегация — другой контракт: persistent run Project API с completion-уведомлением и точным result endpoint. Временная декомпозиция без отдельной вкладки принадлежит встроенным subagent-инструментам Claude/Codex.

## Внутренняя граница единого Terminal MCP

Namespace объединён, ownership нет:
- live process/scenario tools действуют на текущий runtime;
- history-tools читают сохранённый transcript и только для Claude могут вызвать подтверждённый edit/fork pipeline.

Один MCP нужен для обнаруживаемости нейронкой, а не для слияния реализаций. Подробнее см. [`fact-terminal-mcp.md`](fact-terminal-mcp.md).

## History-tools: granular-чтение + редактирование

**Чтение** — agent сам решает сколько контекста забрать, сервер не навязывает:
- `list_open_sessions` — все Claude/Codex табы всех проектов: tabId, sessionId, cwd, project, createdAt + runtime-поля `status`, `busy`, `busySources`, `turnBusy`, `lastEventType/lastEventTs`. Для Claude дополнительно отдаёт `model`, `contextUsedPct/contextRemainingPct` и `contextSource` (`bridge` или persisted DB), если это видно из statusline bridge. Эти поля нужны регистратору: `isLive` означает только «PTY/таб жив», а не «ответ уже готов».
- `session_stats` — масштаб **без контента**: turnCount, char-counts по ролям, toolUseCount, largestUserTurn/largestThinkingTurn, compact-счётчики, заметки/rewind-маркеры/docs-edits
- `list_turns` — карта ходов: preview (220 char) + размеры каждого thinking/text-блока + имена tool_uses. Полные тела не возвращаются клиенту, но canonical transcript подготавливается внутри приложения
- `list_notes` — пользовательские якоря Timeline (заметки, rewind-маркеры, orphan-notes)
- `get_user_prompt` / `get_thinking` / `get_assistant_text` — точечный pull одного блока, UTF-16 диапазон через `start/end` (negative offsets как в Python)
- `get_turn_evidence` — историческая модель/effort и страничная карта инструментов одного выбранного хода; по точному `operationId` возвращает ограниченные input/result и их источник. `operationOffset/operationLimit` листают операции, `inputStart/inputEnd` и `resultStart/resultEnd` читают нужный диапазон; `maxChars` ограничен 65536

**Поиск обсуждения и поиск инструментов — разные операции.** `search_sessions`
(`/overseer/search-sessions`) отвечает на «где я это обсуждал»: он строит
turn-модель каждой сессии-кандидата и сравнивает запрос токенами с текстом
промпта и видимым ответом. Правок файлов он не видит в принципе — сборщик
ответа берёт только блоки thinking/text, поэтому ни apply_patch, ни Edit/Write,
ни их вывод в сравнение не попадают. Вопрос «какая сессия редактировала вот
этот символ» через него не решается никакой формулировкой запроса.

`search_transcripts` (`/overseer/search-transcripts`, `src/main/transcript-grep.js`)
— обратный подход: turn-модель не строится вообще, файл сессии читается чанками,
совпадение ищется побайтово, JSON парсится только у совпавшей строки. Запрос
здесь точная подстрока, а не токены. Мерка стоимости: построить turn-модель
одного Codex rollout'а на 300 МБ дороже, чем пройти побайтово весь корпус —
измеренные 17 ГБ за ~11 с. Поэтому чтение обязано быть асинхронным: `readSync`
в цикле заморозил бы main на эти секунды целиком.

Окно дат у двух поисков означает разное, и это не мелочь. В каталоге сессий
дата — это когда вкладка создана или закрыта. Живой пример 2026-09-10: вкладка
«визуал History» создана 17 августа, а правку сделала 10 сентября; под
`period:"today"` по датам каталога проходило 5 сессий из 100 и нужной среди них
не было — поиск честно вернул бы ноль на вопрос «кто менял это сегодня». Поэтому
`search_transcripts` не передаёт окно в каталог, а фильтрует по времени записи
файла транскрипта: те же 100 кандидатов дают 59 подходящих, и правка находится.
Неизвестное время файла не выбрасывает сессию — пустой ответ хуже лишнего скана.
Отдельно считаются `outsideDateWindow` и `unresolvedSessions`: сессия без файла
на диске это ограничение охвата, а не ошибка чтения, и держать её в `errors`
значило бы отдавать десятки строк шума и прятать в них настоящие отказы.

Ключевой фильтр — `kinds="edit"`. Символ из уже закоммиченного кода лежит в
десятках сессий, которые файл только читали; без фильтра выдача — шум. Правка
опознаётся по записи, а не по тексту: у Codex это `patch_apply_begin/end`
(там же лежат изменённые пути) и `exec` с `*** Begin Patch`, у Claude —
`tool_use` с именем Edit/Write/MultiEdit. Вторая ловушка — Codex resume копирует
транскрипт предка в новый rollout, поэтому одна историческая правка честно
находится сразу в нескольких сессиях; сортировка идёт по времени записи, и
верхнее совпадение — та сессия, где правка реально произошла. Путь файла для
обоих провайдеров берётся из `AgentSessionAvailabilityService.resolveSessionFiles`:
второй сканер деревьев `~/.claude/projects` и `~/.codex/sessions` завёл бы
собственный кэш с собственным рассинхроном.

**Редактирование Claude** — через те же IPC что Timeline-кнопка; Terminal MCP **никогда не пишет JSONL напрямую**:
- `fork_session` — клон под новым UUID
- `propose_edit` — dry-run: что именно удалится (backtrace + forward-expand), без записи на диск
- `apply_edit` — реальная правка через `claude:edit-range` (mode=compact) или `claude:delete-range` (mode=delete)

Для Codex эти же имена tools остаются видимыми как единый контракт, но mutation path обязан отказать явно. Молчаливый no-op хуже ошибки: агент решит, что переписал историю, и начнёт строить следующий шаг на несуществующем fork/edit.

## Granular-чтение: почему agent decides volume

19MB-сессия (262 turn'а) → читаемый overview за ~6K токенов. Сервер отдаёт **карту размеров** (`session_stats` → `list_turns`), агент видит где мясо и тянет точечно `get_thinking` только нужных ходов с byte-range для больших. Это не truncate-на-сервере: агент сам решает глубину. Эмпирически agent сначала зовёт thinking (плотнее текста — Claude в нём пересказывает задачу), text только если непонятно.

## Фильтрованные пользовательские сообщения

Для аудита пользовательского feedback `search_user_messages` читает прежнюю
canonical turn-модель, но возвращает только выбранные user records и их refs.
Это не новый transcript reader или индекс. Scope — один `project` либо явные
`sessionIds`; `dateFrom/dateTo` относятся к времени сообщения, не созданию вкладки.
`query` ищет подстроку только в полном user text. `promptName` сравнивается с
историческим именем структурной saved_prompt-обёртки: упоминание и plain Markdown
не доказывают вставку, context-update-id — другой вид контекста. Даже найденная
обёртка не доказывает жест Opt+V. Примеры в Markdown code/blockquote не считаются
обёртками вставки. Найденные `prompts/contextUpdates` возвращаются раздельно.

Default `kinds:[user]` включает Claude queued_command. Complete leading AGENTS/
environment и context wrappers отделяются от собственного пользовательского
хвоста, а не выкидывают весь turn. Compact, служебный/агентский ввод и пустая
continuation имеют отдельные классы. Durable semantic tag сильнее текстового
service-envelope; у старого текста без sidecar классификация остаётся явно
помеченной envelope evidence, а не независимым доказательством авторства.

`get_user_messages({messages:[...ref],maxChars,cursor})` возвращает только выбранные
полные canonical user bodies. Ref содержит sessionId, turnIndex, userUuid и textHash;
изменение UUID/текста даёт явный отказ, не чтение другого сообщения по старому номеру.
Budget тела60000 по умолчанию, максимум250000 UTF-16 символов и100refs за запрос;
большое тело продолжается по nextCursor без разрыва surrogate pair. На странице
сохраняются start/end/totalChars и признаки остатка. Ошибки прежних страниц
не превращаются в complete=true при успешном последнем фрагменте.

Search: default50/max200 строк и5/max25 сессий за страницу; дополнительные
128000символов бюджета summaries, ограниченные названия/списки с явными flags.
Пустая страница может иметь nextCursor. Cursor stateless, привязан к фильтрам,
каталогу и source revision недочитанной сессии; изменение требует нового поиска.
Порядок catalog-then-turn, не глобальная сортировка сообщений. Живой обход разных
сессий не является атомарным снимком архива. scanComplete означает конец каталога;
coverageComplete отдельно учитывает ошибки и неизвестные timestamps.

Записи fork не считаются новыми использованиями промпта: copyStatus показывает
доказанное наследование либо неизвестность; usageProof не выводится из равенства
текста/имени. `evidenceTurnIndex/evidenceAddress` сохраняют границу канонического
proof: послеcompact overview может создать пустую строку, тогда exact operation
адресуется в предыдущем настоящем user-turn. Переносить proof по соседству без
совпавшего operationId нельзя. Шрам04.10: map18 child2a561 → evidence16 по exact
call_ROhEcHK0BzgjOGRBIl5K8MaI:canonical:3, без чтения raw JSONL агентом.

Wire: GET `/overseer/user-messages`, POST `/overseer/user-messages/read`;
`/overseer/capabilities.userMessageHistory.version=1` проверяется MCP до вызова.
Новый MCP поверх старого Main требует app update, а не выдаёт пустой архив.

## Недоступный источник и основание fork

History resolver учитывает точную provider-column binding, общий availability
resolver и прежний metadata lookup Codex. Ошибочный cwd не ограничивает поиск
одним project directory. Отсутствующий Claude-файл больше не выдаётся за Codex
только из-за fallback; missing, I/O unknown, provider conflict и lineage failure
различаются. Error сохраняет diagnostics и lineageReason через HTTP и MCP.
`session_stats({diagnosticsOnly:true})` читает metadata/availability без turn parse;
наличие файла и записанной relation не обещает успешного canonical чтения.

При архивном пробеле нельзя делать вывод о чистке по одному404. В UAV e4aa28e4
старый живой shared resolver подтвердил именно Codex catalog и unresolved source
в active/archived roots; альтернативный cwd не помог. Для6b47b298 найден child59MB,
но отказ provider-history-base-absent означает legacy unknown relation без списка
доказанных inherited UUID и пригодного provider history_base. Новая сборка даёт
точную диагностику, но не восстанавливает отсутствующий файл или недостающий proof.
Нельзя подставить parent как child или объявить все218missing/5lineage случаев
восстановленными по двум примерам. Retention policy — fact-хранилище-сессий.md;
факт удаления конкретного источника требует отдельного свидетельства.

## Ожидание ответа: status первичен, текст вторичен

Terminal MCP `send_prompt` подтверждает только доставку текста в живую вкладку. `Status: sent` не означает, что Claude/Codex закончил отвечать. Для разовой ручной инспекции регистратор использует history-tools того же MCP: `list_open_sessions` пока нужная сессия появилась с `sessionId`, затем `busy:false` / terminal completion event.

Это ручной MCP-flow для разовой инспекции уже открытой сессии. Для «дождись её
нынешней работы, затем прочитай ответ» используется `wait_for_tab_response`,
без prompt/Resume целевому агенту. Ожидание принадлежит persistent run приложения,
а не серии `list_open_sessions`/`session_stats`; новый ответ обычно приходит inline.
Новая работа поручается отдельно через `delegate_to_session`. Read-only наблюдение
не подменяет ошибку/оборванный последний ход предыдущим успехом. Такой клиент может
работать через Project API без локальных MCP; см. [`fact-оркестрация-вкладок.md`](fact-оркестрация-вкладок.md).

`get_assistant_text` может уже показывать промежуточные text-блоки, пока `busy:true`: для длинного Claude-аудита это нормальное состояние, а не готовый финал. Если оркестратор объявил «Claude не ответил», а позже в JSONL появился финальный text-блок, это баг преждевременного ожидания/timeout в оркестраторе, не потеря ответа.

`read_output` допустим только как аварийный fallback, когда history backend вообще не видит sessionId. TUI-буфер содержит ANSI/обрезку/wrap и может отставать от JSONL, поэтому не является источником истины для ответа агента.

## Edit через существующие IPC + auto-fork safety

`apply_edit` не дублирует backtrace/orphan-cleanup/relink — оборачивает `_api.editRange`/`_api.deleteRange`, экспортированные из `ipc/claude-data.js` (те же функции что зовёт IPC-handler Timeline-кнопки). Это гарантирует идентичное поведение с UI и не удваивает поверхность багов (logic знает про compact-границы, parentUuid-цепочку, atomic temp-write).

**Auto-fork по умолчанию**: первая правка сессии (`autoFork: true`) сначала делает `fork_session`, оперирует на копии, возвращает новый sessionId — оригинал нетронут, откат = закрыть таб форка. `fs.copyFile` 19MB ≈ 50ms. Для chained-правок на том же форке — `autoFork: false` + sessionId форка.

`propose_edit` обязателен перед `apply_edit` (правило в промпте регистратора) — сначала план в чат, OK юзера, потом запись.

## Двухзаписный compact

Каждый `/compact` в JSONL — **пара соседних записей**: `compact_boundary` (turnIndex N, без контента, `preTokens`/`postTokens` в `compactMetadata`) и сразу следом `isCompactSummary`-user-запись (turnIndex N+1, 6-17K символов auto-сгенерированного summary). `list_turns` отдаёт их как `kind:'compact_boundary'` и `kind:'compact_summary'` — это **одна логическая операция**, не две. Точка сжатия = boundary, содержимое сжатого = summary. Агент, ссылающийся на «turn N+1» после boundary, не ошибается — это summary-запись, отдельный addressable entry.

## App-owned compact/fork context

`session_stats` при чтении идемпотентно сверяет provider transcript с
`session_history_events` и возвращает компактный `historyEvents`: direct fork,
children и compacts без тяжёлого UUID snapshot. `totalIterations` считает только
реальные user/queued turns без noise. `list_turns` добавляет `iterationIndex`, а
compact-строки — `afterIterationIndex` и `nextIterationIndex`; Claude
boundary+summary имеют одну `compactEventIdentity`.

Команда `/compact` не является фактом: строка БД появляется только после
Claude `compact_boundary` либо Codex top-level `compacted`. Старые/provider-native
fork восстанавливаются из Claude `forkedFrom` или Codex `forked_from_id`, после
чего переживают закрытие вкладки и удаление orchestration-run. Источник истории,
visual parent и orchestration parent возвращаются разными полями и не могут
подменять друг друга.

## Доказательства отдельной операции без выгрузки всей сессии

Обычный `list_turns` сохраняет компактную карту. Аргументы и результаты запрашиваются отдельно через `get_turn_evidence` → `/overseer/session/:id/turn/:idx/evidence`. Причина появления: при аудите нельзя было отличить успешный `docs_search` от упоминания или ошибочного запуска, а модель живой вкладки не доказывала, какая модель выполняла августовский ход. Поиск сначала определяет нужное место; затем сверяются `userUuid`/timestamp, поскольку номер итерации может измениться после восстановления истории.

Codex evidence использует общий `transcriptService.loadCodexOperationSource` с `includeRecords:true`, включая frozen parent и child составной истории. Точный UUID не заменяется совпадением номера/текста. Время вызова и ответа берётся из соответствующих provider records, output связывается по call id; у вложенного exec время контейнера не выдаётся за время отдельного внутреннего вызова. Claude выбирает результаты только из активной ветки. Model/effort имеют provenance; поздняя смена настроек после проверяемой операции не изменяет её историческую модель.

Поле `result.state` описывает provider output/is_error, а не успешность задачи внутри него: stdout может содержать ненулевой exit code, MCP error или `Script running with cell ID ...`. В последнем случае нужен окончательный ответ соответствующего Wait; при проверке поиска важны его реальные `found/files/error/model`. Нормализованный input динамического exec может содержать имя переменной вместо вычисленного значения — недостающий факт нельзя угадывать. Отсутствующий ответ отмечается как missing, обрезанный — явными границами среза.

`docsEdited`/`docsSearchQueries` у Codex берутся из существующей Timeline-проекции, а не из одного Claude-style имени инструмента. Это полезные признаки для отбора, но динамические exec-выражения могут не раскрывать query; нулевой флаг не доказывает отсутствия поиска. `isCompactSummary` и fork-происхождение также нужно учитывать: копия FULL в контексте не является новым нажатием промпта.

## Транспорт

Terminal MCP stdio → HTTP к main (`/overseer/*` остаются внутренними endpoint'ами) → парсеры из `ipc/claude-data.js`. Port discovery сначала использует `NOTED_MAIN_PID`, затем longest-prefix по cwd. Кэш распарсенных turns по `mtime+size` JSONL: первый `list_turns` на 19MB ~3-4с (CPU-bound parse), последующие миллисекунды пока сессия не дописана. См. [`fix-mcp-multi-instance.md`](fix-mcp-multi-instance.md) про PID-порт инфру.

## Code Map (неочевидные связи)
- `_api` объект в `ipc/claude-data.js` — `forkSessionFile`/`editRange`/`deleteRange` вынесены из IPC-handler'ов в named-функции, handler стал тонким шимом `(e,payload)=>_api.editRange(payload)`. main.js импортирует `_api` как `claudeDataApi`, history endpoints зовут его напрямую. Edit-логика живёт в одном месте, два входа (IPC от Timeline + внутренний HTTP).
- `_computeEditRangePlan` (main.js) — read-only зеркало forward-expand логики edit-range для `propose_edit`, считает removeUuids без записи.

## Main-owned bounded History

Claude и Codex History читаются одним main-owned сервисом. Ограничения `last`,
`before`, `after` и `around` применяются на этой границе, до передачи в HTTP/MCP;
доступность renderer и произвольный UI-timeout не участвуют в результате.
Persisted tab/session binding является первичным для остановленной фоновой
вкладки, поэтому открывать History ради чтения не требуется.

Для обычного Claude `last=N` rich-проекция удерживает только хвост N записей уже
во время прохода по transcript. Полный parentUuid/backtrace всё ещё строится там,
где он нужен для edit/fork, но bounded read не создаёт второй полный массив и не
маскирует тяжёлую работу пятитисекундным отказом.
