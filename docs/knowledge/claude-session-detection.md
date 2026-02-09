# Claude Session Detection: Research & Findings (2026-02-09)

## Проблема
Как связать PID запущенного Claude Code CLI с конкретным `.jsonl` session файлом **ретроактивно** (когда момент старта пропущен)?

## Текущее решение: Sniper Watcher
`startSessionSniper()` — dual-method (fs.watch + polling 1с) ловит session ID **в момент создания** `.jsonl` файла. Работает для 99% кейсов. Detect кнопка в InfoPanel — fallback, использует lsof + mtime.

## Что НЕ работает (проверено тестами)

| Метод | Почему не работает |
|-------|-------------------|
| `lsof -p PID \| grep .jsonl` | Claude открывает файл на append и **сразу закрывает** — нет постоянного FD |
| `sessions-index.json` | Не всегда существует (зависит от версии Claude) |
| `mtime -5min` fallback | Idle сессия >5 мин — файл не найдётся |
| `~/.claude/session-env/` | 289 папок, **все пустые** (0 files). Бесполезно |
| `CLAUDE_SESSION_ID` env var | Не реализовано — feature request #17188 открыт |
| Lock-файл `{session}.lock` | Не реализовано — feature request #19364 открыт |
| Парсинг первой строки .jsonl | Ненадёжно (см. ниже) |

## Парсинг .jsonl — детальный анализ

### Идея
Каждый `type: "user"` entry содержит `sessionId` и `cwd`. Можно сопоставить CWD процесса с CWD в файле.

### Тестирование (863 файла)
- **222 (25%)** — filename == entry.sessionId (корректно)
- **196 (23%)** — filename != entry.sessionId (session chain: fork/clear context создают новый файл, но первая строка ссылается на старый sessionId)
- **223 (26%)** — нет sessionId вообще (первая строка = `type: "summary"` после `/compact`)
- **222 (26%)** — пустые/parse error

### Критическая проблема
При нескольких сессиях в одном CWD (частый кейс для `custom-terminal` с 248 .jsonl файлами) — **выбирает неправильную сессию** по mtime. Тест подтвердил: для `--resume af8bd4a8...` алгоритм выбрал `7ff6c081...` (более свежий mtime, но чужая сессия).

## Что РАБОТАЕТ

### `ps -p PID -o args=` → `--resume <uuid>`
Если Claude запущен с `--resume`, session ID **прямо в аргументах процесса**. Но бесполезно для нас: при resume ID уже сохранён в БД.

### Hooks (`SessionStart`)
Claude Code поддерживает hooks в `~/.claude/settings.json`. При старте сессии hook получает JSON на stdin:
```json
{
  "session_id": "...",
  "transcript_path": ".../.jsonl",
  "cwd": "...",
  "source": "startup|resume"
}
```
**Подтверждено тестом.** Но это проактивный метод (ловит при старте) — то же самое что Sniper Watcher.

### `--session-id <uuid>` flag
Можно передать pre-generated UUID при запуске. Claude создаст файл с этим именем. Но мы контролируем запуск через Sniper, поэтому избыточно.

## Fix: Bridge File Filtering (Parallel Session Bug)

### Баг
При параллельных Claude сессиях в одной директории Sniper мог поймать bridge-файл чужой сессии. Сценарий:
1. Сессия A работает в `/custom-terminal/`
2. Запускаем сессию B → Sniper стартует, snapshot фиксирует существующие файлы
3. Сессия A делает Clear Context → Claude создаёт новый `.jsonl` (bridge-файл)
4. Sniper B ловит bridge-файл, думая что это сессия B → **неверный ID**

### Ключевой инсайт
- **Bridge-файл** (от Clear Context): первая строка имеет `entry.sessionId !== filename` (указывает на родительскую сессию)
- **Fresh-файл** (новая сессия): первая строка имеет `entry.sessionId === filename`

### Тестирование (865 файлов)
- 178 (20.6%) — fresh (`sessionId === filename`) → корректно ACCEPT
- 163 (18.8%) — bridge (`sessionId !== filename`) → корректно REJECT
- 244 (28.2%) — нет uuid (не релевантно для Sniper)
- 280 (32.4%) — пустые/parse error

### Решение
В `checkFile()` после проверки времени — читаем первые 2KB файла:
- Если `entry.sessionId !== fileSessionId` → **SKIP** (bridge от другой сессии)
- Если файл пустой/непарсится → **return**, ждём следующий poll
- Если `entry.sessionId === fileSessionId` → **ACCEPT**

Код: `src/main/main.js`, функция `startSessionSniper()` → `checkFile()`.

## Вывод
Claude Code CLI **не предоставляет** механизма для связи PID → Session ID извне. Единственный надёжный путь — перехват в момент старта (Sniper Watcher / Hooks). Ретроактивная детекция idle сессий невозможна без эвристик.

## Потенциальные будущие решения
- Если Anthropic реализует lock-файл (#19364) — читать `{session}.lock`
- Если добавят env var (#17188) — читать через `ps eww` (но только для env на момент запуска)
- Hooks как альтернатива Sniper: прописать один раз в settings.json, hook пишет `.active-session.json` — Detect читает его
