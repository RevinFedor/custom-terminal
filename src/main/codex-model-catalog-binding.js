'use strict';

// Diagnostic bookends, not a launcher or kernel identity proof. Native bytes
// and the pinned wrapper/interpreter protocol belong to the external verifier.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');

const LIMIT = Object.freeze({ string: 4096, path: 8192, entries: 64, components: 128,
  links: 16, operations: 1024, header: 256, facts: 2560, prototypes: 8, keys: 256 });
// Retain only resolution/loader inputs. Descriptor names are boundedly checked
// for accessors; the full environment is never copied, hashed or published.
// Nonempty overrides cannot be attested by stat/shebang observations alone.
const LOADER_KEYS = Object.freeze([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_ICU_DATA',
  'NODE_V8_COVERAGE', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_USE_ENV_PROXY',
  'ELECTRON_RUN_AS_NODE', 'OPENSSL_CONF', 'OPENSSL_ENGINES',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_ORIGIN_PATH',
  'LD_ASSUME_KERNEL', 'LD_HWCAP_MASK', 'GLIBC_TUNABLES',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_VERSIONED_LIBRARY_PATH', 'DYLD_VERSIONED_FRAMEWORK_PATH',
  'DYLD_ROOT_PATH', 'DYLD_IMAGE_SUFFIX', 'DYLD_SHARED_REGION',
  'DYLD_FORCE_FLAT_NAMESPACE', 'DYLD_BIND_AT_LAUNCH',
  'DYLD_SHARED_CACHE_DIR', 'DYLD_SHARED_CACHE_DONT_VALIDATE',
]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw Object.assign(new Error(reason), { bindingReason: reason }); };
const absent = code => code === 'ENOENT' || code === 'ENOTDIR';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Reading a diagnostic must not run a getter/toString/proxy trap. Node normally
// enumerates inherited env data properties too; descriptor lookup preserves that.
function data(object, key, enumerable = false) {
  for (let depth = 0; object != null; depth++) {
    if (depth >= LIMIT.prototypes || types.isProxy(object)) fail('unsupported-input-object');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) {
      if (!('value' in descriptor)) fail('accessor-input');
      return enumerable && !descriptor.enumerable ? undefined : descriptor.value;
    }
    object = Object.getPrototypeOf(object);
  }
  return undefined;
}

function string(value, cap = LIMIT.string) {
  if (typeof value !== 'string' || value.includes('\0')) fail('unsupported-input-value');
  if (Buffer.byteLength(value) > cap) fail('input-budget-exceeded');
  return value;
}

function checkDescriptors(object, environment = false) {
  const seen = new Set();
  const loaderKeys = [];
  for (let depth = 0; object != null; depth++, object = Object.getPrototypeOf(object)) {
    if (depth >= LIMIT.prototypes || types.isProxy(object)) fail('unsupported-input-object');
    const keys = Object.getOwnPropertyNames(object);
    if (keys.length + seen.size > LIMIT.keys) fail('input-budget-exceeded');
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor.enumerable) continue;
      // Even an unrelated getter/coercion could mutate PATH while Node builds
      // envPairs. Inspect descriptors only; never invoke it or retain its value.
      if (!('value' in descriptor)) fail('accessor-input');
      if (environment && descriptor.value != null
        && ['object', 'function', 'symbol'].includes(typeof descriptor.value)) fail('unsupported-environment-value');
      if (environment && /^(DYLD_|LD_)/.test(key)) loaderKeys.push(key);
    }
  }
  return loaderKeys;
}

function statIdentity(stat, directory = false) {
  const keys = directory ? ['dev', 'ino', 'mode'] : ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
  const identity = {};
  for (const key of keys) {
    if (typeof stat[key] !== 'bigint') fail('unsupported-stat');
    identity[key] = stat[key].toString();
  }
  return identity;
}

function boundedFs(impl) {
  let operations = 0;
  return (method, ...args) => {
    // Cleanup must remain possible even if the next measured call hits its cap.
    if (method !== 'closeSync' && ++operations > LIMIT.operations) fail('filesystem-budget-exceeded');
    // The JS realpath implementation normalizes '..' before following links.
    if (method === 'realpathSync' && impl.realpathSync.native) return impl.realpathSync.native(...args);
    return impl[method](...args);
  };
}

// Do not normalize '..' before traversing symlinks: link/../bin may refer to a
// different directory from path.resolve(link/../bin). Every walk has hard caps.
function describe(lexical, io, directory = false) {
  string(lexical);
  if (!path.posix.isAbsolute(lexical)) fail('ambiguous-resolution');
  const pending = lexical.split('/'), resolved = [], aliases = [];
  let components = 0, links = 0, finalStat;
  while (pending.length) {
    if (++components > LIMIT.components) fail('resolution-budget-exceeded');
    const component = pending.shift();
    if (!component || component === '.') continue;
    if (component === '..') { resolved.pop(); continue; }
    const current = '/' + [...resolved, component].join('/');
    const st = io('lstatSync', current, { bigint: true });
    if (st.isSymbolicLink()) {
      if (++links > LIMIT.links) fail('resolution-budget-exceeded');
      const target = string(io('readlinkSync', current));
      aliases.push([hash(current), statIdentity(st), hash(target)]);
      if (path.posix.isAbsolute(target)) resolved.length = 0;
      pending.unshift(...target.split('/'));
    } else {
      if (pending.some(part => part && part !== '.') && !st.isDirectory()) fail('ambiguous-resolution');
      aliases.push([hash(current), statIdentity(st, st.isDirectory())]);
      resolved.push(component);
      finalStat = st;
    }
  }
  const manualRealPath = '/' + resolved.join('/');
  const realPath = string(io('realpathSync', lexical));
  if (manualRealPath !== realPath) fail('resolution-raced');
  // A final '.'/'..' (or root) needs its own exact endpoint stat.
  finalStat = io('statSync', lexical, { bigint: true });
  if (directory ? !finalStat.isDirectory() : !finalStat.isFile()) fail('unsupported-file-type');
  const facts = { lexicalPathDigest: hash(lexical), realPathDigest: hash(realPath),
    aliasDigest: hash(aliases), stat: statIdentity(finalStat, directory) };
  return { facts, realPath, lexical };
}

function resolveExecutable(command, cwd, pathValue, io) {
  const candidates = command.includes('/') ? [path.posix.isAbsolute(command) ? command : cwd + '/' + command]
    : searchPath(command, cwd, pathValue);
  for (const candidate of candidates) {
    string(candidate);
    try {
      const st = io('statSync', candidate, { bigint: true });
      if (!st.isFile()) continue;
      io('accessSync', candidate, fs.constants.X_OK);
    } catch (error) {
      if (absent(error.code) || error.code === 'EACCES') continue;
      throw error;
    }
    return describe(candidate, io);
  }
  fail('executable-unresolved');
}

function searchPath(command, cwd, pathValue) {
  // Missing PATH has platform-specific execvp defaults. It is deliberately
  // unqualified rather than guessed from the parent or a different runtime.
  if (pathValue === undefined) fail('path-unavailable');
  const entries = pathValue.split(':');
  if (entries.length > LIMIT.entries) fail('path-budget-exceeded');
  return entries.map(entry => (path.posix.isAbsolute(entry) ? entry : cwd + '/' + entry) + '/' + command);
}

function readHeader(file, io) {
  const descriptor = io('openSync', file.realPath,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const before = io('fstatSync', descriptor, { bigint: true });
    if (!before.isFile() || hash(statIdentity(before)) !== hash(file.facts.stat)) fail('file-raced');
    const bytes = Buffer.alloc(LIMIT.header);
    const length = io('readSync', descriptor, bytes, 0, bytes.length, 0);
    if (hash(statIdentity(io('fstatSync', descriptor, { bigint: true }))) !== hash(file.facts.stat)) fail('file-raced');
    if (hash(describe(file.lexical, io).facts) !== hash(file.facts)) fail('file-raced');
    return bytes.subarray(0, length);
  } finally { io('closeSync', descriptor); }
}

function nativeHeader(bytes, platform) {
  const magic = bytes.subarray(0, 4).toString('hex');
  return platform === 'linux' ? magic === '7f454c46'
    : ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic);
}

function observe(launch, deps) {
  const io = boundedFs(deps.fs);
  const cwd = describe(launch.cwd, io, true);
  const context = { recipe: launch.recipe, cwdDigest: hash(cwd.facts),
    pathDigest: launch.pathDigest, loaderContextDigest: launch.loaderContextDigest };
  const executable = resolveExecutable(launch.command, cwd.realPath, launch.pathValue, io);
  const header = readHeader(executable, io);
  let interpreter = null;
  let kind = 'native';
  if (header[0] === 35 && header[1] === 33) {
    const end = header.indexOf(10);
    if (end < 0) fail('unsupported-shebang');
    const lineBytes = header.subarray(2, end);
    const line = lineBytes.toString('utf8');
    if (!Buffer.from(line).equals(lineBytes)) fail('unsupported-shebang');
    // Narrow, explicit protocols only: no env -S/options/assignments, shell,
    // chained scripts, CRLF ambiguity or arbitrary interpreter arguments.
    const match = /^[ \t]*(\/[^\s]+)[ \t]*(?:([a-z]+))?[ \t]*$/.exec(line);
    if (!match) fail('unsupported-shebang');
    if (match[1] === '/usr/bin/env' && match[2] === 'node') {
      const via = describe('/usr/bin/env', io);
      io('accessSync', via.lexical, fs.constants.X_OK);
      if (!nativeHeader(readHeader(via, io), deps.platform)) fail('unsupported-env-interpreter');
      const node = resolveExecutable('node', cwd.realPath, launch.pathValue, io);
      if (!nativeHeader(readHeader(node, io), deps.platform)) fail('unsupported-node-interpreter');
      interpreter = { kind: 'env-node', ...node.facts, via: via.facts };
      kind = 'node-script';
    } else if (!match[2] && path.posix.basename(match[1]) === 'node') {
      const node = resolveExecutable(match[1], cwd.realPath, launch.pathValue, io);
      if (!nativeHeader(readHeader(node, io), deps.platform)) fail('unsupported-node-interpreter');
      interpreter = { kind: 'direct-node', ...node.facts };
      kind = 'node-script';
    } else fail('unsupported-shebang');
  } else if (!nativeHeader(header, deps.platform)) fail('unsupported-executable-format');
  return { context, executable: { kind, ...executable.facts }, interpreter };
}

function seal(body) {
  if (Buffer.byteLength(JSON.stringify(body)) > LIMIT.facts - 100) {
    body = { status: 'unqualified', reason: 'facts-budget-exceeded', context: null, executable: null, interpreter: null };
  }
  body = { schemaVersion: 1, ...body };
  return freeze({ ...body, factsDigest: hash(body) });
}

function unqualified(error, context = null) {
  return seal({ status: 'unqualified', reason: error.bindingReason || 'filesystem-error',
    context, executable: null, interpreter: null });
}

function capture(command, args, options, deps) {
  command = string(command);
  if (!command) fail('unsupported-recipe');
  if (!Array.isArray(args) || types.isProxy(args)) fail('unsupported-recipe');
  const length = data(args, 'length');
  if (length !== 2 && length !== 3) fail('unsupported-recipe');
  const copy = Array.from({ length }, (_, index) => data(args, String(index)));
  if (copy[0] !== 'debug' || copy[1] !== 'models' || (length === 3 && copy[2] !== '--bundled')) fail('unsupported-recipe');
  checkDescriptors(options);
  const shell = data(options, 'shell');
  if (shell !== undefined && shell !== false) fail('unsupported-shell');
  if (data(options, 'uid') != null || data(options, 'gid') != null || data(options, 'argv0') != null) fail('unsupported-execution-options');
  const cwdValue = data(options, 'cwd');
  const base = string(deps.cwd());
  if (!path.posix.isAbsolute(base)) fail('ambiguous-cwd');
  const cwd = cwdValue == null ? base : string(cwdValue);
  const rawEnv = data(options, 'env');
  const env = rawEnv == null ? deps.env : rawEnv;
  if (!env || typeof env !== 'object' || types.isProxy(env)) fail('unsupported-input-object');
  const extraLoaderKeys = checkDescriptors(env, true);
  const pathValue = data(env, 'PATH', true);
  if (pathValue !== undefined) string(pathValue, LIMIT.path);
  const loaders = [];
  for (const key of [...new Set([...LOADER_KEYS, ...extraLoaderKeys])].sort()) {
    let value = data(env, key, true);
    // Node propagates its own V8 coverage setting even with explicit child env.
    if (key === 'NODE_V8_COVERAGE') {
      const ambient = data(deps.env, key, true);
      if (ambient && (rawEnv == null || !Object.getOwnPropertyDescriptor(env, key))) value = ambient;
    }
    if (value !== undefined) string(value);
    loaders.push([key, value === undefined ? null : value]);
  }
  const launch = { command, cwd: path.posix.isAbsolute(cwd) ? cwd : base + '/' + cwd,
    pathValue, pathDigest: hash(pathValue === undefined ? null : pathValue),
    loaderContextDigest: hash(loaders),
    recipe: { commandTag: 'codex-debug-models', commandDigest: hash(command), args: copy, shell: false } };
  // Preserve only hashes in an unsupported diagnostic; no raw loader values.
  const context = { recipe: launch.recipe, cwdDigest: null,
    pathDigest: launch.pathDigest, loaderContextDigest: launch.loaderContextDigest };
  if (loaders.some(([, value]) => value)) {
    return { before: unqualified({ bindingReason: 'unsupported-loader-context' }, context), launch: null };
  }
  try { return { before: seal({ status: 'qualified', reason: 'resolved', ...observe(launch, deps) }), launch }; }
  catch (error) { return { before: unqualified(error, context), launch: null }; }
}

// This factory's closure cannot retain caller options/env/args. Only bounded
// resolution scalars survive until the first finish; afterwards even those drop.
function binding(before, launch, deps) {
  let result;
  return Object.freeze({ before, finish() {
    if (result) return result;
    let after = before;
    if (launch && before.status === 'qualified') {
      try { after = seal({ status: 'qualified', reason: 'resolved', ...observe(launch, deps) }); }
      catch (error) { after = unqualified(error); }
    }
    launch = null;
    const matched = before.status === 'qualified' && after.status === 'qualified'
      && before.factsDigest === after.factsDigest;
    result = freeze({ status: matched ? 'qualified' : 'unqualified',
      reason: matched ? 'matched' : after.status === 'qualified' ? 'launch-binding-drift' : after.reason,
      factsDigest: after.factsDigest, matched });
    return result;
  } });
}

// Injections are for finite filesystem fixtures, never for product launch:
// {fs: synchronous fs adapter, cwd: () => absolutePath, env: ambient env,
//  platform: 'darwin'|'linux'}. finish is synchronous, filesystem-only, one-shot.
function beginCatalogLaunchBinding(command, args, options = {}, injections = {}) {
  const deps = { fs: injections.fs || fs, cwd: injections.cwd || (() => process.cwd()),
    env: injections.env || process.env, platform: injections.platform || process.platform };
  let captured;
  try {
    if (!['darwin', 'linux'].includes(deps.platform)) fail('unsupported-platform');
    captured = capture(command, args, options, deps);
  } catch (error) { captured = { before: unqualified(error), launch: null }; }
  // Do not retain even the ambient env through dependency injection/defaults.
  return binding(captured.before, captured.launch, { fs: deps.fs, platform: deps.platform });
}

module.exports = { beginCatalogLaunchBinding };
