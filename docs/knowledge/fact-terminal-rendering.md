# UI Terminal Rendering

---

## Цена TUI в живых CLI: ограниченный A/B 02.10.2026

Отказ от терминального экрана не равен остановке агента: в этом сравнении
каждый процесс оставался живым после warmup, во время следующего ответа и
в 15-секундном окне простоя после него. На M1 Pro / 32 GiB / macOS 26.5.2
выполнены два последовательных прогона каждого режима с обратным порядком,
одинаковой выбранной моделью и проверенными 120 строками ответа. Реальные
inference-вызовы; операции с проектными файлами не выполнялись.

Числа ниже — средние двух прогонов: память дерева CLI-процессов по
`proc_pid_rusage.phys_footprint` (медиана окна простоя), CPU — накопленные
локальные CPU-секунды на полный ответ, а не время ответа модели.

| CLI / модель | TUI → без TUI, MiB | Локальное CPU-время, s |
| --- | --- | --- |
| Claude 2.1.287 / Haiku 4.5 | 158.9 → 133.2 (−16%) | 0.926 → 0.471 (−49%) |
| Codex 0.159.2 / GPT-6-Luna low | 111.9 → 84.8 (−24%) | 2.599 → 1.080 (−58%) |
| AGY 1.2.14 / Gemini 3.8 Flash low, host-патч | 169.6 → 128.4 (−24%) | 6.357 → 0.792 (−88%) |

Codex без TUI здесь — штатный persistent `app-server`, **не** собственный
core-api host; TUI запускался с `--no-daemon`, чтобы не приписать память чужому
общему процессу. Claude — прямой stream-json, без SDK и без патча. AGY проверен
и штатным stream-json (129.1 MiB / 0.972 CPU-s), и ранее исследованной host-копией
с управляемыми вопросами/разрешениями. В нагрузочном задании сами вопросы не
вызывались; их correctness подтверждён отдельным прошлым probe, не этим замером.

Это **не процент экономии всего Noted**: Electron, Canvas/GPU, History и реальные
наборы MCP/tools не включены в таблицу. Отдельный Node host обрабатывал JSON либо
два headless xterm по 5000 строк; его показатели сохранены отдельно. Длинный
coding-run и множество одновременно работающих вкладок не проверялись. Особенно
нельзя обещать точный коэффициент Codex RAM: после ответа TUI дал 93.7–130.2 MiB,
app-server 79.1–90.5 MiB. В простое все CLI в этих прогонах потребляли в среднем
меньше 1% одного ядра. Снижение локального CPU не доказывает ускорение модели:
Claude выдавал тот же объём примерно за 14 s в обоих режимах.

Артефакты: `/tmp/noted-cli-benchmark.a21AKd/` — `bench.mjs`, `batch.mjs`,
`patched.mjs`, `summary.json`, `audit.json`, samples/events/ANSI по каждому run.
14/14 основных прогонов PASS; все root PID жили в каждом idle sample, все
ответы прошли проверку 120 строк, после cleanup ни один собственный PID не
остался. Счётчик CPU использует Mach timebase 125/3, его 14 targeted tests PASS.
Smoke/harness-прогоны исключены: в Claude маркер мог появиться в thinking,
а Codex alt-screen сохраняет лишь видимые строки; приёмка требует завершённого
ответа и накопленного набора всех строк, не одного финального кадра.

---

## Холодный CLI-процесс: wall-time A/B 03.10.2026

Это отдельный замер обычных секунд от запуска, **не CPU-секунд** из таблицы
выше. 42 успешных запуска: по шесть на Claude/Codex/AGY TUI и без TUI, плюс
шесть на host-патченном AGY. Порядок зеркалился между повторами. Каждый раз
новый PID; сохранённые login и доверенные пустые cwd из предыдущего стенда,
без resume истории. OS/disk cache не сбрасывался. Это не первый запуск после
установки и не полный cold start Electron/Noted.

В readiness-path нет прежних фиксированных пауз стенда. TUI измерялся до
появления рабочего composer, JSON Claude — до initialize response, Codex —
до initialize + thread/start, AGY — до init event. Затем немедленно отправлялся
одинаковый короткий prompt, проверялся настоящий ответ `LAUNCH_READY`.
Перед Enter TUI подтверждал реальное появление текста в input. First-text
считался по assistant text, не по echo промпта, thinking или startup banner.

| CLI | Готовность TUI, s: медиана (min–max) | Без TUI, s: медиана (min–max) | Первый текст от запуска, s: TUI → без TUI, медианы |
| --- | --- | --- | --- |
| Claude 2.1.287 / Haiku 4.5 | 0.426 (0.386–0.858) | 0.461 (0.309–0.620) | 2.587 → 2.546 |
| Codex 0.159.2 / GPT-6-Luna low | 0.322 (0.318–0.324) | 0.731 (0.159–1.519) | 5.268 → 4.802 |
| AGY TUI 1.2.15 / host-копия 1.2.14, Flash low | 1.783 (1.362–2.194) | 2.991 (2.748–3.193) | 5.594 → 4.929 |

Уточнение по исходным артефактам: все шесть cold-TUI banner содержат1.2.15,
host-копия основана на1.2.14; отдельный build/hash stock headless не сохранён.
Поэтому cold-AGY здесь **не version-matched A/B** и не доказывает цену TUI/патча.
Числа остаются реальными наблюдениями этих запусков. Warm A/B02.10 выше
сохраняет1.2.14 в обоих TUI-banner и исходный binary hash в `audit.json`.
Нельзя переносить native API/patch proof1.2.14 на обновлённый executable.

У штатного AGY headless init медиана 3.103 s, первый текст 5.187 s. Из этого
не следует стабильный выигрыш самого 4-byte патча: сеть/генерация не фиксированы.
Готовый composer и completed protocol initialization — разные границы: особенно
AGY может показать ввод раньше, чем headless выдаст init; сравнение только
этих двух timestamps не доказывает, что TUI доводит запрос до модели быстрее.
Поэтому first-text измерялся отдельно. В обоих случаях в нём есть server/network
latency; разность медиан нельзя выдать за изолированную стоимость отрисовки.

Для вопроса «когда можно отправить первый запрос» использовать отдельно
сохранённый `inputWrittenMs`, не first-text: медианы TUI→machine-send у Claude
0.517→0.469 s, Codex 0.338→0.731 s, AGY host-copy 1.809→2.993 s. Это Enter /
JSON передача локальному движку. У Codex response на `turn/start` подтвердил
приём за 0.164–1.525 s от spawn, примерно через 5–6 ms после local write.
В этих 42 запусках время исходящего HTTP к облачной модели не снималось;
local ACK/turn-start не доказывает эту сетевую границу. Сводка и актуальный
рабочий файл — `docs/tmp/исследование-терминалов-и-агентов.md`.

Универсальная надбавка TUI в 1–2 s не подтверждена. Claude в этом коротком
сценарии практически равен. Codex app-server имел две группы ready-times —
около 0.16 s и 1.3–1.5 s; причина этой вариативности отдельно не установлена,
не приписывать её кэшу или сети как доказанный факт.

Как и в resource A/B, Claude — прямой JSON host (не измерение npm SDK import),
Codex — отдельный штатный app-server, не собственный core-api host; TUI
`--no-daemon`, startup update-check отключён только inline config тестового
процесса. Пользовательские MCP/hooks и длинная история не участвуют. Патч и
App Server не обязаны иметь одинаковый startup: общий cloud API не определяет
локальные auth/config/session/protocol-init этапы.

Артефакты `/tmp/noted-cli-startup.xezRX9/`: `startup.mjs`, `batch.mjs`,
`analyze.mjs`, `batch-results.json`, `summary.json`, timed events/ANSI/ready
snapshots и cleanup каждой попытки. 42/42 PASS, 42 разных root PID, ответы
верны, собственных оставшихся процессов нет. Probe-попытки не входят в сводку.

---

## Большой Codex resume: запуск → исходящий запрос 03.10.2026

По запросу пользователя отдельно проверены копии двух его длинных разговоров,
а не свежие короткие диалоги из предыдущего теста. Codex 0.159.2, восемь новых
PID, по два повтора каждого режима/источника с обратным порядком. TUI
`--no-daemon` против штатного App Server `thread/resume(excludeTurns:true)`.
Сравнивается практический путь управления без повторной отдачи всех UI-turns
через API, **не чистая стоимость отрисовки** и не cold start всего Noted.

Начало — spawn; конец — получение первого `POST /v1/responses` локальным
HTTP-приёмником. Он отдаёт bundled model catalog и контролируемый SSE-ответ:
нет облачной генерации/сетевой задержки и расхода квоты. Новый prompt и шесть
хешей исходных user/assistant сообщений совпали во всех восьми запросах.
Простое появление input/локальный ACK этой границы не доказывает: TUI composer
был виден через 0.35–0.41 s, пока фактическая отправка ещё ждала resume.

| Исходная вкладка / замороженный rollout | TUI до HTTP, s | App Server до HTTP, s |
| --- | --- | --- |
| 4196 / 231.4 MiB, 23623 записи | 13.23–15.85 | 3.90–7.00 |
| 3314 / 735.9 MiB, 73481 запись | 35.13–35.52 | 9.10–19.43 |

Внутри пары сохранены одна история и model/effort, изменены только собственные
session identity/cwd и тестовый provider. MCP/hooks/goals отключены per-process;
OS-cache не сбрасывался. Разброс API велик — не обещать один коэффициент для
любой истории. Дополнительную цену внутри TUI по функциям не профилировали.

`phys_footprint` дерева CLI через 4 s после ответа и максимальный sample:

| Источник | После ответа TUI / API, MiB | Пик TUI / API, MiB |
| --- | --- | --- |
| 4196 | 175–189 / 303–369 | 369–404 / 375–389 |
| 3314 | 769–795 / 309–382 | 1341–1416 / 1055–1282 |

API здесь быстрее до первого запроса, но RAM не всегда меньше. Два повтора
не дают нижний предел памяти полноценного агента. API-цикл, файловые tools
и история сами по себе не обязывают держать весь архив в RAM; runtime,
представление объектов, копии и кэши — отдельные расходы, их heap-доли не сняты.
У 4196/3314 архивные compacted-записи занимают 117.5/423.7 MiB (18/61 записей),
а актуальные тела запросов — около 10.27/6.72 MB. Эти размеры не отождествлять.

Артефакты `/tmp/noted-large-session.wXqfzG/`: `summary.json` с audit, восемь
`result.json`, scripts/events/ANSI, `source-prefix-proof.json`, `cleanup.json`.
8/8 PASS; исходная 4196 не изменилась, занятая 3314 дописывалась своим владельцем
при неизменном frozen prefix. Их процессы не останавливали, prompts в них не
отправляли. Тестовые rollouts/копии и четыре записи thread удалены native API,
test-cwd thread/list пуст, собственных PID не осталось. Исследовательский стенд
не включает Electron/Canvas/History Noted; runtime продукта не менялся.

---

## Noted с одной AGY-вкладкой: реальный renderer/PTY04.10.2026

Отдельный UI smoke, не продолжение CLI-only A/B: frozen built DEV Electron28.3.3,
одна generic shell-tab → original AGY1.2.16/Gemini3.8Flash low, два настоящих
ответа, без нового AGY provider-кода. Дерево native phys_footprint:

| Состояние | Noted целиком с дочерними процессами | Входящий в него AGY |
| --- | --- | --- |
| Пустая shell |312.27MiB |— |
| После двух ответов |634.63MiB |159.84MiB |

Вложенные деревья не суммируются. GPU helper134.00→286.39MiB, renderer
60.06→68.17MiB, main103.92→106.11MiB. Это point samples с разным состоянием
терминального содержимого, не причинный профиль GPU и не matched no-TUI A/B.
Нельзя объявлять634−160 «ценой терминала»: здесь весь Electron/UI, а сравнимого
Noted с headless AGY/History не было. Native window1900×1000 был hidden/focus=false,
DOM visibility=visible; UI/PTY проверены через CDP, foreground latency — нет.
Не считать паузы между действиями тестировщика временем запуска или модели.

Артефакты `/private/tmp/noted-agy-pty-e2e.8WKVDr/REPORT.md`,
`artifacts/metrics-before.json`, `metrics-after-second.json`. Базовый ввод,
draft, реальный picker/cancel и exit прошли; история восстановлена в63steps с
исходным canonical hash, собственные processes/ports закрыты. Методика и
границы AGY-поддержки — fact-gemini-automation; production не устанавливался.

---

## Большой синтетический AGY: RAM и CPU с TUI и без него,04.10.2026

Original AGY1.2.16, M1Pro10cores/32GiB; создан внешний import artifact с11000
user/assistant парами и финальным checkpoint. Файл731426816bytes (~697.5MiB)
выбран по масштабу Codex3314, но это text-heavy стресс, не копия её267turns/
tools/61compacted. Checkpoint оставляет короткий активный контекст: реальные
Gemini3.8Flash low ответы подтвердили последний canary, SUMMARY_BRFSHE и40строк.

CLI tree phys_footprint, медиана15s после ответа; два квалифицированных запуска
на режим, новый процесс каждый раз, между ними native conversation-only rewind:

| Метрика | TUI | Штатный stream-json |
| --- | --- | --- |
| После ответа, MiB |3470.7–4635.2 |2182.3–2185.9 |
| Максимальный sample, MiB |4316.4–4635.2 |2182.3–2186.0 |
| CPU восстановления, CPU-s |138.27–138.45 |145.27–147.61 |
| CPU нового40-line ответа, CPU-s |1.29–1.47 |0.48–0.82 |
| CPU idle после ответа, % одного ядра |0.62–0.85 |0.04–0.06 |

Память без TUI на этом стрессе заметно ниже, но CPU восстановления не меньше:
значительная работа принадлежит самому agent runtime. Не обещать фиксированные
20% экономии или обязательные200MiB на агента. Время до спокойного состояния
~146–156s включает3s guard низкого CPU и drainage; это НЕ измерение earliest
HTTP send. Процесс на протяжении замера остаётся прогретым и живым.

Первая загрузка нового импорта исключена из A/B: после первого model-turn AGY
сам нормализовал сохранённые payload725791311→376039579bytes при сохранённом
числе22001steps и SHA трёх ответов в начале/середине/конце. First-import headless
2941.7MiB нельзя напрямую сравнивать с последующими нормализованными запусками.
Порядок квалифицированных больших случаев TUI-b,TUI-c,headless-b,headless-c;
это не рандомизированная статистика. Medium1000turns дал525.3/335.8MiB, одна пара.
Offline audit собственного import artifact:11000 исходных `response` суммарно
360448000bytes, `modifiedResponse` остался у396 записей (12976128bytes).
Поэтому размер файла~698MiB не равен актуальному payload/объёму запроса к модели.

Измерение не включает Electron/Canvas и Node-хост с двумя xterm5000lines.
TUI выдал364MiB ANSI; runner потреблял его с backpressure, не держал весь raw
поток в RAM. Появление composer/JSON init раньше окончания загрузки не считается
idle: первая версия стенда ошибочно смешала restore и простой, исправлена.
Первый large-TUI остановлен своим3GiB guard (не crash); принятые прогоны с
5GiB CLI/1200MiB runner cap завершились штатно, все процессы закрылись.

Источник `/tmp/noted-agy-large.BRfShe/summary.json`, phase samples/real output
по путям внутри; исключённые прогоны сохранены отдельно. Воспроизводимые команды,
fixture builder/контекст и полный Noted UI этап — в рабочем
`docs/tmp/исследование-терминалов-и-агентов.md`. Продовый код/AGY binary не менялись.

### Полный Noted с этим архивом: ограниченный результат, не after-answer benchmark

Два bounded UI-прогона в том же frozen DEV, CDP9356/API7996, одна generic
terminal-tab. Первый остановлен на readiness gate без отправки model prompt:
позднее hostWithoutAgy держал~220–250% одного ядра при почти idle AGY, строки
на экране менялись. `/exit` затем принят (main-log21:08:44 UTC, exit0), поэтому
из этого нельзя выводить неработоспособность ввода. Пик wholeNoted5634.3MiB,
вложенного AGY5104.0MiB; root cause высокой hostCPU не профилирован.

Коррекция не требовала низкого CPU, планировала один prompt через180s жизни
AGY. На176.45s сработал собственный5GiB engine guard: AGY5220.2MiB,
wholeNoted5713.1MiB (5.58GiB). SIGTERM от monitor подтверждён AGY-log
04:23:43local; это не crash и не абсолютный максимум runtime. Prompt ещё не
отправлен, новых native steps нет. **RAM/CPU полного Noted после нового ответа
этими UI-прогонами не измерены.** CLI A/B выше остаётся отдельным успешным proof.
Нельзя подменять эту границу обещанием готового AGY History adapter или выводом,
что интерфейс вообще не умеет посылать сообщения. Перед production rollout
большие restore/send требуют отдельной проверки массового вывода и ресурсов;
повышение safety cap само по себе не чинит наблюдавшуюся нагрузку UI.

Родитель сверил source main-log, native guard log, screenshots и raw metrics.
Сохранены `noted-ui/report.md`, `noted-ui-retry/report.md` в том же artifact-root.
Оба lease остановлены, Inbox0 восстановлен, fixture вернули к22001steps перед
native cleanup. Новый AGY control/runtime в продукт не внедрялся.

---

## 1. Ink/TUI Render Tearing & Synchronized Output (Input Jitter)
**Файл-источник:** `fix-ink-tui-render-tearing.md`, `fix-terminal-jitter.md`

Ниже сохранена история Ink-ремонта, не описание текущей реализации. Старый
sync-frame splitter удалён13.05.2026 из-за потери разрезанных ANSI-маркеров —
см. `fix-terminal-jitter.md::Upstream fix`. Текущая write-очередь сохраняет
порядок байтов, но сама по себе не делает их показ атомарным по DEC2026.

### Problem
When running CLI tools built with Ink framework (e.g., Claude Code CLI, Gemini CLI), the input bar at the bottom of the terminal jitters/flickers during typing or when the tool is "thinking".

### Symptoms
- Input field visually "jumps" or "shakes"
- Text briefly disappears and reappears
- Cursor position seems unstable
- Problem is specific to Ink-based CLIs, not regular commands
- **NEW (Feb 2026):** Viewport "drifts" or entire screen jumps mid-write due to uncontrolled sync frame rendering

### Root Cause
#### Traditional Ink Issue
Ink framework updates the terminal UI at very high frequency (~100 writes/sec, 9ms gaps between updates). Each update sends a sequence:
1. `ESC[2K` - Erase line
2. `ESC[1A` - Move cursor up
3. Write new content

When xterm.js processes these as separate frames:
- Frame 1: Empty line (after erase)
- Frame 2: New content (after write)

The human eye perceives the empty frame as a "flash" or "jitter".

#### Modern Synchronized Output (DEC 2026)
Claude Code CLI (Feb 2026+) uses **DEC mode 2026 (Synchronized Output)** to wrap each differential frame:
- `\x1b[?2026h` marks frame start
- Multiple intermediate updates occur (cursor moves, line erases)
- `\x1b[?2026l` marks frame end
- **xterm.js 5.5.0 does NOT natively buffer these frames** — renders each escape sequence immediately
- Result: viewport "jitters" as intermediate cursor positions become visible, causing cascading redraws

### Solution
Implement a **Sync Frame-Aware Write Buffer** that:
1. **Detects DEC 2026 markers** in PTY output
2. **Batches writes** across complete sync frames (from `\x1b[?2026h` to `\x1b[?2026l`)
3. **Flushes atomically** ensuring xterm.js never renders intermediate states

#### Key Code (renderer.js)
```javascript
const FLUSH_DELAY = 10; // ms - aligns with 60fps
const MAX_BUFFER_SIZE = 4096; // safety valve

ipcRenderer.on('terminal:data', (event, tabId, data) => {
  const tabData = tabs.get(tabId);
  tabData.writeBuffer += data;

  if (!tabData.pendingWrite) {
    tabData.pendingWrite = setTimeout(() => {
      tabData.terminal.write(tabData.writeBuffer);
      tabData.writeBuffer = '';
      tabData.pendingWrite = null;
    }, FLUSH_DELAY);
  }

  // Flush immediately if buffer too large
  if (tabData.writeBuffer.length > MAX_BUFFER_SIZE) {
    clearTimeout(tabData.pendingWrite);
    tabData.terminal.write(tabData.writeBuffer);
    tabData.writeBuffer = '';
    tabData.pendingWrite = null;
  }
});
```

#### Why FLUSH_DELAY = 16ms (Updated Feb 2026)?
- 60fps = 16.67ms per frame
- Originally 10ms, increased to 16ms to align exactly with one frame
- 16ms ensures we batch multiple Ink updates into single frame
- Works in tandem with **Synchronized Output (DEC 2026)** protocol:
  - Claude Code wraps each differential frame in `\x1b[?2026h` ... `\x1b[?2026l`
  - Write buffer holds data until sync frame closes, preventing intermediate renders
  - 16ms then flushes the complete, atomic frame to xterm.js
- For details on sync frame awareness, see [`fix-terminal-jitter.md`](fix-terminal-jitter.md)

### Codex0.154: белый курсор скачет при звёздах Astra

11.09.2026 непрерывный30s dev-capture воспроизвёл белый block-cursor справа,
выше и ниже `Ask`, хотя пользователь ничего не вводил. Один кадр sparkle
приходит несколькими PTY-пакетами: seq1611 открыл DEC2026 и оставил cursor
наx204,y13; seq1612 продолжил рисунок; seq1613 вернулx2,y14 и закрыл кадр.
Видимый DOM-renderer успел выполнить `onRender` после1611. Screencast показал
белый блок наx≈1799,y281 вместоx≈216,y296; это видимый промежуточный экран,
не только изменение координаты в parser. В30s было23 различных DOM-позиции
курсора; после `tui.whimsy=false` — одна позиция и обычный blink.

Полный исходный snapshot +595 последовательных пакетов1611–2205 восстановили
точный финальный main-экран (символы, цвета, cursor), без gaps/resize/input.
Все197 закрытых DEC2026-кадров имели правильный cursor. Main/headless replay
и renderer model совпали на одинаковых seq. Поэтому старые256 сохранённых
**только committed** samples и пять разовых снимков не опровергали жалобу:
дефект живёт между ними. Пустота input и отсутствие потери байтов не означают,
что промежуточный экран не был показан пользователю.

Это граница presentation: применение PTY-пакета не равно завершению TUI-кадра.
Если чинить показ при включённой анимации, синхронизировать нужно paint, сохраняя
полный поток/ввод/headless и background capability. Нельзя возвращать старый
`indexOf`-splitter, blind resize либо править draft по положению белого блока.
Штатное отключение sparkle устраняет этот триггер, но не доказывает общую
атомарность renderer при других TUI-анимациях; такой source-ремонт не выполнен.
Артефакты и повторяемый30s recorder — в рабочем плане стабилизации, раздел4196.

---

## 2. Terminal Jitter & Project Switching
**Файл-источник:** `fix-terminal-jitter.md`

### Проблема
При создании нового терминала или переключении между проектами наблюдалось визуальное "дёргание" интерфейса. Это происходило по двум причинам:
1.  **Race Condition при рендеринге:** Терминал `xterm.js` сначала рендерится с дефолтными размерами, и только через короткий промежуток времени (setTimeout 100ms) вызывается `fitAddon.fit()`, что вызывает резкое изменение размера.
2.  **Unmount/Mount при смене проекта:** Раньше `TerminalArea` рендерил только табы активного проекта. При смене проекта старые терминалы уничтожались, а новые создавались с нуля, что вызывало лаги и потерю состояния WebGL.

### Решение

#### 1. Скрытие до готовности (Opacity Strategy)
В компоненте `Terminal.tsx` введены два механизма:
-   `isVisible` state: Начально установлен в `false`.
-   `opacity: isVisible ? 1 : 0` на первом cold mount.
Терминал становится видимым только после первого доказанного `safeFit()`. Для навигационного show/hide уже прогретого слоя transition не используется: active/presentation — состояние, не entrance-анимация.

#### 2. Персистентные слои (Persistent Layers)
В приложении используется стратегия «Смонтирован навсегда» для всех тяжелых компонентов:
-   **Terminal:** Рендерим терминалы **всех** открытых проектов одновременно. PTY/xterm живут в фоне. Обычный никогда не показанный слой может оставаться `visibility:hidden`, но прогретый pane и уже посещённый single-center Canvas сохраняют pixels renderer-presented; реальный show/hide управляется внешней tab-boundary через `opacity`, `pointer-events`, `aria-hidden` и focus quarantine. Иначе `visibility:hidden` выбрасывает готовый Canvas и тёплый возврат снова платит raster/composite.
-   **Источник активности слоя:** `TerminalArea` держит структурный список терминалов отдельно от `activeLayerKey` и явно передаёт `active/isActiveProject` в `Terminal`/`ClaudeSDKTab`. Не возвращать модель, где каждый терминал сам решает активность только через внутренний Zustand-селектор: прод-подтверждённый симптом 2026-06 — старый проект оставался `active=1 opacity=1`, а активная вкладка другого проекта была `active=1 opacity=0`; пользователь видел старый `Process completed`, хотя title/Timeline уже переключились.
-   **Workspace:** Компонент `Workspace` в `App.tsx` остаётся смонтированным при переходе на Dashboard. Его boundary меняет `opacity` и положение слоя, скрытый слой получает `zIndex:-1`/`pointer-events:none`/`aria-hidden` и прежнюю focus quarantine. Наследуемая `visibility` не меняется: даже готовый DOM иначе заставлял браузер обходить тысячи потомков при каждом Home↔Workspace. Скрытые controls не получают клавиатуру, а внутренние pane-boundaries сохраняют своё владение фокусом.
-   **Почему:** Любой unmount `xterm.js` приводит к потере WebGL-контекста и визуального буфера. Пересоздание занимает 1-3с, что неприемлемо для быстрого переключения.
-   **Важно:** `display:none` для живого xterm запрещён: он схлопывает контейнер в 0×0 и убивает геометрию. Но это не означает «всегда использовать visibility:hidden»: после первого прогрева retained Canvas прячется только внешней presentation-boundary. `actualPresentationRef` отдельно отвечает, имеет ли слой право на focus/input/fit.
-   **Контракт фона:** скрытие терминала не должно убивать PTY, xterm buffer или main/headless mirror. Mobile/API/History могут управлять скрытой вкладкой, поэтому stale-screen баги чинятся только визуальным слоем, а не unmount/kill/suspend терминала.
-   **Пауза циклического feedback:** статический `presentationAnimations.css` адресует точные классы индикаторов, inline infinite-анимации имеют `noted-infinite-animation` на animated DOM/SVG. Владельцы скрытия — terminal wrapper, pane chrome, single-center boundary и History; скрытый внешний owner выигрывает над locally-presented потомком. Видимое unfocused окно продолжает анимироваться. Finite callbacks работают в фоне; у notification dismiss paused только бесконечное кольцо. Generic style/class substring selectors запрещены из-за descendant invalidation при каждом warm show/hide; причина и контроль — `fix-performance-lags.md::7c`.
-   **History-primary — тот же контракт:** когда History занимает центр, floating-терминал оборачивает тот же единственный `TerminalArea`. `active`, retained pixels и actual presentation — разные оси: закрытое окно не крадёт focus/input и не получает чужой `safeFit`, но PTY, listeners, xterm buffer и Canvas pixels остаются живыми. Полный контракт — `fact-история-как-основная-поверхность.md`.
-   **Raw scrollback ограничен 5000 строками в обоих xterm-слоях.** Renderer и main/headless mirror используют один бюджет; прежняя lazy-ветка случайно создавала 50 000 строк и делала память зависимой от первого способа показа вкладки. Сокращение ограничивает JS/xterm heap и стоимость snapshot, но почти не уменьшает GPU `IOSurface`: там живут viewport-sized Canvas pixels, а не все строки scrollback. Для AI полный transcript принадлежит JSONL/rollout History; 5000 строк остаются большим диагностическим хвостом и для обычного terminal/dev-server.
    Проверка04.10 предложения500rows: полный ANSI replay двух старых
    controlled Codex0.159.2 запусков копии3314 (11391/11479bytes) при5000/500
    сохранил одинаковые40rows на границах chunks и snapshot2609bytes/exact hash.
    Тогдашняя35s подготовка доHTTP не объясняется заполненным xterm scrollback.
    Уменьшенный retention не предотвращает upstream rollout read/ANSI emission
    и не позволяет пропускать ANSI parser. Видимая высота/PTY rows — другой
    параметр, влияющий на layout TUI. Источник `/tmp/noted-scrollback-replay.mqzdqb/`;
    это replay записанного вывода, не новый CLI/GUI speed benchmark. Вsource5k
    не менялся; отдельный500-row AI budget пока только предложение.
    Последующее живое сравнение04.10: свежая копия3314 (773.80MiB,
    278turn_context), шесть новых Codex0.159.2 PID, два повтора5000/40,
    500/40,500/20 (retained rows / PTY height), порядок A/B/C/C/B/A. Реально
    принятый UUID-текст в input — медианы351/355/347ms; первый исходящий запрос
    к локальному Responses-приёмнику —33.27/31.25/30.49s. Это не время первого
    ответа: сервер отдавал контролируемый SSE без облачной генерации. Во всех
    вариантах восстановлена одна история, запрос373items/5921272bytes, ответ
    виден; MCP/hooks/goals отключены, OS-cache не очищен. На40-row экране оба
    буфера удерживали только40rows, на20-row —20rows. Выигрыша до доступного
    input не обнаружено; два повтора не доказывают причинность разницы доHTTP,
    а30s подготовки не устраняются уменьшением терминального хвоста/экрана.
    Граница — реальный CLI+PTY+два headless xterm, НЕ Electron/History/внешний
    composer Noted. Артефакты `/tmp/noted-codex-input-ready.oysEGJ/`
    (`summary.json`,scripts,полный ANSI,frames,cleanup);6/6 PASS, оригинальный
    frozen prefix неизменен, собственные thread/копии/PID убраны. Ограничения
    xterm в продукте этим исследованием не изменены.

---

## 9. Отказ от WebGL в пользу Canvas
**Файл-источник:** Сессия 2026-01-21 (GPU Optimization)

### Проблема
Первое переключение на "лениво" инициализированный терминал вызывало лаг в 2-3 секунды.

### Технические причины
1. **Shader Compilation (Warm-up):** При создании `WebglAddon` GPU должен скомпилировать шейдеры и создать атлас текстур для шрифта. Это тяжелая операция, блокирующая поток на время "прогрева".
2. **WebGL Context Limit:** Chromium имеет жесткий лимит (обычно 16) на количество активных WebGL контекстов. При открытии 17-го таба один из предыдущих контекстов уничтожается, вызывая краш или пустой экран терминала.

### Как делают "большие" (VS Code, Hyper, Warp)
- **VS Code** использует WebGL, но с очень сложной системой управления контекстами. Они не держат WebGL активным во всех табах — динамически включают/выключают его для активного таба, а для фоновых используют DOM/Canvas рендер.
- **Hyper/Warp** — кастомные форки xterm.js с собственной оптимизацией.
- Реализовывать такую логику (`oldTab.loadAddon(canvas)`, `newTab.loadAddon(webgl)`) самому — сложно и не оправдано для нашего use case.

### Почему WebGL не нужен для работы с AI
- **Скорость вывода LLM:** Gemini и Claude выдают текст со скоростью чтения (~100 токенов/сек). Для Canvas это смешная нагрузка.
- **Когда WebGL реально нужен:** Компиляция C++/Rust (`make -j12`), где строки бегут быстрее чем глаз видит. LLM так не делают.
- **Качество текста:** На некоторых экранах (особенно не Retina) WebGL может "мылить" шрифты из-за особенностей sub-pixel antialiasing.

### Решение
Полный отказ от `WebglAddon` в пользу стандартного **Canvas рендерера**.

### Результат
- Мгновенное переключение табов (нет warm-up)
- Отсутствие лимита на количество открытых терминалов
- Стабильная отрисовка шрифтов
- Упрощение кодовой базы (нет логики управления WebGL контекстами)

---

## 10. Font Rendering & Smoothing (iTerm Style)
**Файл-источник:** Сессия 2026-01-22 (Visual Polish)

### Проблема
Шрифт в терминале выглядел слишком жирным, "рыхлым" или менее четким по сравнению с нативными терминалами (iTerm2) или VS Code, особенно при использовании ярких цветов.

### Решение

#### 1. CSS Antialiasing
Для достижения "эффекта тонкого шрифта" в macOS необходимо принудительно включить сглаживание на уровне CSS для всех слоев терминала (включая Canvas):
```css
/* src/renderer/styles/globals.css */
.terminal-instance,
.terminal-instance .xterm-screen,
.terminal-instance .xterm-screen canvas {
  -webkit-font-smoothing: antialiased !important;
  -moz-osx-font-smoothing: grayscale !important;
}
```

#### 2. xterm.js Bold/Bright Logic
По умолчанию xterm.js может отрисовывать "яркие" цвета (bright colors) жирным шрифтом, что создает визуальный шум. Для чистоты интерфейса это поведение отключено:
```javascript
// src/renderer/components/Workspace/Terminal.tsx
const term = new XTerminal({
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  drawBoldTextInBrightColors: false, // Запрещает ярким цветам быть жирными по умолчанию
  // ...
});
```

#### 3. Единая palette для normal и lazy init

Terminal component имеет больше одного пути инициализации: обычный mount активного tab'а и lazy/warm init фоновой вкладки. Палитра xterm должна приходить из одного `TERMINAL_THEME` constant в оба пути. Если lazy init получит только `background/foreground`, а active init — полный 16-color palette, пользователь увидит «почти чёрно-белый» Claude/Codex после restore/warm-init даже при корректных ANSI и `COLORTERM=truecolor`. Это не лечится на стороне CLI: CLI уже шлёт цвета, но renderer маппит их непредсказуемо из-за разных theme objects.

### Результат
Текст стал более четким, тонким и профессиональным, сохраняя читаемость даже при мелком кегле.

---

## 11. Background Terminal Throttling (currentView)
**Файл-источник:** Сессия 2026-02-08

### Проблема
Терминалы в фоновых вкладках или при переключении на Dashboard/Notes продолжали считаться "активными" в логике `TerminalArea.tsx`, что могло приводить к лишним перерисовкам или конфликтам фокуса.

### Решение
Введена зависимость состояния `isActive` таба от глобального состояния `currentView` (из `useUIStore`).

```javascript
// src/renderer/components/Workspace/TerminalArea.tsx
const currentView = useUIStore((s) => s.currentView);

// ... внутри useMemo ...
const isActive = isActiveProject && workspace.activeTabId === tab.id && currentView === 'terminal';
```

---

## 11.1. Stale Canvas After View Switch (fit.fit() No-Op Trap)

### Ловушка xterm.js
`FitAddon.fit()` внутри проверяет `if (this.cols === newCols && this.rows === newRows) return` — если размеры контейнера не менялись, метод **ничего не делает**: ни `_renderService.clear()`, ни repaint. Это не баг xterm.js, а оптимизация, но она ломает рендеринг после `visibility:hidden`.

Эта секция остаётся для поверхностей, которые действительно теряют paint через `visibility` (cold/general view). Прогретые pane и retained single-center terminal избегают самой предпосылки: Canvas pixels не скрываются внутренним visibility, а outer opacity меняет только композицию. При неизменной геометрии их тёплый возврат не должен делать forced clear/refresh.

### Почему ломается
Пока терминал скрыт (Home view), данные из PTY продолжают писаться в буфер xterm.js. Canvas renderer накапливает stale state. При возврате `safeFit()` вызывает `fit.fit()`, но размеры те же → no-op → canvas не обновляется → Ink CLI (Gemini/Claude) рисует мусор (прогресс-бары переносятся, строки дублируются).

### Решение
В `Terminal.tsx`, useEffect активации (`[effectiveActive, isActiveProject, tabId]`), после `safeFit()`:
```javascript
// Форсированная очистка и перерисовка
if (xtermInstance.current) {
  const term = xtermInstance.current;
  const core = (term as any)._core;
  if (core?._renderService) {
    core._renderService.clear(); // Помечает все строки dirty
  }
  term.refresh(0, term.rows - 1); // Форсирует repaint canvas
}
```

### 11.2. The isInverse() Mystery (SGR 7)

### Проблема
В приложении (xterm.js) некоторые части интерфейса Claude/Gemini (например, префиксы промпта) выглядят как текст с закрашенным фоном, однако при захвате сырого ANSI-вывода (`node-pty`) соответствующие коды фонового цвета (`\x1b[48;...m`) отсутствуют.

### Причина
Использование флага **Reverse Video (SGR 7)**: `\x1b[7m`. 
Этот флаг велит терминалу визуально поменять местами цвета текста (Foreground) и фона (Background). В результате:
- Текст становится цветом фона.
- Фон становится цветом текста.

### Значимость
Это объясняет, почему попытки найти границы сообщений по явным кодам Background RGB провалились — визуальный "фон" создаётся через SGR 7, а не через `\x1b[48;...m`. Подход с анализом фоновых цветов был **отброшен** в пользу OSC 7777 маркеров (Claude) и текстового поиска (Gemini). `cell.isInverse()` в текущем коде не используется.

### ⚠️ ЛОВУШКА: Visibility Visible Override
Если дочерний элемент имеет стиль `visibility: visible`, он **перекрывает** `visibility: hidden` родителя.
- **Проблема:** При переходе на Dashboard весь Workspace скрывался через `hidden`, но терминалы (имея `visible`) продолжали «просвечивать» поверх главного экрана.
- **Решение:** Использовать `visibility: inherit` (или `visibility: visible` только при условии видимости родителя). Это заставляет детей подчиняться состоянию верхнего слоя.
- **Симптом 2026-06:** при переключении таба/проекта или после переноса окна между мониторами меняются title/Timeline/status, но центр остаётся на старом Codex `Process completed`/shell prompt. Это stale painted layer, а не доказательство что active tab/session state не переключился. Диагностика: `[Terminal:VisibleSetInvariant]` показывает `expected=<новая вкладка>` и `painted=<старая вкладка>` либо `count=0`; чинить через внешний terminal-layer / `activeLayerKey`, не через остановку фонового PTY.

### ⚠️ ОПАСНО: Resize Cycle (Trap)
Попытка форсировать пересчет через `term.resize(cols-1)` -> `term.resize(cols)` является **ловушкой**.
- **Эффект:** Это заставляет xterm.js пересчитать буфер, но так как это происходит внутри приложения, PTY не получает `SIGWINCH` (или получает их слишком быстро).
- **Результат:** В Ink-based CLI (Gemini) это намертво ломает позицию курсора. Курсор остается на строке ввода, но Ink продолжает считать, что он в другом месте, что приводит к "фантомным" строкам при каждом обновлении TUI.
- **Вывод:** Используйте только `_renderService.clear()` и `refresh()`. Это не трогает логические размеры терминала и курсор, но принудительно обновляет визуальный слой Canvas.

### 11.3. Renderer canvas не source of truth для background automation

Canvas/xterm в renderer отвечает за видимый terminal UI; он может быть hidden, not mounted, stale после view switch или сброшен dev-HMR. Поэтому фоновые сценарии не должны читать composer/status только из renderer registry. Для API/History/Rewind main-side headless xterm mirror является proof-слоем: он хранит xterm buffer/cell-style без зависимости от активной вкладки, а renderer snapshot используется только как fallback или визуальная диагностика.

Если фиксим баг с `no-terminal`, нельзя чинить его отказом от background-flow. Правильный вопрос: какой source of truth доступен в main для того же PTY stream? Этот шрам проявился на Codex Rewind/History/iOS, но класс общий для любой automation, которая должна работать без фокуса Mac-вкладки.

Тот же headless mirror является авторитетом при первом позднем открытии renderer xterm. Произвольно обрезанный хвост raw ANSI не является снимком: Ink/Codex обновляет экран дифференциальными cursor/erase-командами, смысл которых зависит от уже существовавшего кадра. Refresh, resize и повторная запись такого хвоста могут перекрасить только неверный логический buffer.

Cold hydration поэтому состоит из сериализованного headless-экрана на точной границе записи и всех более новых PTY-чанков того же поколения. Sequence сравним только внутри непрозрачного поколения конкретного PTY/headless mirror: новый процесс может начать счётчик заново, и смешивать его с прежним snapshot запрещено. Пока snapshot переносится, live-tail не обрезается; если поколение сменилось, renderer запрашивает новый authority вместо рекурсивного склеивания.

SerializeAddon не сохраняет невидимые OSC 7777 boundaries Timeline, поэтому main переносит их отдельными метаданными с точными строками. Более полный renderer-checkpoint допустим только при точном совпадении generation и полностью подтверждённой sequence-границы. Финальный headless-экран естественно завершившегося PTY удерживается до явного kill/закрытия или нового PTY, иначе позднее открытие потеряет единственный авторитетный кадр. Подробный production-шрам — `fix-terminal-jitter.md::Cold renderer после долгой фоновой работы`.

---

## 19. Idempotent Resize (SIGWINCH Storm Protection)

### Проблема: Лишние сигналы при переключении табов
При каждом переключении на вкладку терминала вызывался метод `fit()`, который отправлял IPC-сообщение `terminal:resize` в Main процесс. Main процесс, в свою очередь, вызывал `pty.resize()`, что порождало системный сигнал `SIGWINCH`.

**Следствие:** Даже если физический размер окна не менялся, Claude CLI (Ink TUI) получал сигнал о ресайзе. Это заставляло его полностью перерисовывать интерфейс, генерируя новые sync-маркеры. Это ломало логику ожидания в `safePasteAndSubmit` (см. `knowledge/fix-stale-sync-markers.md`).

### Решение: Проверка изменений (Safe Fit)
В функцию `safeFit` добавлена проверка текущих размеров.

```javascript
const safeFit = () => {
  if (!xtermInstance.current || !containerRef.current) return;
  const { cols, rows } = fitAddon.current.proposeDimensions();

  // 🛡️ Фильтр: не шлем resize если размеры те же
  if (cols === lastSize.current.cols && rows === lastSize.current.rows) {
    return;
  }

  lastSize.current = { cols, rows };
  fitAddon.current.fit();
  ipcRenderer.send('terminal:resize', tabId, cols, rows);
};
```

### Результат
Переключение вкладок стало "бесшумным" для процессов внутри терминала. Claude CLI больше не ловит ложных ресайзов, что стабилизирует работу всех автоматизаций (модели, форки, откаты).
