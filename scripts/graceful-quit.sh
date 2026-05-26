#!/usr/bin/env bash
# Gracefully quit Noted Terminal so the before-quit handler runs to completion
# (Ctrl+C to every live Claude, JSONL flush, DB marks). Falls back to pkill
# after a deadline if the app refuses to exit on its own.
#
# Used by build:install — replaces the previous unconditional `pkill -f` which
# sent SIGTERM directly, bypassing Ink and corrupting JSONL transcripts.
#
# Usage: scripts/graceful-quit.sh [deadline_seconds=5]

set -u

DEADLINE="${1:-5}"
APP_NAME="Noted Terminal"

is_running() {
  pgrep -f "/Applications/${APP_NAME}.app" > /dev/null 2>&1
}

if ! is_running; then
  exit 0
fi

echo "[graceful-quit] requesting graceful quit of '${APP_NAME}' (deadline ${DEADLINE}s)…"

# AppleScript 'quit' triggers Cocoa applicationShouldTerminate, which Electron
# maps to app.quit() → our before-quit handler (with event.preventDefault()
# + graceful Ctrl+C fan-out → app.quit() again to actually exit).
osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true

# Poll until process disappears or deadline passes.
SECS=0
while is_running; do
  if [ "${SECS}" -ge "${DEADLINE}" ]; then
    echo "[graceful-quit] app did NOT exit in ${DEADLINE}s — falling back to pkill (JSONL of unfinished turns may be lost)"
    pkill -f "/Applications/${APP_NAME}.app" 2>/dev/null || true
    sleep 0.5
    break
  fi
  sleep 0.25
  SECS=$((SECS + 1))
done

# Final cleanup wait so the OS releases /Applications/Noted Terminal.app
# (electron-builder rm -rf would otherwise race with a still-running process).
for _ in 1 2 3 4 5 6 7 8; do
  if ! is_running; then break; fi
  sleep 0.25
done

if is_running; then
  echo "[graceful-quit] WARNING: app still running after deadline+SIGTERM; forcing SIGKILL"
  pkill -9 -f "/Applications/${APP_NAME}.app" 2>/dev/null || true
fi

echo "[graceful-quit] done"
exit 0
