# Архитектура и подключения

```text
Рабочая вкладка: cwd + CLI + native transcript
    ↑                       ↓
Desktop / iPhone / MCP → общие действия Main → History / result / события

Внешний чат → Inbox run (Codex) → terminal execution → exact result
  свой transcript                 runtime Noted
```

## Terminal MCP

`mcp/terminal-server.mjs` — standalone Node stdio wrapper для API работающего
Noted. `npm run install:terminal-mcp` регистрирует его локально для Claude/Codex
и сохраняет другие записи. `current_context` определяет вызывающую вкладку,
не пользовательский UI focus. Для чтения сначала search/catalog, затем карта
turns и выбранные блоки. Codex history mutation через MCP не поддерживается;
Claude propose/apply использует существующий history pipeline.

`send_message` — адресный вопрос; `reply_to_message` — ответ на точный messageId.
`delegate_to_session` — самостоятельное долговечное поручение с runId. Оба вида
действий исполняет приложение; accepted/queued не означает прочтение моделью.
После принятой делегации закончите ход; дождитесь notification. Если в ней есть
полный ответ, используйте его. Result GET нужен при явной ссылке/старом формате
или recovery, а не как polling.

MCP hub обычно53133 — другой endpoint. Public build включает только установленный
terminal/knowledge и явно настроенные optional adapters. `NOTED_MCP_IDENTITY` несёт
routing context, это не bearer-secret внешнего API. Для отдельного native MCP
используйте конфигурацию своего CLI; старый процесс не обязан перечитать её после
hub restart. Knowledge MCP и его платный/model-backed routing не нужны для setup.

## REST/SSE

`src/main/web-server.js` — действующий API. Dev preferred port7979, packaged7878;
при конфликте actual port меняется. API стартует вместе с desktop runtime и
слушает LAN (`0.0.0.0`). Token хранится в `~/.noted-terminal/web-token.txt` и
передаётся как `Authorization: Bearer <YOUR_LOCAL_TOKEN>`. Копируйте адрес/token
этого Mac. Token даёт управление процессами/проектными данными; подключайте только
доверенные клиенты, удалённый доступ настраивается владельцем отдельно.

Первый read — `GET /api/me`: проверить service name/listening/actual port и
capabilities. Он не запускает inference. Не объявляйте отсутствующую capability
доступной по наличию похожего имени endpoint. Каталог моделей — `/api/agent-models`;
не выводите entitlement аккаунта из одного label.

Пример без записей и model prompt: после выбора actual port установите
`NOTED_API_URL` адресом своего Mac, а `NOTED_API_TOKEN` — локально введённым
token (значение не сохраняйте в history или отчёте).

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $NOTED_API_TOKEN" "$NOTED_API_URL/api/me"
```

Для SSE используйте возвращённый URL и разрешённый tab scope; native клиент
может отправлять bearer header. После reconnect snapshot/event только будит
чтение прежних receipts/history/result. Создание нового run ради reconnect
не является восстановлением. Точные capability/envelope handlers находятся в
[src/main/web-server.js](../src/main/web-server.js); MCP schema — в
[mcp/terminal-server.mjs](../mcp/terminal-server.mjs).

Не port-forward этот listener в публичный интернет. Remote access требует
отдельно защищённого ingress; token — credential с правом управления.

| Маршрут | Назначение |
|---|---|
| `GET /api/projects` | Legacy execution namespaces; не workflow identities |
| `GET /api/projects/:id/tabs` | Вкладки и их runtime metadata |
| `GET /api/terminal-tabs/inspect?tabIds=[...]` | До8 точных вкладок: passive runtime/turn, own background, jobs/delivery; optional cached final |
| `POST /api/terminal-tabs/:tabId/send` | Send в выбранную сессию |
| `GET /api/terminal-tabs/:tabId/send-receipts` | Прежняя доставка без повторного Enter |
| `GET /api/terminal-tabs/:tabId/history` | Structured history snapshot/delta |
| `POST /api/terminal-tabs/:tabId/interrupt` | Прервать текущий ответ |
| `POST /api/terminal-tabs/:tabId/stop` | Остановить процесс, сохраняя разговор |
| `POST /api/inbox/runs` | External Codex request с устойчивым runId/conversationKey |
| `GET /api/inbox/runs/:runId` | Creation/submission/runtime outcome той же попытки |
| `GET /api/inbox/runs/:runId/result` | Exact result, не status-derived ответ |
| `POST /api/inbox/runs/:runId/stop` | Остановить external runtime |
| `GET /api/events` | SSE wake/runtime updates по выбранному scope |

Эта таблица — вход в source API, не полный schema contract. Точные поля/guards
сверяйте с handler и advertised capability. Endpoint names сохраняют legacy
`projectId`; подставлять workflowId вместо него нельзя.

## Delivery, result и recovery

```text
Создать вкладку ≠ запустить CLI ≠ подготовить input
  ≠ принять Send ≠ получить ответ ≠ завершить всю Goal/дочернюю работу
```

HTTP202 означает продолжение наблюдения. `queued` и `sent` — состояния доставки,
не готовый assistant answer. Client заранее сохраняет request/run identity;
reconnect читает ту же receipt/run/result. Timeout, исчезновение UI или потеря SSE
не разрешают новый prompt. Unknown остаётся unknown до точного proof.

Inbox setupOutcome отделяет создание от отправки. Reservation не является writer
binding. `not-submitted` требует явного no-write proof; generic scalar false при
create timeout его не даёт. Внешний чат владеет своим composer/transcript; project
API не очищает чужой TUI draft. Cancel observation, interrupt turn и process Stop
имеют разные эффекты. Отказ stop не объявляется успешной отменой.

Native iPhone и companion-chat используют этот Mac backend, но являются отдельными
продуктами/сборками. `mobile-web` оставлен как legacy и не является primary iPhone
клиентом. No-GUI daemon из одного web-server.js не поставляется.

## Storage maintenance

Проверять `GET /api/me → capabilities.storageMaintenance.version=1`; source/MCP
update не означает, что метод доступен у работающего app. Auth тот же Bearer.

- `GET /api/storage/inventory` — metadata inventory, в том числе `Test runs`.
- `GET /api/storage/plan` — dry-run готовых session deletions и closed History.
- `GET /api/storage/database-space` — page/free-page counters и число служебных
  workflow snapshots; не тяжёлый scan RAG и не обещание размера reclaimed.
- `POST /api/storage/cleanup {operationId,maxItems?}` — прежний bounded retention
  executor. Только созревшие/не защищённые данные; текущие workflow/процессы не
  закрывает. Archive expiration сохраняет RAG, files проходят provider guards.
- `GET /api/storage/cleanup/:operationId` — durable receipt. `started/unknown`
  не повторяются и не разрешают новую отправку с другим ID для «проверки».

`node scripts/storage-cleanup.mjs` по умолчанию dry-run. `--apply` требует
заранее выбранный `--operation-id`; потерянный ответ читается с `--receipt`.
На старой версии — update-required без прямого открытия/правки SQLite.
