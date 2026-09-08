# Шрам: картинка принята Codex, но durable receipt остаётся audit-pending

## Подтверждённый случай 2026-09-05

Изолированный physical E2E, handoff `project-send:07501ced-da4c-416f-9b90-3540115797a4`, показал три представления одной отправки:

- исходный request: 3583 символа, hash `771bcdfd7914f8ff`, `[imagePath: /…/icon.png]`;
- реально подготовленный PTY transport: 3605 символов, hash `e8f14d6ece349948`, whitespace-free alias того же файла;
- native user carrier: 3510 символов, hash `eedd2ac5484b3664`, канонический image slot.

`CodexPasteAudit:CANONICAL_MATCH` правильно подтвердил transport→native по `codex_image_placeholder_canonical`. Но `publishAgentPromptAuditResult` передал transport hash как identity исходного request. Строгая durable-проверка справедливо отвергла `promptHash,expectedHash`; renderer уже показал SENT, а `presentation ACK` получил `delivery-not-confirmed`. Ошибка не в распознавании картинки и не в SQLite CAS — потерялось доказательство промежуточного преобразования самим приложением.

## Контракт исправления

`codex-image-request-projection.js` создаёт перед Enter доказательство **только image marker→alias**. Оно связано с exact tab/handoff/operation/attempt и содержит исходный текст, hashes/lengths и упорядоченные image identities. Повторная сборка через существующий `buildCodexImagePastePlan` должна побайтно воспроизвести staged transport; неизвестный source, другая картинка/порядок, потерянный marker или любое изменение обычного текста не получают доказательства.

На публикации exact audit main объединяет это доказательство с существующим `codex_image_placeholder_canonical`. Только при совпадении durable original hash, всей operation identity, staged path/ref order и transport hash/length наружу идёт исходный request hash. Нативный `actualHash` остаётся прежним; transport hash/length доступны в диагностике как `transportExpectedHash/transportExpectedLen` и в `[CodexImageAuditProjection]`.

`agent-send-receipt-store`, runtime registry и `agent-prompt-audit-identity` не ослаблены. Нет общего правила «разные hashes допустимы», нет попытки угадать предыдущий prompt по сходству. Missing-image degradation и произвольные преобразования текста этим доказательством не покрываются.

## Перезапуск — то же доказательство, не повторное угадывание

Доказательство создаётся до `stageAttemptContext` и вместе с упорядоченными `expectedImageRefs` сохраняется в receipt **до paste/Enter**. Live audit получает тот же объект; отдельной memory-only версии больше нет. Новых таблиц и ослабления CAS нет. Desktop History, уже использующий transport hash как свою durable identity, не сохраняет ненужную request→transport projection.

Startup reconciliation по-прежнему выбирает `transportText`. Если его hash/length отличаются от immutable request, разрешение даёт только сохранённая typed projection: exact operation/attempt, сырой `promptText`, transport, hashes, paths и refs проверяются повторной сборкой. Отсутствующая/повреждённая projection не заменяется fallback'ом на `promptText`. После этого реальный native carrier в сохранённой byte boundary обязан отдельно пройти image canonical proof; строка с голыми alias-путями не доказывает приём картинки. Итоговый audit использует исходный request hash, но сохраняет raw native `actualHash` без переписывания.

## Проверки

`ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test src/main/codex-image-request-projection.test.js src/main/agent-send-startup-reconcile.test.js src/main/agent-send-receipt-registry.test.js src/main/agent-send-receipt-store.test.js src/main/agent-prompt-audit-identity.test.js src/main/codex-prompt-audit.test.js`

Проверяются настоящий `publishAgentPromptAuditResult`, SQLite store, runtime registry и точный 3583→3605→3510 physical fixture. Отдельный тест исполняет настоящий pre-Enter staging block, закрывает/открывает SQLite и восстанавливает audit с неизменным native hash `eedd2ac5484b3664`. Подмена attempt, operation, текста, image ref/path/order и утрата projection не подтверждают доставку. Старая передача hash воспроизводит оба mismatch; новая переводит оба receipt в confirmed. Unit-тесты не заменяют финальный physical E2E нового build, его restart и presentation ACK.
