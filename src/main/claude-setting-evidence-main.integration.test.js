'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { parseClaudeStartupSlashCommand } = require('./claude-startup-slash-proof');
const { classifyClaudeStartupDeliveryProof } = require('./claude-startup-main-runtime');
const { PROOF } = require('./claude-startup-transaction');
const { createClaudeStartupProofSession } = require('./claude-startup-proof-session');
const { submitWithClaudeLocalCommandLifecycle } = require('./claude-local-command-submission');
const { createClaudeSettingEvidence } = require('./claude-setting-evidence');
const { advanceManualInputLineState } = require('./claude-local-command-input');
const { prebindClaudeHookPid } = require('./claude-hook-routing');

const mainPath = path.join(__dirname, 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
const tree = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, true);
const windows = [];
function found(node, label) {
  assert.ok(node, 'actual main source: ' + label);
  const start = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const end = tree.getLineAndCharacterOfPosition(node.end).line + 1;
  windows.push({ label, file: mainPath, start, end });
  return node;
}
function declaration(name) {
  return found(tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name), name);
}
function variable(name) {
  return found(tree.statements.find(n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name)), name);
}
function descendant(parent, predicate, label) {
  let result;
  function visit(node) { if (result) return; if (predicate(node)) result = node; else ts.forEachChild(node, visit); }
  visit(parent); return found(result, label);
}
function ipc(channel) {
  return found(tree.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.expression.expression.getText(tree) === 'ipcMain.handle' && n.expression.arguments[0]?.text === channel), channel);
}

const names = ['resolveClaudeSessionFileForTab', 'captureClaudeSettingEvidenceOwner',
  'getTerminalStopRevision', 'captureAgentInputIdentity', 'agentSendExecutionFailure',
  'claudeSettingEvidenceOwnerCurrent', 'captureClaudeSettingEvidenceProcessScope',
  'claudeSettingEvidenceProcessScopeCurrent', 'ensureClaudeSettingEvidenceProcessOwner',
  'resolveClaudeSettingEvidenceBinding',
  'normalizeClaudeLocalCommandText', 'claudeStartupProofOutcome', 'scanClaudeStartupSlashProof',
  'readClaudeStartupSlashProof', 'waitForClaudeStartupSlashProofInMain',
  'trackClaudeInputLineForLocalCommands', 'reconcileClaudeInputLineBridgeTransition',
  'inspectClaudeExactSettingInputAtWriteBoundary', 'inspectClaudeExactSettingInput',
  'sendClaudeCommandInternal', 'sendClaudeCommandUnclaimed'];
const declarations = names.map(name => declaration(name).getText(tree)).join('\n');
const registryDeclaration = variable('claudeSettingEvidence').getText(tree);
const queueSource = ['pasteInflight', 'ptyActiveWriteOperation', 'ptyLastQueuedWriteOperation', 'ptyWriteOwners']
  .map(name => variable(name).getText(tree)).join('\n') + '\n' + declaration('withPtyWriteLock').getText(tree);
const pasteFunction = declaration('_safePasteAndSubmitInner');
const chunkLoop = descendant(pasteFunction, node => ts.isForStatement(node)
  && node.statement.getText(tree).includes("claudeSettingEvidence.prepareWrite(options.claudeSettingEvidenceToken, 'paste')"), 'actual PTY chunk loop');
const enterTry = descendant(pasteFunction, node => ts.isTryStatement(node)
  && node.tryBlock.statements.some(statement => ts.isIfStatement(statement)
    && statement.expression.getText(tree) === 'options.claudeSettingEvidenceToken'
    && statement.thenStatement.getText(tree).includes("'enter'")), 'actual PTY Enter try/catch');
const startupSend = descendant(variable('claudeStartupMainRuntime'), node => ts.isPropertyAssignment(node)
  && node.name.getText(tree) === 'sendCommand', 'actual startup settings send adapter').initializer.getText(tree);
const sendIpc = ipc('claude:send-command').getText(tree);
const exactIpc = ipc('claude:retry-exact-setting-input').getText(tree);

// The existing queue, sender decisions and the exact physical paste/Enter AST
// fragments are executed verbatim. Only TUI framing/preflight, PTY I/O and the
// provider's JSONL append are fixtures. This is not a full safePaste E2E and
// does not launch Electron, Claude, a server, or inspect a user's transcript.
const fragmentSource = `async function actualPhysicalFragments(term, content, options = {}) {
  const source = options.source || 'fixture';
  const chunks = [
    { text: content.slice(0, 4), startsPaste: true, endsPaste: false },
    { text: content.slice(4), startsPaste: false, endsPaste: true },
  ];
  const PASTE_START = '\\x1b[200~', PASTE_END = '\\x1b[201~';
  const draftPasteFailure = () => null, destinationFailure = () => null;
  const knownEmptyDestination = false, handoffId = null, broadcastTabId = 'tab-a';
  const sendOperationContext = null, sendAttemptId = null, sendOperationKey = null;
  const writeExecutionIdentity = captureAgentInputIdentity(broadcastTabId, term);
  const exactSendCancellationRequested = () => false;
  const fast = false, renderTimes = [], stagedCodexAudit = null, stagedClaudeAudit = null;
  const codexSubmissionWatcher = null, codexPromptInFlightState = null;
  let submitAttempted = false;
  const submitSequence = '\\r';
  let pasteWritten = false;
  ${chunkLoop.getText(tree)}
  if (options.submit === false) return { success: true, submitted: false, enterWritten: false, pasteWritten };
  ${enterTry.getText(tree)}
  return { success: true, submitted: true, enterWritten: true, pasteWritten };
}`;

const COMMAND = '/effort max';
const line = record => JSON.stringify(record) + '\n';
const anchor = () => ({ type: 'assistant', uuid: 'anchor', sessionId: 'session-a', message: { role: 'assistant', content: 'fixture boundary' } });
function wrapper(uuid, command = COMMAND, sessionId = 'session-a') {
  const parsed = parseClaudeStartupSlashCommand(command);
  return { type: 'user', uuid, sessionId, parentUuid: 'anchor', timestamp: '1970-01-01T00:00:01.000Z',
    message: { role: 'user', content: `<command-name>/${parsed.kind}</command-name>\n<command-message>${parsed.kind}</command-message>\n<command-args>${parsed.value}</command-args>` } };
}
function output(uuid, { sessionId = 'session-a', text = 'Set effort level to max' } = {}) {
  return { type: 'user', uuid: uuid + '-out', parentUuid: uuid, sessionId, timestamp: '1970-01-01T00:00:01.000Z',
    message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } };
}

function harness(t, options = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-main-setting-proof-'));
  const file = path.join(scratch, 'session-a.jsonl');
  if (!options.freshMissing) fs.writeFileSync(file, options.initial ?? line(anchor()));
  const files = new Map([['session-a', file]]);
  const writes = [], claims = [], forwardedOptions = [], proofRequests = [];
  const handlers = new Map();
  let pid = options.pidPending ? null : 123;
  let lifecycle = 'lifecycle-a', inputRevision = 10, counter = 0, processLookups = 0;
  let composer = '', mode = options.mode || 'append', bridgeSid = options.freshMissing ? null : 'session-a';
  let opened;
  const proofOpened = new Promise(resolve => { opened = resolve; });
  const quiet = { log(message) { if (String(message).includes('[ClaudeStartupProofWait] open')) opened(); }, warn() {}, error() {} };
  const term = { write(data) {
    writes.push(data);
    if (data !== '\r') { composer += data.replace(/\x1b\[20[01]~/g, ''); return; }
    const command = composer || COMMAND;
    if (mode === 'throw') throw new Error('fixture Enter may have crossed');
    if (mode === 'append') appendPair('physical-' + (++counter), command);
    composer = '';
  } };
  function appendPair(uuid, command = COMMAND, extra = '') {
    fs.appendFileSync(file, line(wrapper(uuid, command)) + extra + line(output(uuid)));
  }
  const bridgeKnownSessions = new Map(bridgeSid ? [['tab-a', bridgeSid]] : []);
  const bridgePidCache = new Map(pid ? [[pid, 'tab-a']] : []);
  const launch = { generation: 'launch-a', launchMode: options.freshMissing ? 'fresh' : 'resume', sessionIdHint: 'session-a' };
  const context = vm.createContext({ console: quiet, Buffer, path, crypto, srcMainDir: __dirname,
    Date: class extends Date { static now() { return 1000; } },
    require(filePath) {
      if (filePath === path.join(__dirname, 'claude-setting-evidence')) {
        return { createClaudeSettingEvidence: deps => createClaudeSettingEvidence({ ...deps, now: () => 1000 }) };
      }
      return require(filePath);
    },
    terminals: new Map([['tab-a', term]]), terminalLifecycleEpochs: new WeakMap([[term, 'term-instance-a']]),
    terminalStopRevisions: new WeakMap(),
    terminalCommandState: new Map([['tab-a', { runSeq: 7, isRunning: true }]]),
    claudeLaunchGenerationByTab: new Map([['tab-a', launch]]), bridgeKnownSessions, bridgePidCache,
    claudeInputLineBuffers: new Map(), promptBoundarySeq: new Map([['tab-a', 1]]),
    advanceManualInputLineState,
    terminalProjects: new Map([['tab-a', scratch]]), aiStoppingTabs: new Set(),
    getTerminalLifecycleGeneration: () => lifecycle, findClaudePidByTab: () => pid,
    getHeadlessTerminalMirror: () => null,
    getTerminalInputRevision: () => inputRevision, bumpTerminalInputRevision: () => ++inputRevision,
    findSessionFile: sid => files.has(sid) && fs.existsSync(files.get(sid)) ? { filePath: files.get(sid) } : null,
    parseClaudeStartupSlashCommand, CLAUDE_STARTUP_PROOF: PROOF, classifyClaudeStartupDeliveryProof,
    claudeStartupTestFaultActive: kind => kind === 'swallow-effort' && mode === 'withhold',
    claudeStartupMainRuntime: {
      claimManualSetting(tabId, command, source, metadata) { const claim = { claim: { id: 'claim-' + (++counter) } }; claims.push({ tabId, command, source, metadata }); return claim; },
      rollbackManualClaim() {}, confirmManualClaimAfterSend() {}, settleManualClaim() {},
      snapshot: () => ({ transaction: { attemptId: 'startup-attempt' } }),
    },
    isPromptQueueAutomationSource: () => false, isPromptQueueSource: () => false,
    isLocalSlashCommandPrompt: value => String(value).startsWith('/'), hasLiveClaudeInTab: () => true,
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent', UNKNOWN: 'unknown' },
    invalidateAiProcessLookupCache() {},
    inspectAiDescendantProcessesByTab: async () => {
      processLookups += 1;
      if (options.replaceDuringProcessLookup) lifecycle = 'replacement-during-process-proof';
      return options.processLookup || { status: 'found', matches: [{ pid: 123, processName: 'claude' }] };
    },
    waitForAiLaunchAccepted: async () => {
      processLookups += 1;
      if (options.replaceDuringProcessLookup) lifecycle = 'replacement-during-process-proof';
      const lookup = options.processLookup || { status: 'found', matches: [{ pid: 123, processName: 'claude' }] };
      if (lookup.status !== 'found') return {
        accepted: false,
        error: lookup.status === 'unknown' ? 'process_lookup_failed' : 'claude_launch_not_accepted',
      };
      const result = prebindClaudeHookPid({ tabId: 'tab-a', matches: lookup.matches,
        tabByPid: bridgePidCache, hasTab: () => true });
      if (result.bound) pid = result.pid;
      return { accepted: true, pid: result.bound ? result.pid : Number(lookup.matches[0]?.pid) || null };
    },
    prebindClaudeHookPid: args => {
      const result = prebindClaudeHookPid(args);
      if (result.bound) pid = result.pid;
      return result;
    },
    claudeCtrlCDangerZone: new Map(), mainWindow: null,
    submitWithClaudeLocalCommandLifecycle, prepareClaudeLocalCommandWatcher: () => null,
    readClaudeLocalCommandOwner: () => ({ terminal: term, sessionId: bridgeSid,
      generation: launch.generation, inputRevision }),
    activateClaudeLocalCommandWatcher() {}, discardClaudeLocalCommandWatcherPreparation() {},
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 1,
    recordComposerForensicPtyInput: () => null, codexSubmitDropTestFault: { consume: () => false },
    confirmClaudeSettingsDialogFromCurrentFrame: async () => null,
    captureAgentInputAtWriteBoundary: async () => ({ success: true, text: composer,
      terminalIdentityStable: true, terminalRunSeq: 7, inputRevision,
      terminalLifecycleGeneration: lifecycle, mirrorGeneration: 'mirror-a' }),
    armPromptBoundaryForSubmittedCommand() {},
    claudePromptStability: { wait: options.promptStabilityWait
      || (async () => ({ ready: true, lease: { id: 'lease' } })), validate: () => ({ valid: true }) },
    aiBoundaryTestGate: { waitIfArmed: async () => null },
    prepareClaudeStartupComposer: async () => ({ ready: true, exactEmptyEvidence: { id: 'empty' } }),
    ipcMain: { handle: (channel, handler) => { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } },
  });
  vm.runInContext(queueSource + '\n' + declarations + '\n' + registryDeclaration + '\n' + fragmentSource
    + '\nconst actualStartupSend = ' + startupSend + ';\n' + sendIpc + '\n' + exactIpc, context);
  const actual = vm.runInContext(`({ send: sendClaudeCommandInternal, read: readClaudeStartupSlashProof,
    wait: waitForClaudeStartupSlashProofInMain, inspect: inspectClaudeExactSettingInput,
    startupSend: actualStartupSend, evidence: claudeSettingEvidence, queue: withPtyWriteLock,
    trackNative: trackClaudeInputLineForLocalCommands,
    bridgeTransition: reconcileClaudeInputLineBridgeTransition,
    resolveBinding: resolveClaudeSettingEvidenceBinding, captureOwner: captureClaudeSettingEvidenceOwner,
    ensureProcessOwner: ensureClaudeSettingEvidenceProcessOwner,
    physical: actualPhysicalFragments })`, context);
  context.safePasteAndSubmit = (target, content, raw) => {
    forwardedOptions.push(raw);
    return actual.queue(target, async () => {
      // A deterministic input-reservation signal at the existing lock head;
      // exact draft safety/rendering is outside these two physical fragments.
      if (!raw.inputRevisionAlreadyReserved) inputRevision++;
      return actual.physical(target, content, raw);
    }, { kind: 'fixture-safe-paste' }, raw.ptyWriteOwner || null);
  };
  const proofSession = createClaudeStartupProofSession({ subscribe: async () => ({ success: true }),
    unsubscribe: async () => ({ success: true }), currentGeneration: () => launch.generation,
    resolveBinding: () => {
      const binding = actual.resolveBinding('tab-a', actual.captureOwner('tab-a'));
      return binding ? { sessionId: binding.sessionId, cwd: scratch } : null;
    },
    readProof: request => { proofRequests.push(request); return actual.read(request); }, log: quiet });
  context.claudeStartupProofSession = proofSession;
  t.after(async () => { proofSession.cancel('tab-a'); await proofSession.stop(); fs.rmSync(scratch, { recursive: true, force: true }); });
  return { file, scratch, actual, context, term, writes, claims, forwardedOptions, proofRequests, proofOpened, proofSession,
    handlers, files, launch, appendPair,
    enterCount: () => writes.filter(data => data === '\r').length,
    send: (command = COMMAND, raw = {}) => handlers.get('claude:send-command')({}, 'tab-a', command, raw),
    read: (send, extra = {}) => actual.read({ tabId: 'tab-a', command: COMMAND, commandId: send.settingCommandId,
      sessionId: bridgeSid, afterMs: 1000, ...extra }),
    wait: send => actual.wait({ tabId: 'tab-a', generation: launch.generation, command: COMMAND,
      afterMs: 1000, label: 'fixture', sendResult: send }),
    setMode: next => { mode = next; }, setComposer: next => { composer = next; },
    setPid: next => { pid = next; }, setLifecycle: next => { lifecycle = next; },
    get processLookups() { return processLookups; },
    bind: (sid = 'session-a') => { const oldSid = bridgeKnownSessions.get('tab-a') || null;
      actual.bridgeTransition('tab-a', oldSid, sid); bridgeSid = sid; bridgeKnownSessions.set('tab-a', sid);
      proofSession.handleBindingChanged('tab-a', { sessionId: sid, cwd: scratch, generation: launch.generation }); },
  };
}

test('actual main source windows include sender, startup, exact helper and physical byte boundaries', t => {
  assert.ok(windows.some(window => window.label === 'actual PTY chunk loop'));
  assert.ok(windows.some(window => window.label === 'actual PTY Enter try/catch'));
  t.diagnostic(JSON.stringify({ sourceHash, windows }));
});

test('actual main/queue/byte fragments exclude same-clock old success and rejection, retain exact new pair', async t => {
  const initial = line(anchor()) + line(wrapper('old-success')) + line(output('old-success'))
    + line(wrapper('old-failure')) + line(output('old-failure', { text: 'API error: 429 rate limit' }));
  const h = harness(t, { initial, mode: 'defer' });
  const send = await h.send();
  assert.equal(send.submitted, true, JSON.stringify(send));
  assert.ok(send.settingCommandId);
  assert.equal((await h.read(send)).success, false);
  const gap = line({ type: 'assistant', text: 'x'.repeat(1100000) });
  h.appendPair('new', COMMAND, gap);
  const proof = await h.read(send);
  assert.equal(proof.success, true);
  assert.equal(proof.outcome, 'found');
  assert.equal(proof.wrapperUuid, 'new');
  assert.equal(proof.evidence.commandId, send.settingCommandId);
  assert.equal(h.enterCount(), 1);
  assert.equal(h.forwardedOptions[0].claudeSettingEvidenceToken.commandId, send.settingCommandId);
  assert.ok(proof.evidence.write.pasteInputRevision > proof.evidence.write.admissionInputRevision);
});

test('native setting Enter occupies the same ledger and cannot be assigned to a later identical command', async t => {
  const h = harness(t, { mode: 'defer' });
  const native = h.actual.trackNative('tab-a', COMMAND + '\r');
  assert.equal(native.settingEvidenceTokens.length, 1);
  h.term.write('\r');
  h.actual.evidence.markWritten(native.settingEvidenceTokens[0], 'enter');
  const send = await h.send();
  assert.equal(send.submitted, true);
  h.appendPair('late-native');
  const proof = await h.read(send);
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'ambiguous-prior-command');
  assert.equal(h.enterCount(), 2, 'one native Enter and one later owned Enter');
});

test('native setting before first bridge occupies the ledger and waits for the verified late writer', async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  const native = h.actual.trackNative('tab-a', COMMAND + '\r');
  assert.equal(native.settingEvidenceTokens.length, 1);
  h.term.write('\r');
  h.actual.evidence.markWritten(native.settingEvidenceTokens[0], 'enter');
  const send = await h.send();
  assert.equal(send.submitted, true);
  h.appendPair('delayed-native');
  h.bind();
  const proof = await h.read(send, { sessionId: 'session-a' });
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'ambiguous-prior-command');
  assert.equal(h.enterCount(), 2);
});

test('first bridge materialization between native typing and Enter does not erase the command epoch', async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  const typed = h.actual.trackNative('tab-a', '/effort ');
  assert.equal(typed.settingEvidenceTokens.length, 0);
  h.bind();
  const submitted = h.actual.trackNative('tab-a', 'max\r');
  assert.equal(submitted.settingEvidenceTokens.length, 1);
  h.term.write('\r');
  h.actual.evidence.markWritten(submitted.settingEvidenceTokens[0], 'enter');
  assert.equal(h.enterCount(), 1);
});

test('the one-time prebridge typing allowance cannot hide a later S1 to S2 owner change', async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  h.actual.trackNative('tab-a', '/eff');
  h.bind('session-a');
  h.actual.trackNative('tab-a', 'ort ');
  h.bind('session-b');
  const submitted = h.actual.trackNative('tab-a', 'max\r');
  assert.equal(submitted.settingEvidenceTokens.length, 0,
    'S2 receives only its own suffix, not the prebridge/S1 prefix');
});

test('accepted S1 then S2 bridge transitions reset a prebridge line even without intervening input', async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  h.actual.trackNative('tab-a', '/eff');
  h.bind('session-a');
  h.bind('session-b');
  const submitted = h.actual.trackNative('tab-a', 'ort max\r');
  assert.equal(submitted.settingEvidenceTokens.length, 0);
});

test('accepted S1 identity survives missing-map gap and still rejects later S2 without input', async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  h.actual.trackNative('tab-a', '/eff');
  h.bind('session-a');
  h.context.bridgeKnownSessions.delete('tab-a');
  h.bind('session-b');
  const submitted = h.actual.trackNative('tab-a', 'ort max\r');
  assert.equal(submitted.settingEvidenceTokens.length, 0);
});

test('a transient missing bridge does not re-arm the one-time null to writer allowance', async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  h.actual.trackNative('tab-a', '/eff');
  h.bind('session-a');
  h.actual.trackNative('tab-a', 'ort ');
  h.context.bridgeKnownSessions.delete('tab-a');
  h.actual.trackNative('tab-a', 'm');
  h.bind('session-b');
  const submitted = h.actual.trackNative('tab-a', 'ax\r');
  assert.equal(submitted.settingEvidenceTokens.length, 0);
});

test('withheld actual sender branch never scans old proof; startup recovery owns one exact Enter with same ID', async t => {
  const h = harness(t, { mode: 'withhold', initial: line(anchor()) + line(wrapper('old')) + line(output('old')) });
  const send = await h.actual.startupSend({ tabId: 'tab-a', generation: 'launch-a', attemptId: 'startup-attempt',
    command: COMMAND, source: 'startup-defaults:effort' });
  assert.equal(send.submitted, false);
  assert.equal(h.enterCount(), 0);
  h.context.scanClaudeStartupSlashProof = () => assert.fail('withheld branch must not scan an old equal command');
  const delivery = await h.wait(send);
  assert.equal(delivery.outcome, 'absent');
  assert.equal(delivery.recovery.settingCommandId, send.settingCommandId);
  h.setMode('append');
  const retried = await h.actual.startupSend({ tabId: 'tab-a', generation: 'launch-a', attemptId: 'startup-attempt',
    command: COMMAND, source: 'startup-defaults:effort:retry', recovery: delivery.recovery });
  assert.equal(retried.settingCommandId, send.settingCommandId);
  assert.equal(retried.submitted, true);
  assert.equal(h.enterCount(), 1);
  const token = h.actual.evidence.get(send.settingCommandId, { tabId: 'tab-a', command: COMMAND });
  const proof = await h.actual.evidence.read({ ...token, sessionId: 'session-a' });
  assert.equal(proof.success, true);
  assert.equal(proof.operationId, 'startup-attempt');
  assert.equal(proof.evidence.startupAttemptId, 'startup-attempt');
  h.setComposer(COMMAND);
  const duplicate = await h.actual.inspect('tab-a', COMMAND, { submit: true, settingCommandId: send.settingCommandId });
  assert.equal(duplicate.submitted, false);
  assert.equal(h.enterCount(), 1);
});

test('actual public exact-retry IPC preserves ID and unknown/reused IDs write no additional Enter', async t => {
  const h = harness(t, { mode: 'withhold' });
  const send = await h.send();
  h.setMode('append');
  const retried = await h.handlers.get('claude:retry-exact-setting-input')({}, {
    tabId: 'tab-a', command: COMMAND, settingCommandId: send.settingCommandId,
  });
  assert.equal(retried.settingCommandId, send.settingCommandId);
  assert.equal(retried.submitted, true);
  h.setComposer(COMMAND);
  for (const settingCommandId of [send.settingCommandId, 'unknown-command-id']) {
    const result = await h.handlers.get('claude:retry-exact-setting-input')({}, { tabId: 'tab-a', command: COMMAND, settingCommandId });
    assert.equal(result.submitted, false);
    assert.equal(h.enterCount(), 1);
  }
});

test('actual Enter throw becomes unknown; late exact proof settles same command without a second Enter', async t => {
  const h = harness(t, { mode: 'throw' });
  const send = await h.send();
  assert.equal(send.submitted, null);
  assert.equal(send.transportUnknown, true);
  assert.equal(h.enterCount(), 1);
  assert.equal((await h.read(send)).success, false);
  const retry = await h.handlers.get('claude:retry-exact-setting-input')({}, { tabId: 'tab-a', command: COMMAND,
    settingCommandId: send.settingCommandId });
  assert.equal(retry.submitted, false);
  h.appendPair('late');
  const proof = await h.read(send);
  assert.equal(proof.success, true);
  assert.equal(proof.commandId, send.settingCommandId);
  assert.equal(h.enterCount(), 1);
});

test('actual startup wait follows fresh binding event into the SAME evidence after late file creation', { timeout: 3000 }, async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  const send = await h.actual.startupSend({ tabId: 'tab-a', generation: 'launch-a', attemptId: 'fresh-attempt',
    command: COMMAND, source: 'startup-defaults:effort' });
  const waiting = h.wait(send);
  await h.proofOpened;
  h.appendPair('fresh');
  h.bind();
  const proof = await waiting;
  assert.equal(proof.success, true);
  assert.equal(proof.commandId, send.settingCommandId);
  assert.equal(proof.evidence.owner.freshLaunch, true);
  assert.ok(h.proofRequests.every(request => request.commandId === send.settingCommandId));
  assert.equal(h.enterCount(), 1);
});

test('fresh mobile startup binds the exact late Claude PID before the first setting byte', async t => {
  const h = harness(t, { freshMissing: true, pidPending: true, mode: 'defer' });
  const send = await h.actual.startupSend({
    tabId: 'tab-a',
    generation: 'launch-a',
    attemptId: 'mobile-fresh-attempt',
    command: COMMAND,
    source: 'startup-defaults:tui-ready-effort',
    isExecutionCurrent: () => true,
  });

  assert.equal(send.success, true);
  assert.equal(send.submitted, true);
  assert.equal(h.processLookups, 1);
  assert.equal(h.launch.pid, 123);
  assert.equal(h.actual.captureOwner('tab-a').processId, 123);
  assert.equal(h.forwardedOptions[0].claudeSettingEvidenceToken.commandId, send.settingCommandId);
  assert.equal(h.enterCount(), 1);
});

test('ambiguous or replaced fresh process ownership still refuses before setting paste', async t => {
  const ambiguous = harness(t, { freshMissing: true, pidPending: true, mode: 'defer',
    processLookup: { status: 'found', matches: [{ pid: 123 }, { pid: 124 }] } });
  const first = await ambiguous.actual.startupSend({ tabId: 'tab-a', generation: 'launch-a',
    attemptId: 'ambiguous-attempt', command: COMMAND, source: 'startup-defaults:tui-ready-effort',
    isExecutionCurrent: () => true });
  assert.equal(first.error, 'claude_setting_write_refused');
  assert.equal(first.detail, 'setting-process-owner-unavailable');
  assert.equal(ambiguous.writes.length, 0);

  const replaced = harness(t, { freshMissing: true, pidPending: true, mode: 'defer',
    replaceDuringProcessLookup: true });
  const second = await replaced.actual.startupSend({ tabId: 'tab-a', generation: 'launch-a',
    attemptId: 'replaced-attempt', command: COMMAND, source: 'startup-defaults:tui-ready-effort',
    isExecutionCurrent: () => true });
  assert.equal(second.error, 'claude_setting_write_refused');
  assert.equal(second.detail, 'setting-process-scope-changed');
  assert.equal(replaced.writes.length, 0);

  for (const [status, detail] of [
    ['unknown', 'setting-process-lookup-unknown'],
    ['absent', 'setting-process-absent'],
  ]) {
    const unresolved = harness(t, { freshMissing: true, pidPending: true, mode: 'defer',
      processLookup: { status, matches: [] } });
    const result = await unresolved.actual.startupSend({ tabId: 'tab-a', generation: 'launch-a',
      attemptId: status + '-attempt', command: COMMAND, source: 'startup-defaults:tui-ready-effort',
      isExecutionCurrent: () => true });
    assert.equal(result.error, 'claude_setting_write_refused');
    assert.equal(result.detail, detail);
    assert.equal(unresolved.writes.length, 0);
  }
});

test('actual main startup adapter rechecks execution after composer await before any write', async t => {
  let release;
  let reached;
  const entered = new Promise(resolve => { reached = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  let current = true;
  const h = harness(t, { mode: 'defer', promptStabilityWait: async () => {
    reached();
    await wait;
    return { ready: true, lease: { id: 'lease' } };
  } });
  const pending = h.actual.startupSend({ tabId: 'tab-a', generation: 'launch-a',
    attemptId: 'startup-attempt', command: COMMAND, source: 'startup-defaults:manual-retry-effort',
    isExecutionCurrent: () => current });
  await entered;
  current = false;
  release();
  const result = await pending;
  assert.equal(result.submitted, false);
  assert.equal(result.error, 'superseded-settings-outcome');
  assert.equal(h.enterCount(), 0);
});

test('actual owner adapter refuses stale PID/lifecycle writes and suppresses old buffered proof', async t => {
  for (const change of ['pid', 'lifecycle']) {
    const h = harness(t);
    const send = await h.send();
    if (change === 'pid') h.setPid(999); else h.setLifecycle('replacement');
    assert.equal((await h.read(send)).success, false);
    h.setComposer(COMMAND);
    const retry = await h.actual.inspect('tab-a', COMMAND, { submit: true, settingCommandId: send.settingCommandId });
    assert.equal(retry.submitted, false);
    assert.equal(retry.detail, 'owner-changed');
    assert.equal(h.enterCount(), 1);
  }
});

test('saved Resume SID is only a baseline; actual resolver will not authorize it without a verified bridge', async t => {
  const h = harness(t, { freshMissing: true, mode: 'defer' });
  h.launch.launchMode = 'resume';
  fs.writeFileSync(h.file, line(anchor()) + line(wrapper('saved-old')) + line(output('saved-old')));
  const send = await h.send();
  assert.equal(h.actual.resolveBinding('tab-a', h.actual.captureOwner('tab-a')), null);
  const proof = await h.read(send, { sessionId: 'session-a' });
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'session-binding-mismatch');
  assert.equal(h.enterCount(), 1);
});

test('actual queue keeps two manual commands byte-contiguous and reentrant main owner survives sender options', async t => {
  const h = harness(t);
  const [a, b] = await Promise.all([h.send(), h.send()]);
  assert.notEqual(a.settingCommandId, b.settingCommandId);
  assert.deepEqual(h.writes.map(data => data === '\r' ? 'enter' : 'paste'), ['paste', 'paste', 'enter', 'paste', 'paste', 'enter']);
  assert.equal((await h.read(a)).success, true);
  assert.equal((await h.read(b)).success, true);
  const c = await h.actual.queue(h.term, owner => h.send(COMMAND, { ptyWriteOwner: owner, proofOwner: 'main',
    settingsOperationId: 'manual-operation', startupAttemptId: 'manual-attempt', expectSettingClaimResult: true }));
  assert.equal(c.submitted, true);
  assert.equal(h.claims.at(-1).metadata.proofOwner, 'main');
  assert.equal((await h.read(c)).operationId, 'manual-operation');
});
