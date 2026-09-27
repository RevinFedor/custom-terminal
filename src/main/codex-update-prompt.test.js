'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideCodexUpdatePromptAction,
  decideCodexUpdatePromptDismissal,
  inspectCodexUpdatePrompt,
} = require('./codex-update-prompt');

const firstSelected = [
  '✨ Update available! 0.146.0 -> 0.147.0',
  '',
  '› 1. Update now',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  'Press enter to continue',
].join('\n');

const secondSelected = firstSelected
  .replace('› 1. Update now', '  1. Update now')
  .replace('  2. Skip', '› 2. Skip');

const boundary = {
  sameTerminal: true,
  sameRunSeq: true,
  sameInputRevision: true,
  screenAvailable: true,
};

const currentUpdate = [
  'Update available · 0.156.1 → 0.157.1',
  'Release notes:',
  'https://github.com/openai/codex/releases/latest',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  'enter continue · esc skip',
].join('\n');

test('captured 0.156.1 compact footer preserves the same select-Skip then confirm protocol', () => {
  assert.equal(decideCodexUpdatePromptAction({ ...boundary, cleanText: currentUpdate }).action, 'select-skip');
  const selected = currentUpdate.replace('› 1.', '  1.').replace('  2. Skip', '› 2. Skip');
  assert.equal(decideCodexUpdatePromptAction({ ...boundary, cleanText: selected }).action, 'confirm-skip');
  for (const text of [
    currentUpdate.replace('  3. Skip until next version', ''),
    currentUpdate.replace('enter continue · esc skip', 'enter continue'),
    currentUpdate.replace('› 1.', '  1.').replace('  3.', '› 3.'),
    currentUpdate + '\n› normal user composer',
  ]) assert.equal(decideCodexUpdatePromptAction({ ...boundary, cleanText: text }).allowed, false);
});

test('actual main update handler verifies selected Skip before its only Enter', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const ast = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'performCodexStartupUpdateAutoSkip');
  for (const changeInput of [false, true]) {
    const term = {}, state = {}, writes = []; let input = 1;
    const context = { decideCodexUpdatePromptAction, decideCodexUpdatePromptDismissal,
      console: { log() {} }, terminals: new Map([['T', term]]),
      terminalCommandState: new Map([['T', { runSeq: 2 }]]),
      getTerminalInputRevision: () => input, codexStartupAutoEnter: new Map([['T', state]]),
      readCodexAuthoritativeScreen: async () => ({ success: true, clean: currentUpdate }),
      sendCodexKeyAndCapture: async (_term, key, _timeout, _log, predicate, options) => {
        const guard = options.writeGuard('fixture');
        if (!guard.allowed) return { writeAborted: true, error: guard.reason };
        writes.push(key);
        const clean = key === '\x1b[B'
          ? currentUpdate.replace('› 1.', '  1.').replace('  2. Skip', '› 2. Skip')
          : '› Ask Codex to do anything\ngpt-6-sol max';
        assert.equal(predicate(clean), true);
        if (changeInput) input++;
        return { clean, timedOut: false };
      },
    };
    const run = vm.runInNewContext(node.getText(ast) + '\nperformCodexStartupUpdateAutoSkip', context);
    const result = await run({ tabId: 'T', state, expectedTerm: term, expectedRunSeq: 2, expectedInputRevision: 1 });
    assert.equal(result.success, !changeInput);
    assert.deepEqual(writes, changeInput ? ['\x1b[B'] : ['\x1b[B', '\r']);
  }
});

test('fresh, materialized-fresh and Resume use the same current update detector', () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const ast = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
  const context = vm.createContext({
    inspectCodexUpdatePrompt, console: { log() {} },
    codexStartupAutoEnter: new Map(), codexStartupPromptManualOwnershipTabs: new Set(),
    clearCodexStartupAutoEnter() {}, scheduleCodexStartupAutoEnterTimeout() {}, queueMicrotask() {},
    CODEX_STARTUP_AUTO_ENTER_TTL_MS: 45000, CODEX_TRUST_PROMPT_AUTO_ENTER_TTL_MS: 15000,
  });
  for (const name of ['armCodexStartupAutoEnter', 'isCodexUpdatePrompt', 'detectCodexStartupAutoEnterPrompt']) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    vm.runInContext(node.getText(ast), context);
  }
  for (const launch of [
    { command: 'codex' },
    { command: 'codex-c', sessionId: 'new-materialized-session' },
    { command: 'codex-c', sessionId: 'existing-session' },
  ]) {
    context.armCodexStartupAutoEnter('T', launch);
    const state = context.codexStartupAutoEnter.get('T');
    assert.equal(context.detectCodexStartupAutoEnterPrompt(currentUpdate, state), 'update-available');
  }
});

test('requires selecting Skip before confirming the update modal', () => {
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: firstSelected,
  }).action, 'select-skip');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: secondSelected,
  }).action, 'confirm-skip');
});

test('does not write against a changed lifecycle, input, or incomplete modal', () => {
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    sameTerminal: false,
    cleanText: firstSelected,
  }).reason, 'terminal-changed');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    sameRunSeq: false,
    cleanText: firstSelected,
  }).reason, 'run-changed');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    sameInputRevision: false,
    cleanText: firstSelected,
  }).reason, 'input-changed');
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: firstSelected.replace('Press enter to continue', ''),
  }).allowed, false);
});

test('third option and old scrollback never authorize automatic input', () => {
  const thirdSelected = firstSelected
    .replace('› 1. Update now', '  1. Update now')
    .replace('  3. Skip until next version', '› 3. Skip until next version');
  assert.equal(inspectCodexUpdatePrompt(thirdSelected).canAutoSkip, false);

  const oldModalWithNewComposer = firstSelected
    + '\n\n› Implement {feature}\ngpt-5.6-sol max · Full Access';
  assert.equal(decideCodexUpdatePromptAction({
    ...boundary,
    cleanText: oldModalWithNewComposer,
  }).allowed, false);
});

test('Enter is acknowledged only after the interactive modal disappears', () => {
  assert.equal(decideCodexUpdatePromptDismissal({
    ...boundary,
    cleanText: secondSelected,
  }).reason, 'prompt-still-visible');
  assert.deepEqual(decideCodexUpdatePromptDismissal({
    ...boundary,
    cleanText: '› Implement {feature}\ngpt-5.6-sol max · Full Access',
  }).allowed, true);
});
