'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const ts = require('typescript');
const { readPackagedAuthProfileConfiguration: read } = require('./codex-auth-profile-target');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n)
  && n.name?.text === 'createConfiguredCodexAuthProfileRoute');
assert.ok(node);
const factory = source.slice(node.getStart(ast), node.end);

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-auth-target-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = fs.realpathSync(base), data = path.join(root, 'data'); fs.mkdirSync(data);
  const env = { NOTED_E2E_TEST: 'true', NOTED_E2E_CLI_ISOLATION_ROOT: data };
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NOTED_USER_DATA_DIR', 'NOTED_DISCOVERY_DIR']) {
    env[key] = path.join(data, key); fs.mkdirSync(env[key]);
  }
  const appPath = path.join(root, 'own-app.asar'); fs.writeFileSync(appPath, 'fixture-image');
  const otherApp = path.join(root, 'other-app.asar'); fs.writeFileSync(otherApp, 'other-fixture-image');
  const fixtureCwd = path.join(data, 'work'); fs.mkdirSync(fixtureCwd);
  const configPath = path.join(data, 'auth-profile.json');
  const config = { version: 1, target: { kind: 'isolated-packaged', appPath },
    homePath: path.join(root, 'existing-auth-source'), accountKey: 'aaaaaaaaaaaaaaaa', fixtureCwd };
  const write = value => fs.writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 }); write(config);
  let credentialReads = 0;
  const context = { process: { env }, path, fs, app: { getAppPath: () => appPath }, isDev: false,
    srcMainDir: __dirname, getMainProcessEnvValue: () => configPath,
    codexDataModule: { _api: { readCodexAuthSession: () => { credentialReads++;
      return { accountKey: config.accountKey, accessToken: 'fixture-token', accountId: 'fixture-account', accessExpiresAtMs: 9e15 }; } } },
    require: name => require(name), terminalCommandState: new Map(), codexLastRunCommandPayload: new Map(),
    terminals: new Map(), terminalProjects: new Map(), getTerminalLifecycleGeneration: () => null };
  const create = extra => vm.runInNewContext(factory + '\ncreateConfiguredCodexAuthProfileRoute()', { ...context, ...extra });
  return { root, data, appPath, otherApp, configPath, config, env, write, create,
    args: () => ({ configPath, appPath, isolation: { root: data } }), reads: () => credentialReads };
}

test('actual packaged Main factory retains isolated CLI homes and reads account only through route', t => {
  const f = fixture(t), before = Object.fromEntries(Object.entries(f.env));
  const route = f.create(); assert.equal(f.reads(), 0);
  assert.equal(route.inspect().configured, true); assert.equal(f.reads(), 1);
  assert.deepEqual(f.env, before); assert.equal(fs.existsSync(path.join(f.env.CODEX_HOME, 'auth.json')), false);
  assert.doesNotMatch(JSON.stringify(route.inspect()), /fixture-token|fixture-account|existing-auth-source/);
});
test('ordinary packaged startup has no alternate auth route', t => {
  const f = fixture(t); assert.equal(f.create({ getMainProcessEnvValue: () => undefined }), null);
  assert.equal(f.reads(), 0);
});
for (const [name, change] of [
  ['missing E2E flag', f => { delete f.env.NOTED_E2E_TEST; }],
  ['missing isolated home', f => { delete f.env.CODEX_HOME; }],
  ['shared home', f => { f.env.CODEX_HOME = f.root; }],
  ['missing explicit target', f => { const c = { ...f.config }; delete c.target; f.write(c); }],
  ['wrong target kind', f => f.write({ ...f.config, target: { ...f.config.target, kind: 'ordinary' } })],
  ['wrong version', f => f.write({ ...f.config, version: 2 })],
  ['another app', f => f.write({ ...f.config, target: { kind: 'isolated-packaged', appPath: f.otherApp } })],
  ['foreign fixture cwd', f => f.write({ ...f.config, fixtureCwd: f.root })],
]) test('actual factory refuses '+name+' before credentials', t => {
  const f = fixture(t); change(f); assert.throws(() => f.create()); assert.equal(f.reads(), 0);
});
test('real config symlink outside the lease is rejected before reading it', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside.json');
  fs.renameSync(f.configPath, outside); fs.symlinkSync(outside, f.configPath);
  assert.throws(() => read(f.args()), /configuration_outside_lease/); assert.equal(f.reads(), 0);
});
test('oversized or non-file configuration is rejected', t => {
  const f = fixture(t); fs.writeFileSync(f.configPath, ' '.repeat(16385));
  assert.throws(() => read(f.args()), /configuration_invalid/);
  fs.unlinkSync(f.configPath); fs.mkdirSync(f.configPath);
  assert.throws(() => read(f.args()));
});
test('legacy DEV configuration does not require the new packaged target', t => {
  const f = fixture(t), c = { ...f.config }; delete c.target; delete c.version; f.write(c);
  assert.ok(f.create({ isDev: true })); assert.equal(f.reads(), 0);
});

test('named pipe configuration refuses without waiting for a writer', t => {
  const f = fixture(t); fs.unlinkSync(f.configPath);
  execFileSync('/usr/bin/mkfifo', [f.configPath]);
  const code = `try {
    require(process.argv[1]).readPackagedAuthProfileConfiguration(JSON.parse(process.argv[2]));
    process.exitCode = 2;
  } catch (error) {
    if (error.code !== 'codex_auth_profile_configuration_invalid') throw error;
    process.stdout.write('refused');
  }`;
  const child = spawnSync(process.execPath, ['-e', code,
    path.join(__dirname, 'codex-auth-profile-target.js'), JSON.stringify(f.args())],
  { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'refused');
});
