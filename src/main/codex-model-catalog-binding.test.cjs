'use strict';

// Only finite, owned filesystem fixtures. No subprocess/Electron/native/provider
// execution, app/profile access, timers, network, or global CLI changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { beginCatalogLaunchBinding: begin } = require('./codex-model-catalog-binding');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const args = ['debug', 'models'];
const native = Buffer.from('7f454c4601020304', 'hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-binding-')));
  const bin = path.join(root, 'bin');
  const envFile = path.join(root, 'system/usr/bin/env');
  const calls = [], handles = new Set();
  let bytesRead = 0, hook;
  function write(name, body = native) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o755 });
    return file;
  }
  write('bin/codex', '#!/usr/bin/env node\n// private, never executed\n');
  write('bin/node');
  write('system/usr/bin/env');
  // Virtualize the fixed /usr/bin/env shebang endpoint onto our tiny fixture.
  // No test opens the host OS env executable (or the installed node/Codex).
  function physical(value) {
    return typeof value === 'string' && (value === '/usr' || value.startsWith('/usr/'))
      ? path.join(root, 'system', value) : value;
  }
  const adapter = {};
  for (const method of ['lstatSync', 'statSync', 'realpathSync', 'readlinkSync', 'accessSync', 'openSync', 'fstatSync', 'readSync', 'closeSync']) {
    adapter[method] = (...input) => {
      calls.push({ method, input });
      if (hook) hook(method, input);
      const mapped = [...input];
      if (typeof mapped[0] === 'string') mapped[0] = physical(mapped[0]);
      let result = method === 'realpathSync' ? fs.realpathSync.native(...mapped) : fs[method](...mapped);
      if (method === 'realpathSync' && input[0].startsWith('/usr')) {
        result = '/' + path.relative(path.join(root, 'system'), result);
      }
      if (method === 'openSync') handles.add(result);
      if (method === 'closeSync') handles.delete(input[0]);
      if (method === 'readSync') bytesRead += result;
      return result;
    };
  }
  const deps = { fs: adapter, env: {}, cwd: () => root, platform: 'linux' };
  const options = (extra = {}) => ({ cwd: root, env: { PATH: bin }, shell: false, ...extra });
  t.after(() => {
    try { assert.equal(handles.size, 0, 'every diagnostic fd was closed'); }
    finally {
      for (const fd of handles) fs.closeSync(fd);
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'own temporary fixture removed');
    }
  });
  return { root, bin, envFile, deps, options, write, calls,
    hook: value => { hook = value; }, bytes: () => bytesRead };
}

function qualified(binding) {
  assert.equal(binding.before.status, 'qualified', JSON.stringify(binding.before));
  assert.match(binding.before.factsDigest, /^[a-f0-9]{64}$/);
  for (const key of ['cwdDigest', 'pathDigest', 'loaderContextDigest']) assert.match(binding.before.context[key], /^[a-f0-9]{64}$/);
}

test('actual PATH env-node resolution yields immutable, bounded, body-free facts and one-shot finish', t => {
  const f = fixture(t);
  const env = { PATH: f.bin, SECRET: 'credential-canary-must-not-be-read' };
  const options = Object.freeze({ cwd: f.root, env: Object.freeze(env), shell: false });
  const binding = begin('codex', args, options, f.deps);
  qualified(binding);
  assert.deepEqual(binding.before.context.recipe.args, args);
  assert.equal(binding.before.context.recipe.shell, false);
  assert.equal(binding.before.executable.kind, 'node-script');
  assert.equal(binding.before.executable.realPathDigest, hash(path.join(f.bin, 'codex')));
  assert.equal(binding.before.interpreter.kind, 'env-node');
  assert.equal(binding.before.interpreter.realPathDigest, hash(path.join(f.bin, 'node')));
  assert.equal(binding.before.interpreter.via.realPathDigest, hash('/usr/bin/env'));
  for (const value of Object.values(binding.before.interpreter.stat)) assert.equal(typeof value, 'string');
  assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.before.context.recipe.args));
  assert.ok(Object.isFrozen(binding.before.interpreter.stat));
  assert.throws(() => { binding.before.context.recipe.args[0] = 'execute'; }, TypeError);
  const reads = f.calls.length;
  for (let i = 0; i < 50; i++) {
    const wire = JSON.stringify(binding.before);
    assert.ok(Buffer.byteLength(wire) <= 2560);
    assert.equal(wire.includes(f.root), false);
    assert.equal(wire.includes('credential-canary'), false);
    assert.equal(wire.includes('SECRET'), false);
    assert.equal(wire.includes('never executed'), false);
  }
  assert.equal(f.calls.length, reads, 'reading facts has no filesystem side effects');
  const after = binding.finish();
  assert.deepEqual(after, { status: 'qualified', reason: 'matched', factsDigest: binding.before.factsDigest, matched: true });
  assert.equal(after.then, undefined, 'finish is synchronous');
  const closedReads = f.calls.length;
  for (let i = 0; i < 50; i++) assert.equal(binding.finish(), after);
  assert.equal(f.calls.length, closedReads, 'repeated finish is a pure snapshot');
  assert.ok(f.bytes() <= 2 * 3 * 256, 'at most three bounded shebang/header reads per observation');
  assert.ok(Buffer.byteLength(JSON.stringify(after)) < 256);
});

test('native and absolute node shebang use actual file descriptors, never process.execPath', t => {
  const f = fixture(t);
  const executable = f.write('native-codex');
  let b = begin(executable, [...args, '--bundled'], f.options(), f.deps);
  qualified(b);
  assert.equal(b.before.executable.kind, 'native');
  assert.equal(b.before.interpreter, null);
  assert.equal(b.finish().matched, true);
  const interpreter = f.write('private/node');
  f.write('bin/codex', '#!' + interpreter + '\n// finite wrapper\n');
  b = begin('codex', args, f.options(), f.deps);
  qualified(b);
  assert.equal(b.before.interpreter.kind, 'direct-node');
  assert.equal(b.before.interpreter.realPathDigest, hash(interpreter));
  assert.equal(b.finish().matched, true);
});

test('Darwin native magic is resolved using only owned Mach-O-shaped prefix fixtures', t => {
  const f = fixture(t);
  const macho = Buffer.from('cffaedfe01020304', 'hex');
  f.write('bin/node', macho);
  f.write('system/usr/bin/env', macho);
  const b = begin('codex', args, f.options(), { ...f.deps, platform: 'darwin' });
  qualified(b);
  assert.equal(b.finish().matched, true);
  const executable = f.write('mach-native', macho);
  const direct = begin(executable, args, f.options(), { ...f.deps, platform: 'darwin' });
  qualified(direct);
  assert.equal(direct.finish().matched, true);
});

test('private HOME PATH shadow wins; unrelated env and HOME do not replace the actual PATH', t => {
  const f = fixture(t);
  const shadow = f.write('private-home/.local/bin/codex');
  const env = { PATH: path.dirname(shadow) + ':' + f.bin, HOME: path.join(f.root, 'private-home') };
  const b = begin('codex', args, f.options({ env }), f.deps);
  qualified(b);
  assert.equal(b.before.executable.realPathDigest, hash(shadow));
  assert.equal(b.before.interpreter, null);
  const other = begin('codex', args, f.options({ env: { ...env, HOME: '/irrelevant', TOKEN: 'new' } }), f.deps);
  assert.equal(other.before.factsDigest, b.before.factsDigest);
  assert.equal(b.finish().matched, true);
  assert.equal(other.finish().matched, true);
});

test('new higher-priority PATH shadow between bookends is drift', t => {
  const f = fixture(t);
  const early = path.join(f.root, 'early');
  fs.mkdirSync(early);
  const b = begin('codex', args, f.options({ env: { PATH: early + ':' + f.bin } }), f.deps);
  qualified(b);
  f.write('early/codex');
  assert.equal(b.finish().reason, 'launch-binding-drift');
  assert.equal(b.finish().matched, false);
});

test('symlink alias drift is detected even with unchanged realpath and native file', t => {
  const f = fixture(t);
  f.write('actual-codex');
  const alias = path.join(f.bin, 'codex');
  fs.unlinkSync(alias);
  fs.symlinkSync('../actual-codex', alias);
  const b = begin('codex', args, f.options(), f.deps);
  qualified(b);
  fs.unlinkSync(alias);
  fs.symlinkSync('.././actual-codex', alias);
  const next = begin('codex', args, f.options(), f.deps);
  qualified(next);
  assert.equal(b.before.executable.realPathDigest, next.before.executable.realPathDigest);
  assert.deepEqual(b.before.executable.stat, next.before.executable.stat);
  assert.notEqual(b.before.executable.aliasDigest, next.before.executable.aliasDigest);
  assert.equal(b.finish().reason, 'launch-binding-drift');
});

test('native replacement, node drift, env drift and directory alias drift each refuse matching', async t => {
  for (const target of ['native', 'node', 'env', 'directory-alias']) {
    await t.test(target, t => {
      const f = fixture(t);
      let selected = 'codex';
      if (target === 'native') selected = f.write('native-codex');
      if (target === 'directory-alias') {
        fs.symlinkSync('bin', path.join(f.root, 'alias'));
      }
      const options = target === 'directory-alias'
        ? f.options({ env: { PATH: path.join(f.root, 'alias') } }) : f.options();
      const b = begin(selected, args, options, f.deps);
      qualified(b);
      if (target === 'native') {
        const replacement = f.write('replacement');
        fs.renameSync(replacement, selected);
      } else if (target === 'node') {
        f.write('bin/node', Buffer.concat([native, Buffer.from('different interpreter')]));
      } else if (target === 'env') {
        f.write('system/usr/bin/env', Buffer.concat([native, Buffer.from('different env')]));
      } else {
        fs.unlinkSync(path.join(f.root, 'alias'));
        fs.symlinkSync('./bin', path.join(f.root, 'alias'));
      }
      const after = b.finish();
      assert.equal(after.status, 'unqualified');
      assert.equal(after.reason, 'launch-binding-drift');
      assert.equal(after.matched, false);
    });
  }
});

test('effective cwd, empty/relative PATH entries and symlink/.. keep POSIX resolution semantics', t => {
  const f = fixture(t);
  f.write('work/codex');
  const work = path.join(f.root, 'work');
  const options = { env: { PATH: '' } };
  let cwdCalls = 0;
  const b = begin('codex', args, options, { ...f.deps, cwd: () => { cwdCalls++; return work; } });
  qualified(b);
  assert.equal(b.before.executable.realPathDigest, hash(path.join(work, 'codex')));
  assert.equal(b.finish().matched, true);
  assert.equal(cwdCalls, 1, 'finish uses the captured launch cwd');
  f.write('physical/codex');
  fs.mkdirSync(path.join(f.root, 'physical/deep'));
  fs.symlinkSync('../physical/deep', path.join(work, 'link'));
  const direct = begin('./link/../codex', args, f.options({ cwd: work }), f.deps);
  qualified(direct);
  assert.equal(direct.before.executable.realPathDigest, hash(path.join(f.root, 'physical/codex')));
  assert.equal(direct.finish().matched, true);
  const relativeCwd = begin('codex', args, { cwd: 'work/link/..', env: { PATH: '.' } }, f.deps);
  qualified(relativeCwd);
  assert.equal(relativeCwd.before.executable.realPathDigest, hash(path.join(f.root, 'physical/codex')));
  assert.equal(relativeCwd.finish().matched, true);
});

test('changed effective cwd and PATH have different digests; cwd identity drift is rejected', t => {
  const f = fixture(t);
  f.write('a/codex'); f.write('b/codex');
  const a = begin('codex', args, { cwd: path.join(f.root, 'a'), env: { PATH: '.' } }, f.deps);
  const b = begin('codex', args, { cwd: path.join(f.root, 'b'), env: { PATH: '.' } }, f.deps);
  qualified(a); qualified(b);
  assert.notEqual(a.before.context.cwdDigest, b.before.context.cwdDigest);
  const c = begin('codex', args, { cwd: path.join(f.root, 'a'), env: { PATH: '' } }, f.deps);
  qualified(c);
  assert.notEqual(a.before.context.pathDigest, c.before.context.pathDigest);
  assert.equal(b.finish().matched, true);
  fs.renameSync(path.join(f.root, 'a'), path.join(f.root, 'old-a'));
  f.write('a/codex');
  assert.equal(a.finish().matched, false);
  assert.equal(c.finish().matched, false);
});

test('launch scalars are captured; later caller mutations are not a new child environment', t => {
  const f = fixture(t);
  const options = f.options();
  const mutableArgs = [...args];
  const b = begin('codex', mutableArgs, options, f.deps);
  qualified(b);
  options.env.PATH = '/not-the-launched-PATH';
  options.env.NODE_OPTIONS = '--require /should-never-be-retained';
  options.cwd = '/not-the-launched-cwd';
  mutableArgs[0] = 'mutated';
  assert.equal(b.finish().matched, true);
  assert.deepEqual(b.before.context.recipe.args, args);
});

test('unsupported loader overrides are diagnostic-only and hash only selected inputs', t => {
  const f = fixture(t);
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'ELECTRON_RUN_AS_NODE', 'DYLD_UNKNOWN_LOADER_OVERRIDE']) {
    const beforeCalls = f.calls.length;
    const b = begin('codex', args, f.options({ env: { PATH: f.bin, [key]: 'private-override-canary' } }), f.deps);
    assert.equal(b.before.status, 'unqualified');
    assert.equal(b.before.reason, 'unsupported-loader-context');
    assert.match(b.before.context.loaderContextDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(b.before).includes('private-override-canary'), false);
    assert.equal(b.finish().matched, false);
    assert.equal(f.calls.length, beforeCalls, 'unsupported override does no filesystem work');
  }
  const ambient = begin('codex', args, f.options(), { ...f.deps, env: { NODE_V8_COVERAGE: '/ambient-coverage' } });
  assert.equal(ambient.before.reason, 'unsupported-loader-context');
  const inherited = Object.create({ NODE_V8_COVERAGE: '' }); inherited.PATH = f.bin;
  assert.equal(begin('codex', args, f.options({ env: inherited }), {
    ...f.deps, env: { NODE_V8_COVERAGE: '/ambient-coverage' },
  }).before.reason, 'unsupported-loader-context');
  const empty = begin('codex', args, f.options({ env: { PATH: f.bin, NODE_OPTIONS: '' } }), f.deps);
  qualified(empty);
  const plain = begin('codex', args, f.options(), f.deps);
  assert.notEqual(empty.before.context.loaderContextDigest, plain.before.context.loaderContextDigest);
});

test('unsupported shebangs and chained interpreters never receive a qualified binding', t => {
  const f = fixture(t);
  for (const line of ['#!/usr/bin/env -S node', '#!/usr/bin/env node --require x', '#!/bin/sh',
    '#!/usr/bin/env node\r', '#!node', '#!/usr/bin/env node ' + 'x'.repeat(300)]) {
    f.write('bin/codex', line + '\n');
    const b = begin('codex', args, f.options(), f.deps);
    assert.equal(b.before.status, 'unqualified', line);
    assert.equal(b.before.reason, 'unsupported-shebang');
    assert.equal(b.finish().matched, false);
  }
  f.write('bin/codex', '#!/usr/bin/env node\n');
  f.write('bin/node', '#!/usr/bin/env node\n');
  assert.equal(begin('codex', args, f.options(), f.deps).before.reason, 'unsupported-node-interpreter');
});

test('accessors, proxies and coercion hooks are never invoked by diagnostics or serialization', t => {
  const f = fixture(t);
  let effects = 0;
  const getter = () => { effects++; throw Error('must not run'); };
  for (const key of ['env', 'cwd', 'shell', 'uid', 'argv0']) {
    const options = f.options();
    Object.defineProperty(options, key, { get: getter, enumerable: true });
    const b = begin('codex', args, options, f.deps);
    assert.equal(b.before.reason, 'accessor-input');
    JSON.stringify(b.before); JSON.stringify(b.finish());
  }
  for (const key of ['PATH', 'NODE_OPTIONS', 'IRRELEVANT_SECRET']) {
    const env = { PATH: f.bin };
    Object.defineProperty(env, key, { get: getter, enumerable: true });
    assert.equal(begin('codex', args, f.options({ env }), f.deps).before.reason, 'accessor-input');
  }
  const proxy = new Proxy({}, { get: getter, ownKeys: getter, getOwnPropertyDescriptor: getter });
  assert.equal(begin('codex', args, proxy, f.deps).before.status, 'unqualified');
  assert.equal(begin('codex', args, f.options({ env: proxy }), f.deps).before.status, 'unqualified');
  const coercion = { toString: getter };
  assert.equal(begin('codex', args, f.options({ env: { PATH: coercion } }), f.deps).before.status, 'unqualified');
  assert.equal(begin('codex', args, f.options({ env: { PATH: f.bin, OTHER: coercion } }), f.deps).before.reason, 'unsupported-environment-value');
  const getterArgs = [...args]; Object.defineProperty(getterArgs, '0', { get: getter });
  assert.equal(begin('codex', getterArgs, f.options(), f.deps).before.reason, 'accessor-input');
  assert.equal(effects, 0);
});

test('inherited enumerable env uses Node semantics; missing PATH is explicitly unqualified', t => {
  const f = fixture(t);
  const inherited = Object.create({ PATH: f.bin });
  const b = begin('codex', args, f.options({ env: inherited }), f.deps);
  qualified(b); assert.equal(b.finish().matched, true);
  const missing = begin('codex', args, f.options({ env: {} }), f.deps);
  assert.equal(missing.before.reason, 'path-unavailable');
  assert.equal(missing.finish().matched, false);
  Object.defineProperty(inherited, 'PATH', { value: f.bin, enumerable: false });
  assert.equal(begin('codex', args, f.options({ env: inherited }), f.deps).before.reason, 'path-unavailable');
  const ambient = begin('codex', args, { cwd: f.root }, { ...f.deps, env: { PATH: f.bin } });
  qualified(ambient);
  assert.equal(ambient.finish().matched, true);
});

test('caps refuse oversize recipe/PATH/alias chains; reads stay header-sized on a larger own file', t => {
  const f = fixture(t);
  const cases = [
    ['codex', args, f.options({ env: { PATH: 'x'.repeat(8193) } }), 'input-budget-exceeded'],
    ['codex', args, f.options({ env: { PATH: Array(65).fill(f.bin).join(':') } }), 'path-budget-exceeded'],
    ['c'.repeat(4097), args, f.options(), 'input-budget-exceeded'],
    ['codex', ['debug', 'models', '--other'], f.options(), 'unsupported-recipe'],
    ['codex', args, f.options({ shell: true }), 'unsupported-shell'],
    ['codex', args, f.options({ uid: 12345 }), 'unsupported-execution-options'],
    ['codex', args, f.options({ env: Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['KEY_' + i, 'x'])) }), 'input-budget-exceeded'],
  ];
  for (const [command, argv, options, reason] of cases) {
    const b = begin(command, argv, options, f.deps);
    assert.equal(b.before.reason, reason);
    assert.equal(b.finish().matched, false);
    assert.ok(Buffer.byteLength(JSON.stringify(b.before)) <= 2560);
  }
  f.write('linked-native');
  for (let i = 16; i >= 0; i--) fs.symlinkSync(i === 16 ? 'linked-native' : 'link-' + (i + 1), path.join(f.root, 'link-' + i));
  assert.equal(begin(path.join(f.root, 'link-0'), args, f.options(), f.deps).before.reason, 'resolution-budget-exceeded');
  const big = f.write('larger-native');
  fs.truncateSync(big, 64 * 1024);
  const bytes = f.bytes();
  const b = begin(big, args, f.options(), f.deps);
  qualified(b); assert.equal(b.finish().matched, true);
  assert.equal(f.bytes() - bytes, 512, 'only two 256-byte header reads, never native hashing');
  assert.equal(b.before.executable.stat.size, String(64 * 1024));
});

test('file races and filesystem errors stay unqualified, close fds and omit raw error messages', t => {
  const f = fixture(t);
  const b = begin('codex', args, f.options(), f.deps);
  qualified(b);
  f.hook(method => { if (method === 'statSync') throw Error('credential-error-canary'); });
  const after = b.finish();
  assert.equal(after.reason, 'filesystem-error');
  assert.equal(after.matched, false);
  assert.equal(JSON.stringify(after).includes('credential-error-canary'), false);
  f.hook(undefined);
  const file = f.write('raced-native');
  let raced = false;
  f.hook(method => {
    if (method === 'fstatSync' && !raced) {
      raced = true;
      fs.writeFileSync(file, Buffer.concat([native, Buffer.from('changed')]));
    }
  });
  assert.equal(begin(file, args, f.options(), f.deps).before.reason, 'file-raced');
  f.hook(method => { if (method === 'readSync') throw Error('own read failure'); });
  assert.equal(begin(file, args, f.options(), f.deps).before.reason, 'filesystem-error');
});
