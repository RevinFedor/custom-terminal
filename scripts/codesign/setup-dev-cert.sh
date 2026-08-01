#!/bin/bash
# One-time setup of a self-signed code-signing certificate so that
# `npm run sign:local-fast` produces a signature whose designated requirement
# is tied to `com.noted.terminal` and this certificate — STABLE across rebuilds.
#
# Why this exists: an adhoc signature (`codesign -s -`) pins the designated
# requirement to the binary's CDHash, which changes on every rebuild. macOS
# TCC stores the csreq blob alongside each grant, so when the CDHash changes,
# the stored grant no longer matches and `isTrustedAccessibilityClient(false)`
# returns false even when the System Settings toggle is ON. A self-signed
# cert in the login keychain gives us a stable identifier-based DR, so the
# grant persists across `npm run build:install` runs.
#
# Run once. After this script completes:
#   1. Open Keychain Access → Login → find "Noted Terminal Dev"
#   2. Double-click → expand "Trust" → set Code Signing = Always Trust
#   3. Close, authenticate with your login password
#   4. Run `npm run sign:local-fast` after packaging (the normal build scripts
#      already do this) — TCC grants will now persist
#
# Reference: docs/knowledge/fact-codesign-tcc.md

set -euo pipefail

CERT_NAME="Noted Terminal Dev"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Check it doesn't already exist (idempotent)
if security find-certificate -c "$CERT_NAME" ~/Library/Keychains/login.keychain-db >/dev/null 2>&1; then
  echo "==> Certificate \"$CERT_NAME\" already exists in login keychain"
  echo "    If you need to re-create it: security delete-certificate -c \"$CERT_NAME\""
  echo "    Then re-run this script."
  exit 0
fi

echo "==> Generating self-signed code-signing cert: $CERT_NAME"

# RSA 2048, 10-year validity, code-signing extensions.
# The Subject CN is what `security find-identity` will display and what
# package.json's mac.identity must match.
openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
  -keyout "$TMP/dev.key" -out "$TMP/dev.crt" \
  -subj "/CN=$CERT_NAME" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" 2>/dev/null

# Convert to PKCS12 for keychain import. -legacy is required on
# OpenSSL 3.x for compatibility with macOS Security framework.
openssl pkcs12 -export -legacy \
  -in "$TMP/dev.crt" -inkey "$TMP/dev.key" \
  -out "$TMP/dev.p12" -password pass:dev123

# Import into login keychain. -T /usr/bin/codesign grants codesign
# access to use the private key without an interactive prompt every time.
security import "$TMP/dev.p12" \
  -k ~/Library/Keychains/login.keychain-db \
  -P dev123 \
  -T /usr/bin/codesign \
  >/dev/null

echo "==> Imported into login keychain"
echo ""
echo "==> Verifying with: security find-identity -v -p codesigning"
security find-identity -v -p codesigning | grep -F "$CERT_NAME" || {
  echo "WARNING: certificate not found by codesigning search. You may need to"
  echo "         trust it manually in Keychain Access (see steps below)."
}
echo ""
echo "================================================================"
echo "  NEXT (MANUAL — required, one time):"
echo "================================================================"
echo "  1. Open Keychain Access (Spotlight: 'Keychain Access')"
echo "  2. Login keychain → find '$CERT_NAME' (certificate)"
echo "  3. Double-click → expand 'Trust' section"
echo "  4. Set 'When using this certificate' = 'Always Trust'"
echo "     OR specifically: 'Code Signing' = 'Always Trust'"
echo "  5. Close window → enter login password to confirm"
echo "================================================================"
echo ""
echo "  After that, run: npm run build:install"
echo "  TCC grants will persist across all future rebuilds."
echo ""
