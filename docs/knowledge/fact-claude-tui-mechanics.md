# Fact: Claude TUI Mechanics (Ink Engine)

Этот файл описывает скрытое поведение TUI интерфейса Claude Code (на базе React Ink), которое невозможно понять, просто читая исходный код `xterm.js`.

## 1. Цветовая Схема (The "Lavender" Marker)
Claude Code использует уникальный RGB-цвет для выделения активной строки в меню истории (Rewind).
*   **RGB:** `177, 185, 249`
*   **ANSI Code:** `\x1b[38;2;177;185;249m`
*   **Почему это важно:** Символ курсора `❯` часто исчезает из diff-ов PTY при частичном обновлении экрана. Цвет — единственная константа, гарантирующая нахождение активного элемента.

Этот marker использовать как reverse-verification, а не как источник контента. Для Rewind/model/effort/AskUserQuestion контент по возможности берётся из структурного канала (JSONL/tool_input/SSE), а PTY-цвет отвечает только на вопрос «какая видимая строка сейчас активна после нажатия стрелки». Такой narrow parse устойчивее полного screen parsing: flicker и исчезающий `❯` не ломают проверку, пока активная строка сохраняет lavender color.

## 2. Проблема Stale Sync Markers
Библиотека Ink (React renderer for CLI) асинхронна. При вставке текста или обновлении UI она может генерировать **несколько** пар маркеров синхронизации (`\x1b[?2026h` ... `\x1b[?2026l`) за одну операцию.

### Сценарий сбоя (Race Condition):
1. Мы отправляем `Chunk 1`.
2. Ink шлёт Sync Marker #1 (Confirm input).
3. Ink шлёт Sync Marker #2 (Re-render UI).
4. Наш код ловит Marker #1, считает что всё готово, и шлёт `Chunk 2`.
5. `Chunk 2` обрабатывается Ink-ом параллельно с рендером Marker #2, что приводит к состоянию гонки и потере ввода (особенно `Enter`).

### Решение (Drain Pauses):
Любая автоматизация ввода в Ink требует принудительных пауз для "слива" (drain) устаревших маркеров:
*   **50ms** между чанками вставки.
*   **100ms** перед нажатием `Enter`.
*   *Попытка убрать эти `sleep()` приведет к нестабильной работе.*

## 3. Input Collapsing (terminal:input vs terminal:paste)
Отправка текста в Claude Code через raw `term.write()` (IPC `terminal:input`) **не обрабатывается** как пользовательский ввод, если текст длиннее нескольких символов.

### Механика:
- Ink TUI детектирует "paste" (много символов одним write) и показывает `[Pasted text #N +M lines]`
- Но без **Bracketed Paste Mode** (`\x1b[200~...\x1b[201~`) Ink не буферизирует текст как единое целое
- Результат: Claude **не обрабатывает** текст как промпт — просто показывает его и возвращает курсор

### Правило:
Для программной отправки промптов в Claude Code **всегда** используй `terminal:paste` (IPC handle), который вызывает `safePasteAndSubmit` с корректным bracketed paste.

```javascript
// ПРАВИЛЬНО: safePasteAndSubmit через IPC
await ipcRenderer.invoke('terminal:paste', { tabId, content: 'prompt text', submit: true })

// НЕПРАВИЛЬНО: raw write — Ink не обработает как промпт
ipcRenderer.send('terminal:input', tabId, 'prompt text\r')
```

## 4. Atomic Bracketed Paste

### Slow-mode (Claude Ink TUI) — single write, без chunking

Один `term.write(\x1b[200~ + content + \x1b[201~)`. node-pty 1.2.0-beta.13 (PR #831) умеет писать >TTYHOG без потерь через `fs.write` + `EAGAIN` retry — TTYHOG больше не диктует разбивку. После записи **один** `waitForRender` (а не per-chunk). Ink эмитит ровно один `\x1b[?2026l`, когда `\x1b[201~` закрывает paste — это deterministic сигнал, что можно жать Enter.

### Fast-mode (Gemini/bash) — chunking по 900 байт без waits

Тот же single bracket pair, но payload бьётся на `CHUNK_MAX=900` и пишется back-to-back с tick'ом каждые 10 чанков. Никаких `waitForRender` — Ink не задействован, marker некому эмитить.

### Что НЕ работает (и почему отказались)

*   **НЕПРАВИЛЬНО:** Оборачивать каждый чанк в `\x1b[200~...\x1b[201~`. Создаёт N `[Pasted text #N]` chip'ов. 49 чанков = 49 chip'ов в UI.
*   **НЕПРАВИЛЬНО:** Per-chunk `waitForRender` внутри открытого bracketed paste. Раньше slow-mode бил payload на 900-байтные чанки и ждал sync marker после каждого. Гипотеза была: «Ink эмитит `\x1b[?2026` на каждом промежуточном render cycle». **Гипотеза неверна.** Ink батчит все рендеры до `\x1b[201~` и эмитит marker только один раз — в конце. 53 промежуточных чанка ждут полный timeout (1000ms каждый) → 57 секунд тишины перед отправкой большого paste из очереди. См. [`fix-claude-paste-stuck-queue.md`](fix-claude-paste-stuck-queue.md) для repro из prod.

### Гарантия отсутствия регрессий: PasteAudit

После единственного `term.write` нет per-chunk verification. Post-hoc audit через UserPromptSubmit hook: `safePasteAndSubmit` перед Enter ставит ожидание `{expectedLen, expectedHash, preSubmitBoundary}` в **упорядоченный per-tab список** (`pendingPasteAudit: tabId → audit[]`), где boundary — байтовая позиция и последний UUID JSONL до Enter. Hook handler читает не «последнюю» user-запись, а все кандидаты после самой ранней boundary, и сводит их oldest-first: самая ранняя причинная запись подтверждает самое раннее ожидание (len+hash+позиция после boundary; один byte offset подтверждает ровно один audit). Так два подряд одинаковых prompt'а (type-ahead) получают каждый своё подтверждение, а не «второй усыновил запись первого».

Судьбы ожидания: подтверждён → `✅ match`; запись не совпала → кандидат логируется `MISMATCH-CANDIDATE … kept pending` и ожидание ЖИВЁТ дальше (поздний JSONL-flush — норма); timeout → caller получает `success:false, lateReconciliationPending:true` (это «ещё не согласовано», НЕ delivery failure — SEND FAILED из него делать нельзя), само ожидание остаётся до bridge-clear; Enter так и не ушёл в PTY (guard/ошибка до submit) → finally-блок финализирует `claude_submit_not_sent`, чтобы мёртвое ожидание не украло durable-запись у следующей одинаковой отправки; выход Claude → финальный tail-scan, потом evict unconfirmed (`…_unconfirmed_evicted`, presentation sidecar сохраняется при позднем подтверждении). Кап: 32 pending на вкладку / 30 мин. Подробнее в `fix-claude-paste-stuck-queue.md::Защита от регрессий`.

### Параллельная причина N chip'ов на ручной Cmd+V

Claude теряет свой DEC ?2004 при alt-screen toggle → xterm.js шлёт paste raw → TTYHOG режет → Ink делает N chip. См. секцию 9 ниже и [`fix-paste-bracket-mode-loss.md`](fix-paste-bracket-mode-loss.md). Это **другой** root cause тех же визуальных N chip'ов — наш chunking не задействован, дело в потере dec mode.

## 5. Виртуальный Скролл
Меню истории Claude использует "ленивый" рендеринг.
*   **Факт:** В DOM (PTY буфере) существуют только видимые строки.
*   **Следствие:** Нельзя вычислить количество нажатий `UP` математически (`CursorPos - TargetIdx`), если TargetIdx за пределами экрана.
*   **Решение:** Только визуальный поиск (нажимать UP, пока не увидим RGB-цвет нужной строки).

## 6. Перехват Session ID (TUI Interception)
Приложение «подслушивает» поток данных PTY на предмет строки `Session ID: <UUID>` (обычно выводится командой `/status`).

### Защита от ложных срабатываний (Guard Clause):
*   **Проблема:** Gemini CLI или простая команда `cat` могут вывести похожий текст, что вызовет ошибочное уведомление в UI.
*   **Решение:** Перехват работает только если для текущего таба в `bridgeKnownSessions` уже есть активная запись от Клода. 
*   **Логика:** Мы доверяем TUI-выводу только если **StatusLine Bridge** (надежный источник) подтвердил, что в этом табе действительно запущен Claude Code.

## 7. Подтверждение выхода (Danger Zone)
При первом нажатии Ctrl+C Claude выводит: `Press Ctrl-C again to exit`.
*   **Особенность:** Ink TUI вставляет невидимые коды перемещения курсора. При стриппинге ANSI-кодов текст часто выглядит как `PresCtrl-C again to exit` или `Press Ctrl-Cagain`.
*   **Маркер:** Для детекции используется подстрока `again to exit`, так как она остается цельной в обоих случаях.
*   **Риск:** Любой ввод в этом состоянии (включая программный Ctrl+C от кнопок UI) интерпретируется как второе нажатие и завершает процесс. 
*   **Защита:** Реализовано принудительное ожидание возврата промпта (`⏵`) перед выполнением следующих команд. См. `knowledge/fix-claude-ctrlc-exit.md`.

## 8. Spinner Detection (The Busy State)
Для точного определения состояния «занят» (busy) в Claude Code приложение не полагается на логику шелла, а напрямую детектирует Unicode-символы спиннера (`✢✳✶✻✽`) в потоке данных PTY.

### Критерии детекции:
*   **Стриппинг OSC:** Перед анализом необходимо вырезать из данных все OSC-последовательности (заголовки окон). Claude устанавливает window title `✳ Claude Code`, который ошибочно воспринимается детектором как активный спиннер.
*   **Символы:** Используются `✢✳✶✻✽`. Символ `·` (middle dot) исключен, так как является статичным разделителем в интерфейсе.
*   **Цвет:** Ранее использовался фильтр по оранжевому RGB (`215, 119, 87`), но это признано ненадежным из-за изменений в рендеринге Claude Code. Детекция теперь контентная (после стриппинга OSC).
*   **Событийность:** Состояние `busy` активируется мгновенно при первом появлении символа спиннера. Возврат в `idle` происходит с **500ms дебаунсом** (тишины) после отсутствия спиннеров в потоке.
*   **Подробнее:** См. [`fix-claude-busy-detection.md`](fix-claude-busy-detection.md).

## 9. Alt-screen ⇄ DEC ?2004 state loss (Claude 2.1.110+)
Claude Code с версии 2.1.110 (16 апреля 2026) использует fullscreen-renderer на alternate screen по умолчанию. При каждом переключении `\x1b[?1049h/l` Claude теряет свой DEC private mode 2004 (bracketed paste). Без `\x1b[?2004h` xterm.js не оборачивает Cmd+V в `\x1b[200~...\x1b[201~` — текст уходит в PTY как raw stream. Дальше его дробит macOS TTYHOG (~1KB watermark), Ink в Claude получает несколько data-event'ов между render cycle, каждый превращается в отдельный `[Pasted text #N]` chip. Поведение **рандомно меняется между сессиями** — в одной alt-screen toggle случился непосредственно перед paste и DEC ?2004 потерян, в другой нет.

Фикс — env `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` в PTY shell env (добавлен Anthropic в Claude 2.1.132, май 2026). Возвращает Claude к scrollback-renderer'у, alt-screen toggle перестаёт случаться, DEC ?2004 держится стабильно. Применяется к всем PTY безопасно — не-Claude процессы env игнорируют. См. [`fix-paste-bracket-mode-loss.md`](fix-paste-bracket-mode-loss.md).

## 10. Prompt-ready как глобальный сигнал

Существующий handshake-детектор `⏵`/`>` (Section 2) включён только в `claudeState === 'WAITING_PROMPT'` ветке — то есть **только** когда мы запускаем Claude чтобы отправить ему конкретный prompt по handshake-протоколу. Для всех остальных табов и сценариев (ручной запуск, Resume, MCP-delegate, mobile-инициированный create) детектор молчит — после `claudeState.delete(tabId)` поток PTY-данных проходит мимо.

При работе mobile-web с CLAUDE-PTY-табами этот сигнал нужен расширенно: phone-композер должен знать когда Claude **действительно** готов принимать ввод. Текущий критерий «процесс жив» через `bridgeKnownSessions.has(tabId)` опережает реальную готовность TUI на 1-6 секунд — bridge.json пишется при инициализации, **до** того как Ink отрисовал prompt. Send в этот промежуток приходит в недо-инициализированный input.

Решение — глобальный детектор поверх существующего: при каждом PTY-data event для таба у которого `bridgeKnownSessions.has` и `claudePromptReady` ещё не выставлен, ищем `⏵`/`>` в данных. Первое попадание → `claudePromptReady.add(tabId)` + WS snapshot для mobile. Локальный handshake-state не трогается — продолжает работать как раньше, просто теперь есть второй reader того же сигнала.

`claude:get-presence` IPC использует флаг для различения `starting` (process есть, prompt ещё нет) и `active` (готов к вводу). Cleanup в трёх местах: `clearBridgeTab` (Claude exit через Ctrl+C×2), PTY `onExit`, `terminal:kill`. См. `fact-mobile-claude-pty.md::Lifecycle states`.
