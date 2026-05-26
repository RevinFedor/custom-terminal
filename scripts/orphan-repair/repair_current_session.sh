#!/usr/bin/env bash
# Repair orphan parentUuids in the CURRENT live session 7e5a86dd.
#
# IMPORTANT: The Claude CLI process keeps the JSONL open via file descriptor.
# An atomic rename creates a new inode, so the running CLI would keep
# appending to the OLD (orphan-tainted) inode and our repair would be lost.
#
# Therefore:
#   1) You MUST close the Claude tab in Noted Terminal first (kill the CLI)
#      OR `/exit` inside the Claude TUI.
#   2) Confirm no claude process owns this file.
#   3) Then run this script.
#   4) Reopen the tab — Noted Terminal will `claude --resume 7e5a86dd...`
#      against the repaired transcript.
#
# Usage:
#   bash scripts/orphan-repair/repair_current_session.sh           # dry-run
#   bash scripts/orphan-repair/repair_current_session.sh --apply   # actually fix
set -euo pipefail

SESSION_ID="7e5a86dd-ea51-451e-afc6-e7c2237576ee"
JSONL="/Users/fedor/.claude/projects/-Users-fedor-Desktop-custom-terminal/${SESSION_ID}.jsonl"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${SCRIPT_DIR}/repair_orphans.py"

APPLY_FLAG=""
if [[ "${1:-}" == "--apply" ]]; then
  APPLY_FLAG="--apply"
fi

if [[ ! -f "$JSONL" ]]; then
  echo "❌ File not found: $JSONL"
  exit 1
fi

# Check no claude CLI process is holding the file open.
HOLDERS=$(lsof -- "$JSONL" 2>/dev/null | awk 'NR>1 {print $1, $2}')
if [[ -n "$HOLDERS" ]]; then
  echo "⚠️  WARNING: the following processes currently have this file open:"
  echo "$HOLDERS" | sed 's/^/    /'
  echo
  echo "Close the Claude tab (or /exit inside the TUI) FIRST."
  echo "Otherwise the running CLI will keep writing to the old inode and your repair will be lost."
  if [[ "$APPLY_FLAG" == "--apply" ]]; then
    echo
    echo "Refusing to --apply while file is in use. Aborting."
    exit 2
  fi
  echo "(dry-run will continue read-only)"
  echo
fi

echo "Repair target: $JSONL"
echo "Mode: ${APPLY_FLAG:-(dry-run)}"
echo

python3 "$PY" $APPLY_FLAG "$JSONL"

if [[ "$APPLY_FLAG" == "--apply" ]]; then
  echo
  echo "✔ Done. Now reopen the tab in Noted Terminal — it will resume the repaired session."
fi
