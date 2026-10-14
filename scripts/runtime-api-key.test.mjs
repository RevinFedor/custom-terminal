import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { getGeminiApiKey } from '../src/renderer/utils/geminiApiKey.mjs';

test('actual settings registration exposes only the runtime Gemini key', () => {
  const filename = new URL('../src/main/ipc/settings.js', import.meta.url);
  const require = createRequire(filename);
  const handlers = new Map();
  const env = { GEMINI_API_KEY: 'synthetic-local-value', SONIOX_API_KEY: 'another-value' };
  const module = { exports: {} };
  const electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'electron' ? electron : require(name), module, exports: module.exports,
    process: { env }, console, __dirname: new URL('../src/main/ipc/', import.meta.url).pathname,
  });
  module.exports.register({ projectManager: {} });
  const read = handlers.get('settings:get-gemini-api-key');
  assert.equal(typeof read, 'function');
  assert.equal(read({}, { name: 'SONIOX_API_KEY' }), 'synthetic-local-value');
  env.GEMINI_API_KEY = 'updated-runtime-value';
  assert.equal(read(), 'updated-runtime-value');
  delete env.GEMINI_API_KEY;
  assert.equal(read(), '');
});

test('renderer uses local IPC without a provider or build-time environment', async () => {
  const calls = [];
  const ipc = { invoke: async (...args) => { calls.push(args); return 'synthetic-runtime-value'; } };
  assert.equal(await getGeminiApiKey(ipc), 'synthetic-runtime-value');
  assert.deepEqual(calls, [['settings:get-gemini-api-key']]);
  assert.equal(await getGeminiApiKey({ invoke: async () => null }), '');
});
