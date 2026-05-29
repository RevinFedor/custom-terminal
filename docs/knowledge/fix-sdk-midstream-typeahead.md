# Fix: Mid-stream type-ahead в SDK-табе

Отправка сообщения **во время** стриминга ответа Claude в SDK-табе — нативное поведение Claude TUI («дожидается окончания текущего блока, потом сразу отправляется»). Реализовано через долгоживущий input-channel поверх `query({ prompt: asyncIterable })`. Эта подсистема прошла 4+ итерации с разными неправильными сигналами промоута — здесь зафиксировано что реально работает и почему остальное провалилось.

### Симптомы которые сюда ведут
- Сообщение, отправленное во время стриминга, не доезжает до Claude / доезжает но с задержкой.
- Queued-промпт в треде стоит **не на той позиции** что в JSONL (выше блока который Claude дописывал в момент Enter, а не после него).
- Chip «QUEUED» висит над инпутом вечно даже после того как Claude ответил.
- После Cmd+R queued-промпт **пропал** из истории, хотя ответ Claude на него виден.
- Edit/Repeat на queued-сообщении обрезает историю не в том месте.
- Queued-промпт виден в треде SDK-чата, но **отсутствует** в Timeline / при rewind.

## Long-lived input channel + priority:'next'

`query()` принимает `prompt` как `AsyncIterable<SDKUserMessage>`. Чтобы доставить сообщение mid-stream, канал должен **оставаться открытым** весь turn (не закрываться после initial prompt). `createInputChannel(initialMsg)` в `main.js` — генератор который yield'ит initial prompt, потом блокируется на await до push'а. `session.push(text)` кладёт `buildUserMessage(text, 'next')` в буфер — `priority:'next'` говорит SDK доставить на ближайшей boundary между sub-iterations текущего turn'а.

**Почему канал нельзя закрывать рано:** если AsyncIterable закроется до `result`-события, у SDK ломаются hooks/`canUseTool` (см. [anthropics/claude-code#9705](https://github.com/anthropics/claude-code/issues/9705) — «Stream closed» каскад). Держим открытым до `finally` стрима.

## Channel race: pre-created signal pattern

**Что было невидимо (deadlock).** Наивная реализация: генератор делает `await new Promise(r => wakeUp = r)` когда буфер пуст, `push()` зовёт `wakeUp()`. Между моментом когда генератор вышел из `yield` и моментом когда дошёл до `await new Promise(...)` — `wakeUp` ещё `null`. Если `push()` прилетает в это окно, сообщение ложится в буфер, но `wakeUp` пустой → генератор затем создаёт **новый** promise и виснет на нём навсегда. Buffer не пуст, но генератор спит. Lost-wakeup — классическая JS concurrency-ловушка.

**Решение:** сигнал создаётся **заранее** (`makeSignal()` до любого await, и пересоздаётся сразу после каждого resolve). `push()` всегда видит живой `wakeUp` и может его дёрнуть синхронно. Это community-стандарт (`Promise.withResolvers()` в современном Node делает то же). Реализация — `createInputChannel` в `main.js`.

## Три фазы chip: queued → sent → landed

Mid-stream сообщение проходит три состояния, и переход между ними — на **разных** сигналах:

1. **queued** (оранжевый chip над инпутом) — push'нули в канал локально, SDK ещё не забрал. **Отзываемое**: Esc / ↑ / клик возвращают текст в композер.
2. **sent** (серый chip, тот же слот) — SDK вытащил сообщение из канала (`onConsumed` callback в `createInputChannel` после `yield`), переслал в Claude CLI subprocess. **Нельзя отозвать** — оно уже у Claude. Recall/dismiss на этом состоянии — no-op.
3. **landed** (user-bubble в треде) — CLI **физически записал** сообщение в сессионный JSONL. Только тут промоутим chip → bubble, на позиции записи в JSONL.

Эти три события **разнесены во времени** — см. следующую секцию.

## КРИТИЧНО: consumed ≠ JSONL-landed; CLI пишет по-разному в зависимости от entrypoint

Главное архитектурное открытие сессии, верифицировано живым E2E.

**consumed происходит за ~5 секунд до JSONL-записи.** SDK забирает сообщение из канала мгновенно (channel `onConsumed` fires), но CLI **буферизует** его и пишет в JSONL только на следующей границе turn'а (atomic flush). Замеренный лаг: push в `20:32:51.957` → CLI записал в `20:33:01.806` — 5.5с и два tool_use Claude'а между ними. Поэтому промоут по `onConsumed` ставит bubble **слишком рано** — перед блоком который Claude дописывал.

**CLI пишет mid-stream сообщение в JSONL двумя разными способами:**
- entrypoint `sdk-ts` (TypeScript SDK путь) → запись `type:'attachment'`, `attachment.type:'queued_command'`, `attachment.prompt:[{text}]`.
- entrypoint `sdk-cli` (native binary путь, который SDK использует по умолчанию через `pathToClaudeCodeExecutable`) → запись **обычного** `type:'user'` с `entrypoint:'sdk-cli'`, **не** attachment.

Watcher обязан ловить **обе** формы. Фильтр только на `attachment.queued_command` пропускал `sdk-cli`-запись — chip висел до turn-end fallback'а.

## JSONL watcher: deferred dir-watch + final tail-read

Чтобы поймать момент реальной записи — `fs.watch` на сессионном JSONL (`jsonlWatchers` Map по tabId в `main.js`). Свой `fs.promises.open` + incremental tail-read, **не** общий `_jsonlCache` который читает Timeline (иначе race на pre-await snapshot, см. [`fix-incremental-reader-race.md`](fix-incremental-reader-race.md)). `lastSize` снимается до `await open`, дебаунс 30мс на бурст записей.

**Deferred mode — обязателен.** sessionId приходит из SDK на ~20-100мс **раньше** чем CLI создаёт файл JSONL на диске. Если стартовать watcher и сразу `findSessionFile` вернёт null — наивный код бросает и не ретраит. Решение: когда файла ещё нет, watch'им **родительскую директорию** (`~/.claude/projects/<slug>/`) на появление `<sessionId>.jsonl`, и как только файл создан — закрываем dir-watcher, вешаем file-watcher, делаем немедленный tail-read (поймать контент записанный до arming).

**Resume-path тоже армит watcher.** При `sdkStartQuery` с `resumeSessionId` сессия конструируется уже с `session.sessionId` заполненным — событие `sessionId captured` в for-await loop **не fires** (`!session.sessionId` ложно), поэтому watcher надо стартовать явно из `sdkStartQuery` для resume-ветки. Без этого второй и последующие turn'ы оставались без watcher'а.

**Final tail-read перед teardown.** В `finally` стрима и в `claude-sdk:stop` — один последний `_processJsonlTail` до `stopJsonlWatcher`, чтобы поймать запись которую CLI флашнул между последним дебаунс-тиком и закрытием.

## Drop вместо promote: JSONL — единственная правда о памяти Claude

Если turn закончился / юзер нажал стоп / Escape, а sent-сообщение **не** появилось в JSONL — оно **молча удаляется**, bubble не рисуется. Обоснование (юзер сформулировал сам): *«если он не записался в JSONL, как он будет в истории, если мы остановили его раньше»*. То что SDK передал байты в CLI, не значит что Claude это запомнит — при `--resume` Claude читает JSONL, а не runtime-буфер. Прерванное до записи для будущего не существовало → в UI его тоже не показываем как доставленное.

Применяется одинаково в трёх местах: turn-end (`result`-event), ручной стоп (`was-stopped`), Escape/cancel (`onCancel`). Раньше эти пути промоутили sent как «unconfirmed user-bubble» — это рисовало ghost-сообщение которого нет в транскрипте. Переносимый принцип — [`methodology/переносимый-дизайн.md::Durable artifact определяет UI-историю`](../methodology/переносимый-дизайн.md).

## Single-slot: блок второго mid-stream Enter

Пока chip есть (любого состояния), второй mid-stream Enter не отправляется: текст остаётся в инпуте, toast объясняет (`queued` → «edit или discard chip»; `sent` → «in flight to Claude»), chip кратко вспыхивает (CSS `sdk-chip-flash`, key-remount). Причина: один chip представляет одну запись, второй push создал бы невидимую очередь без UI-представления и сбил бы порядок.

## Pending переживает переключение проекта

Live-очередь хранится в `Tab.sdkMidstreamPending` (Zustand), не только в local `pendingMidstreamRef`. При переключении проекта `ClaudeSDKTab` unmount'ится, но watcher в main работает по tabId независимо — события `landed` копятся и применяются к гидрированному из стора chip'у при возврате. На mount компонент читает `sdkMidstreamPending` из стора и восстанавливает chip. Принцип — [`methodology/переносимый-дизайн.md::Live state фоновой операции переживает unmount владельца`](../methodology/переносимый-дизайн.md). NOT персистится в SQLite — живёт только сессию.

## Reload: attachment → user-bubble с QUEUED-бейджем

При Cmd+R / открытии таба `loadHistory` парсит JSONL. Запись `attachment.queued_command` раньше проваливалась с `role:'attachment'` (нет ветки) → assistant-ui молча дропал её как unknown role → юзер видел «queued-промпт пропал после reload». Фикс: ветка в начале `loadHistory` map'а превращает `queued_command` attachment в `role:'user'` bubble.

**ID-префикс обязателен.** Оранжевый «↑ QUEUED» бейдж в треде определяется не по полю объекта, а regex'ом `/^user-queued-/` по `msgId` (assistant-ui дропает лишние поля при re-import). Поэтому id восстановленной записи формируется `user-queued-<uuid>`, иначе бейдж не рендерится.

## Edit/Repeat учитывает attachment в счёте позиций

`truncateAndResend` адресует по `userPosition` = индекс среди user-промптов. В renderer attachment-bubble считается как user (его роль `'user'`), поэтому его индекс попадает в `userPos`. В `main.js::truncate-history` счётчик раньше фильтровал `e.type !== 'user'` → пропускал attachment → позиции renderer↔main расходились, truncate резал не ту запись. Фикс: `isUserPrompt(e)` включает `attachment.queued_command` наравне с `type:'user'`.

После Edit/Repeat attachment перестаёт быть mid-stream: truncate сносит старую attachment-запись, re-send пишет обычный `type:'user'`. Это by design — отредактированное сообщение становится первым промптом нового turn'а, не mid-stream вбросом.

## Несоответствие: тред показывает queued, Timeline/rewind — нет

Тред SDK-чата (через `loadHistory`) рендерит `queued_command` как user-bubble. Но Timeline и rewind считают только `type:'user'` записи — attachment туда не попадает, queued-промпт в них невидим. Это известное расхождение: одна запись по-разному трактуется в двух подсистемах (тред смотрит на attachment, Timeline фильтрует по type). Не баг рендера — следствие того что CLI кладёт mid-stream в особый тип записи.

## Graveyard

1. **`SDKUserMessageReplay` — тип-призрак.** Gemini-research утверждал что Anthropic ввёл нативную поддержку replay queued-сообщений «с v2.1.17». Проверено: тип `SDKUserMessageReplay` (`isReplay:true`) **задекларирован** в `sdk.d.ts` даже в свежей `0.3.154` (на момент сессии стояла `0.3.142`, latest от того дня), но в минифицированном runtime (`sdk.mjs`/`assistant.mjs`/`bridge.mjs`) строк `isReplay`/`queued_command` **нет** — runtime его не эмитит. Тип объявлен «на вырост». Опции `replayUserMessages` тоже нет. Вывод: полагаться на наш `fs.watch`-механизм, не ждать SDK-события. Когда Anthropic включит эмиссию — переезд = слушать `msg.isReplay === true` в обычном `claude-sdk:message`.

2. **promote-on-chunk** (первая версия) — промоутили chip→bubble на первом assistant-chunk после push'а. Слишком рано: между push и chunk SDK уже отправил следующий tool_use, bubble вставал перед ним.

3. **promote-on-consumed** (вторая версия) — на `onConsumed` канала. Тоже слишком рано: consumed на ~5с опережает JSONL-запись (см. выше). Оставлен как переход queued→sent, не как промоут.

4. **JSONL-watch только на attachment** (третья версия) — ловили `attachment.queued_command`, но native `sdk-cli` пишет обычный `type:'user'` → не матчилось, chip висел до turn-end fallback. Фикс — dual filter.

## Code map

- `main.js::createInputChannel(initialMsg, debugTag, onConsumed)` — long-lived AsyncIterable. Pre-created signal против lost-wakeup. `onConsumed(msg)` fires после `yield` для pushed-сообщений (queued→sent сигнал).
- `main.js::sdkStartQuery` → `session.push(text)` пушит `buildUserMessage(text, 'next')`. Watcher армится из двух мест: `sessionId captured` в for-await loop (fresh) И явно в `sdkStartQuery` для resume-ветки (там `session.sessionId` уже задан, событие не fires).
- `main.js::jsonlWatchers` Map + `startJsonlWatcher`/`stopJsonlWatcher`/`_processJsonlTail`/`_attachFileWatcher` — deferred dir-watch до создания файла, потом file-watch. Dual filter: `attachment.queued_command` (sdk-ts) ИЛИ `type:'user' && entrypoint:'sdk-cli'`. Эмитит `claude-sdk:midstream-jsonl-landed`.
- `ClaudeSDKTab.tsx::pendingMidstreamRef` (`{text, ts, state}`) ↔ зеркало в `Tab.sdkMidstreamPending` через `syncPendingToStore`. `refreshChipFromPending` пере-выводит chip из головы очереди. Hydrate из стора на mount.
- IPC: `claude-sdk:midstream-consumed` (queued→sent) и `claude-sdk:midstream-jsonl-landed` (sent→bubble, drop из pending). turn-end/stop/cancel — drop оставшихся sent без промоута.
- `main.js::truncate-history` `isUserPrompt(e)` включает `queued_command` attachment в счёт `userPosition`.
