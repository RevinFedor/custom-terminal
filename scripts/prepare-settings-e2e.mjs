#!/usr/bin/env node
// Creates disposable test fixtures only. Never starts/kills an application,
// changes a global config, or restores an old backup over live settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertE2ECliIsolation } = require('../src/main/e2e-cli-isolation');
const exec = promisify(execFile);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lease = await fs.realpath(process.argv[2] || '');
if (!path.basename(lease).startsWith('noted-settings-final-')) throw new Error('expected a dedicated mktemp lease');
if ((await fs.readdir(lease)).length) throw new Error('lease must be empty; never overwrite another run');
const source = path.join(lease, 'source');
const env = {
  NODE_ENV: 'development', NOTED_E2E_TEST: 'true', NOTED_E2E_WINDOWED: '1',
  NOTED_E2E_USE_BUILT_RENDERER: 'true', NOTED_E2E_CLI_ISOLATION_ROOT: lease,
  NOTED_E2E_FILE_LOG: '1',
  NOTED_CDP_PORT: '9340', NOTED_WEB_PORT: '7997',
  NOTED_USER_DATA_DIR: path.join(lease, 'user-data'),
  NOTED_DISCOVERY_DIR: path.join(lease, 'discovery'),
  CODEX_HOME: path.join(lease, 'codex-home'),
  CLAUDE_CONFIG_DIR: path.join(lease, 'claude-home'),
};
await fs.mkdir(source, { mode: 0o700 });
for (const key of ['NOTED_USER_DATA_DIR', 'NOTED_DISCOVERY_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) await fs.mkdir(env[key], { mode: 0o700 });
const globalConfig = path.join(os.homedir(), '.codex', 'config.toml');
const globalBytes = await fs.readFile(globalConfig);
const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: project, maxBuffer: 8 * 1024 * 1024 });
const hashes = {};
for (const name of new Set(stdout.split('\0').filter(Boolean))) {
  if (/(^|\/)(node_modules|release|dist|target|logs|\.git|tmp)(\/|$)/.test(name)
    || name.startsWith('packages/codex/') || /(^|\/)\.env(?:\.|$)|\.(?:db|sqlite|log)(?:$|-)/.test(name)) continue;
  const from = path.join(project, name);
  const stat = await fs.lstat(from).catch(() => null);
  if (!stat?.isFile()) continue;
  const bytes = await fs.readFile(from);
  hashes[name] = digest(bytes);
  const to = path.join(source, name);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, bytes, { mode: stat.mode & 0o777, flag: 'wx' });
}
await fs.symlink(path.join(project, 'node_modules'), path.join(source, 'node_modules'));
// Vite's two repo-local source packages must be frozen too, not HMR symlinks.
await fs.cp(path.resolve(project, '../noted-shared'), path.join(lease, 'noted-shared'), {
  recursive: true,
  filter: p => !/(^|\/)(node_modules|\.git|target|logs)(\/|$)/.test(p),
});
await fs.symlink(path.resolve(project, '../noted-shared/node_modules'), path.join(lease, 'noted-shared/node_modules'));
await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n', { mode: 0o600, flag: 'wx' });
// Auth is reused locally for the same provider/account, never logged. Do not
// copy sessions, config, account profile directories or MCP server settings.
for (const file of ['auth.json', 'models_cache.json']) {
  const bytes = await fs.readFile(path.join(os.homedir(), '.codex', file)).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (bytes) await fs.writeFile(path.join(env.CODEX_HOME, file), bytes, { mode: 0o600, flag: 'wx' });
}
assertE2ECliIsolation(env);
const after = await fs.readFile(globalConfig);
if (digest(after) !== digest(globalBytes)) throw new Error('global config changed during setup; do not guess a rollback');
const manifest = { source, lease, cutoff: new Date().toISOString(), env, hashes,
  globalConfig, globalConfigHash: digest(globalBytes), provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' };
await fs.writeFile(path.join(lease, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ ready: true, lease, source, files: Object.keys(hashes).length, globalConfigHash: manifest.globalConfigHash, env }));
