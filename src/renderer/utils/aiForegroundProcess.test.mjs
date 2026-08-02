import test from 'node:test';
import assert from 'node:assert/strict';
import { isAiForegroundProcess } from './aiForegroundProcess.mjs';

const child = (processName, command) => ({ hasProcess: true, processName, command });

test('codex launched through its bin shim is recognised as the agent', () => {
  // Measured live: the shell's first child is the node launcher, not the
  // vendor binary. This is the case that made middle-click ask for
  // confirmation on an idle Codex tab.
  assert.equal(
    isAiForegroundProcess(child('node', 'node /opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox')),
    true,
  );
});

test('codex vendor binary and package path are recognised', () => {
  assert.equal(
    isAiForegroundProcess(child(
      '/opt/homebrew/li',
      '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    )),
    true,
  );
  assert.equal(isAiForegroundProcess(child('codex-code-mode-host', '/usr/local/bin/codex-code-mode-host')), true);
});

test('claude and gemini are recognised in bare and path form', () => {
  assert.equal(isAiForegroundProcess(child('claude', 'claude')), true);
  assert.equal(isAiForegroundProcess(child('node', 'node /Users/fedor/.claude/local/bin/claude --resume abc')), true);
  assert.equal(isAiForegroundProcess(child('gemini', '/opt/homebrew/bin/gemini')), true);
});

test('an ordinary process in an AI tab still requires confirmation', () => {
  // These must stay false — closing them kills work the user started by hand.
  assert.equal(isAiForegroundProcess(child('node', 'npm run dev')), false);
  assert.equal(isAiForegroundProcess(child('node', 'node scripts/build.js')), false);
  assert.equal(isAiForegroundProcess(child('vite', 'vite --port 5182')), false);
  assert.equal(isAiForegroundProcess(child('bash', 'bash deploy.sh')), false);
});

test('a name that merely contains an agent word is not the agent', () => {
  assert.equal(isAiForegroundProcess(child('node', 'node mycodex-runner.js')), false);
  assert.equal(isAiForegroundProcess(child('tail', 'tail -f claudelog.txt')), false);
  assert.equal(isAiForegroundProcess(child('node', 'node build-gemini-assets.js')), false);
});

test('an agent name adjacent to a separator still counts', () => {
  // `codex.js`, `claude-wrapper` invoked as the executable itself.
  assert.equal(isAiForegroundProcess(child('node', 'node /usr/local/bin/codex.js')), true);
  assert.equal(isAiForegroundProcess(child('claude-code', '/usr/local/bin/claude-code')), true);
});

test('no process means nothing to confirm', () => {
  assert.equal(isAiForegroundProcess({ hasProcess: false }), false);
  assert.equal(isAiForegroundProcess(null), false);
  assert.equal(isAiForegroundProcess(undefined), false);
  assert.equal(isAiForegroundProcess(child('', '')), false);
});
