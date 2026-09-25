# Шрам: automatic Ctrl+G после таймаута открывал Sublime

## Наблюдение 2026-09-04, UTC

В `production.log` автоматический Codex copy отправил Ctrl+G в `22:18:43.293` для CLI PID `60631`. В `22:18:46.295` истекли 3000ms: main удалил `/tmp/noted-grab-60631.json` и вернул `codex_ctrl_g_noop` по отсутствию роста общего helper-log. `/tmp/noted-grab-helper.log` фиксирует запуск helper PID `70759` в `22:18:46.344` — **через 49ms после удаления intent**. Чтение lock дало ENOENT, и в `22:18:46.350` helper выполнил PASSTHROUGH в `/usr/local/bin/subl -w`. Следующий grab в `22:19:25` снова timeout'ил, пока внешний editor оставался открыт.

Система приняла отсутствие уже удалённой пометки за доказательство ручного запроса пользователя. Лог другого процесса и timeout не могут доказать, что provider проигнорировал клавишу.

## Исправление и границы

- `AgentInputCaptureProtocol`: immutable operation + main/PTY owner tokens, PID aliases, explicit commit/cancel decision. Cancellation остаётся видимой позднему helper.
- `noted-code-grab-v2.js`: prepare с исходным текстом, exact authorization до grab/restore mutation, сохранение текста при socket failure до commit. Настоящий manual вызов без automatic intent сохраняет прежний editor.
- Main GrabInput проверяет operation/owner/helper/PID/mode и актуальное поколение до применения image/draft side effects. Поздняя операция не привязывается к новой по одному PID/tab.
- Return watcher устанавливается до disk commit и socket ACK. Success требует результата helper и подтверждённого возвращения TUI; timer не является success proof.
- Versioned rollout: dev берёт repo helper; packaged helper устанавливается через `install:claude-hook`; legacy helper не изменяется под работающим production main.

Unknown no-op остаётся unknown: без provider key-consumed/no-editor ACK нельзя безопасно перезаписать intent для того же PID. После expiry новая automatic попытка явно возвращает `external_editor_pending_drain`; разрешён exact old-helper return/exit либо retirement процесса. Не очищать intent по свежему generic frame или произвольному TTL. Не перезапускать CLI автоматически: draft и текущая работа принадлежат пользователю. Особенность первого manual Ctrl+G после совершенно неисполненного automatic запроса описана в `fact-prompt-queue.md`; это отдельная recovery-граница для physical E2E/acceptance.

Новая физическая комбинация24.09 tab2686: старый автоматический `/model`
получил `slash-input frame timed out` с нулём ответных PTY bytes; собственный
rollback не доказал принадлежность текста и оставил команду в composer.
Следующий выбор модели увидел `/model` как реальный draft и попытался сохранить
его через Ctrl+G. Helper не вернулся за3с, поэтому `History Send` через4с
получил `external_editor_pending_drain` **до paste/Enter** и вернул авторский
текст в input. Позже, когда composer освободился, выбор модели был
подтверждён отдельно. Нельзя объяснять этот отказ только case-разницей
`GPT-6-Sol`/`gpt-6-sol` и нельзя удалять pending lock по таймеру: это
защитный след потенциально запоздалого helper. Открытый PTY-owner scope —
доказать exact helper-return/retirement или иной безопасный путь отзыва
собственной `/model`-вставки; production tab не использовался для retake.

## Проверки

`node --test src/main/agent-input-capture-protocol.test.js scripts/install-capture-editor-helper.test.mjs`

Проверяются exact 3000ms +49ms delayed start, grab/copy/clear/restore, настоящий manual passthrough, socket connection/ACK failures, stale/new operation, owner/generation mismatch, no-op ambiguity и real child helper + Unix socket. Installer тестируется только с временным home, включая dry-run, idempotence и неизменность legacy helper. Эти тесты не заменяют physical Codex/Claude E2E в отдельной dev вкладке.

## Соседние подтверждённые потери authoring snapshot (2026-09-05)

Независимые probes исходного кода подтвердили два разрыва после исправления dispatch: (1) helper уже очистил native draft, но ошибка return-barrier давала `success:false`, и History/Queue выбрасывали полный payload; exception image materialization выбрасывал даже текст; (2) renderer coalescing по `tabId:mode` отдавал один destructive результат двум независимым получателям. Поздний History-preflight дополнительно возвращал `draftImages` как count, теряя реальные refs нового terminal draft после того, как старый History snapshot уже был очищен.

Снимок теперь готовится до commit, ownership transfer отделён от готовности терминала, а renderer adoption идёт по exact physical operation ID. Независимые request IDs не разделяют один destructive result. Полный контракт — в `fact-prompt-queue.md`.

Дополнительные behavioral проверки: `node --test src/main/agent-draft-transfer.test.js src/main/codex-image-bindings.test.js src/renderer/utils/agentDraftTransfer.test.mjs`. Они исполняют настоящий main GrabInput branch с v2 helper/Unix socket и настоящие renderer capture/History/Queue/preflight/bridge функции с изолированными зависимостями; не являются regex-only доказательством.
