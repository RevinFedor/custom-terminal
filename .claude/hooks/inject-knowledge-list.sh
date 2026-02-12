#!/bin/bash
# Hook: UserPromptSubmit
# Извлекает ВСЕ ссылки на knowledge/ из CLAUDE.md и docs/architecture.md
# и вклеивает их как обязательный список для чтения
# По умолчанию НЕ инжектит. Инжектит только если промпт начинается с "q " (quality mode)

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
if [ -z "$PROMPT" ] || ! echo "$PROMPT" | grep -qi '^q '; then
  exit 0
fi

CLAUDE_FILE="CLAUDE.md"
ARCH_FILE="docs/architecture.md"

FILES=""

for f in "$CLAUDE_FILE" "$ARCH_FILE"; do
  if [ -f "$f" ]; then
    FOUND=$(grep -oE '(docs/)?knowledge/[a-zA-Z0-9_.-]+\.md' "$f")
    FILES="$FILES"$'\n'"$FOUND"
  fi
done

# Нормализуем пути (всё к формату docs/knowledge/...)
FILES=$(echo "$FILES" | sed 's|^knowledge/|docs/knowledge/|' | sort -u | grep -v '^$')

if [ -n "$FILES" ]; then
  echo "[MANDATORY] Before answering, issue read_file for EACH file below."
  echo "Do NOT skip any. Do NOT assume you already know their contents."
  echo ""
  echo "$FILES" | while IFS= read -r f; do
    echo "  - $f"
  done
  echo ""
  echo "Then find the relevant feature file(s) for the user's request and read ALL knowledge/ files mentioned in them too."
fi
