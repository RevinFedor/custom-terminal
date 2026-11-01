import assert from 'node:assert/strict';
import test from 'node:test';
import prodApi from './noted-prod-api.js';
import { buildInstallNotedTerminal, main, PREPARE_SCRIPTS } from './build-install-noted-terminal.mjs';

const executable = '/Applications/Noted Terminal.app/Contents/MacOS/Noted Terminal';
const hubSnapshot = '53960 ' + executable + ' /bundle/src/main/mcp-hub.js --standalone --port 53133\n';
const found = { status: 'found', server: { pid: 42, port: 7878 } };
const absent = { status: 'absent', server: null };
const unknown = { status: 'unknown', reason: 'synthetic-read-failure' };

// Exercise the existing classifier with finite input, never ps/discovery/API.
function inspectSnapshot(snapshot, records = {}) {
  return prodApi.inspectProdServer({
    discoveryDir: '/synthetic/discovery',
    fileSystem: {
      readdirSync: () => Object.keys(records),
      readFileSync: file => records[file.split('/').at(-1)],
    },
    processSnapshot: () => snapshot,
  });
}

function fixture({ fail = null, cancelAt = null } = {}) {
  const events = [];
  const controller = new AbortController();
  const applicationsDir = '/synthetic/Applications';
  const installedApp = applicationsDir + '/Noted Terminal.app';
  const releaseApp = '/synthetic/release/Noted Terminal.app';
  const nodes = new Map([
    [applicationsDir, { directory: true }],
    [installedApp, { directory: true, version: 'old' }],
    [releaseApp, { directory: true, version: 'new' }],
  ]);
  let validations = 0;
  let failed = false;
  const event = (kind, detail = {}) => {
    events.push({ kind, ...detail });
    if (kind === cancelAt) controller.abort(Error('synthetic cancellation'));
    if (kind === fail && !failed) { failed = true; throw Error('synthetic ' + kind); }
  };
  const missing = () => Object.assign(Error('synthetic missing'), { code: 'ENOENT' });
  const fileSystem = {
    async mkdir(target) {
      if (nodes.has(target)) throw Object.assign(Error('exists'), { code: 'EEXIST' });
      nodes.set(target, { directory: true });
    },
    async writeFile(target, text) { nodes.set(target, { text }); },
    async readFile(target) { if (!nodes.has(target)) throw missing(); return nodes.get(target).text; },
    async lstat(target) {
      const item = nodes.get(target);
      if (!item) throw missing();
      return { isDirectory: () => !!item.directory, isSymbolicLink: () => false };
    },
    async mkdtemp(prefix) { const target = prefix + 'fixture'; nodes.set(target, { directory: true }); return target; },
    async rename(from, to) {
      event('rename', { from, to });
      if (!nodes.has(from)) throw missing();
      assert.equal(nodes.has(to), false, 'no merge/overwrite');
      nodes.set(to, nodes.get(from)); nodes.delete(from);
    },
    async unlink(target) { if (!nodes.delete(target)) throw missing(); },
    async rmdir(target) { assert(nodes.delete(target)); },
  };
  const run = async (command, args) => {
    if (command === 'npm') { assert.equal(args[0], 'run'); event(args[1]); }
    else if (command === '/usr/bin/ditto') {
      event('stage-copy'); assert(nodes.has(args[0])); nodes.set(args[1], { ...nodes.get(args[0]) });
    } else if (command === 'bash') event('quit', { args });
    else if (command === '/usr/bin/open') event('open', { args, version: nodes.get(args[0])?.version });
    else assert.fail('unexpected external command: ' + command);
    return '';
  };
  const maintenance = {
    operationId: 'synthetic:install',
    async begin() { event('maintenance-begin'); return { operationId: this.operationId, bootstrap: true }; },
    async complete() { event('maintenance-complete'); return { operationId: this.operationId, complete: true }; },
    launchArguments: () => ['--args', '--research-maintenance-operation=synthetic:install'],
  };
  const execute = options => buildInstallNotedTerminal({
    ...options, applicationsDir, releaseApp, fileSystem, run,
    signal: options?.signal || controller.signal,
    validate: async () => event(['validate-release', 'validate-stage', 'validate-installed'][validations++]),
    beforeReplace: async () => event('before-replace'),
    beforeQuit: async data => { event('before-quit'); await options?.beforeQuit?.(data); },
    maintenance,
    aliveCheck: () => assert.fail('no real process-liveness lookup'),
    prune: async () => { event('prune'); return []; },
    log() {},
  });
  return { events, execute, controller, nodes, installedApp };
}

async function cli(inspect, install, env = {}) {
  const names = ['NOTED_INSTALL_IDLE_ACK_ID', 'NOTED_INSTALL_CONTINUATION_BINDING', 'NOTED_INSTALL_FORCE'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  const exitCode = process.exitCode, log = console.log;
  for (const name of names) delete process.env[name];
  Object.assign(process.env, env);
  console.log = () => {};
  try { await main({ projectDir: '/synthetic/project', inspect, install }); }
  finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    process.exitCode = exitCode; console.log = log;
  }
}

test('existing process reader distinguishes shared hub, Main, and unknown with finite input', () => {
  assert.equal(inspectSnapshot(hubSnapshot).status, 'absent');
  assert.equal(inspectSnapshot(hubSnapshot + '99 ' + executable + ' --type=renderer\n').status, 'absent');
  assert.equal(inspectSnapshot(hubSnapshot + '42 ' + executable + '\n').status, 'unknown');
  assert.equal(inspectSnapshot(hubSnapshot + '42 ' + executable + '\n', {
    'web-server-42.json': JSON.stringify({ pid: 42, port: 7878 }),
  }).status, 'found');
  assert.equal(inspectSnapshot('').status, 'unknown');
});

test('hub-only closed CLI prepares, reconfirms after stage/maintenance, installs and launches without Quit/hooks', async () => {
  const f = fixture(); let result, checks = 0;
  await cli(() => {
    f.events.push({ kind: 'inspect' }); checks++;
    return inspectSnapshot(hubSnapshot);
  }, async options => { result = await f.execute(options); return result; });
  assert.equal(result.ok, true); assert.equal(checks, 2);
  const kinds = f.events.map(x => x.kind);
  assert.equal(kinds[0], 'inspect');
  assert(kinds.lastIndexOf('inspect') > kinds.indexOf('before-replace'));
  assert(kinds.lastIndexOf('inspect') > kinds.indexOf('maintenance-begin'));
  assert(kinds.lastIndexOf('inspect') < kinds.indexOf('rename'));
  assert(!kinds.includes('quit')); assert(!kinds.includes('before-quit'));
  assert.deepEqual(kinds.filter(k => PREPARE_SCRIPTS.includes(k)), PREPARE_SCRIPTS);
  assert.equal(f.nodes.get(f.installedApp).version, 'new');
  assert.equal(f.events.find(e => e.kind === 'open').version, 'new');
});

test('earlier absence never authorizes replacement if final source is found or unknown', async () => {
  for (const changed of [found, unknown]) {
    const f = fixture(); let checks = 0, result;
    await cli(() => (++checks === 1 ? absent : changed), async options => {
      result = await f.execute(options); return result;
    });
    assert.equal(checks, 2); assert.equal(result.ok, false);
    assert.equal(result.failedStep, 'confirm-closed-source');
    assert.equal(result.recovery.status, 'installed-app-untouched');
    assert.equal(f.nodes.get(f.installedApp).version, 'old');
    assert(!f.events.some(e => ['quit', 'before-quit', 'rename', 'open', 'maintenance-complete'].includes(e.kind)));
  }
});

test('initial unknown refuses before install; a live Main is quit by its exact PID re-read before Quit', async () => {
  await assert.rejects(cli(() => unknown, () => assert.fail('unknown cannot start install')), /source is not known/);
  const f = fixture(); let checks = 0, result;
  await cli(() => { checks++; f.events.push({ kind: 'inspect' }); return found; }, async options => {
    assert.equal(options.confirmClosedSource, undefined);
    result = await f.execute(options); return result;
  });
  assert.equal(result.ok, true); assert.equal(checks, 2, 'start + immediately before Quit');
  const kinds = f.events.map(e => e.kind);
  assert(kinds.lastIndexOf('inspect') > kinds.indexOf('before-quit'));
  assert(kinds.lastIndexOf('inspect') < kinds.indexOf('quit'));
  // The detached MCP hub shares the executable path. Only the exact Main PID
  // is awaited/signalled, so the hub survives (it was SIGTERM'd 01.11 20:05).
  assert.deepEqual(f.events.find(e => e.kind === 'quit').args, ['scripts/graceful-quit.sh', '20', '', '', '42']);
});

test('the ordinary Voice/MCP job also gets the exact-Main re-read; a closed source does not', async () => {
  let seen;
  await cli(() => found, async options => { seen = options; return { ok: true }; },
    { NOTED_INSTALL_IDLE_ACK_ID: 'synthetic-voice-job' });
  assert.equal(typeof seen.inspectQuitSource, 'function');
  assert.equal(seen.confirmClosedSource, undefined);
  assert.deepEqual(await seen.inspectQuitSource(), found);
  await cli(() => absent, async options => { seen = options; return { ok: true }; });
  assert.equal(seen.inspectQuitSource, undefined);
  assert.equal(typeof seen.confirmClosedSource, 'function');
});

test('a pre-Quit re-read decides the Quit: unknown or failed read keeps path-wide, absent skips it', async () => {
  for (const [label, second, expected] of [
    ['unknown', () => unknown, ['scripts/graceful-quit.sh', '20']],
    ['read error', () => { throw Error('synthetic ps failure'); }, ['scripts/graceful-quit.sh', '20']],
    ['Main already closed', () => absent, null],
  ]) {
    const f = fixture(); let checks = 0, result;
    await cli(() => (++checks === 1 ? found : second()), async options => {
      result = await f.execute(options); return result;
    });
    assert.equal(result.ok, true, label); assert.equal(checks, 2, label);
    const quit = f.events.find(e => e.kind === 'quit');
    if (expected) assert.deepEqual(quit?.args, expected, label);
    else assert.equal(quit, undefined, label + ': nothing to quit, the shared hub is never sent Quit');
    assert.equal(f.nodes.get(f.installedApp).version, 'new', label);
  }
});

test('closed preparation failure/cancellation never reopens the app; replaced validation failure rolls back', async () => {
  for (const options of [{ fail: 'build:markdown' }, { cancelAt: 'stage-copy' }, { fail: 'validate-installed' }]) {
    const f = fixture(options);
    const result = await f.execute({ confirmClosedSource: () => absent });
    assert.equal(result.ok, false); assert(!f.events.some(e => e.kind === 'quit'));
    assert.equal(f.nodes.get(f.installedApp).version, 'old');
    const opens = f.events.filter(e => e.kind === 'open');
    if (options.fail === 'validate-installed') {
      assert.equal(result.recovery.status, 'previous-app-reopened'); assert.equal(opens.length, 1);
      assert.equal(opens[0].version, 'old');
    } else { assert.equal(opens.length, 0); assert.equal(result.recovery.status, 'installed-app-untouched'); }
  }
});

test('failed closed-source launch cannot send path-wide Quit during rollback', async () => {
  for (const afterLaunch of [absent, found, unknown]) {
    const f = fixture({ fail: 'open' }); let checks = 0;
    const result = await f.execute({ confirmClosedSource: () => (++checks === 1 ? absent : afterLaunch) });
    assert.equal(result.ok, false); assert.equal(checks, 2);
    assert(!f.events.some(e => e.kind === 'quit'));
    if (afterLaunch.status === 'absent') {
      assert.equal(result.recovery.status, 'previous-app-reopened');
      assert.equal(f.nodes.get(f.installedApp).version, 'old');
    } else {
      assert.equal(result.recovery.status, 'failed');
      assert.match(result.recovery.error, /rollback requires proven Main absence/);
      assert.equal(f.nodes.get(f.installedApp).version, 'new');
      assert.equal(f.events.filter(e => e.kind === 'open').length, 1);
    }
  }
});

test('nonce/force entry and app-owned PID wait remain separate from closed-source inspection', async () => {
  await cli(() => assert.fail('nonce must not inspect a new source'), async options => {
    assert.equal(options.confirmClosedSource, undefined);
    assert.equal(typeof options.beforeQuit, 'function');
    return { ok: true };
  }, { NOTED_INSTALL_IDLE_ACK_ID: 'synthetic-nonce', NOTED_INSTALL_FORCE: '1' });
  const f = fixture();
  const result = await f.execute({ appOwnedQuitSource: found });
  assert.equal(result.ok, true);
  assert.deepEqual(f.events.find(e => e.kind === 'quit').args,
    ['scripts/graceful-quit.sh', '20', '--require-graceful', '--wait-only', '42']);
  await assert.rejects(f.execute({ appOwnedQuitSource: found, confirmClosedSource: () => absent }),
    /only valid for an external prepare-first install/);
});
