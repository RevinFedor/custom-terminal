# Codex: старая строка picker блокирует новую отправку как draft

## Доказанный случай

2026-09-08, orchestration4497349c-b187-4a22-b2b1-fd331f95d41c, target suffix
14d1d1aa72f4. В15:51UTC приложение восстановило Codex и применило настройки,
но отказало до paste/Enter с `codex_existing_draft_before_paste`.
Receipt: `submitted:false`, `status:not-submitted`; preview якобы черновика —
`5. More reasoning… Max and Ultra consume usage limits`. Источник verdict:
`headless-main:cursor:1016:dim-hint+renderer-positive:tail:1024`.

Main уже доказал пустой composer, но асинхронный запрос к отставшему desktop
xterm вернул старую строку меню. Система считала свежий запрос свежим кадром
и позволяла любому renderer-positive переопределить отрицательный main proof.
Оркестрация честно сообщила об отказе доставки; задача не была отправлена.

## Исправление без изменения пользовательского контракта

- Main и renderer передают границу реально применённого PTY-вывода вместе с
  draft verdict (`frameIdentity.generation/writeSeq`), а не время чтения экрана.
  Renderer использует уже существующий `markRendererWriteFlushed`; callback
  заменённого xterm не может снабдить текущий xterm чужой frame identity.
- После асинхронного ответа renderer main ещё раз догоняет свой mirror.
  Замена mirror останавливает операцию. Ошибка flush не сохраняет прежний
  empty verdict и не превращает renderer-only empty в разрешение на запись.
- При доказанном main-empty старый, чужой или неподтверждённый renderer frame
  не считается более свежим draft. Positive на том же или более новом кадре
  по-прежнему защищает ручной текст. При недоступном main proof сохраняется
  консервативный positive-only fallback; отрицательный renderer не разрешает
  запись. Исключение — явно отозванный read-owner: `superseded/cancelled`
  нельзя оживить даже положительным renderer. Legacy unscoped callers сохраняют
  прежнюю positive-only семантику только для неотозванного наблюдения.
- Текст меню не внесён в blacklist: пользователь может сам набрать ровно те
  же слова, и такой настоящий draft должен блокировать смешивание сообщений.

29.09 tab34 выявил диагностическую грань того же правила. При cold Resume
первый main read ещё unknown, поэтому inner `codex:get-draft-state` запрашивает
renderer hint. После await main уже доказывает empty на frame141, а renderer
вернул frame100 той же generation и назвал placeholder draft. В этом входе
positive promotion отключён: Send правильно продолжился и exact1396char audit
подтвердился. Но причина отбрасывания hint вычислялась только при включённом
promotion; её отсутствие создало ложный `draft-screen-contradiction` и тяжёлый
capture/уведомление. Теперь возраст hint сохраняется независимо от opt-in:
разрешение записи не меняется, безопасное отставание остаётся обычным логом.
Same/newer, unknown/foreign generation и failed main по-прежнему диагностируются
или защищают draft по прежним правилам. Проверять реальный request с порядком
unknown→renderer await→empty и БЕЗ `mergeRendererPositive`, не только сам merge
либо IPC с заглушкой «main уже definitive».

Общий guard находится перед первой PTY-записью, поэтому правило действует для
History, Project API, Inbox, Terminal MCP, оркестраций и Run After. Защита
input revision и независимые проверки native picker/Rewind не снимаются.
Нет timer-success, повторного Enter или ожидания клика/переключения вкладки.

10.10/4196 уточнил positive-only fallback: при ещё неизвестном текущем Main
старый renderer-positive тоже не становится текущим черновиком. Main передаёт
applied boundary даже во время незаконченного frame, сохраняя hasDraft=null.
Обе стороны merge отбрасывают только доказанно более старую same-generation
подсказку в unknown; прежний frame wake/deadline ждёт актуальный composer.
Это не отрицательное доказательство для paste. Same/newer и отсутствие
сопоставимых границ сохраняют консервативную защиту текста.
Incident показал renderer5031 против Main5132 и строку рабочего контекста вместо
ввода; Ctrl+G подтвердил empty, исходный Send затем получил exact SENT. Поэтому
«exact empty input confirmed» — восстановленная preflight-проверка, не ошибка
доставки и не основание повторять сообщение. Replay scheduling в тесте controlled,
не физический повтор4196; остальные неожиданные противоречия не скрываются.

Последующие вложенные чтения используют остаток одного main deadline, не
получают новый бюджет. Шрам4412 empty→renderer await→partial привёл к общей
read-транзакции для обоих провайдеров; см.
[`fact-terminal-core.md`](fact-terminal-core.md#единое-наблюдение-ввода-до-записи).

## Проверка

Регрессия merge воспроизвела отказ до правки. После — actual main request
проверяется с поздним renderer, новым настоящим draft, сменой mirror и отказом
финального flush. Реальный headless xterm + actual terminalRegistry прогоняют
picker→empty composer→ручной текст с теми же словами. Общий набор с
draft-preservation/lifecycle/model-picker:101PASS; electron-vite build PASS.
Это source/replay/integration proof, не отдельный новый полный CLI UI E2E.

Артефакты: /private/tmp/noted-fork-repair-20260907.ZGoQNr/
codex-stale-renderer-before.log, codex-stale-renderer-regressions.log,
codex-stale-renderer-build.log. В main остаётся диагностический тег
`[CodexDraftState] renderer positive ignored` с обеими frame identities.
