'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { EventEmitter } = require('node:events');
const picker = require('./codex-model-picker');
const { planCodexPickerMovement } = require('./codex-runtime-contract');
const main = fs.readFileSync(process.env.CODEX_PICKER_MAIN_SOURCE || require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const catalog = [ { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' } ];

for (const frameDelivery of ['raw', 'raw-before-commit']) test('actual Main picker chooses Terra/Max once via ' + frameDelivery, async () => {
  const events = new EventEmitter(), keys = []; let phase = 'model', selected = 0;
  const mirror = { synchronizedFrameWaiters: new Set() };
  let visible = 'old composer';
  const publish = () => {
    const next = screen();
    if (frameDelivery === 'raw') { visible = next; events.emit('data', next); return; }
    // Deliver the actual post-key/ACK delta, but let the old committed screen
    // remain visible until its later commit. No historical-screen ACK shortcut.
    events.emit('data', next);
    queueMicrotask(() => { visible = next; [...mirror.synchronizedFrameWaiters].forEach(wake => wake()); });
  };
  function screen() {
    if (phase === 'done') return '• Model changed to gpt-6.1-terra max\n› Ask Codex to do anything\ngpt-6.1-terra max · /fixture';
    const lines = phase === 'model' ? [
      'Select Model and Effort', 'Warning: OpenAI base URL is overridden to http://127.0.0.1:4001/codex/t/fixture.', '',
      '1. GPT-6.1-Sol (current)      Latest workhorse model.',
      '2. GPT-6-Astra                Frontier intelligence.',
      '3. GPT-6.1 Terra              GPT-6.1 Terra Codex model.',
    ] : phase === 'effort' ? ['Select Reasoning Level', '1. Low', '2. Medium', '3. High', '4. More reasoning']
      : ['Advanced Reasoning', '1. Max', '2. Ultra'];
    let ordinal = 0;
    return [...lines.map(line => /^\d+\./.test(line) ? ((ordinal++ === selected ? '› ' : '  ') + line) : line),
      '', 'enter select · esc back'].join('\n');
  }
  const term = { onData(fn) { events.on('data', fn); return { dispose: () => events.removeListener('data', fn) }; },
    write(value) {
      keys.push(value);
      if (value === '\x1b[B') selected++;
      else if (value === '\x1b[A') selected--;
      else if (value === '\r') { phase = phase === 'model' ? 'effort' : phase === 'effort' ? 'advanced' : 'done'; selected = 0; }
      publish();
    } };
  const context = vm.createContext({ ...picker, planCodexPickerMovement,
    setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 80)), clearTimeout,
    CODEX_SYNC_MARKER: '\x1b[?2026l', cleanCodexTuiFrame: text => text,
    console: { log() {}, warn() {} }, codexSettingsMutationQueue: { getUnsubmittedInput: () => null },
    readCodexAuthoritativeScreen: async () => ({ success: true, clean: visible }),
    getHeadlessTerminalMirror: () => mirror,
    waitForCodexModelEffortConfig: async () => ({ success: true, source: 'controlled-config-proof' }),
    sendCodexSlashCommand: async (_term, command, _log, options) => {
      assert.equal(command, '/model'); assert.equal(options.writeGuard('slash-command-paste').allowed, true);
      options.onBeforeEnter(); setImmediate(publish);
      return { success: true, submitted: true };
    },
    closeCodexPickerToComposer: async () => ({ success: true }),
  });
  const functions = ['captureCodexFrame', 'readCodexPickerWriteRefusal', 'sendCodexKeyAndCapture',
    'codexModelEffortConfirmationObservedInFrame', 'moveCodexPickerTo', 'selectCodexPickerItem',
    'latestCodexSynchronizedFrameText', 'currentCodexPickerFrameText', 'ensureCodexPickerFrame', 'selectCodexModelEffort'];
  vm.runInContext(functions.map(declaration).join('\n'), context);
  const result = await context.selectCodexModelEffort(term, { tabId: 'T', model: 'gpt-6.1-terra', effort: 'max',
    hasDraft: false, modelCatalog: catalog, writeGuard: () => ({ allowed: true }), configPath: '/fixture/config.toml' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.model, 'gpt-6.1-terra'); assert.equal(result.effort, 'max');
  assert.deepEqual(keys, ['\x1b[B', '\x1b[B', '\r', '\x1b[B', '\x1b[B', '\x1b[B', '\r', '\r']);
  assert.equal(events.listenerCount('data'), 0);
  assert.equal(mirror.synchronizedFrameWaiters.size, 0);
});
