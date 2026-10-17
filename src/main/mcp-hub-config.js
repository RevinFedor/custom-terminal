'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { buildChildProcessEnv } = require('./child-process-env');

const HUB_NAMES = Object.freeze(['terminal', 'knowledge', 'browser', 'electron', 'ios', 'sc-desktop']);
const OPTIONAL_NAMES = HUB_NAMES.slice(2);
const CONFIG_HEADER = 'x-noted-mcp-configuration';
const EXPECTED_CONFIG_ENV = 'NOTED_MCP_EXPECTED_CONFIGURATION';
const MAX_BYTES = 64 * 1024;
const bindingKey = name => name === 'sc-desktop' ? 'NOTED_SC_DESKTOP_MCP_COMMAND'
  : 'NOTED_' + name.toUpperCase() + '_MCP_PATH';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Read one bounded regular-file snapshot; never repair, chmod or overwrite it.
function readProfile(file, io) {
  let fd;
  try {
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = io.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) fail('profile_invalid');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const count = io.readSync(fd, buffer, size, buffer.length - size, null);
      size += count;
      if (size > MAX_BYTES) fail('profile_invalid');
      if (!count) break;
    }
    const after = io.fstatSync(fd, { bigint: true });
    const current = io.lstatSync(file, { bigint: true });
    const same = other => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === other[key]);
    if (!same(after) || !same(current) || BigInt(size) !== before.size) fail('profile_changed');
    let value;
    try { value = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { fail('profile_invalid'); }
    if (!object(value) || value.version !== 1 || !object(value.servers)
      || Object.keys(value).some(key => !['version', 'servers'].includes(key))
      || Object.keys(value.servers).some(name => !HUB_NAMES.includes(name))) fail('profile_invalid');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' && fd === undefined) return null;
    if (['profile_changed', 'profile_invalid'].includes(error.code)) throw error;
    fail('profile_unreadable');
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

function normalize(name, value) {
  if (!object(value) || typeof value.enabled !== 'boolean'
    || Object.keys(value).some(key => !['enabled', 'command', 'args', 'env', 'stateful', 'reapMarker'].includes(key))) {
    fail('entry_invalid');
  }
  if (!value.enabled) return null;
  if (!text(value.command) || !Array.isArray(value.args) || value.args.length > 128
    || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || (value.stateful !== undefined && typeof value.stateful !== 'boolean')
    || (value.env !== undefined && (!object(value.env) || Object.entries(value.env).some(([key, val]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== 'string' || val.includes('\0'))))
    || (value.reapMarker !== undefined && (!text(value.reapMarker) || !path.isAbsolute(value.reapMarker)))) {
    fail('entry_invalid');
  }
  return { command: value.command, args: [...value.args], env: buildChildProcessEnv({}, value.env || {}),
    stateful: value.stateful ?? ['electron', 'ios'].includes(name),
    ...(value.reapMarker !== undefined ? { reapMarker: value.reapMarker } : {}) };
}

function validatePaths(def, io) {
  // Reaping is destructive: a directory/prefix cannot identify one server.
  if (def.reapMarker && !io.statSync(def.reapMarker).isFile()) fail('path_invalid');
  if (def.command.includes('/') && !path.isAbsolute(def.command)) fail('path_invalid');
  if (path.isAbsolute(def.command)) {
    if (!io.statSync(def.command).isFile()) fail('path_invalid');
    io.accessSync(def.command, fs.constants.X_OK);
  }
  if (/^node(?:js)?(?:\.exe)?$/i.test(path.basename(def.command)) && def.args[0] && !def.args[0].startsWith('-')) {
    if (!path.isAbsolute(def.args[0]) || !io.statSync(def.args[0]).isFile()) fail('path_invalid');
    io.accessSync(def.args[0], fs.constants.R_OK);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}

function resolveHubConfiguration(source = process.env, { home = source.HOME || os.homedir(), io = fs } = {}) {
  const serverDefs = {};
  const entries = [];
  let profile;
  let error = null;
  try { profile = readProfile(path.join(home, '.noted-terminal', 'mcp-hub.json'), io); }
  catch (failure) { error = failure.code; }
  if (!error) for (const name of HUB_NAMES) {
    const entry = profile?.servers[name];
    const override = source[bindingKey(name)];
    let def;
    let origin = 'profile';
    try {
      if (entry !== undefined) {
        def = normalize(name, entry);
        if (!def) { entries.push({ name, state: 'disabled', source: origin }); continue; }
        const equivalent = name === 'sc-desktop' ? def.command === override
          : def.command === 'node' && def.args[0] === override;
        if (override !== undefined && !equivalent) fail('override_conflict');
        if (name === 'sc-desktop' && source.NOTED_SC_DESKTOP_MCP_REAP_MARKER !== undefined
          && source.NOTED_SC_DESKTOP_MCP_REAP_MARKER !== def.reapMarker) fail('override_conflict');
      } else {
        // Profiles own named entries, not absent neighbours. A partial profile
        // must preserve an existing explicit ENV binding; disable is deliberate
        // enabled:false, never inferred from omission during a staged migration.
        origin = override !== undefined ? 'environment' : 'default';
        const file = override !== undefined ? override
          : OPTIONAL_NAMES.includes(name) ? null : path.join(home, '.claude/mcp', name + '-server.mjs');
        if (file === null) { entries.push({ name, state: 'unconfigured', source: origin }); continue; }
        if (origin === 'default' && !io.existsSync(file)) {
          entries.push({ name, state: 'not_installed', source: origin }); continue;
        }
        if (!text(file) || !path.isAbsolute(file)) fail('path_invalid');
        def = normalize(name, { enabled: true, command: name === 'sc-desktop' ? file : 'node',
          args: name === 'sc-desktop' ? [] : [file],
          ...(name === 'sc-desktop' && source.NOTED_SC_DESKTOP_MCP_REAP_MARKER !== undefined
            ? { reapMarker: source.NOTED_SC_DESKTOP_MCP_REAP_MARKER } : {}),
          env: name === 'knowledge' ? {
            KNOWLEDGE_DISABLE_GEMINI: 'true', KNOWLEDGE_DISABLE_CLAUDE_P: 'true',
            KNOWLEDGE_ROUTER_PROVIDER: 'codex', KNOWLEDGE_CODEX_MODEL: source.KNOWLEDGE_CODEX_MODEL || 'gpt-5.6-luna',
            KNOWLEDGE_CODEX_EFFORT: 'low', KNOWLEDGE_INDEX_PROVIDER: 'codex',
          } : {},
        });
      }
      validatePaths(def, io);
      serverDefs[name] = def;
      entries.push({ name, state: 'configured', source: origin });
    } catch (failure) {
      entries.push({ name, state: 'invalid', source: origin,
        error: ['entry_invalid', 'override_conflict'].includes(failure.code) ? failure.code : 'path_invalid' });
    }
  }
  const status = { error, entries, needsReview: !!error || entries.some(entry =>
    ['invalid', 'unconfigured'].includes(entry.state)) };
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ serverDefs, status }))).digest('hex');
  return { serverDefs, status, fingerprint, canLaunch: !error };
}

module.exports = { HUB_NAMES, CONFIG_HEADER, EXPECTED_CONFIG_ENV, resolveHubConfiguration };
