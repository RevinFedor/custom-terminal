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

SYSTEM_PROMPT='Ты — Semantic Router для Noted Terminal (Electron + React 19 + xterm.js + Claude/Gemini AI).
Задача: по запросу разработчика выбрать 2-5 файлов из индекса, которые РЕАЛЬНО нужны для решения задачи.

АРХИТЕКТУРА (запомни для маршрутизации):
- Main process (main.js) ↔ Renderer (React) через IPC
- PTY (node-pty) + xterm.js Canvas renderer
- Zustand store → SQLite persistence (debounced)
- Claude CLI сессии хранятся в JSONL, связываются через bridges
- Два механизма paste: Tier 1 (user Ctrl+V, без sync markers) и Tier 2 (programmatic safePasteAndSubmit, с sync markers)

АЛГОРИТМ ВЫБОРА (выполни мысленно перед ответом):

ШАГ 1 — Определи СИМПТОМ:
Что именно сломано? UI не обновляется? Данные пустые? Процесс крашится? Кнопка пропала?

ШАГ 2 — Подумай о ROOT CAUSE, а не о ключевых словах:
КРИТИЧНО: Не хватай файл по совпадению слов! Думай о ПРИЧИНЕ.
- "кнопка restart пропала после создания таба" — это НЕ про restart и НЕ про табы. Это про useEffect dependency change → IPC listener re-subscription → event drop window. Ищи terminal-core.md (IPC trap) и ui-ux-stability.md (useEffect).
- "копирование из Timeline возвращает пустое" — это НЕ про Timeline UI. Это про Zustand silent mutation → stale sessionId → wrong JSONL chain loaded. Ищи fix-zustand-silent-mutation.md и ai-automation.md (Backtrace).
- "paste зависает на 30 секунд" — это НЕ про UI freeze. Это про wrong paste path routing: user paste попал в programmatic path (safePasteAndSubmit), который ждет sync markers от bash/zsh, но те их не шлют → 5s timeout × N chunks. Ищи terminal-core.md (Two-Tier Paste).

ШАГ 3 — Проверь 8 категорий кросс-доменных мостов:
a) Zustand silent mutation — если что-то "не обновляется", "стейл", "пропадает после" → fix-zustand-silent-mutation.md
b) Sync marker timing — если paste/Enter/команда "не срабатывает", "зависает", "теряется" → fix-stale-sync-markers.md
c) Paste path routing — если paste "ломает текст", "зависает", "дублирует" → terminal-core.md (Two-Tier)
d) CSS visibility chain — если терминал "показывает мусор", "дублирует UI", "не перерисовывается" после переключения → ui-ux-stability.md + terminal-core.md (safeFit)
e) JSONL chain resolution — если Timeline/export "неправильный", "пропускает", "не показывает" → ai-automation.md (Backtrace) + fix-claude-plan-mode-chain.md
f) React useEffect + IPC — если индикатор/кнопка "пропадает", "моргает" после создания/закрытия таба → terminal-core.md (IPC listener trap)
g) Vite escaping — если escape sequences "не работают" после сборки → environment-fixes.md
h) Layout depth — если компонент "работает в одном месте, но не в другом" → ui-ux-stability.md + rendering-styles.md

ШАГ 4 — Сканируй implicit теги:
Пройдись по ВСЕМ записям индекса. Сравни implicit теги с симптомом и root cause.
Не ограничивайся файлами, в названии которых есть ключевое слово запроса.

ПРАВИЛА:
- НЕ добавляй architecture.md или main-feature.md — они уже в контексте Claude.
- Выбирай 2-5 файлов. Лучше 4 правильных, чем 2 очевидных.
- Если запрос про баг — ОБЯЗАТЕЛЬНО включи хотя бы один knowledge/ файл с root cause.
- Если запрос про фичу — включи feature/ + связанные knowledge/ с ловушками.

Ответь ТОЛЬКО валидным JSON-массивом путей. Без markdown, без пояснений, без рассуждений.
Пример: ["docs/features/tabs.md", "docs/knowledge/terminal-core.md", "docs/knowledge/fix-zustand-silent-mutation.md"]'

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
