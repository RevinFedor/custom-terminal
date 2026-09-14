#!/bin/bash
# Claude Code statusLine bridge used by Noted Terminal.

input=$(cat)
JQ_BIN="${JQ_BIN:-$(command -v jq 2>/dev/null)}"

if [ -z "$JQ_BIN" ]; then
  echo "[unknown] 0%"
  exit 0
fi

updated_at=$(date +%s)
payload=$(printf '%s' "$input" | "$JQ_BIN" -c \
  --argjson updated_at "$updated_at" \
  --argjson ppid "$PPID" '
  {
    session_id: (.session_id // ""),
    transcript_path: (.transcript_path // ""),
    model: (.model.display_name // "unknown"),
    cwd: (.workspace.current_dir // ""),
    context_pct: (try (.context_window.used_percentage | tonumber) catch null),
    rate_limits: (
      if (.rate_limits | type) == "object" then
        {
          five_hour: (
            if (.rate_limits.five_hour | type) == "object" then
              {
                used_percentage: .rate_limits.five_hour.used_percentage,
                resets_at: .rate_limits.five_hour.resets_at
              }
            else null end
          ),
          seven_day: (
            if (.rate_limits.seven_day | type) == "object" then
              {
                used_percentage: .rate_limits.seven_day.used_percentage,
                resets_at: .rate_limits.seven_day.resets_at
              }
            else null end
          )
        }
      else null end
    ),
    updated_at: $updated_at,
    ppid: $ppid
  }
') || {
  echo "[unknown] 0%"
  exit 0
}

SESSION_ID=$(printf '%s' "$payload" | "$JQ_BIN" -r '.session_id')
MODEL=$(printf '%s' "$payload" | "$JQ_BIN" -r '.model')
PCT=$(printf '%s' "$payload" | "$JQ_BIN" -r 'if .context_pct == null then 0 else (.context_pct | floor) end')

if [[ -n "$SESSION_ID" && "$SESSION_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  BRIDGE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/bridge"
  mkdir -p "$BRIDGE_DIR"
  chmod 700 "$BRIDGE_DIR"
  BRIDGE_FILE="$BRIDGE_DIR/${SESSION_ID}.json"
  TMP_FILE=$(mktemp "$BRIDGE_DIR/.${SESSION_ID}.XXXXXX")
  if [ -n "$TMP_FILE" ]; then
    chmod 600 "$TMP_FILE"
    printf '%s\n' "$payload" > "$TMP_FILE"
    mv -f "$TMP_FILE" "$BRIDGE_FILE"
  fi
fi

echo "[$MODEL] ${PCT}%"
