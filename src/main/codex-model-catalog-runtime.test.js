'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const childEnv = require('./child-process-env');
const accounts = require('./codex-account-profiles');
const { projectConfiguredAgentModels } = require('./agent-provider-model-contract');
const { mergeCodexModelOptions, projectCodexModelOptions } = require('../shared/codex-model-catalog.cjs');

const source = fs.readFileSync(require.resolve('./ipc/codex-data'), 'utf8');
const ast = ts.createSourceFile('codex-data.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
};
const rawModels = [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list',
    default_reasoning_level: 'high', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { slug: 'future-account-model', display_name: 'Future model', visibility: 'list',
    default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'high'] },
  { slug: 'hidden-provider-model', visibility: 'hide' },
];

function harness({ liveFailure = false, bundledFailure = false } = {}) {
  // Actual GUI host environment observed 11.09: no npm/Homebrew/user CLI dirs.
  const guiEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: '/tmp/catalog-test-home',
    ANTHROPIC_ADMIN_API_KEY: 'must-not-leave-main' };
  const calls = [], logs = [];
  const context = vm.createContext({
    process: { env: guiEnv },
    buildChildProcessEnv: overrides => childEnv.buildChildProcessEnv(overrides, guiEnv),
    buildCodexProcessPath: () => accounts.buildCodexProcessPath(guiEnv),
    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    console: { log: line => logs.push(line), warn: line => logs.push(line) },
    execFile: (command, args, options, callback) => {
      calls.push({ command, args: [...args], options });
      const paths = options.env.PATH.split(path.delimiter);
      const cliFound = paths.includes(path.join(os.homedir(), '.local', 'bin'));
      const failed = !cliFound || (args.includes('--bundled') ? bundledFailure : liveFailure);
      setImmediate(() => callback(failed ? Object.assign(new Error('catalog unavailable'), {
        code: cliFound ? 'EFAIL' : 'ENOENT',
      }) : null, failed ? '' : JSON.stringify({ models: rawModels })));
    },
  });
  vm.runInContext('let modelCache = null; let modelCacheInflight = null; const MODEL_CACHE_TTL_MS = 300000;\n'
    + ['normalizeCodexModel', 'parseCodexModelsCatalog', 'listCodexModels'].map(declaration).join('\n')
    + '\nglobalThis.readCatalog = listCodexModels;', context);
  return { read: () => context.readCatalog(), calls, logs, guiEnv };
}

test('actual catalog reader discovers Astra from the minimal GUI environment, not the old fallback', async () => {
  const h = harness();
  const models = JSON.parse(JSON.stringify(await h.read()));
  assert.deepEqual(models.map(model => model.id), ['gpt-6-astra', 'future-account-model']);
  assert.equal(h.calls.length, 1);
  const env = h.calls[0].options.env;
  assert.ok(env.PATH.indexOf('/.local/bin') < env.PATH.indexOf('/opt/homebrew/bin'),
    'same user CLI priority as account probes; the observed Homebrew CLI was older');
  assert.equal(env.CODEX_HOME, h.guiEnv.CODEX_HOME);
  assert.equal(env.ANTHROPIC_ADMIN_API_KEY, undefined);
  assert.equal(h.guiEnv.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'host env is never rewritten');
  assert.ok(h.logs.some(line => line.includes('source=live')));

  const configuredSettings = { models: [{ id: 'gpt-5.5', label: 'Old hidden row', visible: false }], removedModelIds: [] };
  const external = projectConfiguredAgentModels({ liveModels: models, configuredSettings });
  const desktop = projectCodexModelOptions(mergeCodexModelOptions(models, configuredSettings.models, []));
  assert.deepEqual(external, desktop);
  assert.ok(external.some(model => model.id === 'gpt-6-astra'));
  assert.deepEqual(projectConfiguredAgentModels({ liveModels: models,
    configuredSettings: { ...configuredSettings, removedModelIds: ['gpt-6-astra'] },
  }).map(model => model.id), ['future-account-model'], 'explicit user removal still wins');
});

test('bundled retry uses the same resolved CLI environment and reports the live failure', async () => {
  const h = harness({ liveFailure: true });
  assert.ok((await h.read()).some(model => model.id === 'gpt-6-astra'));
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.env.PATH, h.calls[0].options.env.PATH);
  assert.ok(h.logs.some(line => line.includes('source=bundled')));
  assert.ok(h.logs.some(line => line.includes('live') && line.includes('EFAIL')));
});

test('a genuine CLI failure retains compatibility fallback but is no longer silent', async () => {
  const h = harness({ liveFailure: true, bundledFailure: true });
  const models = await h.read();
  assert.ok(models.some(model => model.id === 'gpt-5.6-sol'));
  assert.ok(h.logs.some(line => line.includes('source=builtin-fallback')));
  assert.ok(h.logs.some(line => line.includes('bundled') && line.includes('EFAIL')));
});

test('many desktop/API catalog consumers still share one process request and its TTL cache', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 40 }, () => h.read()));
  assert.equal(h.calls.length, 1);
  assert.ok(results.every(result => result === results[0]));
  assert.equal(await h.read(), results[0]);
  assert.equal(h.calls.length, 1);
});
