'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Test-only startup guard. Missing CLI isolation must stop the test before
// account initialization or a native picker can change the user's defaults.
function assertE2ECliIsolation(env = process.env, fileSystem = fs) {
  if (env.NOTED_E2E_TEST !== 'true') return null;
  const root = env.NOTED_E2E_CLI_ISOLATION_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error('e2e_cli_isolation_root_required');
  const realRoot = fileSystem.realpathSync(root);
  const realHome = fileSystem.realpathSync(os.homedir());
  if (realRoot === path.parse(realRoot).root || ['tmp', 'private'].includes(path.basename(realRoot))
    || realRoot === realHome || inside(realRoot, realHome)) {
    throw new Error('e2e_cli_isolation_root_too_broad');
  }
  const resolved = {};
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NOTED_USER_DATA_DIR', 'NOTED_DISCOVERY_DIR']) {
    const value = env[key];
    if (!value || !path.isAbsolute(value)) throw new Error('e2e_cli_isolation_missing:' + key);
    const actual = fileSystem.realpathSync(value);
    if (!inside(realRoot, actual)) throw new Error('e2e_cli_isolation_escape:' + key);
    if (!fileSystem.statSync(actual).isDirectory()) throw new Error('e2e_cli_isolation_not_directory:' + key);
    resolved[key] = actual;
  }
  if (new Set(Object.values(resolved)).size !== Object.keys(resolved).length) throw new Error('e2e_cli_isolation_shared_directory');
  for (const [key, files] of [['CODEX_HOME', ['config.toml', 'auth.json']], ['CLAUDE_CONFIG_DIR', ['settings.json', '.credentials.json']]]) {
    for (const file of files) {
      const target = path.join(resolved[key], file);
      if (fileSystem.existsSync(target) && !inside(resolved[key], fileSystem.realpathSync(target))) {
        throw new Error('e2e_cli_isolation_file_escape:' + key + '/' + file);
      }
    }
  }
  return { root: realRoot, ...resolved };
}

module.exports = { assertE2ECliIsolation };
