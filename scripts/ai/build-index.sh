#!/bin/bash
# =============================================================================
# Semantic Indexer — Phase 1
# Сканирует docs/ (и опционально src/), отправляет каждый файл в Haiku 4.5
# через `claude -p`, получает "семантический паспорт" и складывает в .semantic-index.json
#
# Запуск: bash scripts/ai/build-index.sh
# Опции: --with-src  — также индексировать src/ (только компоненты и сторы)
#
# CLAUDE.md переименовывается автоматически (mv → .bak) и восстанавливается при выходе
# =============================================================================

# НЕ используем set -e — обрабатываем ошибки вручную
set -u

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INDEX_FILE="$PROJECT_DIR/.semantic-index.json"
LOG_FILE="$PROJECT_DIR/scripts/ai/indexer.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Очищаем лог
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

# Гарантируем восстановление CLAUDE.md при любом выходе (Ctrl+C, ошибка, успех)
cleanup() {
  if [ "$CLAUDE_MD_MOVED" = true ] && [ -f "$PROJECT_DIR/CLAUDE.md.bak" ]; then
    mv "$PROJECT_DIR/CLAUDE.md.bak" "$PROJECT_DIR/CLAUDE.md"
    echo -e "\n${GREEN}CLAUDE.md.bak → CLAUDE.md (восстановлен)${NC}"
  fi
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
   Пример: ai-automation.md содержит 9 подсистем → теги: "handshake_auto_prompt", "fork_session_copy", "compact_gap_recovery", "rewind_paste_insert", "silence_detection", "sniper_watcher", "code_stripping_export", "session_tree_hierarchy", "gemini_research_activation"

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

echo -e "${BLUE}Scanning project: $PROJECT_DIR${NC}"

FILES=()

while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(find "$PROJECT_DIR/docs" -name '*.md' -not -path '*/tmp/*' -not -path '*/dev-journal/*' -print0 2>/dev/null)

# НЕ индексируем CLAUDE.md — он уже в контексте Claude Code по умолчанию

if [[ "${1:-}" == "--with-src" ]]; then
  echo -e "${YELLOW}Including src/ components and stores...${NC}"
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$PROJECT_DIR/src" \( -path '*/components/*.tsx' -o -path '*/store/*.ts' -o -path '*/hooks/*.ts' \) -print0 2>/dev/null)
fi

TOTAL=${#FILES[@]}
echo -e "${GREEN}Found $TOTAL files to index${NC}"
echo -e "${YELLOW}Estimated time: ~$((TOTAL * 5)) seconds (~$((TOTAL * 5 / 60)) min)${NC}"
echo ""

if [ "$TOTAL" -eq 0 ]; then
  echo -e "${RED}No files found. Check project structure.${NC}"
  exit 1
fi

RESULTS="[]"
COUNT=0
ERRORS=0
START_TIME=$(date +%s)

for FILE in "${FILES[@]}"; do
  COUNT=$((COUNT + 1))
  REL_PATH="${FILE#$PROJECT_DIR/}"
  FILE_START=$(date +%s)
  echo -ne "${BLUE}[$COUNT/$TOTAL]${NC} $REL_PATH ... "

  # Читаем содержимое файла
  CONTENT=""
  CONTENT=$(cat "$FILE" 2>/dev/null | head -c 8000) || true
  if [ -z "$CONTENT" ]; then
    echo -e "${YELLOW}skip (empty)${NC}"
    log "SKIP (empty): $REL_PATH"
    continue
  fi

  # Пишем промпт во временный файл (избегаем проблем с pipe + subshell)
  TMPFILE=$(mktemp /tmp/indexer-XXXXXXXX)
  printf 'Файл: %s\n\nСодержимое:\n%s' "$REL_PATH" "$CONTENT" > "$TMPFILE"

  # Вызываем claude -p, stderr в лог
  TEXT=""
  TEXT=$(claude -p \
    --model haiku \
    --system-prompt "$SYSTEM_PROMPT" \
    --no-session-persistence \
    < "$TMPFILE" \
    2>> "$LOG_FILE") || true

  rm -f "$TMPFILE"

  if [ -z "$TEXT" ]; then
    echo -e "${RED}error (empty response, see indexer.log)${NC}"
    log "ERROR (empty response): $REL_PATH"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  log "RESPONSE for $REL_PATH: $(echo "$TEXT" | head -c 200)"

  # Пробуем распарсить JSON
  # Шаг 1: чистый JSON?
  PARSED=""
  PARSED=$(echo "$TEXT" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true

  # Шаг 2: Haiku обернул в ```json ... ``` — вырезаем
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    CLEANED=$(echo "$TEXT" | sed -n '/^```/,/^```/p' | sed '/^```/d')
    PARSED=$(echo "$CLEANED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  # Шаг 3: ищем JSON между { и }
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    EXTRACTED=$(echo "$TEXT" | sed -n '/^{/,/^}/p' | head -20)
    PARSED=$(echo "$EXTRACTED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  # Шаг 4: ищем { где угодно в строке
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    EXTRACTED=$(echo "$TEXT" | grep -o '{.*}' | head -1)
    PARSED=$(echo "$EXTRACTED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  FILE_END=$(date +%s)
  FILE_ELAPSED=$((FILE_END - FILE_START))

  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    echo -e "${YELLOW}wrapped (non-JSON) [${FILE_ELAPSED}s]${NC}"
    log "WARN (non-JSON): $REL_PATH"
    PARSED=$(jq -n --arg path "$REL_PATH" --arg raw "$TEXT" \
      '{path: $path, type: "unknown", explicit: [], implicit: [], related_components: [], raw_response: $raw}') || true
  else
    echo -e "${GREEN}ok [${FILE_ELAPSED}s]${NC}"
  fi

  if [ -n "$PARSED" ] && [ "$PARSED" != "null" ]; then
    RESULTS=$(echo "$RESULTS" | jq --argjson item "$PARSED" '. += [$item]') || true
  fi
done

echo "$RESULTS" | jq '.' > "$INDEX_FILE"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Index built: $INDEX_FILE${NC}"
echo -e "${GREEN}Files indexed: $((COUNT - ERRORS))/$TOTAL${NC}"
echo -e "${GREEN}Time: ${ELAPSED}s${NC}"
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${YELLOW}Errors: $ERRORS (see scripts/ai/indexer.log)${NC}"
fi
echo -e "${GREEN}========================================${NC}"
