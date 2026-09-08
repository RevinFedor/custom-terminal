const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const vm = require('node:vm');
const {
  AgentInputCaptureProtocol,
  decide,
  lockPathForPid,
  readDecision,
  readJson,
  readOutcome,
} = require('./agent-input-capture-protocol');
const { runCaptureHelper } = require('./noted-code-grab-v2');

function fixture(t) {
  const directory = fs.mkdtempSync('/tmp/noted-capture-test-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const protocol = new AgentInputCaptureProtocol({ directory, ownerId: 'owner-A', now: () => now });
  const file = path.join(directory, 'draft.md');
  fs.writeFileSync(file, 'keep this draft\n');
  const socketPath = path.join(directory, 'capture.sock');
  const defaults = {
    tabId: 'tab-A', terminalId: 'terminal-A', agent: 'codex', mode: 'grab',
    pids: [process.pid], sock: socketPath, generation: { run: 1 },
  };
  const env = { NOTED_GRAB_OWNER_ID: protocol.ownerId, NOTED_GRAB_TERMINAL_ID: defaults.terminalId,
    NOTED_ORIGINAL_EDITOR: '/mock/editor -w' };
  return { protocol, directory, file, socketPath, env,
    arm: overrides => protocol.arm({ ...defaults, ...overrides }),
    advance: value => { now += value; },
    text: () => fs.readFileSync(file, 'utf8'),
  };
}

async function serverFor(t, socketPath, onEnvelope) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onEnvelope(JSON.parse(line), socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server;
}

function ack(socket, envelope, decision) {
  socket.write(JSON.stringify({ ...envelope, text: undefined, decision }) + '\n');
}

function invoke(f, extra = {}) {
  return runCaptureHelper({ file: f.file, directory: f.directory, env: f.env,
    ppid: process.pid, pid: 900001, socketTimeoutMs: 50, ...extra });
}

test('main capture refuses Codex startup draft before process lookup or Ctrl+G; initialized busy input stays eligible', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('async function captureAgentInputAtWriteBoundary(');
  const end = source.indexOf('\nasync function captureAgentInput(', start);
  assert.ok(start > 0 && end > start);
  const term = { write() { throw new Error('startup must not receive Ctrl+G'); } };
  let ready = false;
  let lookups = 0;
  const capture = vm.runInNewContext('(' + source.slice(start, end) + ')', {
    terminals: new Map([['tab', term]]),
    isCodexTuiEffectivelyReady: () => ready,
    claudeTurnBusy: new Map([['tab', true]]),
    resolveAgentInputProcess: async () => { lookups++; return { success: false, error: 'reached-initialized-input' }; },
  });
  const refused = await capture('tab', 'copy', 'codex');
  assert.equal(refused.success, false);
  assert.equal(refused.error, 'codex_input_not_ready');
  assert.equal(refused.draftPreserved, true);
  assert.equal(lookups, 0);
  ready = true;
  assert.equal((await capture('tab', 'copy', 'codex')).error, 'reached-initialized-input');
  assert.equal(lookups, 1);
});

test('3000ms cancellation survives a helper launched 49ms later; real socket rejects without editor or mutation', async t => {
  const f = fixture(t);
  const intent = f.arm();
  f.advance(3000);
  assert.equal(f.protocol.cancel(intent, 'external_editor_timeout').decision, 'cancel');
  assert.equal(readJson(lockPathForPid(f.directory, process.pid)).operationId, intent.operationId);
  assert.throws(() => f.arm(), /external_editor_pending_drain/);
  f.advance(49);
  let envelopes = 0;
  await serverFor(t, f.socketPath, (envelope, socket) => {
    envelopes++;
    const decision = f.protocol.authorize(intent, envelope, true);
    assert.equal(decision.decision, 'cancel');
    ack(socket, envelope, decision.decision);
  });
  let opened = false;
  const result = await invoke(f, { runEditor() { opened = true; } });
  assert.equal(result.action, 'preserve');
  assert.equal(result.applied, false);
  assert.equal(f.text(), 'keep this draft\n');
  assert.equal(opened, false);
  assert.equal(envelopes, 1);
  assert.equal(f.protocol.release(intent, { parentReturned: true }), true);
  assert.equal(fs.existsSync(lockPathForPid(f.directory, process.pid)), false);
  assert.equal(fs.existsSync(intent.operationDir), false);
  const next = f.arm();
  assert.notEqual(next.operationId, intent.operationId);
});

for (const [mode, expected] of [
  ['copy', 'keep this draft\n'], ['grab', ''], ['clear', ''], ['restore', 'replacement\nexact'],
]) {
  test(mode + ' modifies the temporary file only after exact main authorization', async t => {
    const f = fixture(t);
    const intent = f.arm({ mode, text: 'replacement\nexact' });
    await serverFor(t, f.socketPath, (envelope, socket) => {
      assert.equal(f.text(), 'keep this draft\n');
      assert.equal(envelope.text, mode === 'restore' ? 'replacement\nexact' : 'keep this draft\n');
      const decision = f.protocol.authorize(intent, envelope, true);
      assert.equal(decision.decision, 'commit');
      ack(socket, envelope, decision.decision);
    });
    const result = await invoke(f);
    assert.equal(result.action, mode);
    assert.equal(result.applied, true);
    assert.equal(f.text(), expected);
    assert.equal(readOutcome(intent).helperId, result.helperId);
    assert.equal(f.protocol.release(intent, { parentReturned: true }), true);
  });
}

test('truly manual Ctrl+G keeps the original editor and its exit status', async t => {
  const f = fixture(t);
  const calls = [];
  const result = await invoke(f, { runEditor(binary, args) { calls.push({ binary, args }); return { status: 7 }; } });
  assert.deepEqual(calls, [{ binary: '/mock/editor', args: ['-w', f.file] }]);
  assert.equal(result.status, 7);
  assert.equal(result.action, 'manual');
  assert.equal(f.text(), 'keep this draft\n');
});

test('socket connection failure preserves grab/restore draft and exact helper-exit permits retry', async t => {
  for (const mode of ['grab', 'restore']) {
    const f = fixture(t);
    const intent = f.arm({ mode, text: 'must not replace' });
    const result = await invoke(f);
    assert.equal(result.action, 'preserve');
    assert.equal(readDecision(intent).decision, 'cancel');
    assert.equal(f.text(), 'keep this draft\n');
    assert.equal(f.protocol.reconcileReturned(intent, () => true), false);
    assert.equal(f.protocol.reconcileReturned(intent, () => null), false);
    assert.equal(f.protocol.reconcileReturned(intent, () => false), true);
    assert.notEqual(f.arm().operationId, intent.operationId);
  }
});

test('helper socket timeout wins cancellation; a delayed main response cannot mutate the file', async t => {
  const f = fixture(t);
  const intent = f.arm();
  let received;
  await serverFor(t, f.socketPath, envelope => { received = envelope; });
  const result = await invoke(f);
  assert.ok(received);
  assert.equal(result.action, 'preserve');
  assert.equal(f.protocol.authorize(intent, received, true).decision, 'cancel');
  assert.equal(f.text(), 'keep this draft\n');
});

test('lost socket ACK after committed authorization does not undo ownership or lose captured draft', async t => {
  const f = fixture(t);
  const intent = f.arm();
  let captured;
  await serverFor(t, f.socketPath, (envelope, socket) => {
    captured = envelope.text;
    assert.equal(f.protocol.authorize(intent, envelope, true).decision, 'commit');
    socket.destroy();
  });
  const result = await invoke(f);
  assert.equal(captured, 'keep this draft\n');
  assert.equal(result.applied, true);
  assert.equal(f.text(), '');
  assert.equal(f.protocol.cancel(intent, 'main_timeout').decision, 'commit');
});

test('current process/input generation mismatch cancels before side effects', async t => {
  const f = fixture(t);
  const intent = f.arm();
  await serverFor(t, f.socketPath, (envelope, socket) => {
    const decision = f.protocol.authorize(intent, envelope, false);
    assert.equal(decision.decision, 'cancel');
    ack(socket, envelope, decision.decision);
  });
  assert.equal((await invoke(f)).action, 'preserve');
  assert.equal(f.text(), 'keep this draft\n');
});

test('foreign owner and malformed automatic intent are not treated as manual requests', async t => {
  const f = fixture(t);
  f.arm();
  let opened = false;
  const result = await invoke(f, { env: { ...f.env, NOTED_GRAB_OWNER_ID: 'different-main' }, runEditor() { opened = true; } });
  assert.equal(result.action, 'preserve');
  assert.equal(opened, false);
  assert.equal(f.text(), 'keep this draft\n');
  fs.writeFileSync(lockPathForPid(f.directory, process.pid), '{invalid-json');
  assert.equal((await invoke(f, { runEditor() { opened = true; } })).action, 'preserve');
  assert.equal(opened, false);
});

test('retirement keeps canceled dispatch while old parent can still start its delayed helper', async t => {
  const f = fixture(t);
  const intent = f.arm();
  f.protocol.release(intent, { processRetired: true });
  assert.equal(readJson(lockPathForPid(f.directory, process.pid)).operationId, intent.operationId);
  await serverFor(t, f.socketPath, (envelope, socket) => {
    assert.equal(f.protocol.matchesEnvelope(intent, envelope), false);
    ack(socket, envelope, 'cancel');
  });
  let manual = false;
  const result = await invoke(f, { runEditor() { manual = true; } });
  assert.equal(result.applied, false);
  assert.equal(manual, false);
  assert.equal(f.text(), 'keep this draft\n');
});

test('file changed after prepare is preserved instead of overwritten by commit', async t => {
  const f = fixture(t);
  const intent = f.arm({ mode: 'restore', text: 'automated replacement' });
  await serverFor(t, f.socketPath, (envelope, socket) => {
    fs.writeFileSync(f.file, 'newer external edit');
    ack(socket, envelope, f.protocol.authorize(intent, envelope, true).decision);
  });
  const result = await invoke(f);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'editor_file_changed');
  assert.equal(f.text(), 'newer external edit');
});

test('late older envelope cannot authorize or clean a newer operation on the same PID', t => {
  const f = fixture(t);
  const old = f.arm();
  const oldEnvelope = { ...old, event: 'GrabInput', ppid: process.pid, pid: 12345, helperId: 'old-helper' };
  f.protocol.cancel(old, 'process_retired');
  assert.equal(f.protocol.release(old, { processRetired: true }), true);
  const next = f.arm({ terminalId: 'terminal-B', generation: { run: 2 } });
  assert.equal(f.protocol.matchesEnvelope(next, oldEnvelope), false);
  assert.equal(f.protocol.authorize(next, oldEnvelope, true).decision, 'cancel');
  // Cleanup is conditional, not a blind unlink of every historical PID alias.
  f.protocol.release(old, { processRetired: true });
  assert.equal(readJson(lockPathForPid(f.directory, process.pid)).operationId, next.operationId);
  assert.equal(readDecision(next), null);
  assert.equal(readDecision(old).decision, 'cancel');
});

test('no helper after timeout is unknown, not no-op proof; parent output alone cannot clear it', t => {
  const f = fixture(t);
  const intent = f.arm();
  f.advance(100000);
  f.protocol.cancel(intent, 'external_editor_timeout');
  assert.equal(f.protocol.reconcileReturned(intent, () => false), false);
  assert.equal(f.protocol.release(intent, { parentReturned: true }), false);
  assert.throws(() => f.arm(), /external_editor_pending_drain/);
  assert.equal(f.protocol.release(intent, { processRetired: true }), true);
  assert.ok(f.arm({ terminalId: 'new-terminal' }));
});

test('real child helper and Unix socket complete a versioned capture with actual process identity', async t => {
  const f = fixture(t);
  const intent = f.arm({ mode: 'copy' });
  let helperPid;
  await serverFor(t, f.socketPath, (envelope, socket) => {
    assert.equal(envelope.ppid, process.pid);
    helperPid = envelope.pid;
    ack(socket, envelope, f.protocol.authorize(intent, envelope, true).decision);
  });
  const child = spawn(process.execPath, ['-e',
    'require(process.env.TEST_HELPER).runCaptureHelper({file:process.env.TEST_DRAFT,directory:process.env.TEST_DIRECTORY}).then(r=>{process.stdout.write(JSON.stringify(r));}).catch(e=>{console.error(e);process.exitCode=1;});',
  ], { env: { ...process.env, ...f.env,
    TEST_HELPER: path.join(__dirname, 'noted-code-grab-v2.js'), TEST_DRAFT: f.file, TEST_DIRECTORY: f.directory,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.equal(helperPid, child.pid);
  assert.equal(JSON.parse(output).applied, true);
  assert.equal(f.text(), 'keep this draft\n');
  let manualOpened = false;
  const manual = await invoke(f, { runEditor() { manualOpened = true; return { status: 0 }; } });
  assert.equal(manual.action, 'manual');
  assert.equal(manualOpened, true);
  assert.equal(fs.existsSync(lockPathForPid(f.directory, process.pid)), false);
  assert.ok(readOutcome(intent), 'manual cleanup leaves the exact outcome available for main reconciliation');
  assert.equal(f.protocol.reconcileReturned(intent), true);
});
