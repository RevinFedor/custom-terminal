import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'scripts/graceful-quit.sh'), 'utf8');

test('crash detection snapshots report identities before requesting quit', () => {
  const baseline = source.indexOf('CRASH_BASELINE="$(mktemp -t noted-crash-baseline)"');
  const quit = source.indexOf('osascript -e');
  assert.ok(baseline >= 0 && baseline < quit);
  assert.match(source, /grep -Fqx -- "\$\{report\}" "\$\{CRASH_BASELINE\}"/);
});

test('touched old reports cannot be mistaken for a new crash', () => {
  assert.doesNotMatch(source, /^\s*find[^\n]*-newer/m);
  assert.doesNotMatch(source, /noted-quit-marker/);
  assert.match(source, /find "\$\{CRASH_DIR\}"[^\n]*-name "\$\{APP_NAME\}-\*\.ips"/);
});
