const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function load(t, { result, env = {} }) {
  const filename = path.join(__dirname, 'semantic-index-status.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const launches = [];
  const errors = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-index-ipc-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'one.md'), '# One\nSynthetic document');
  fs.writeFileSync(path.join(root, '.semantic-index.json'), '[]');
  const spawn = (command, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => true;
    const messages = [];
    launches.push({ command, args, options, messages });
    proc.stdin = { write(line) { messages.push(JSON.parse(line)); }, end() {
      queueMicrotask(() => {
        proc.stderr.write('__KNOWLEDGE_REINDEX_PROGRESS__' + JSON.stringify({
          phase: 'failed', workTotal: 1, completed: 1, active: 0, file: 'docs/one.md', workerLimit: 1,
        }) + '\n');
        proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        } }) + '\n');
      });
    } };
    return proc;
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.test = { startWatching, stopWatching, rebuildIndex };', {
    module, exports: module.exports, __dirname,
    require(name) {
      if (name === 'electron') return { ipcMain: { handle() {} } };
      if (name === 'child_process') return { spawn };
      if (name === '../child-process-env') return { buildChildProcessEnv: overrides => ({ ...env, ...overrides }) };
      return realRequire(name);
    },
    process: { env, on() {} }, setTimeout, clearTimeout, queueMicrotask,
    console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
  }, { filename });
  const api = module.exports.test;
  t.after(() => { api.stopWatching('P'); fs.rmSync(root, { recursive: true, force: true }); });
  return { api, root, launches, errors };
}

test('actual rebuild leaves model default to MCP and exposes failed file, model and live progress', async t => {
  const failure = "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.";
  const h = load(t, { result: { success: false, provider: 'codex', model: 'gpt-5.4-mini',
    error: 'codex reindex completed with 1 indexing errors', failures: [{ path: 'docs/one.md', error: failure }],
    summary: 'Files indexed: 0/1 (cached: 0, skip: 0, warn: 0, err: 1)' } });
  const messages = [];
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const win = { isDestroyed: () => false, webContents: { send(channel, data) {
    messages.push({ channel, data }); if (channel === 'semantic-index:rebuild-done') done(data);
  } } };
  h.api.startWatching('P', h.root, win);
  assert.equal(h.api.rebuildIndex('P', win, { parallelism: 99 }).success, true);
  const result = await finished;
  assert.equal(h.launches.length, 1);
  assert.equal(Object.hasOwn(h.launches[0].options.env, 'KNOWLEDGE_CODEX_MODEL'), false);
  const args = h.launches[0].messages[1].params.arguments;
  assert.equal(args.parallel, 20);
  assert.equal(args.projectPath, h.root);
  assert.equal(Object.hasOwn(args, 'model'), false);
  assert.equal(result.success, false, 'completed does not turn a failed MCP result into success');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.projectPath, h.root);
  assert.equal(result.stats.failedFiles[0], 'docs/one.md:' + failure);
  assert.ok(messages.some(m => m.channel === 'semantic-index:progress' && m.data.outdatedCompleted === 1));
  assert.ok(h.errors.some(line => line.includes(failure) && line.includes('docs/one.md')));
  assert.equal(fs.readFileSync(path.join(h.root, '.semantic-index.json'), 'utf8'), '[]');
});

test('explicit model override survives; a real successful result produces success', async t => {
  const h = load(t, { env: { KNOWLEDGE_CODEX_MODEL: 'explicit-user-model' },
    result: { success: true, provider: 'codex', model: 'explicit-user-model', summary: 'Files indexed: 1/1 (cached: 0, skip: 0, warn: 0, err: 0)' } });
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  const win = { isDestroyed: () => false, webContents: { send(channel, data) {
    if (channel === 'semantic-index:rebuild-done') done(data);
  } } };
  h.api.startWatching('P', h.root, win);
  h.api.rebuildIndex('P', win);
  assert.equal((await finished).success, true);
  assert.equal(h.launches[0].options.env.KNOWLEDGE_CODEX_MODEL, 'explicit-user-model');
  assert.equal(h.errors.length, 0);
});
