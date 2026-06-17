# Fix: Rewind Navigation Logic

### Симптомы
При попытке восстановить сессию из Timeline (Rewind) курсор в меню истории Claude начинает быстро прыгать вверх, но "промахивается" мимо нужного сообщения. В результате либо восстанавливается неверная точка истории, либо (в старых версиях) сессия ошибочно откатывалась в самый верх (к первому сообщению).

Проблема навигации по меню истории Claude Code (Rewind) и переход к "Visual Search".

## Актуальность после native `/rewind` flow (2026-06)

Этот файл описывает safety/fallback-логику навигации, а не основной путь Timeline Rewind. Текущий default action в Timeline отправляет Claude slash-команду `/rewind`, выбирает target в родном picker'е, затем переносит восстановленный prompt из terminal composer в History textarea через тот же `grab-input` path, которым пользуется `+ clear`; terminal composer после этого должен остаться пустым. AI compact-варианты включаются только отдельными кнопками. Visual Search Strategy ниже остаётся защитой для ситуаций, когда позиционное сопоставление меню не сработало, но не должна снова становиться primary-моделью и не должна автоматически нажимать Enter при не найденной цели.

## Codex native backtrack: prime first, grab only as verification

Codex откатывается не через `/rewind`, а через цепочку `Escape` → hint `esc again to edit previous message` → transcript overlay → `Escape` к старым prompt'ам → `Enter`. Не переносить сюда Claude/Gemini slash-command модель и не начинать с `Ctrl+G` как preflight. External-editor grab до первого prime-кадра сам меняет composer/TUI state и маскирует root cause: потом в логах видно только `codex_rewind_prime_hint_not_observed`, хотя реальная проблема в том что backtrack даже не был корректно открыт.

Правильный порядок для диагностики: сначала добиться `prime initial timedOut=false hint=true`, потом увидеть transcript overlay, потом confirm-кадр с target prompt, и только после этого забирать восстановленный prompt через `codex:grab-input`. Grab здесь не способ открыть rewind, а verification/transfer step: доказать что Codex префиллил именно выбранный prompt и что terminal composer очищен перед передачей текста в History input. Логовая цепочка успешного случая: `[Codex:Rewind] prime initial ... hint=true` → `thread_rolled_back` в `codex:get-timeline/full-history` → `[Codex:Rewind] Terminal input grabbed+cleared ... matchedTarget=true`.

Если после `Enter` rollback уже применился, а grab вернул пусто/другой текст, это не «почти успех». Возвращай `codex_rewind_restored_input_mismatch` / `codex_rewind_restored_input_empty` с `rollbackMayHaveApplied: true`: History должна перечитать rollout как durable source, но UI не имеет права утверждать что target prompt безопасно перенесён в textarea. Пользовательский симптом нарушения — справа история уже усечена или JSON поменялся, а в живом терминале prompt не появился/не очистился; это выглядит как рассинхрон terminal vs History.

## Codex AI Rewind: tail-only paste is not JSONL truncation

Симптом: после AI Rewind в Codex Gemini-сводка генерируется полностью, но новый prompt в Codex/rollout начинается с середины текста — например видны только пункты 4-5 списка, а первые пункты исчезли. В той же операции Claude принимает сводку целиком. Это не обрезка JSONL writer'ом: rollout сериализует уже тот `user_message`, который успел оказаться в composer'е Codex к моменту submit.

Отброшенный подход: разбить fast paste на UTF-8-safe чанки до 900 байт. Это правильно для защиты кириллицы от разрыва внутри code point, но не решает race Codex composer ↔ Enter: fast path всё ещё пишет start/chunks/end подряд и затем жмёт Enter по задержке, без подтверждения что crossterm/React state увидели весь logical paste. Поэтому хвостовой prompt может сохраниться даже когда байтовые границы корректны.

Финальный контракт для `codex-rewind-ai`: использовать TUI-safe `safePasteAndSubmit(..., fast:false)`, то есть одна complete bracketed paste, ожидание sync/render marker после закрывающего `\x1b[201~`, короткий drain и только потом Enter. Перед Enter staging `CodexPasteAudit` обязателен: следующая запись rollout `event_msg.user_message` должна совпасть по длине/hash с Gemini result. Если audit показывает mismatch, сначала чинить paste/composer path; Gemini prompt и формат summary здесь вторичны.

Архитектурная граница: это всё ещё PTY fallback. Если Rewind AI начнёт требовать больше structured control над Codex thread'ом, правильный путь — перейти на `codex app-server` и его `thread/rollback` + `turn/start`, а не наращивать эвристики вокруг TUI paste.

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
