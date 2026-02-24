#!/bin/bash
# =============================================================================
# Semantic Router — Phase 2 (UserPromptSubmit Hook)
# Триггер: промпт заканчивается на "???"
#
# 1. Читает промпт пользователя
# 2. Отправляет его + .semantic-index.json в Haiku 4.5 через claude -p
# 3. Haiku выбирает 2-4 релевантных файла
# 4. Содержимое файлов выводится в stdout -> инжектится как контекст для Claude
# =============================================================================

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

# Check trigger: prompt ends with ???
if [ -z "$PROMPT" ] || ! echo "$PROMPT" | grep -qE '\?\?\?[[:space:]]*$'; then
  exit 0
fi

# Strip trigger
CLEAN_PROMPT=$(echo "$PROMPT" | sed 's/[[:space:]]*???[[:space:]]*$//')

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
INDEX_FILE="$PROJECT_DIR/.semantic-index.json"

# Silent exits if prerequisites missing
if ! command -v claude &>/dev/null; then
  exit 0
fi

if [ ! -f "$INDEX_FILE" ]; then
  echo "[semantic-router] WARN: .semantic-index.json not found. Run: bash scripts/ai/build-index.sh"
  exit 0
fi

if ! command -v jq &>/dev/null; then
  exit 0
fi

# Load index compact
INDEX_COMPACT=$(jq -c '.' "$INDEX_FILE" 2>/dev/null)
if [ -z "$INDEX_COMPACT" ]; then
  exit 0
fi

SYSTEM_PROMPT='Ты — Semantic Router для Senior-разработчика. Твоя цель — выбрать из index.json ровно те файлы, которые нужны AI-агенту (Claude) для выполнения задачи пользователя.

ПРАВИЛА ВЫБОРА (Gold Standard v6.0):
1. Если задача касается изменения логики UI — обязательно найди релевантный файл из features/.
2. КРИТИЧНО: Обязательно проверь по неявным связям (implicit), нет ли в knowledge/ файла с описанием багов или хаков, связанных с этой задачей (например, если задача про цвета — ищи файлы про рендеринг/WebGL; если про клики/фокус — ищи баги фокуса ОС).
3. Если есть исходный код в индексе — выбери 1-2 наиболее релевантных файла src/.
4. Выбирай МИНИМУМ файлов (2-4). Лучше пропустить неважное, чем завалить контекст.
5. НЕ добавляй architecture.md или main-feature.md — они уже читаются по умолчанию.

Ответь ТОЛЬКО валидным JSON-массивом путей, без markdown, без пояснений.
Пример: ["docs/features/tabs.md", "docs/knowledge/fix-macos-titlebar.md"]'

USER_MSG=$(printf 'Запрос пользователя: %s\n\nДоступный индекс:\n%s' "$CLEAN_PROMPT" "$INDEX_COMPACT")

# Call Haiku via claude -p
# env -u CLAUDECODE — обязательно, иначе "nested session" error
TEXT=$(echo "$USER_MSG" | env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p \
  --model haiku \
  --system-prompt "$SYSTEM_PROMPT" \
  --no-session-persistence \
  2>/dev/null) || true

if [ -z "$TEXT" ]; then
  exit 0
fi

# Extract file list from Haiku response
FILE_LIST=$(echo "$TEXT" | jq -r '.[]' 2>/dev/null)

if [ -z "$FILE_LIST" ]; then
  # Haiku might have wrapped in markdown — extract paths
  FILE_LIST=$(echo "$TEXT" | grep -oE '"[^"]+\.(md|tsx?|ts)"' | tr -d '"' 2>/dev/null)
fi

if [ -z "$FILE_LIST" ]; then
  exit 0
fi

# Log selected files (visible to user as first line of hook output)
FILE_NAMES=$(echo "$FILE_LIST" | xargs -I{} basename {} | tr '\n' ', ' | sed 's/,$//')
echo "[Semantic Router] Haiku selected: $FILE_NAMES"
echo ""

# Inject file contents
echo "<semantic_context>"
echo "These files were pre-selected by Haiku 4.5 as most relevant to the user's task."
echo "Read them carefully. DO NOT re-read these files with the Read tool."
echo ""

INJECTED=0
while IFS= read -r rel_path; do
  FULL_PATH="$PROJECT_DIR/$rel_path"
  if [ -f "$FULL_PATH" ]; then
    echo "--- FILE: $rel_path ---"
    cat "$FULL_PATH"
    echo ""
    echo "--- END: $rel_path ---"
    echo ""
    INJECTED=$((INJECTED + 1))
  fi
done <<< "$FILE_LIST"

if [ "$INJECTED" -gt 0 ]; then
  echo "Total files injected: $INJECTED"
  echo "Now proceed with the user task. DO NOT re-read these files with Read tool."
fi
echo "</semantic_context>"
