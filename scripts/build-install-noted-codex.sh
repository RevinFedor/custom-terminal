#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
codex_root="$repo_root/packages/codex"
rust_root="$codex_root/codex-rs"
patch_file="$repo_root/patches/codex-noted-side-channel-0.147.0.patch"
install_dir="$HOME/.noted-terminal/bin"
installed_bin="$install_dir/codex"
marker_file="$install_dir/codex.noted-build"
host_resolver="$repo_root/scripts/noted-codex-host-resolve.mjs"
installed_host="$install_dir/codex-code-mode-host"

# Since Codex 0.147 the CLI resolves `codex-code-mode-host` as a sibling of the
# running executable. Our patched `codex` lives in a bare bin dir, so without an
# adjacent host every Code Mode tool call fails closed with
# "failed to spawn code-mode host ...: host executable was not found".
#
# The host cannot be built here: codex-code-mode-runtime depends on the `v8`
# crate and no prebuilt V8 archive is published for aarch64-apple-darwin. The
# only supported source is the official npm vendor payload, and it must match
# our CLI version because the host speaks a versioned framed protocol.
install_code_mode_host() {
  local codex_version="$1"
  local resolved source_host temporary_host
  if [[ ! -f "$host_resolver" ]]; then
    echo "[noted-codex] missing host resolver: $host_resolver" >&2
    return 1
  fi
  if ! resolved="$(node "$host_resolver" --expect-version "$codex_version" --print-path)"; then
    echo "[noted-codex] cannot locate codex-code-mode-host $codex_version." >&2
    echo "[noted-codex] install the matching CLI, e.g.: npm install -g @openai/codex@$codex_version" >&2
    return 1
  fi
  source_host="$resolved"
  if [[ ! -x "$source_host" ]]; then
    echo "[noted-codex] resolved host is not executable: $source_host" >&2
    return 1
  fi
  temporary_host="$install_dir/codex-code-mode-host.tmp.$$"
  install -m 0755 "$source_host" "$temporary_host"
  mv "$temporary_host" "$installed_host"
  echo "[noted-codex] installed host: $installed_host (from $source_host)"
}

if [[ ! -d "$codex_root/.git" ]]; then
  echo "[noted-codex] missing source checkout: $codex_root" >&2
  exit 1
fi
if [[ ! -f "$rust_root/tui/src/noted_side_channel.rs" ]]; then
  if [[ ! -f "$patch_file" ]]; then
    echo "[noted-codex] missing side-channel patch: $patch_file" >&2
    exit 1
  fi
  if ! git -C "$codex_root" apply --check "$patch_file"; then
    echo "[noted-codex] patch does not apply cleanly; checkout rust-v0.147.0 first" >&2
    exit 1
  fi
  git -C "$codex_root" apply "$patch_file"
fi

source_commit="$(git -C "$codex_root" rev-parse HEAD)"
source_hash="$({
  printf '%s\n' "$source_commit"
  shasum -a 256 \
    "$rust_root/tui/src/noted_side_channel.rs" \
    "$rust_root/tui/src/noted_side_channel_tests.rs" \
    "$rust_root/tui/src/chatwidget/protocol.rs" \
    "$rust_root/tui/src/lib.rs"
} | shasum -a 256 | awk '{print $1}')"

codex_version_of() {
  "$1" --version 2>/dev/null | awk '{print $NF}'
}

if [[ -x "$installed_bin" && -f "$marker_file" \
  && "$(tr -d '\r\n' < "$marker_file")" == "$source_hash" ]]; then
  echo "[noted-codex] current: $installed_bin ($("$installed_bin" --version))"
  # The companion host is a separate artifact with its own lifecycle: it can be
  # missing (older install), stale, or removed while `codex` itself is current.
  # Re-verify it on every run instead of trusting the codex-only marker.
  mkdir -p "$install_dir"
  install_code_mode_host "$(codex_version_of "$installed_bin")"
  exit 0
fi

mkdir -p "$install_dir"
lock_backup="$(mktemp -t noted-codex-lock.XXXXXX)"
cp "$rust_root/Cargo.lock" "$lock_backup"
restore_lock() {
  cp "$lock_backup" "$rust_root/Cargo.lock"
  rm -f "$lock_backup"
}
trap restore_lock EXIT

echo "[noted-codex] building patched Codex from $source_commit"
(
  cd "$rust_root"
  PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH" \
    cargo build --release -p codex-cli --bin codex
)

temporary_bin="$install_dir/codex.tmp.$$"
install -m 0755 "$rust_root/target/release/codex" "$temporary_bin"

# Install the companion host BEFORE publishing the new codex and its marker.
# A patched codex without an adjacent host is a broken install: Code Mode fails
# closed on every tool call. Failing here leaves the previous (working) codex in
# place instead of publishing a half-installed pair.
if ! install_code_mode_host "$(codex_version_of "$temporary_bin")"; then
  rm -f "$temporary_bin"
  exit 1
fi

mv "$temporary_bin" "$installed_bin"
temporary_marker="$marker_file.tmp.$$"
printf '%s\n' "$source_hash" > "$temporary_marker"
chmod 0600 "$temporary_marker"
mv "$temporary_marker" "$marker_file"
echo "[noted-codex] installed: $installed_bin ($("$installed_bin" --version))"
