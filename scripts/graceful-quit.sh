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
REQUIRE_GRACEFUL="${2:-}"
WAIT_ONLY="${3:-}"
TARGET_PID="${4:-}"
APP_NAME="Noted Terminal"
QUIT_FALLBACK="none"

is_running() {
  if [ -n "${TARGET_PID}" ]; then
    case "${TARGET_PID}" in *[!0-9]*|'') return 1 ;; esac
    # A detached MCP hub may retain the same executable path. Wait only for
    # the exact Main PID captured by the API, without touching its children.
    if kill -0 "${TARGET_PID}" 2>/dev/null; then return 0; fi
    # EPERM is not absence. A fresh process lookup distinguishes it from the
    # expected ESRCH after exit; an unavailable lookup remains running/unknown.
    local target_lookup target_status
    target_lookup="$(ps -p "${TARGET_PID}" -o pid= 2>/dev/null)"
    target_status=$?
    if [ "${target_status}" -eq 1 ] && [ -z "${target_lookup}" ]; then return 1; fi
    return 0
  fi
  pgrep -f "/Applications/${APP_NAME}.app" > /dev/null 2>&1
}

if ! is_running; then
  exit 0
fi

if [ "${WAIT_ONLY}" = "--wait-only" ]; then
  echo "[graceful-quit] waiting for captured Main pid=${TARGET_PID} (deadline ${DEADLINE}s)…"
else
  echo "[graceful-quit] requesting graceful quit of '${APP_NAME}' (deadline ${DEADLINE}s)…"
fi

# Snapshot report identities BEFORE asking Cocoa to quit. `find -newer` cannot
# be used here: macOS may touch the mtime/ctime of an old `.ips` while indexing
# DiagnosticReports (observed: the 19.08 incident acquired an mtime from 22.08),
# which made every healthy shutdown look like the same old crash. A real new
# incident always gets a new timestamped filename, so compare identities that
# existed before and after this exact quit attempt.
CRASH_DIR="${HOME}/Library/Logs/DiagnosticReports"
CRASH_BASELINE="$(mktemp -t noted-crash-baseline)"
if [ -d "${CRASH_DIR}" ]; then
  find "${CRASH_DIR}" -maxdepth 1 -type f -name "${APP_NAME}-*.ips" -print 2>/dev/null \
    | sort > "${CRASH_BASELINE}"
fi

# AppleScript 'quit' triggers Cocoa applicationShouldTerminate, which Electron
# maps to app.quit() → our before-quit handler (with event.preventDefault()
# + graceful Ctrl+C fan-out → app.quit() again to actually exit).
if [ "${WAIT_ONLY}" != "--wait-only" ]; then
  osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
fi

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
    if [ "${REQUIRE_GRACEFUL}" = "--require-graceful" ]; then
      echo "[graceful-quit] graceful exit is not confirmed; build:i-c stopped without killing the app"
      rm -f "${CRASH_BASELINE}"
      exit 1
    fi
    echo "[graceful-quit] app did NOT exit in ${DEADLINE}s — falling back to pkill (JSONL of unfinished turns may be lost)"
    QUIT_FALLBACK="SIGTERM"
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
  QUIT_FALLBACK="SIGKILL"
  pkill -9 -f "/Applications/${APP_NAME}.app" 2>/dev/null || true
fi

# Приложение больше не запущено — но КАК оно закончилось? Штатный выход и
# аварийное завершение выглядят отсюда одинаково, а разница принципиальная:
# при падении уборка обрывается на середине, и установка продолжается поверх
# недозакрытого состояния, ничего об этом не сказав.
#
# Пять таких падений 18–19.08 прошли незамеченными именно потому, что этот
# скрипт печатал «done» в обоих случаях. Молчание тут — это не отсутствие
# проблемы, это отсутствие проверки.
#
# Отчёт macOS появляется с задержкой, поэтому даём ему пару секунд.
CRASHED=""
if [ -d "${CRASH_DIR}" ]; then
  for _ in 1 2 3 4 5 6; do
    while IFS= read -r report; do
      if ! grep -Fqx -- "${report}" "${CRASH_BASELINE}"; then
        CRASHED="${report}"
        break
      fi
    done < <(find "${CRASH_DIR}" -maxdepth 1 -type f -name "${APP_NAME}-*.ips" -print 2>/dev/null)
    [ -n "${CRASHED}" ] && break
    sleep 0.5
  done
fi
rm -f "${CRASH_BASELINE}" 2>/dev/null || true

if [ -n "${CRASHED}" ]; then
  echo "[graceful-quit] ВНИМАНИЕ: приложение не вышло штатно, а аварийно завершилось."
  echo "[graceful-quit] отчёт: ${CRASHED}"
  if [ "${REQUIRE_GRACEFUL}" = "--require-graceful" ]; then
    echo "[graceful-quit] build:i-c stopped: graceful shutdown proof unavailable"
    exit 1
  fi
  echo "[graceful-quit] уборка при закрытии оборвана на середине; установка продолжается."
elif [ "${QUIT_FALLBACK}" != "none" ]; then
  echo "[graceful-quit] применён fallback ${QUIT_FALLBACK}; штатный выход не подтверждён"
else
  echo "[graceful-quit] приложение вышло штатно"
fi

echo "[graceful-quit] done"
exit 0
