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
# NOTE: DEADLINE is REAL SECONDS. The previous loop did `sleep 0.25; SECS+=1`,
# so DEADLINE=5 actually pkilled after 5×0.25 = 1.25s of wall-clock — far below
# the app's own before-quit budget (proxyGracefulShutdown drains active SSE
# connections for up to 15s when a Claude turn is mid-flight). The mismatch
# pkilled the process before before-quit could mark was_interrupted, so on the
# next launch AutoResume saw "No interrupted tabs" and no Continue overlay
# appeared, even though JSONL was intact (forensic: 2026-05-26 16:06 restart).
# Now we sleep a real 0.25s per tick and compare elapsed wall-clock, so the
# default deadline genuinely covers the drain budget.
START_TS=$(date +%s)
while is_running; do
  ELAPSED=$(( $(date +%s) - START_TS ))
  if [ "${ELAPSED}" -ge "${DEADLINE}" ]; then
    echo "[graceful-quit] app did NOT exit in ${DEADLINE}s — falling back to pkill (JSONL of unfinished turns may be lost)"
    pkill -f "/Applications/${APP_NAME}.app" 2>/dev/null || true
    sleep 0.5
    break
  fi
  sleep 0.25
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
