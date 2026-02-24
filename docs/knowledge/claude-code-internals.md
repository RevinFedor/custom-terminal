# Claude Code CLI: Internals & Reverse Engineering (2026-02-09)

### Симптомы
При попытке форкнуть сессию через UI новая вкладка открывается с пустой историей, либо Timeline неправильно отображает границы сессий (Plan Mode / Fork), склеивая несколько разных диалогов в одну ленту без разделителей и возможности вернуться к корню.

## Архитектура
- **Binary:** Bun-compiled single executable (172MB, ARM64 Mach-O), не Node.js
- **Путь:** `/opt/homebrew/Caskroom/claude-code/<version>/claude`
- **Нативные модули:** ripgrep.node, file-index.node, image-processor.node, color-diff.node
- **WASM:** tree-sitter (парсинг кода), resvg (SVG)
- **Credentials:** macOS Keychain (`security find-generic-password -a $USER -w -s "Claude Code"`)
- **Feature flags:** Statsig SDK (41 gates, 47 dynamic configs)

## Session Chain: Как устроено внутри

### Clear Context = Plan Mode = Одинаковый механизм
```js
async function clearConversation() {
  setMessages(() => []);
  setConversationId(crypto.randomUUID());
  clearSessionCaches();
  IyR({setCurrentAsParent: true}); // Создаёт bridge entry
  await updateSessionFile();       // Пишет новый .jsonl
  await runSessionStartHooks("clear");
}
```
Plan Mode Exit с опцией `clearContext: true` вызывает ту же `clearConversation()`. Нет никакого поля, которое отличает plan mode от clear context.

### Fork — НЕ bridge
Fork делает `fs.copyFile` всего JSONL + перезаписывает `sessionId` на новый UUID. Первая запись в форке имеет `sessionId === filename` (выглядит как root). Claude добавляет поле:
```json
{ "forkedFrom": { "sessionId": "parent-uuid", "messageUuid": "last-msg-uuid" } }
```
Это единственный маркер форка. Наше приложение вместо этого использует fork markers в SQLite.

### Эволюция формата bridge записей

| Версия | parentUuid | slug | message content |
|--------|-----------|------|-----------------|
| v2.0.64 | `null` | отсутствует | Реальный промпт юзера |
| v2.1.32 | UUID (указывает на сообщение в родителе) | присутствует | `"[Request interrupted by user for tool use]"` |

В v2.1.32 bridge стал полноценной ссылкой — `parentUuid` указывает на конкретное сообщение в родительской сессии.

## JSONL Entry Types (6 типов, 290K записей)

| Type | % | Описание |
|------|---|----------|
| `assistant` | 58% | Ответы (text, thinking, tool_use). Поля: `requestId`, `message.model`, `message.stop_reason`, `message.usage` |
| `user` | 31% | Промпты + tool_result. Спец.поля: `thinkingMetadata`, `todos`, `toolUseResult`, `isCompactSummary` |
| `progress` | 7% | Стриминг Bash: `{type: "bash_progress", output: "chunk", fullOutput: "..."}`, `toolUseID`, `parentToolUseID` |
| `summary` | 3% | Заголовок сессии. Только 3 поля: `type`, `summary`, `leafUuid`. НЕ в UUID цепочке |
| `queue-operation` | 0.6% | Очередь: `enqueue`/`dequeue`/`remove`/`popAll`. Содержит текст сообщения в очереди |
| `system` | 0.5% | Мета-события (4 подтипа, см. ниже) |

### System Subtypes

**`turn_duration`** — время ответа Claude:
```json
{ "type": "system", "subtype": "turn_duration", "durationMs": 54091 }
```

**`compact_boundary`** — маркер компактификации:
```json
{
  "type": "system", "subtype": "compact_boundary",
  "parentUuid": null,
  "logicalParentUuid": "90fb6edd-...",
  "compactMetadata": { "trigger": "manual", "preTokens": 164640 }
}
```
`logicalParentUuid` часто dangling (UUID в памяти Claude, но не в файле). `parentUuid` всегда `null`.

**`api_error`** — ошибки API:
```json
{ "subtype": "api_error", "error": {...}, "retryInMs": 5000, "retryAttempt": 1, "maxRetries": 10 }
```

**`local_command`** — slash-команды (`/stats`, `/compact`, `/config`):
```json
{ "subtype": "local_command", "content": "<command-name>/compact</command-name>" }
```

## Полезные поля для UI

| Поле | Где | Польза |
|------|-----|--------|
| `durationMs` | system.turn_duration | Время ответа в Timeline |
| `preTokens` | compact_boundary.compactMetadata | Токены до /compact |
| `slug` | user/assistant entries | Человекочитаемое имя сессии ("quirky-jumping-rocket") |
| `forkedFrom` | fork entries | Маркер форка без нашей БД |
| `queue-operation` | отдельный тип | "В очереди" индикатор |
| `progress` | отдельный тип | Стриминг Bash с incremental output |
| `retryAttempt` | system.api_error | Retry статус в реальном времени |
| `thinkingMetadata.level` | user entries | high/none — thinking mode status |
| `message.usage` | assistant entries | Токены input/output для каждого ответа |

## Скрытые env vars

| Переменная | Описание |
|-----------|----------|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Мульти-агентные команды |
| `CLAUDE_CODE_IS_COWORK` | Cowork mode |
| `CLAUDE_CODE_PLAN_V2_AGENT_COUNT` | Параллелизм plan mode |
| `CLAUDE_CODE_EFFORT_LEVEL` | Уровень reasoning effort |
| `CLAUDE_CODE_AUTOCOMPACT_PCT_OVERRIDE` | Порог авто-компактификации |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Модель для субагентов |
| `CLAUDE_CODE_SHELL` | Override шелла |

## Файловая структура ~/.claude/

| Путь | Размер | Описание |
|------|--------|----------|
| `projects/` | 2.4GB | Session JSONL файлы (973 файла для custom-terminal) |
| `debug/` | 170MB | Debug логи (1065 файлов) |
| `history.jsonl` | 22MB | Командная история (13K записей) |
| `todos/` | 13MB | TodoWrite state (3440 файлов) |
| `shell-snapshots/` | 11MB | Снимки shell env (1538 файлов) |
| `stats-cache.json` | 11KB | 823 сессии, 231K сообщений |
| `statsig/` | 40KB | Feature flags (Statsig) |
| `plans/` | 116KB | Plan mode файлы (adjective-verb-noun.md) |
| `ide/*.lock` | 4KB | IDE WebSocket connection (PID, workspace, authToken) |
| `session-env/` | 0B | 291 пустая папка (бесполезно) |

## CLI Flags (из бинарника)

```
--session-id <id>                    Задать UUID сессии
--resume-session-at <message-id>     Возобновить с конкретного сообщения
--fork-session                       Форкнуть сессию
--plan-mode-required                 Принудительный plan mode
```

## Цикл-детекция
Claude сам ловит циклы в цепочках: телеметрия `tengu_chain_parent_cycle` и `tengu_transcript_parent_cycle`. Мы реализовали аналогичную защиту через `seen` Set в backtrace.
