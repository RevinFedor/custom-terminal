# Компакт в Claude Code

Что выяснили в сессии 2026-05-17. Reference на будущее. Источники: декомпилированный исходник `packages/claude-code-src/` (v2.1.88, leak от 2026-03-31), live install `claude --version` 2.1.143, ресёрч Perplexity (15861 символов, id `rsz243mtfmp9eil7w`), GitHub issues anthropics/claude-code, официальная документация `code.claude.com`.

---

## Что такое compact

Механизм сжатия истории. Когда контекст близок к лимиту — старые сообщения отправляются в AI-суммаризатор, в активной сессии остаётся только summary, оригинал лежит в JSONL на диске.

## Где живёт код

- `packages/claude-code-src/services/compact/` — вся логика
  - `prompt.ts` — системные промпты (три варианта)
  - `compact.ts` — алгоритм (~60K)
  - `autoCompact.ts` — авто-триггер + circuit breaker
  - `microCompact.ts` — лёгкая очистка tool results
  - `sessionMemoryCompact.ts` — экспериментальный режим
  - `postCompactCleanup.ts`, `compactWarningState.ts`, `compactWarningHook.ts`
- `packages/claude-code-src/commands/compact/compact.ts` — обработчик `/compact`
- `packages/claude-code-src/commands/rewind/rewind.ts` — обработчик `/rewind`
- `packages/claude-code-src/components/MessageSelector.tsx` — UI выбора сообщения для rewind/partial-compact
- `packages/claude-code-src/utils/fileHistory.ts` — file checkpointing (определяет видны ли summarize-опции)
- `packages/claude-code-src/entrypoints/sdk/coreSchemas.ts` — тип `compact_boundary`

## Промпт компакта

`services/compact/prompt.ts:61-143` — `BASE_COMPACT_PROMPT`. Структура (дословные заголовки):

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

Три варианта собираются через `getCompactPrompt` / `getPartialCompactPrompt`:
- `BASE_COMPACT_PROMPT` — полный компакт
- `PARTIAL_COMPACT_PROMPT` (стр. 145-204) — partial direction='from'
- `PARTIAL_COMPACT_UP_TO_PROMPT` (стр. 208-267) — partial direction='up_to'

Обязательная обёртка `NO_TOOLS_PREAMBLE` + `NO_TOOLS_TRAILER` — запрещают вызовы инструментов в момент суммаризации (любой tool_use = провал).

Output: модель пишет `<analysis>...</analysis>` (черновик, выкидывается через `formatCompactSummary`) + `<summary>...</summary>` (сохраняется).

## Continuation prompt

После компакта в новую сессию инжектится (`prompt.ts:337-374`):

> This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.
> 
> [summary]
> 
> If you need specific details from before compaction, read the full transcript at: [path]
> 
> Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.

Объясняет почему агент после компакта сразу пишет ответ без приветствия — это инструкция.

## Триггеры

`services/compact/autoCompact.ts:72-91`. Пороги абсолютные, не процент:

| Порог | Значение | Действие |
|---|---|---|
| `effectiveContextWindow − 20K` | warning | жёлтая нотификация |
| `effectiveContextWindow − 20K` | error | красная нотификация |
| `effectiveContextWindow − 13K` | **AUTO_COMPACT** | запуск компакта |
| `effectiveContextWindow − 3K` | blocking | запрет ввода |

`effectiveContextWindow = model_context_window − reserved_output_tokens` где `reserved = min(model_max_output, 20K)`.

Каскад при `/compact`:
1. **microcompact** — чистит устаревшие tool results (не AI)
2. **session-memory compact** — экспериментальный, если без `customInstructions`
3. **reactive compact** — если включён режим reactive-only
4. **full compact** — fallback

Circuit breaker: `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`. После 3 фейлов подряд авто-компакт **отключается на сессию**, юзер застрянет на blocking-limit. Защита от infinite retry (мотивация в BigQuery-анализе Anthropic — 1279 сессий с 50+ retry жгли ~250K API calls/день).

PTL retry: если сам compact-запрос hit prompt-too-long → удалить oldest groups → retry. До 3 попыток.

## compact_boundary в JSONL

`entrypoints/sdk/coreSchemas.ts`. Спец-запись:

```
type: 'system'
subtype: 'compact_boundary'
compact_metadata: {
  trigger: 'manual' | 'auto'
  pre_tokens: <до компакта>
  preserved_segment?: {
    headUuid, anchorUuid, tailUuid    // только при partial compact
  }
}
```

Старые messages удаляются из активного контекста, но **JSONL на диске сохраняет всё**. Транскрипт лежит в `~/.claude/projects/<hash>/<session>.jsonl`.

В нашем `CLAUDE.md` уже зафиксировано (антипаттерн «Разница sessionId в одном JSONL ≠ bridge»): cross-file bridge = `type === 'compact'` или `type === 'continued'`. Это и есть `compact_boundary` отсюда.

## partialCompactConversation — что это и кто вызывает

Сигнатура `services/compact/compact.ts:772-779`:

```typescript
export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from',
): Promise<CompactionResult>
```

`PartialCompactDirection = 'from' | 'up_to'` (импортируется из `types/message.js`, **не экспортируется в npm-package**).

Семантика:
- `direction='from'` → суммаризирует `allMessages.slice(pivotIndex)`, сохраняет `slice(0, pivotIndex)`
- `direction='up_to'` → суммаризирует `allMessages.slice(0, pivotIndex)`, сохраняет `slice(pivotIndex)`

`pivotIndex` — это **индекс в массиве**, не UUID. Конвертация UUID → index делается через `Array.indexOf(messageObject)` по референсу объекта (`REPL.tsx:~4920`).

После сжатия `annotateBoundaryWithPreservedSegment` записывает в `compact_boundary.compact_metadata.preservedSegment` три UUID: `headUuid` (первое сохранённое), `anchorUuid` (точка склейки), `tailUuid` (последнее сохранённое). Это используется loader'ом при `--resume` для восстановления parentUuid chain.

Telemetry: `logEvent('tengu_partial_compact', { trigger: 'message_selector', direction, ... })`. **Единственный trigger — 'message_selector'.** Других путей вызова в leaked коде нет.

## Доступ из UI (что юзер реально видит)

Все пути ведут к `MessageSelector`:
- `/rewind` slash-команда → `commands/rewind/rewind.ts:4-12` → `context.openMessageSelector()`
- Esc×2 на пустом инпуте → `components/PromptInput/PromptInput.tsx:1254` → `useDoublePress(..., onShowMessageSelector)`

В `MessageSelector` есть **два экрана**, переход через Enter:

1. **Список сообщений** (всегда). Стрелки вверх/вниз → Enter.
2. **Меню опций** (условный). Опции зависят от двух гейтов:

### Гейт 1: `isFileHistoryEnabled`

`MessageSelector.tsx:169-172`:

```typescript
if (!isFileHistoryEnabled) {
  await restoreConversationDirectly(message_0);
  return;
}
```

Если file history выключен → **второй экран не показывается**, мгновенный откат после Enter. Это случай юзера: у него нет папки `~/.claude/file-history/`, в `~/.claude.json` нет `fileCheckpointingEnabled` (но default = true), `fileHistoryEnabled()` смотрит на инфраструктуру и возвращает false если папки backups нет.

Логика `utils/fileHistory.ts:63-78`:

```typescript
export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) return fileHistoryEnabledSdk()
  return getGlobalConfig().fileCheckpointingEnabled !== false &&
         !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
}
function fileHistoryEnabledSdk(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING) &&
         !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
}
```

В SDK-mode требуется явный `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`.

### Гейт 2: `"external" === 'ant'`

`MessageSelector.tsx:121-128`:

```typescript
if ("external" === 'ant') {
  baseOptions.push({ value: 'summarize_up_to', label: 'Summarize up to here', ... });
}
```

Anthropic собирает Claude Code в двух вариантах. Переменная `"external"` заменяется на `"ant"` во внутренней сборке, на `"external"` в публичной (через esbuild define или подобный механизм). В публичных билдах сравнение **всегда false** — `summarize_up_to` присутствует в коде, но **не попадает в options array**.

То есть: даже с включённым file history публичный юзер увидит максимум **«Summarize from here»**, но не **«Summarize up to here»**.

## Полная карта опций rewind menu

| Опция | Direction | Доступна когда |
|---|---|---|
| Restore code and conversation | — | file history включён + есть правки |
| Restore conversation | — | всегда (после file history включён — в меню; без него — мгновенный откат) |
| Restore code | — | file history включён + есть правки |
| **Summarize from here** | `'from'` | file history включён |
| **Summarize up to here** | `'up_to'` | **только внутренние сборки Anthropic** |
| Never mind | — | всегда |

## Что нельзя из публичного API

Перепроверено в:
- `entrypoints/sdk/coreSchemas.ts`, `entrypoints/sdk/controlSchemas.ts` — нет `direction`, `pivotIndex`, `messageId` для compact
- `cli/print.ts`, главные entrypoints — нет флагов `--compact-from`, `--compact-up-to`, `--keep-recent`
- `--rewind-files <uuid>` есть, но это **файловый** откат, не conversation compact
- `--resume <id>` принимает только session UUID/name, не аргументы компакта
- `--fork-session` создаёт новую сессию с resume-точки, но компакт не применяет

Программно `partialCompactConversation` дёрнуть нельзя — не экспортируется в `package.json::exports`, npm-пакет публикует только bundled бинарник (Bun build).

## Feature requests от сообщества (все висят / закрыты)

| Issue | Запрос | Статус |
|---|---|---|
| anthropics/claude-code#1301 | `/compact 50` — partial compact с числовым индексом | Open, нет ответа |
| anthropics/claude-code#2705 | `/compact from:42` (аналогия с `git rebase -i HEAD~5`) | Open, нет ответа |
| anthropics/claude-code#3289 | `claude --resume <session> --from-uuid <uuid>` | Closed: not planned |
| anthropics/claude-code#7359 | `/compact` с любыми опциями | Closed: not planned |
| anthropics/claude-code#7919 | `--keep-recent N` для сохранения последних N | Open, нет ответа |
| anthropics/claude-code#28716 | «Summarize before here» в rewind menu | Closed: not planned → но **шипилось в v2.1.32**, затем перенесено за internal feature-flag |
| anthropics/claude-agent-sdk-typescript#88 | Fork from messageId | Closed |
| anthropics/claude-code#10968 | hook `reload_history: true` для перезагрузки JSONL без рестарта | Closed: not planned |

Паттерн: Anthropic закрывает запросы превентивно, иногда позже шипит фичу, **публично роадмап не комментирует**. Programmatic compact-by-UUID — сознательно не выпускают, причины не объясняют.

## Обходные пути сообщества

1. **Manual JSONL editing.** Открыть `~/.claude/projects/<hash>/<session>.jsonl`, удалить/заменить строки, рестартовать `claude --resume <session>`. Подводный камень: компакт создаёт `parentUuid` references на UUID-ы summary-сообщений, которые **не записаны на диск** — при ручной правке chain может сломаться. Третий тул `@askib/claude-code-toolkit` (cct) специально фиксит broken parentUuid chains.
2. **`/compact` с инструкцией-подсказкой.** Например `/compact preserve the last 10 turns verbatim and skip everything about authentication`. Полный компакт, но AI получает приоритеты. Soft guarantee, ~70% работает.
3. **`claude-code-rewind` (holasoymalva/claude-code-rewind на GitHub).** «Time machine» — snapshot/restore точек, не partial compact.
4. **Issue #10968 — кастомный hook.** Кто-то делал custom compact commands через JSONL-правки + рестарт. Anthropic закрыл fix-запрос `reload_history`.

Прямых monkey-patch'ей или форков для programmatic partial compact в публичных репозиториях **нет**. Bun-bundled бинарник делает runtime-патчинг практически невозможным.

## Аналоги в третьих тулзах

| Тул | Partial compact | Заметки |
|---|---|---|
| Cursor | Нет | Контекст per-request, нет persistent session |
| Cline | Нет | Sliding window, full clear |
| Aider | `/drop` файлов | File-scoped, не message-scoped |
| Roo Code | Нет | Форк Cline |
| claude.ai web | Только auto-compact | `/rewind` недоступен |

Ближайший концептуальный аналог — Aider `/drop`. Все остальные context-management работают грубее.

## Наш Noted Terminal vs Claude Code

| | Claude Code `/rewind → Summarize from here` | `mcp__overseer__apply_edit` mode='compact' |
|---|---|---|
| Точка | Одна (pivot) | Две (startUuid + endUuid — точный middle-range) |
| Direction | `from` или `up_to` | произвольное удаление + вставка summary |
| Кто пишет summary | AI (Claude → сам себе) | Юзер руками |
| API | Только UI | MCP-tool |
| Зависит от Anthropic feature-flags | Да (`isFileHistoryEnabled` + `"external" === 'ant'`) | Нет |
| Поддержка parentUuid chain | Через `preservedSegment` metadata | `relinkChain` + orphan cleanup |
| Auto-fork перед операцией | Нет | Да (через `autoFork: true` по умолчанию) |

Наш строго мощнее: указываешь **диапазон** а не одну точку, работает на любом сообщении, не требует включения file history, доступен программно через MCP.

## Если хотим AI-генерацию summary в apply_edit

Можно добавить опциональный параметр `autoSummarize: true` (или сделать `compactText` опциональным). Когда не передан текст — вызываем Anthropic API напрямую с готовыми промптами:
- `BASE_COMPACT_PROMPT` из `services/compact/prompt.ts:61-143` — для полного диапазона
- `PARTIAL_COMPACT_PROMPT` (`prompt.ts:145-204`) — если нужна direction-aware формулировка

Парсим `<summary>` через ту же логику что `formatCompactSummary` — strip `<analysis>`, replace `<summary>` на `Summary:\n`, trim whitespace.

Через наш Provider Proxy (`fact-provider-proxy.md`) — модель и параметры определяются tab-routing'ом, prompt-caching работает.

Объём: ~40 строк в `mcp__overseer__apply_edit`. Не зависит от Claude Code CLI вообще — собственная реализация той же логики.

## Версионная справка

- Leaked source: `@anthropic-ai/claude-code` v2.1.88 (2026-03-31, через `.map` файл)
- Юзер запускает: v2.1.143 (2026-05, та же ветка)
- v2.1.32 — момент когда `summarize_up_to` шипился публично (issue #28716), позже скрыт за `"external" === 'ant'`
- Поведение `partialCompactConversation` стабильно с v2.1.x

## Файлы для grep

```bash
# Всё про компакт
grep -rn "compactConversation\|partialCompactConversation\|compact_boundary" packages/claude-code-src/

# Промпты
cat packages/claude-code-src/services/compact/prompt.ts | head -270

# Пороги
grep -n "AUTOCOMPACT_BUFFER\|MAX_OUTPUT_TOKENS_FOR_SUMMARY\|MAX_CONSECUTIVE" packages/claude-code-src/services/compact/autoCompact.ts

# UI gates
grep -n 'isFileHistoryEnabled\|"external" === ' packages/claude-code-src/components/MessageSelector.tsx
```
