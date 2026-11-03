# Fix: запуск Claude навсегда в «Configuring claude…», Run After не срабатывает

## Симптом (31.10.2026)

Пользователь: *«ранавтор дошёл до конца, таймер завершился, и он нихуя не
активировался»*, *«бесконечные конфигуры… даже при обычном запуске»*, карточки
Run After в `delivery-unknown`, крестик их не убирает, у остановленной вкладки
вечный лоадер.

Все симптомы — одна причина, доказана на трёх вкладках (`6d6fd1718b66`,
`029152fbe588`, `9b9b7a35`):

```text
15:22      Run After взведён, первая задержка 48 мин
16:10      таймер истёк → cold-start validate → Claude поднят
           c41a18522055: startup-defaults-ready → fire ✓
           остальные три: ждут startup-defaults-ready — не пришёл никогда
17:13:29   [StartupTx] step-start phase=model command="/model claude-opus-5[1m]"
           … ничего: ни prompt-stability, ни paste, gate `pending` навсегда
17:14:37   send вернулся agent_send_durable_delivery_unknown (60 с, байт не было)
17:20:49   ручной Stop → bridge-clear очистил gate
```

## Причина

Шаг стартовой транзакции ждёт `claudePromptStability.wait()`. Готовность выдаёт
`observeClaudeSynchronizedFrameFlushed`, но вызывали её **только** когда сброшенная
запись — конец synchronized-output кадра (`meta.synchronizedFrameEnd`). Claude не
всегда рисует последний кадр так: после resume аккаунт был в 5-часовом лимите, и
уведомление «You've hit your 5-hour limit…» пришло вне synchronized-пары. Дальше
Claude простаивал на пустом composer. Все условия proof выполнены —
`parseClaudeComposerCurrentFrame` даёт `absent`, sync закрыт, writeSeq == flushedSeq
== 330 (снимок `fixtures/claude-usage-limit-idle-composer.json`) — но proof никто не
запускал.

Следствия по цепочке: gate `pending` → «Configuring claude…»; Send ждёт gate без
локального срока (`UntilSettled`) → in-flight → Main через 60 с пишет
`delivery-unknown` при неизменном receipt `in-flight` → крестик отклонён
(`unknown-presentation-changed`); Run After держит владельца, пока gate не `ready`.

## Исправление

После **обычного** (не synchronized) сброса вывода
`scheduleClaudeSettledFrameObservation` через debounce 300 мс запускает тот же proof
(`trigger='output-settled'`, reason `settled-composer-frame:<seq>`) — только пока
стартовая транзакция реально ждёт (`waiters > 0`) и prompt ещё не stable. Поэтому
не тратится parse на обычный вывод и не перештамповывается чужой lease. Все guard'ы
proof прежние: busy, stopping, открытый sync, несброшенные байты, диалоги
trust/auto-mode/rewind/model/effort, composer не доказан. Отказ на этом пути
логируется с причиной (`[ClaudePromptStable] settled-output … outcome=<reason>`),
таймер снимается при dispose зеркала. Debounce ждёт конца пачки вывода и не является
таймаутом готовности.

Сосед добавил в `claude-prompt-stability.js` ограничение 45 с тишины → `ready:false`.
Это страховка: с ним зависание превращается в видимый отказ настройки, который
теперь не блокирует Send/Run After (см. `fact-claude-control-bar.md::Провалившаяся
стартовая настройка не блокирует Send`). Основной путь — settled proof: настройка
применяется, а не проваливается.

## Вторая, главная причина: история принята за меню Rewind (01.11.2026)

После установки settled-проверка запускалась, но каждый раз отвечала
`outcome=dialog-visible` (tab `6d6fd1718b66`, 17:49:50 и 17:52:37 UTC). На реальном
снимке совпадала только `looksLikeClaudeRewindMenuText`: общий маркер `Esc to cancel`
(без учёта регистра) нашёлся в уведомлении «…continuing automatically at 11:10pm ·
esc to cancel», а `❯\s*\S` — в пустом `❯` перед линией рамки. Значит, экран с
уведомлением о лимите отклонялся и на synchronized-пути — версия «только вне sync-пары»
была неполной. Первый тест этого не видел: в нём эвристика была заглушкой (теперь
настоящая функция из `main.js`).

Исправление: когда текущий кадр — доказанный composer (`found`/`absent`), текстовые
эвристики активного диалога (`looksLikeClaudeRewindMenuText`, `Switch model?`/`Change
effort level`) читают только область composer (с верхней рамки, `promptRow - 1`),
а не историю над ней: Claude рисует picker/меню вместо composer. Без доказанного
composer (настоящее меню Rewind или выбор модели) — проверка по всему экрану, как
раньше. Структурные инспекторы trust/auto-mode и hint-наборы не менялись. Тест: случай
настоящего меню Rewind по-прежнему отклоняется.

## Третий симптом того же восстановления: «Claude start failed» без сбоя (01.11.2026)

Пользователь: *«какое-то странное состояние, при том что сессия запустилась,
сообщение отправилось»*. На восстановлении вкладка получает ДВА запроса на
запуск: AutoResume и cold-start Run After. Первый поднимает Claude, второй
приходит позже и видит ту же сессию живой. Отказ правильный — второй writer на
один transcript его испортит, — но подавался как сбой запуска.

```text
03:45:47  AutoResume → claude-c; 03:45:50 процесс жив, /model+/effort применены
03:46:02  Run After  → claude-c → ClaudePrepareResume: owner alive, reason=live-bridge
          → launch-rejected → красная карточка «Claude start failed»
03:46:03  тот же Run After увидел active/inputReady и отправил промпт: confirmed
```

Решение Fedor: «состояния должны складываться». Если живой владелец сессии —
**эта же вкладка** (`repairResult.ownerTabId === tabId`), результат помечается
`alreadyLaunching`/`claude_launch_already_live`, и `agentLaunchPreparations.finish`
получает `joined:true`: подготовка закрывается как `cleared` с reason
`launch-already-live`, без error. `applyAgentLaunchPreparationSnapshot` на такой
снимок возвращает `null`, то есть карточка не появляется и прежняя снимается.
Вызывающий по-прежнему получает `success:false` и ждёт уже идущий запуск —
join не выдаётся за acceptance. Чужая вкладка или внешний процесс
(`external-ps-resume`, `pending-resume`, `stopping`) остаются настоящим отказом
с прежним текстом. Отложенный путь `settleIntentPreparation` не возвращает
ошибку обратно: при `joined` error обнуляется. Тест
`src/main/claude-launch-already-live.actual.test.js` 4/4 (настоящий реестр плюс
настоящий renderer-редьюсер).

## Что отбросили

- Только 45-секундный ограничитель: модель/effort при этом не применяются никогда,
  а каждый запуск в лимите давал бы карточку отказа.
- Признавать готовность по видимому тексту без parser-proof: renderer-fallback для
  этого уже запрещён (`claudeStartupDefaultsReady.ts`), main-owned gate — авторитет.

## Проверка

`claude-prompt-settled-frame.actual.test.js` — настоящие функции из `main.js`,
настоящий парсер и реестр на снимке инцидента: PRE 1/6 → POST 6/6; соседние
`claude-prompt-stability.test.js` 16/16.

## Связанные

- `fact-claude-tui-control.md::Startup defaults /model + /effort при запуске Claude`
- `fact-prompt-queue.md` (cold-start latch Run After)
- `docs/tmp/глобальные-очереди-и-автокомпакт.md`
