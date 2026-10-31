'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeAgentDefaultEffort } = require('./agent-default-effort.cjs');

test('unset global Claude/Codex effort is low; concrete saved choices survive', () => {
  for (const provider of ['claude', 'codex']) {
    for (const value of [undefined, null, '', '  ', 'none', 'default', 'auto']) {
      assert.equal(normalizeAgentDefaultEffort(value, provider), 'low');
    }
    for (const value of ['low', 'medium', 'high', 'max', 'custom-effort']) {
      assert.equal(normalizeAgentDefaultEffort(value, provider), value);
    }
  }
  assert.equal(normalizeAgentDefaultEffort('ultracode', 'claude'), 'ultracode');
  assert.equal(normalizeAgentDefaultEffort('ultra', 'codex'), 'low', 'conversation-only option is not a durable default');
});

test('actual Main default reader applies low without changing model none or swallowing read errors into a preference', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const code = main.slice(main.indexOf('function readDefaultCodexSetting(key)'), main.indexOf('\nfunction tomlString(', main.indexOf('function readDefaultCodexSetting(key)')));
  let value = 'none', failure = false;
  const context = { normalizeAgentDefaultEffort, projectManager: { db: { getAppState() { if (failure) throw Error('read failed'); return value; } } } };
  vm.runInNewContext(code + '\nthis.read = readDefaultCodexSetting;', context);
  assert.equal(context.read('defaultCodexEffort'), 'low');
  assert.equal(context.read('defaultCodexModel'), null);
  value = 'max'; assert.equal(context.read('defaultCodexEffort'), 'max');
  failure = true; assert.equal(context.read('defaultCodexEffort'), null);
});

test('actual StatusBar effort list cannot select or click-toggle back to none; model none remains', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/components/StatusBar.tsx'), 'utf8');
  const start = source.indexOf('function defaultEffortLevels(');
  const helper = source.slice(start, source.indexOf('\nfunction EngineDefaultsSelector', start));
  const js = require('esbuild').transformSync(helper, { loader: 'ts', format: 'cjs' }).code;
  const context = {}; vm.runInNewContext(js + '\nthis.levels = defaultEffortLevels;', context);
  assert.deepEqual([...context.levels('none', ['none', 'default', 'low', 'high'])], ['low', 'high']);
  assert.match(source, /onSelect=\{\(level\) => onEffortSelect\(level\)\}/);
  assert.match(source, /push\(\{ id: 'none', label: 'none' \}\)/, 'independent model preference remains available');
});

test('late SQLite hydration cannot reset a newer global effort selection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/store/useUIStore.ts'), 'utf8');
  for (const provider of ['Claude', 'Codex']) {
    const key = `default${provider}Effort`;
    let code;
    if (provider === 'Claude') code = source.slice(source.indexOf("const APP_STATE_KEY_EFFORT = 'defaultClaudeEffort'"), source.indexOf("const APP_STATE_KEY_MODEL = 'defaultClaudeModel'"));
    else code = "const APP_STATE_KEY_CODEX_EFFORT = 'defaultCodexEffort'; let defaultCodexEffortRevision = 0;\n"
      + source.slice(source.indexOf('const normalizePersistentCodexEffort ='), source.indexOf('// Main owns the durable transaction for native Codex model migration.'));
    let resolveRead;
    const get = new Promise(resolve => { resolveRead = resolve; });
    const state = { [key]: 'low' };
    const storage = new Map();
    const context = { normalizeAgentDefaultEffort, localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      window: { require: () => ({ ipcRenderer: { invoke: (channel) => channel === 'app:getState' ? get : Promise.resolve() } }) },
      useUIStore: { getState: () => state, setState: patch => Object.assign(state, patch) } };
    const select = `\nthis.choose = value => { useUIStore.setState({ ${key}: value }); saveDefault${provider}Effort(value); };`;
    vm.runInNewContext(require('esbuild').transformSync(code, { loader: 'ts', format: 'cjs' }).code + select, context);
    context.choose('max'); resolveRead('none');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state[key], 'max', provider);
  }
});
