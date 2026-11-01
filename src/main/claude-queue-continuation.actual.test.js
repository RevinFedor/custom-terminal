'use strict';

// A message sent into a busy Claude tab is queued by Claude. Claude fires
// UserPromptSubmit at ENQUEUE time with the active turn's prompt_id, which Main
// drops as `duplicate-prompt-start`. When the turn ends, Claude runs the queued
// message as a new turn without a new UserPromptSubmit, so the tab looked idle
// while Claude worked. Reproduced in dev 2026-11-01 (tab aa4e832d003c):
//   18:14:58.377  UserPromptSubmit ignored duplicate-prompt-start
//   18:14:59.161  Stop                    busy=false   <- false "idle"
//   18:14:59.304  QUEUE_CONSUMED operation=dequeue
//   18:15:00.208  Stop (no change)        <- the real end
// Decision 01.11 (Fedor): busy until that queued turn really ends. The dropped
// event is replayed through the same hook socket only when the dequeue lands
// after the Stop's byte boundary — never after a merge into the running turn.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = (name) => ast.statements
  .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  .getText(ast);

const TAB = 'tab-b5066664-c319-4cb6-9a24-aa4e832d003c';
const QUEUED = 'Второе (в очередь): файл. Ответь: принято-2.';

function harness({ turnBusy = false, transcriptSize = 5000 } = {}) {
  const writes = [];
  const logs = [];
  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-')), 's.jsonl');
  fs.writeFileSync(transcript, 'x'.repeat(transcriptSize));
  const ctx = vm.createContext({
    console: { log: (l) => logs.push(l), warn: (l) => logs.push(l) },
    fs, Date, Number, JSON, String,
    claudeQueuedPromptSubmits: new Map(),
    claudeTurnBusy: new Map(turnBusy ? [[TAB, true]] : []),
    CLAUDE_HOOK_SOCK: '/tmp/fake.sock',
    net: {
      createConnection: (sockPath) => {
        const handlers = {};
        const client = {
          setEncoding() {},
          on(name, fn) { handlers[name] = fn; if (name === 'connect') queueMicrotask(fn); return client; },
          write(data) { writes.push({ sockPath, data: JSON.parse(data) }); queueMicrotask(() => handlers.data?.('ok\n')); },
          end() {},
        };
        return client;
      },
    },
  });
  vm.runInContext([
    declaration('rememberClaudeQueuedPromptSubmit'),
    declaration('markClaudeQueuedPromptStopBoundary'),
    declaration('settleClaudeQueuedPromptOnDequeue'),
  ].join('\n'), ctx);
  return { ctx, writes, logs, transcript };
}

const enqueueHook = (transcript) => ({
  event: 'UserPromptSubmit', session_id: 'S', ppid: 4242, prompt_id: 'P-chain',
  prompt: QUEUED, transcript_path: transcript,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a queued message dequeued after the Stop replays its own UserPromptSubmit', async () => {
  const { ctx, writes, logs, transcript } = harness();
  ctx.rememberClaudeQueuedPromptSubmit(TAB, enqueueHook(transcript), 'duplicate-prompt-start');
  ctx.markClaudeQueuedPromptStopBoundary(TAB, { session_id: 'S', transcript_path: transcript });
  const outcome = ctx.settleClaudeQueuedPromptOnDequeue(TAB,
    { operation: 'dequeue', byteOffset: 5000, actualText: QUEUED });
  await flush();
  assert.equal(outcome, 'replay');
  assert.equal(writes.length, 1, 'replayed exactly once through the hook socket');
  const replayed = writes[0].data;
  assert.equal(writes[0].sockPath, '/tmp/fake.sock');
  assert.equal(replayed.event, 'UserPromptSubmit');
  // NO prompt_id: Claude runs the dequeued message under a new prompt id, so
  // pinning the enqueue id made the real Stop a prompt-owner-mismatch and the
  // loader never ended (dev 2026-11-01 18:21:58). Ids compare only when both
  // ends have one; session and process still match.
  assert.equal(replayed.prompt_id, null);
  assert.equal(replayed.session_id, 'S');
  assert.equal(replayed.ppid, 4242);
  assert.equal(replayed.prompt, QUEUED);
  assert.equal(replayed.synthetic, 'claude-queue-dequeue');
  assert.equal(ctx.claudeQueuedPromptSubmits.size, 0, 'one replay per queued message');
  assert.ok(logs.some((l) => l.includes('outcome=replay')));
});

test('no replay can leave a loader without an end', async () => {
  for (const [label, setup, expected] of [
    ['merged into the running turn (still busy)', { turnBusy: true }, 'merged-into-running-turn'],
    ['dequeued before the Stop boundary', { dequeueOffset: 4000 }, 'dequeued-before-stop'],
    ['a different message was dequeued', { actualText: 'другое' }, 'different-message'],
    ['no Stop seen yet', { skipStop: true }, 'boundary-unknown'],
  ]) {
    const { ctx, writes, transcript } = harness({ turnBusy: setup.turnBusy });
    ctx.rememberClaudeQueuedPromptSubmit(TAB, enqueueHook(transcript), 'duplicate-prompt-start');
    if (!setup.skipStop) ctx.markClaudeQueuedPromptStopBoundary(TAB, { session_id: 'S', transcript_path: transcript });
    const outcome = ctx.settleClaudeQueuedPromptOnDequeue(TAB, {
      operation: 'dequeue', byteOffset: setup.dequeueOffset ?? 5000,
      actualText: setup.actualText ?? QUEUED,
    });
    await flush();
    assert.equal(outcome, expected, label);
    assert.equal(writes.length, 0, label + ': nothing replayed');
    assert.equal(ctx.claudeQueuedPromptSubmits.size, 0, label + ': entry consumed');
  }
});

test('only an enqueue-time duplicate with real prompt text is remembered', () => {
  const { ctx, transcript } = harness();
  ctx.rememberClaudeQueuedPromptSubmit(TAB, enqueueHook(transcript), 'subagent-hook');
  ctx.rememberClaudeQueuedPromptSubmit(TAB, { ...enqueueHook(transcript), prompt: '' }, 'duplicate-prompt-start');
  ctx.rememberClaudeQueuedPromptSubmit(TAB, { ...enqueueHook(transcript), synthetic: 'claude-queue-dequeue' },
    'duplicate-prompt-start');
  assert.equal(ctx.claudeQueuedPromptSubmits.size, 0,
    'other drop reasons, empty prompts and our own replay are never remembered');
  // A queue remove (cancelled) or a foreign session Stop discards the entry.
  ctx.rememberClaudeQueuedPromptSubmit(TAB, enqueueHook(transcript), 'duplicate-prompt-start');
  ctx.markClaudeQueuedPromptStopBoundary(TAB, { session_id: 'OTHER', transcript_path: transcript });
  assert.equal(ctx.claudeQueuedPromptSubmits.size, 0);
  // `remove` = Claude took the message into the RUNNING turn (dev 18:27:58,
  // before the Stop): closes the entry, never replays.
  ctx.rememberClaudeQueuedPromptSubmit(TAB, enqueueHook(transcript), 'duplicate-prompt-start');
  assert.equal(ctx.settleClaudeQueuedPromptOnDequeue(TAB, { operation: 'remove', byteOffset: 9, actualText: QUEUED }),
    'merged-into-running-turn');
  assert.equal(ctx.claudeQueuedPromptSubmits.size, 0, 'a merged message leaves no stale entry');
});

test('the replayed turn is ended by the continuation\'s real Stop (new prompt id)', () => {
  const { admitClaudeMainHook } = require('./claude-hook-routing');
  // Turn begun by our replay: no provider prompt id.
  const currentTurn = { provider: 'claude', active: true, sessionId: 'S', processId: 4242, providerPromptId: null };
  const realStop = { event: 'Stop', session_id: 'S', ppid: 4242, prompt_id: 'P-new-from-claude' };
  assert.equal(admitClaudeMainHook({ message: realStop, currentTurn, currentProcessId: 4242 }).accepted, true,
    'the continuation Stop is accepted, so busy ends');
  // Pinning the old id reproduces the stuck loader we saw in dev.
  const pinned = { ...currentTurn, providerPromptId: 'P-chain' };
  assert.equal(admitClaudeMainHook({ message: realStop, currentTurn: pinned, currentProcessId: 4242 }).reason,
    'prompt-owner-mismatch');
  // A foreign session or process is still refused.
  assert.equal(admitClaudeMainHook({ message: { ...realStop, session_id: 'X' }, currentTurn, currentProcessId: 4242 }).accepted, false);
});

test('wired: dropped duplicate is remembered, Stop marks the boundary, dequeue settles', () => {
  assert.ok(main.includes('rememberClaudeQueuedPromptSubmit(tabId, msg, hookAdmission.reason);'));
  assert.ok(main.includes("if (event === 'Stop' || event === 'StopFailure') {\n          markClaudeQueuedPromptStopBoundary(tabId, msg);"));
  assert.ok(main.includes('settleClaudeQueuedPromptOnDequeue(tabId, { operation: record?.operation,'));
  assert.ok(main.includes('claudeQueuedPromptSubmits.delete(tabId);\n  const questionExit'),
    'process exit clears a pending entry');
});
