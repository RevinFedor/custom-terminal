import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { classifyQueuedCodexSettingsIntent } from './promptQueueCodexSettingsIntent.mjs';

const source = fs.readFileSync(new URL('../hooks/usePromptQueueRunner.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node)
  && node.name?.text === 'applyQueuedCodexModelEffort')?.getText(ast);
assert.ok(fn, 'applyQueuedCodexModelEffort source');
const compiled = ts.transpileModule(fn, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(initialState) {
  let state = initialState;
  const listeners = new Set();
  const ipcRenderer = {
    on(channel, listener) {
      if (channel === 'provider:state-changed') listeners.add(listener);
    },
    removeListener(channel, listener) {
      if (channel === 'provider:state-changed') listeners.delete(listener);
    },
    async invoke(channel) {
      if (channel === 'codex:set-model-effort-intent') {
        return { success: true, intentRevision: 8, providerState: state };
      }
      if (channel === 'provider:get-status') return state;
      if (channel === 'codex:get-runtime-session') {
        return { liveLifecycle: true, provenWriterSessionId: 'writer' };
      }
      throw new Error('unexpected IPC ' + channel);
    },
  };
  const context = vm.createContext({
    ipcRenderer,
    classifyQueuedCodexSettingsIntent,
    CODEX_QUEUE_SETTINGS_TIMEOUT_MS: 500,
    setTimeout,
    clearTimeout,
    console: { warn() {} },
  });
  vm.runInContext(compiled, context);
  return {
    apply: () => context.applyQueuedCodexModelEffort('tab', 'gpt-6-astra', 'max'),
    publish(next) {
      state = next;
      for (const listener of listeners) listener({}, { tabId: 'tab', state });
    },
  };
}

const pending = {
  codexSettingsIntentRevision: 8,
  codexSettingsIntentModel: 'gpt-6-astra',
  codexSettingsIntentEffort: 'max',
  codexSettingsIntentError: 'codex_settings_observation_changed',
};

test('Run After waits through a retryable intent error and settles on exact applied owner', async () => {
  const h = harness(pending);
  const result = h.apply();
  setTimeout(() => h.publish({
    ...pending,
    codexSettingsIntentError: null,
    codexSettingsIntentAppliedRevision: 8,
    codexSettingsIntentAppliedOwnerId: 'writer',
  }), 10);
  await result;
});

test('an error attached to an already-applied revision remains terminal', async () => {
  const h = harness({
    ...pending,
    codexSettingsIntentAppliedRevision: 8,
    codexSettingsIntentAppliedOwnerId: 'writer',
    codexSettingsIntentError: 'native-settings-persistence-failed',
  });
  await assert.rejects(h.apply(), /native-settings-persistence-failed/);
});
