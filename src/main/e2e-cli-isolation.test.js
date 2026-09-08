const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertE2ECliIsolation } = require('./e2e-cli-isolation');

test('production does not gain a test-only restriction', () => {
  assert.equal(assertE2ECliIsolation({}), null);
});

test('E2E rejects omitted CLI home and a symlink escape; accepts only four owned directories', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-e2e-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { NOTED_E2E_TEST: 'true', NOTED_E2E_CLI_ISOLATION_ROOT: root };
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NOTED_USER_DATA_DIR', 'NOTED_DISCOVERY_DIR']) {
    env[key] = path.join(root, key);
    fs.mkdirSync(env[key]);
  }
  assert.ok(assertE2ECliIsolation(env));
  assert.throws(() => assertE2ECliIsolation({ ...env, CODEX_HOME: undefined }), /missing:CODEX_HOME/);
  assert.throws(() => assertE2ECliIsolation({ NOTED_E2E_TEST: 'true' }), /root_required/);
  const link = path.join(root, 'escape');
  fs.symlinkSync(os.tmpdir(), link);
  assert.throws(() => assertE2ECliIsolation({ ...env, CODEX_HOME: link }), /escape:CODEX_HOME/);
  assert.throws(() => assertE2ECliIsolation({ ...env, CODEX_HOME: env.CLAUDE_CONFIG_DIR }), /shared_directory/);
  const otherConfig = path.join(root, 'other-config');
  fs.writeFileSync(otherConfig, 'model="never-touch"');
  fs.symlinkSync(otherConfig, path.join(env.CODEX_HOME, 'config.toml'));
  assert.throws(() => assertE2ECliIsolation(env), /file_escape:CODEX_HOME/);
});
