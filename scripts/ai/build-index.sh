#!/bin/bash
# =============================================================================
# Semantic Indexer — Phase 1 (Parallel)
# Сканирует docs/ (и опционально src/), отправляет каждый файл в Haiku 4.5
# через `claude -p`, получает "семантический паспорт" и складывает в .semantic-index.json
#
# Запуск: bash scripts/ai/build-index.sh
# Опции: --with-src    — также индексировать src/ (компоненты и сторы)
#         --parallel N  — количество параллельных запросов (по умолчанию 10)
#
# CLAUDE.md переименовывается автоматически (mv → .bak) и восстанавливается при выходе
#
# =============================================================================

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INDEX_FILE="$PROJECT_DIR/.semantic-index.json"
LOG_FILE="$PROJECT_DIR/scripts/ai/indexer.log"
RESULTS_DIR=$(mktemp -d /tmp/indexer-results-XXXXXXXX)

MAX_PARALLEL=10

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Парсим аргументы
WITH_SRC=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-src) WITH_SRC=true; shift ;;
    --parallel) MAX_PARALLEL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "=== Indexer started: $(date) ===" > "$LOG_FILE"

log() {
  echo "$@" >> "$LOG_FILE"
}

if ! command -v claude &>/dev/null; then
  echo -e "${RED}ERROR: claude CLI not found${NC}"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo -e "${RED}ERROR: jq required. brew install jq${NC}"
  exit 1
fi

# Автоматическое переименование CLAUDE.md (чтобы claude -p не грузил проектный контекст)
CLAUDE_MD_MOVED=false
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  if [ -f "$PROJECT_DIR/CLAUDE.md.bak" ]; then
    echo -e "${YELLOW}WARNING: CLAUDE.md.bak уже существует — пропускаю mv${NC}"
    echo -e "${YELLOW}Удали CLAUDE.md.bak вручную и перезапусти${NC}"
    exit 1
  fi
  mv "$PROJECT_DIR/CLAUDE.md" "$PROJECT_DIR/CLAUDE.md.bak"
  CLAUDE_MD_MOVED=true
  echo -e "${GREEN}CLAUDE.md → CLAUDE.md.bak (будет восстановлен в конце)${NC}"
fi

# Гарантируем восстановление CLAUDE.md и очистку tmp при любом выходе
cleanup() {
  if [ "$CLAUDE_MD_MOVED" = true ] && [ -f "$PROJECT_DIR/CLAUDE.md.bak" ]; then
    mv "$PROJECT_DIR/CLAUDE.md.bak" "$PROJECT_DIR/CLAUDE.md"
    echo -e "\n${GREEN}CLAUDE.md.bak → CLAUDE.md (восстановлен)${NC}"
  fi
  rm -rf "$RESULTS_DIR" 2>/dev/null
}
trap cleanup EXIT

SYSTEM_PROMPT='Ты — Semantic Indexer для проекта Noted Terminal (Electron + React 19 + xterm.js + Claude/Gemini AI).
Твоя задача — создать семантический JSON-паспорт файла для поисковой системы.

АРХИТЕКТУРА ПРОЕКТА:
- features/ — бизнес-логика, UI/UX флоу (tabs, timeline, settings, claude-sessions)
- knowledge/ — шрамы: баги платформ, обходные решения, структурные костыли
- Electron Main (main.js) ↔ Renderer (React) через IPC
- PTY терминалы (node-pty + xterm.js), AI интеграция (Claude CLI + Gemini)
- Zustand стейт, SQLite персистенция, JSONL сессии Claude

КРИТИЧНЫЕ ПРАВИЛА ДЛЯ implicit ТЕГОВ:

1. КОНКРЕТНЫЕ ИМЕНА, НЕ АБСТРАКЦИИ:
   ПЛОХО: "State Machine Detection", "Race Condition Handling"
   ХОРОШО: "handshake_prompt_injection", "safePasteAndSubmit_chunking", "rewind_visual_search_rgb"

2. НАЗВАНИЯ ПОДСИСТЕМ — если файл описывает несколько механизмов, каждый должен быть отдельным тегом:
   Пример: большой файл содержит 5 подсистем → каждая как отдельный тег: "handshake_auto_prompt", "fork_session_copy", "compact_gap_recovery", "rewind_paste_insert", "silence_detection"

3. СИМПТОМЫ — баги и проблемы, которые приведут пользователя к этому файлу:
   Пример: файл про sync markers → теги: "terminal_freeze_after_paste", "enter_not_working_after_rewind", "model_switch_kills_claude"
   Пример: файл про Zustand → теги: "ui_not_updating_after_state_change", "timeline_stale_data", "tab_name_reset_after_restart"

4. КРОСС-ДОМЕННЫЕ МОСТЫ — 8 категорий неявных связей:
   a) Zustand silent mutation → UI не обновляется (любой файл с reactivity на store)
   b) Sync marker validity → safePasteAndSubmit, model switch, Handshake, Rewind (15ms filter)
   c) Paste path routing → user paste (Tier 1) vs programmatic paste (Tier 2) — разные механизмы
   d) CSS visibility → Canvas stale → fit() no-op → SIGWINCH → Ink TUI corruption
   e) JSONL chain resolution → bridges → compact gaps → fork contamination
   f) React useEffect + IPC listener → event drop window при re-subscription
   g) Vite dollar-sign escaping → escape sequences в main.js ломаются при сборке
   h) Layout depth sensitivity → одинаковый компонент ведет себя по-разному в разной DOM глубине

   Если файл КАСАЕТСЯ любой из этих категорий (даже косвенно) — добавь соответствующий тег.

5. ВОПРОСЫ-ТРИГГЕРЫ — представь, какой вопрос задаст разработчик, которому нужен ИМЕННО этот файл:
   Пример: fix-stale-sync-markers.md → "почему Enter не срабатывает", "paste зависает на 30 секунд", "шрифт загрузился поздно и строки переносятся неправильно"
   Добавь 2-3 таких триггера как implicit теги в формате вопроса.

Ответь СТРОГО JSON (без markdown, без комментариев, без обратных кавычек):
{"path": "...", "type": "feature|knowledge|architecture|code", "explicit": ["тема1", "тема2"], "implicit": ["конкретный_тег_1", "конкретный_тег_2", "...минимум 8 тегов..."], "related_components": ["src/path/file.tsx"]}'

# Экспортируем для дочерних процессов
export SYSTEM_PROMPT LOG_FILE RESULTS_DIR

echo -e "${BLUE}Scanning project: $PROJECT_DIR${NC}"

FILES=()

while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(find "$PROJECT_DIR/docs" -name '*.md' -not -path '*/tmp/*' -not -path '*/dev-journal/*' -print0 2>/dev/null)

if [ "$WITH_SRC" = true ]; then
  echo -e "${YELLOW}Including src/ components and stores...${NC}"
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$PROJECT_DIR/src" \( -path '*/components/*.tsx' -o -path '*/store/*.ts' -o -path '*/hooks/*.ts' \) -print0 2>/dev/null)
fi

TOTAL=${#FILES[@]}
echo -e "${GREEN}Found $TOTAL files to index${NC}"
echo -e "${YELLOW}Parallel: $MAX_PARALLEL workers${NC}"
echo ""

if [ "$TOTAL" -eq 0 ]; then
  echo -e "${RED}No files found. Check project structure.${NC}"
  exit 1
fi

# ===== Функция обработки одного файла (запускается как background job) =====
process_file() {
  local FILE="$1"
  local IDX="$2"
  local REL_PATH="${FILE#$PROJECT_DIR/}"
  local RESULT_FILE="$RESULTS_DIR/$IDX.json"
  local FILE_START=$(date +%s)

  # Читаем содержимое
  local CONTENT=""
  CONTENT=$(cat "$FILE" 2>/dev/null) || true
  if [ -z "$CONTENT" ]; then
    echo "SKIP" > "$RESULT_FILE"
    return
  fi

  # Пишем промпт во временный файл
  local TMPFILE=$(mktemp /tmp/indexer-XXXXXXXX)
  printf 'Файл: %s\n\nСодержимое:\n%s' "$REL_PATH" "$CONTENT" > "$TMPFILE"

  # Вызываем claude -p
  local TEXT=""
  TEXT=$(claude -p \
    --model haiku \
    --system-prompt "$SYSTEM_PROMPT" \
    --no-session-persistence \
    < "$TMPFILE" \
    2>> "$LOG_FILE") || true

  rm -f "$TMPFILE"

  if [ -z "$TEXT" ]; then
    echo "ERROR" > "$RESULT_FILE"
    log "ERROR (empty response): $REL_PATH"
    return
  fi

  log "RESPONSE for $REL_PATH: $(echo "$TEXT" | head -c 200)"

  # Парсим JSON (4 стратегии)
  local PARSED=""

  # Шаг 1: чистый JSON
  PARSED=$(echo "$TEXT" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true

  # Шаг 2: markdown fence
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    local CLEANED=$(echo "$TEXT" | sed -n '/^```/,/^```/p' | sed '/^```/d')
    PARSED=$(echo "$CLEANED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  # Шаг 3: { на начале строки
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    local EXTRACTED=$(echo "$TEXT" | sed -n '/^{/,/^}/p' | head -20)
    PARSED=$(echo "$EXTRACTED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  # Шаг 4: { где угодно
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    local EXTRACTED=$(echo "$TEXT" | grep -o '{.*}' | head -1)
    PARSED=$(echo "$EXTRACTED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  local FILE_END=$(date +%s)
  local FILE_ELAPSED=$((FILE_END - FILE_START))

  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    PARSED=$(jq -n --arg path "$REL_PATH" --arg raw "$TEXT" \
      '{path: $path, type: "unknown", explicit: [], implicit: [], related_components: [], raw_response: $raw}') || true
    echo "WARN:${FILE_ELAPSED}s" > "$RESULT_FILE.status"
  else
    echo "OK:${FILE_ELAPSED}s" > "$RESULT_FILE.status"
  fi

  echo "$PARSED" > "$RESULT_FILE"
}

# ===== Параллельный запуск =====
START_TIME=$(date +%s)
RUNNING=0

for i in "${!FILES[@]}"; do
  FILE="${FILES[$i]}"
  REL_PATH="${FILE#$PROJECT_DIR/}"

  # Запускаем в фоне
  process_file "$FILE" "$i" &
  RUNNING=$((RUNNING + 1))

  echo -e "${BLUE}[launched $((i+1))/$TOTAL]${NC} $REL_PATH"

  # Ждём, если достигли лимита параллельности
  if [ "$RUNNING" -ge "$MAX_PARALLEL" ]; then
    wait -n 2>/dev/null || true
    RUNNING=$((RUNNING - 1))
  fi
done

# Ждём оставшиеся
echo ""
echo -e "${YELLOW}Waiting for remaining workers...${NC}"
wait

# ===== Сборка результатов =====
echo -e "${BLUE}Merging results...${NC}"

ERRORS=0
INDEXED=0
SKIPPED=0
WARNINGS=0

RESULTS="["
FIRST=true

for i in "${!FILES[@]}"; do
  RESULT_FILE="$RESULTS_DIR/$i.json"
  STATUS_FILE="$RESULTS_DIR/$i.json.status"
  REL_PATH="${FILES[$i]#$PROJECT_DIR/}"

  if [ ! -f "$RESULT_FILE" ]; then
    echo -e "  ${RED}missing${NC} $REL_PATH"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  CONTENT=$(cat "$RESULT_FILE")

  if [ "$CONTENT" = "SKIP" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ "$CONTENT" = "ERROR" ]; then
    echo -e "  ${RED}error${NC} $REL_PATH"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Читаем статус
  STATUS=""
  if [ -f "$STATUS_FILE" ]; then
    STATUS=$(cat "$STATUS_FILE")
  fi
  TIME_STR=$(echo "$STATUS" | cut -d: -f2)

  if echo "$STATUS" | grep -q "^WARN"; then
    echo -e "  ${YELLOW}wrapped${NC} $REL_PATH [${TIME_STR}]"
    WARNINGS=$((WARNINGS + 1))
  else
    echo -e "  ${GREEN}ok${NC} $REL_PATH [${TIME_STR}]"
  fi

  # Добавляем в JSON массив
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    RESULTS="${RESULTS},"
  fi
  RESULTS="${RESULTS}${CONTENT}"
  INDEXED=$((INDEXED + 1))
done

RESULTS="${RESULTS}]"

# Записываем и форматируем
echo "$RESULTS" | jq '.' > "$INDEX_FILE" 2>/dev/null

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Index built: $INDEX_FILE${NC}"
echo -e "${GREEN}Files indexed: $INDEXED/$TOTAL (skip: $SKIPPED, warn: $WARNINGS, err: $ERRORS)${NC}"
echo -e "${GREEN}Time: ${ELAPSED}s (parallel: $MAX_PARALLEL)${NC}"
echo -e "${GREEN}========================================${NC}"
