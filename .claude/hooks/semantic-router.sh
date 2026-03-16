#!/bin/bash
# =============================================================================
# Semantic Router — Phase 2 (UserPromptSubmit Hook)
# Triggers: ???/&&& (route files), ???+/&&&+ (route + previous Claude response as context)
#
# 1. Читает промпт пользователя
# 2. Отправляет его + .semantic-index.json (+ опционально последний ответ Claude) в Haiku через claude -p
# 3. Haiku выбирает 2-5 релевантных файлов
# 4. Имена файлов + инструкция на чтение выводятся в stdout -> инжектятся как контекст для Claude
# =============================================================================

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

# Check trigger: ???/&&&[+[N|full]] anywhere in prompt
if [ -z "$PROMPT" ] || ! echo "$PROMPT" | grep -qE '\?\?\?|&&&'; then
  exit 0
fi

# Detect context mode: +N-full, +full, +N, + (bare=1), or none
CONTEXT_MODE=""
CONTEXT_COUNT="1"
if echo "$PROMPT" | grep -qE '(\?\?\?|&&&)\+([0-9]+-)?full'; then
  CONTEXT_MODE="full"
  CTX_NUM=$(echo "$PROMPT" | grep -oE '(\?\?\?|&&&)\+[0-9]*-\?full' | head -1 | grep -oE '[0-9]+' | head -1)
  if [ -n "$CTX_NUM" ]; then CONTEXT_COUNT="$CTX_NUM"; fi
elif echo "$PROMPT" | grep -qE '(\?\?\?|&&&)\+[0-9]'; then
  CONTEXT_MODE="text"
  CONTEXT_COUNT=$(echo "$PROMPT" | grep -oE '(\?\?\?|&&&)\+[0-9]+' | head -1 | grep -oE '[0-9]+')
elif echo "$PROMPT" | grep -qE '(\?\?\?|&&&)\+'; then
  CONTEXT_MODE="text"
fi

# Strip all trigger variants from prompt
CLEAN_PROMPT=$(echo "$PROMPT" | sed -E 's/[[:space:]]*((\?\?\?|&&&)\+?(([0-9]+-)?full|[0-9]+)?)[[:space:]]*/ /g' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
INDEX_FILE="$PROJECT_DIR/.semantic-index.json"

# Extract context from JSONL based on mode
LAST_RESPONSE=""
if [ -n "$CONTEXT_MODE" ]; then
  JSONL_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$JSONL_PATH" ] && [ -f "$JSONL_PATH" ]; then
    if [ "$CONTEXT_MODE" = "full" ]; then
      # Full detail: last N turns with thinking + edits + commands (skip file reads)
      LAST_RESPONSE=$(tail -500 "$JSONL_PATH" | jq -rs --argjson n "$CONTEXT_COUNT" '
        [to_entries[] | select(.value.type == "user" and .value.message and (.value.message.content | type) == "string") | .key] as $b
        | ($b | length) as $bl
        | (if $bl >= $n then $b[$bl - $n] else 0 end) as $start
        | [.[$start:][] | select(.message) |
          if .type == "user" and (.message.content | type) == "string" then
            "Human: " + (.message.content | tostring | .[0:500])
          elif .type == "assistant" and (.message.content | type) == "array" and (.message.content | length) > 0 then
            (if .message.content[0].type == "text" then
              "Assistant: " + (.message.content[0].text | .[0:1000])
            elif .message.content[0].type == "thinking" then
              "Thinking: " + (.message.content[0].thinking | .[0:300]) + "..."
            elif .message.content[0].type == "tool_use" then
              (if .message.content[0].name == "Edit" then
                "✏️ Edit: " + (.message.content[0].input.file_path // "?")
              elif .message.content[0].name == "Write" then
                "✏️ Write: " + (.message.content[0].input.file_path // "?")
              elif .message.content[0].name == "Bash" then
                "🖥 Cmd: " + ((.message.content[0].input.command // "?") | .[0:200])
              else empty end)
            else empty end)
          else empty end
        ] | join("\n")
      ' 2>/dev/null | head -c 8000)
    else
      # Text-only: last N assistant text blocks (chronological order)
      COUNT="$CONTEXT_COUNT"
      LAST_RESPONSE=$(tail -500 "$JSONL_PATH" | tail -r | {
        found=0
        result=""
        while IFS= read -r line; do
          TXT=$(echo "$line" | jq -r 'select(.type == "assistant") | .message.content[0] | select(.type == "text") | .text' 2>/dev/null)
          if [ -n "$TXT" ] && [ "$TXT" != "null" ]; then
            if [ -n "$result" ]; then
              result="${TXT}
---
${result}"
            else
              result="$TXT"
            fi
            found=$((found + 1))
            if [ "$found" -ge "$COUNT" ]; then
              break
            fi
          fi
        done
        echo "$result"
      } | head -c 6000)
    fi
  fi
fi

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

SYSTEM_PROMPT='You are a Semantic Router for Noted Terminal (Electron + React 19 + xterm.js + Claude/Gemini AI).
Task: select ALL files from the index that are ACTUALLY needed to solve the developer request. No limit on count — if the request touches 10 topics, return 10 files.

ARCHITECTURE (remember for routing):
- Main process (main.js) ↔ Renderer (React) via IPC
- PTY (node-pty) + xterm.js Canvas renderer
- Zustand store → SQLite persistence (debounced)
- Claude CLI sessions stored in JSONL, linked via bridges
- Two paste mechanisms: Tier 1 (user Ctrl+V, no sync markers) and Tier 2 (programmatic safePasteAndSubmit, with sync markers)

SELECTION ALGORITHM (execute mentally before answering):

STEP 0 — TRANSLATE the user request to English.
The user may write in any language. Mentally translate the request to English first, then work with English tags and symptoms in the index.

STEP 1 — Identify the SYMPTOM:
What exactly is broken? UI not updating? Data empty? Process crashing? Button missing?

STEP 2 — Think about ROOT CAUSE, not keywords:
CRITICAL: Do NOT grab a file by word overlap! Think about the CAUSE.
- "restart button disappeared after creating tab" — NOT about restart or tabs. It is about useEffect dependency change → IPC listener re-subscription → event drop window. Look for fact-terminal-core.md (IPC trap) and fact-react-patterns.md (useEffect).
- "copying from Timeline returns empty" — NOT about Timeline UI. It is about stale closure → findIndex returns -1 → empty result, OR Zustand silent mutation → stale sessionId. Look for fact-react-patterns.md (stale closure) and fix-zustand-silent-mutation.md.
- "paste hangs for 30 seconds" — NOT about UI freeze. It is about wrong paste path routing: user paste hit programmatic path (safePasteAndSubmit), which waits for sync markers that shell never sends → 5s timeout × N chunks. Look for fact-terminal-core.md (Two-Tier Paste).

STEP 3 — Check the "symptoms" field in each index entry:
CRITICAL: Every index entry has a "symptoms" array with natural-language descriptions of WHEN that file is needed.
Compare the translated user request against ALL symptoms across ALL files.
This is the PRIMARY matching mechanism — more reliable than implicit tags.

STEP 4 — Check 8 cross-domain bridge categories:
a) Zustand silent mutation — anything "not updating", "stale", "disappears after" → fix-zustand-silent-mutation.md
b) Sync marker timing — paste/Enter/command "not working", "hangs", "lost" → fix-stale-sync-markers.md
c) Paste path routing — paste "breaks text", "hangs", "duplicates" → fact-terminal-core.md (Two-Tier)
d) CSS visibility chain — terminal "shows garbage", "duplicates UI", "not redrawn" after switch → fact-terminal-rendering.md + fact-terminal-core.md (safeFit)
e) JSONL chain resolution — Timeline/export "wrong", "skips", "missing" → ai-backtrace-jsonl.md + fix-claude-plan-mode-chain.md
f) React useEffect + IPC — indicator/button "disappears", "flickers" after tab create/close → fact-terminal-core.md (IPC listener trap)
g) Vite escaping — escape sequences "broken" after build → environment-fixes.md
h) Layout depth — component "works in one place but not another" → fact-css-layout.md + fact-rendering-styles.md

STEP 5 — Scan implicit tags:
Go through ALL index entries. Compare implicit tags with symptom and root cause.
Do NOT limit yourself to files whose NAME contains a keyword from the request.

RULES:
- All docs are in docs/knowledge/ (flat structure: fix-* and fact-*). No hierarchy.
- Select as many files as needed to cover ALL aspects of the request. No artificial limit.
- For bugs — MUST include at least one knowledge/ file with root cause (fix-*, fact-*).
- For features — include knowledge/ files with traps and workarounds related to that area.

Respond ONLY with a valid JSON array of paths. No markdown, no explanations, no reasoning.
Example: ["docs/knowledge/fact-terminal-core.md", "docs/knowledge/fix-zustand-silent-mutation.md", "docs/knowledge/fact-css-layout.md"]'

if [ -n "$CONTEXT_MODE" ] && [ -n "$LAST_RESPONSE" ]; then
  CTX_DESC="$CONTEXT_COUNT"; if [ "$CONTEXT_MODE" = "full" ]; then CTX_DESC="${CONTEXT_COUNT}-full"; fi
  USER_MSG=$(printf 'User request: %s\n\nPrevious Claude context (%s):\n%s\n\nAvailable index:\n%s' "$CLEAN_PROMPT" "$CTX_DESC" "$LAST_RESPONSE" "$INDEX_COMPACT")
else
  USER_MSG=$(printf 'User request: %s\n\nAvailable index:\n%s' "$CLEAN_PROMPT" "$INDEX_COMPACT")
fi

# Call Haiku via claude -p
# env -u CLAUDECODE — обязательно, иначе "nested session" error
TEXT=$(echo "$USER_MSG" | env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p \
  --model haiku \
  --system-prompt "$SYSTEM_PROMPT" \
  --no-session-persistence \
  2>/dev/null) || true

ROUTER_LOG="/tmp/semantic-router.log"

if [ -z "$TEXT" ]; then
  echo "[$(date '+%H:%M:%S')] FAIL: empty response from Haiku" >> "$ROUTER_LOG"
  exit 0
fi

# Extract file list from Haiku response
FILE_LIST=$(echo "$TEXT" | jq -r '.[]' 2>/dev/null)

if [ -z "$FILE_LIST" ]; then
  # Haiku might have wrapped in markdown — extract paths
  FILE_LIST=$(echo "$TEXT" | grep -oE '"[^"]+\.(md|tsx?|ts)"' | tr -d '"' 2>/dev/null)
fi

if [ -z "$FILE_LIST" ]; then
  echo "[$(date '+%H:%M:%S')] FAIL: could not parse files from Haiku response" >> "$ROUTER_LOG"
  exit 0
fi

# Log selected files
FILE_NAMES=$(echo "$FILE_LIST" | xargs -I{} basename {} | tr '\n' ', ' | sed 's/,$//')

CTX_LABEL=""
if [ "$CONTEXT_MODE" = "full" ]; then CTX_LABEL=" [+${CONTEXT_COUNT}-full]"
elif [ -n "$CONTEXT_MODE" ]; then CTX_LABEL=" [+${CONTEXT_COUNT}]"
fi
echo "[$(date '+%H:%M:%S')]${CTX_LABEL} Selected: $FILE_NAMES" >> "$ROUTER_LOG"
echo "[$(date '+%H:%M:%S')]${CTX_LABEL} Prompt: $(echo "$CLEAN_PROMPT" | head -c 80)..." >> "$ROUTER_LOG"

# stdout: инструкция для Claude (приходит как <system-reminder>)
echo "BLOCKING INSTRUCTION — you MUST complete these steps before responding to the user:"
echo ""
echo "1. Use the Read tool to read EACH of these files (all of them, in parallel):"
while IFS= read -r rel_path; do
  echo "   - $PROJECT_DIR/$rel_path"
done <<< "$FILE_LIST"
echo ""
echo "2. Use the knowledge from these files to answer the user's question."
echo "3. Do NOT tell the user you are reading files. Just read them silently and answer."
echo ""
echo "These files were selected by a semantic search AI (Haiku) as the most relevant docs for this task."
echo "Skipping them will result in an incorrect or incomplete answer."
