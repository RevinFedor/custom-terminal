#!/bin/bash
# =============================================================================
# Semantic Indexer — Phase 1 (Parallel)
# Сканирует docs/knowledge/ (fix-* и fact-*), отправляет в Haiku 4.5
# через `claude -p`, получает "семантический паспорт" и складывает в .semantic-index.json
#
# Запуск: bash scripts/ai/build-index.sh
# Опции: -g            — использовать Gemini 3 Flash (результат → clipboard, индекс не меняется)
#         --with-src    — также индексировать src/ (компоненты и сторы)
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
USE_GEMINI=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -g|--gemini) USE_GEMINI=true; shift ;;
    --with-src) WITH_SRC=true; shift ;;
    --parallel) MAX_PARALLEL="$2"; shift 2 ;;
    [0-9]*) MAX_PARALLEL="$1"; shift ;;
    *) shift ;;
  esac
done

if [ "$USE_GEMINI" = true ]; then
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    echo -e "${RED}ERROR: GEMINI_API_KEY not set${NC}"
    echo "export GEMINI_API_KEY=your_key"
    exit 1
  fi
  GEMINI_MODEL="gemini-3-flash-preview"
  echo -e "${YELLOW}Mode: Gemini ($GEMINI_MODEL, thinking=HIGH)${NC}"
  echo -e "${YELLOW}Dry-run: результат → clipboard, индекс не меняется${NC}"
fi

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

SYSTEM_PROMPT='You are a Semantic Indexer for Noted Terminal (Electron + React 19 + xterm.js + Claude/Gemini AI).
Your task: create a semantic JSON passport for a file, used by a search router.

ALL OUTPUT MUST BE IN ENGLISH. Tags, symptoms, questions — everything in English only.

PROJECT ARCHITECTURE:
- All docs in docs/knowledge/ — flat structure, two types:
  - fix-* — scars: bugs, workarounds, structural hacks
  - fact-* — how subsystems work, platform constraints, feature behavior
- Electron Main (main.js) ↔ Renderer (React) via IPC
- PTY terminals (node-pty + xterm.js), AI integration (Claude CLI + Gemini)
- Zustand state, SQLite persistence, JSONL Claude sessions

RULES FOR implicit TAGS:

1. CONCRETE NAMES, NOT ABSTRACTIONS:
   BAD: "State Machine Detection", "Race Condition Handling"
   GOOD: "handshake_prompt_injection", "safePasteAndSubmit_chunking", "rewind_visual_search_rgb"

2. SUBSYSTEM NAMES — if the file describes multiple mechanisms, each gets its own tag:
   Example: file has 5 subsystems → 5 tags: "handshake_auto_prompt", "fork_session_copy", "compact_gap_recovery", "rewind_paste_insert", "silence_detection"

3. CROSS-DOMAIN BRIDGES — 8 categories of hidden connections:
   a) Zustand silent mutation → UI not updating (any file with store reactivity)
   b) Sync marker validity → safePasteAndSubmit, model switch, Handshake, Rewind (15ms filter)
   c) Paste path routing → user paste (Tier 1) vs programmatic paste (Tier 2)
   d) CSS visibility → Canvas stale → fit() no-op → SIGWINCH → Ink TUI corruption
   e) JSONL chain resolution → bridges → compact gaps → fork contamination
   f) React useEffect + IPC listener → event drop window on re-subscription
   g) Vite dollar-sign escaping → escape sequences in main.js break after build
   h) Layout depth sensitivity → same component behaves differently at different DOM depth

   If the file TOUCHES any of these categories (even indirectly) — add the corresponding tag.

RULES FOR symptoms ARRAY (NEW — CRITICAL):

The "symptoms" field is the MOST IMPORTANT field for search quality.
Write 3-5 SHORT ENGLISH SENTENCES describing WHEN a developer needs this file.
Focus on OBSERVABLE SYMPTOMS, not implementation details.

Example for a file about Zustand silent mutation:
  "symptoms": [
    "UI shows stale data after store update",
    "Timeline displays wrong session after tab switch",
    "Component does not re-render after state change in Zustand"
  ]

Example for a file about React patterns with portals:
  "symptoms": [
    "Copied range from Timeline returns empty data",
    "Button in portal resets immediately after click",
    "Click handler uses outdated state from previous render",
    "Menu or tooltip is clipped or positioned incorrectly"
  ]

Respond with STRICT JSON (no markdown, no comments, no backticks):
{"path": "...", "type": "fix|fact", "explicit": ["topic1", "topic2"], "implicit": ["concrete_tag_1", "concrete_tag_2", "...minimum 8 tags..."], "symptoms": ["When X happens and Y is visible", "If Z returns empty after W"], "related_components": ["src/path/file.tsx"]}'

# Директория для token-счётчиков (Gemini)
TOKENS_DIR=$(mktemp -d /tmp/indexer-tokens-XXXXXXXX)

# Экспортируем для дочерних процессов
export SYSTEM_PROMPT LOG_FILE RESULTS_DIR USE_GEMINI TOKENS_DIR
export GEMINI_API_KEY GEMINI_MODEL 2>/dev/null || true

echo -e "${BLUE}Scanning project: $PROJECT_DIR${NC}"

FILES=()

while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(find "$PROJECT_DIR/docs/knowledge" -name '*.md' -print0 2>/dev/null)

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

  local TEXT=""

  if [ "$USE_GEMINI" = true ]; then
    # ---- Gemini 3 Flash API ----
    local USER_MSG
    USER_MSG=$(printf 'Файл: %s\n\nСодержимое:\n%s' "$REL_PATH" "$CONTENT")

    local REQFILE=$(mktemp /tmp/indexer-req-XXXXXXXX)
    jq -n \
      --arg system "$SYSTEM_PROMPT" \
      --arg user "$USER_MSG" \
      '{
        contents: [{ role: "user", parts: [{ text: $user }] }],
        systemInstruction: { parts: [{ text: $system }] },
        generationConfig: {
          thinkingConfig: { thinkingLevel: "HIGH" },
          responseMimeType: "application/json"
        }
      }' > "$REQFILE"

    local RAW=""
    RAW=$(curl -s -X POST \
      -H "Content-Type: application/json" \
      "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}" \
      -d "@$REQFILE" 2>> "$LOG_FILE") || true

    rm -f "$REQFILE"

    # Сохраняем token usage в файл (суммируем в конце)
    echo "$RAW" | jq -r '[
      .usageMetadata.promptTokenCount // 0,
      .usageMetadata.candidatesTokenCount // 0,
      .usageMetadata.totalTokenCount // 0,
      .usageMetadata.thoughtsTokenCount // 0
    ] | @tsv' > "$TOKENS_DIR/$IDX.tsv" 2>/dev/null

    # Извлекаем текст из response (пропускаем thinking parts)
    TEXT=$(echo "$RAW" | jq -r '
      [.candidates[0].content.parts[] | select(.text and (has("thought") | not)) | .text] | join("")
    ' 2>/dev/null) || true

    # Если text пустой, пробуем без фильтра thought
    if [ -z "$TEXT" ] || [ "$TEXT" = "null" ]; then
      TEXT=$(echo "$RAW" | jq -r '.candidates[0].content.parts[-1].text // empty' 2>/dev/null) || true
    fi

    # Логируем ошибки API
    if [ -z "$TEXT" ] || [ "$TEXT" = "null" ]; then
      local API_ERROR=$(echo "$RAW" | jq -r '.error.message // empty' 2>/dev/null)
      if [ -n "$API_ERROR" ]; then
        log "GEMINI ERROR for $REL_PATH: $API_ERROR"
      else
        log "GEMINI ERROR (no text) for $REL_PATH: $(echo "$RAW" | head -c 300)"
      fi
      echo "ERROR" > "$RESULT_FILE"
      return
    fi
  else
    # ---- Haiku via claude -p ----
    local TMPFILE=$(mktemp /tmp/indexer-XXXXXXXX)
    printf 'Файл: %s\n\nСодержимое:\n%s' "$REL_PATH" "$CONTENT" > "$TMPFILE"

    TEXT=$(claude -p \
      --model haiku \
      --system-prompt "$SYSTEM_PROMPT" \
      --no-session-persistence \
      < "$TMPFILE" \
      2>> "$LOG_FILE") || true

    rm -f "$TMPFILE"
  fi

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
  while [ "$(jobs -rp | wc -l)" -ge "$MAX_PARALLEL" ]; do
    sleep 0.5
  done
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
if [ "$USE_GEMINI" = true ]; then
  echo "$RESULTS" | jq '.' 2>/dev/null | pbcopy
  echo -e "${GREEN}Result copied to clipboard (pbcopy)${NC}"
  echo "$RESULTS" | jq '.' > "$PROJECT_DIR/scripts/ai/gemini-index-preview.json" 2>/dev/null
  echo -e "${GREEN}Preview saved: scripts/ai/gemini-index-preview.json${NC}"
else
  echo "$RESULTS" | jq '.' > "$INDEX_FILE" 2>/dev/null
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo -e "${GREEN}========================================${NC}"
if [ "$USE_GEMINI" = true ]; then
  echo -e "${GREEN}Gemini dry-run complete (index NOT modified)${NC}"
else
  echo -e "${GREEN}Index built: $INDEX_FILE${NC}"
fi
echo -e "${GREEN}Files indexed: $INDEXED/$TOTAL (skip: $SKIPPED, warn: $WARNINGS, err: $ERRORS)${NC}"
echo -e "${GREEN}Time: ${ELAPSED}s (parallel: $MAX_PARALLEL)${NC}"

# Суммируем токены Gemini и считаем стоимость
if [ "$USE_GEMINI" = true ] && ls "$TOKENS_DIR"/*.tsv &>/dev/null; then
  TOTAL_PROMPT=0
  TOTAL_OUTPUT=0
  TOTAL_THINK=0

  for f in "$TOKENS_DIR"/*.tsv; do
    read -r p o a t < "$f" 2>/dev/null || continue
    TOTAL_PROMPT=$((TOTAL_PROMPT + ${p:-0}))
    TOTAL_OUTPUT=$((TOTAL_OUTPUT + ${o:-0}))
    TOTAL_THINK=$((TOTAL_THINK + ${t:-0}))
  done

  # Gemini Flash pricing: input $0.15/1M, output $0.60/1M, thinking $3.50/1M
  COST=$(awk "BEGIN {
    inp = ${TOTAL_PROMPT} * 0.15 / 1000000;
    out = ${TOTAL_OUTPUT} * 0.60 / 1000000;
    thn = ${TOTAL_THINK} * 3.50 / 1000000;
    printf \"%.4f\", inp + out + thn
  }")
  COST_INPUT=$(awk "BEGIN { printf \"%.3f\", ${TOTAL_PROMPT} * 0.15 / 1000000 }")
  COST_OUTPUT=$(awk "BEGIN { printf \"%.3f\", ${TOTAL_OUTPUT} * 0.60 / 1000000 }")
  COST_THINK=$(awk "BEGIN { printf \"%.3f\", ${TOTAL_THINK} * 3.50 / 1000000 }")

  echo -e "${YELLOW}── Gemini Token Usage & Cost ──${NC}"
  echo -e "${YELLOW}  Input:    $(printf '%7d' $TOTAL_PROMPT) tok  \$${COST_INPUT}${NC}"
  echo -e "${YELLOW}  Output:   $(printf '%7d' $TOTAL_OUTPUT) tok  \$${COST_OUTPUT}${NC}"
  echo -e "${YELLOW}  Thinking: $(printf '%7d' $TOTAL_THINK) tok  \$${COST_THINK}${NC}"
  echo -e "${YELLOW}  ─────────────────────────${NC}"
  echo -e "${YELLOW}  TOTAL COST: \$${COST}${NC}"
fi

echo -e "${GREEN}========================================${NC}"

# Cleanup token dir
rm -rf "$TOKENS_DIR" 2>/dev/null
