import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'scripts/build-install-noted-codex.sh'), 'utf8');

test('patched Codex host is cached privately without downgrading global Codex', () => {
  assert.match(source, /cache_prefix="\$install_dir\/vendor\/codex-\$codex_version"/);
  assert.match(source, /cache_root="\$cache_prefix\/node_modules"/);
  assert.match(source, /NOTED_CODEX_VENDOR_ROOT="\$cache_root"[\s\\]*\n\s*node "\$host_resolver"/);
  assert.match(source, /npm install[\s\S]*--prefix "\$cache_prefix"[\s\S]*"@openai\/codex@\$codex_version"/);
  assert.doesNotMatch(source, /npm install -g/);
});

test('explicit vendor override remains fail-closed and version resolution precedes publication', () => {
  const explicitGuard = source.indexOf('if [[ -n "${NOTED_CODEX_VENDOR_ROOT:-}" ]]');
  const privateCache = source.indexOf('cache_prefix="$install_dir/vendor/codex-$codex_version"');
  const copyHost = source.indexOf('install -m 0755 "$source_host" "$temporary_host"');
  assert.ok(explicitGuard >= 0 && explicitGuard < privateCache);
  assert.ok(privateCache >= 0 && privateCache < copyHost);
  assert.match(source, /cached npm payload has no matching code-mode host/);
});
