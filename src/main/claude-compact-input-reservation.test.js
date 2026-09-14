const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { submitWithClaudeLocalCommandLifecycle } = require('./claude-local-command-submission');
const { bindClaudeLocalCommandInputReservation, classifyClaudeLocalCommandOwner } = require('./claude-local-command-proof');

test('actual safePaste input reservation belongs to the compact watcher, not a foreign writer', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = text.indexOf('async function safePasteAndSubmit(');
  const end = text.indexOf('async function finishSafePasteAfterWrite(', start);
  assert.ok(start > 0 && end > start);
  let revision = 6;
  const terminal = { write() {} };
  const current = () => ({ terminal, sessionId: 'S', generation: 'launch1', inputRevision: revision });
  let active;
  const context = {
    assertKnownEmptySend: () => null, isLocalSlashCommandPrompt: () => true,
    console, findTabIdForTerm: () => 'A', getTerminalInputRevision: () => revision,
    bumpTerminalInputRevision: () => ++revision,
    withPtyWriteLock: async (_term, run) => run(),
    reserveClaudeExactEmptyEvidence: () => null,
    terminalCommandState: new Map([['A', { runSeq: 1 }]]),
    getTerminalLifecycleGeneration: () => 'pty1', getHeadlessTerminalMirror: () => ({ generation: 'mirror1' }),
    _safePasteAndSubmitInner: async (_term, _content, options) => {
      assert.equal(options.expectedInputRevision, 7);
      return { submitted: true, success: true };
    },
    finishSafePasteAfterWrite: async (_term, _content, _options, _operation, result) => result,
  };
  vm.createContext(context); vm.runInContext(text.slice(start, end), context);
  await submitWithClaudeLocalCommandLifecycle({ command: '/compact',
    prepare: () => ({ owner: current(), offset: 628754 }),
    submit: (preparation) => context.safePasteAndSubmit(terminal, '/compact', {
      onInputRevisionReserved: (reservation) => {
        assert.equal(bindClaudeLocalCommandInputReservation(preparation, reservation, current()), true);
      },
    }),
    activate: (preparation) => { active = preparation; },
  });
  assert.equal(active.offset, 628754, 'pre-paste transcript boundary must survive the reservation');
  assert.equal(classifyClaudeLocalCommandOwner(active.owner, current()).matches, true);
  revision += 1;
  assert.equal(classifyClaudeLocalCommandOwner(active.owner, current()).reason, 'input-generation-changed');
});

test('reservation cannot adopt an intervening writer, different session or replacement process', () => {
  const terminal = {};
  const owner = { terminal, sessionId: 'S', generation: 'G', inputRevision: 6 };
  for (const [reservation, current] of [
    [{ previousRevision: 7, inputRevision: 8 }, { ...owner, inputRevision: 8 }],
    [{ previousRevision: 6, inputRevision: 7 }, { ...owner, inputRevision: 8 }],
    [{ previousRevision: 6, inputRevision: 7 }, { ...owner, sessionId: 'OTHER', inputRevision: 7 }],
    [{ previousRevision: 6, inputRevision: 7 }, { ...owner, generation: 'OTHER', inputRevision: 7 }],
    [{ previousRevision: 6, inputRevision: 7 }, { ...owner, terminal: {}, inputRevision: 7 }],
  ]) {
    const preparation = { owner };
    assert.equal(bindClaudeLocalCommandInputReservation(preparation, reservation, current), false);
    assert.equal(preparation.owner, owner);
  }
  const alreadyReserved = { owner };
  assert.equal(bindClaudeLocalCommandInputReservation(alreadyReserved, { previousRevision: 6, inputRevision: 6 }, owner), true);
});
