#!/usr/bin/env bash

# Fast local-only signature for iterative Electron builds.
# electron-builder's regular signer walks hundreds of data files and contacts
# Apple's timestamp service for each one. A single local codesign invocation
# gives TCC a stable identity without notarization, network access, or hardened
# runtime. This is intentionally not the production-distribution signing path.

set -euo pipefail

APP_PATH="${1:-}"
EXPECTED_IDENTIFIER="${2:-}"
IDENTITY="${LOCAL_CODESIGN_IDENTITY:-Noted Terminal Dev}"

if [[ -z "$APP_PATH" || -z "$EXPECTED_IDENTIFIER" ]]; then
  echo "[codesign:local-fast] usage: $0 <app-path> <bundle-identifier>" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[codesign:local-fast] macOS is required" >&2
  exit 2
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "[codesign:local-fast] app not found: $APP_PATH" >&2
  exit 2
fi

if ! /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -F "\"$IDENTITY\"" >/dev/null; then
  echo "[codesign:local-fast] signing identity not found: $IDENTITY" >&2
  echo "[codesign:local-fast] run scripts/codesign/setup-dev-cert.sh once" >&2
  exit 1
fi

started_at=$SECONDS
echo "[codesign:local-fast] signing $APP_PATH with $IDENTITY (local, no timestamp server)"
/usr/bin/codesign --deep --force --timestamp=none --sign "$IDENTITY" "$APP_PATH"
/usr/bin/codesign --verify --deep --strict "$APP_PATH"

signature_info="$(/usr/bin/codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
actual_identifier="$(printf '%s\n' "$signature_info" | /usr/bin/awk -F= '/^Identifier=/{print $2; exit}')"
actual_authority="$(printf '%s\n' "$signature_info" | /usr/bin/awk -F= '/^Authority=/{print $2; exit}')"

if [[ "$actual_identifier" != "$EXPECTED_IDENTIFIER" ]]; then
  echo "[codesign:local-fast] identifier mismatch: expected $EXPECTED_IDENTIFIER, got ${actual_identifier:-missing}" >&2
  exit 1
fi

if [[ "$actual_authority" != "$IDENTITY" ]]; then
  echo "[codesign:local-fast] authority mismatch: expected $IDENTITY, got ${actual_authority:-missing}" >&2
  exit 1
fi

echo "[codesign:local-fast] verified identifier=$actual_identifier authority=$actual_authority elapsed=$((SECONDS - started_at))s"
