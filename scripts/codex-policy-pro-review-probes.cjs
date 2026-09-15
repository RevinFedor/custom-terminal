'use strict';
// Source-region replay of the three additional findings from Pro390d31ba.
// Only fixture terminals/stores and exact production function bodies; no app,
// provider, user input or live storage. Baseline mode checks the old failures.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = process.env.CODEX_POLICY_PROBE_ROOT || path.resolve(__dirname, '..');
const baseline = process.env.CODEX_POLICY_EXPECT_BASELINE === '1';
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const web = fs.readFileSync(path.join(root, 'src/main/web-server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src/renderer/store/useWorkspaceStore.ts'), 'utf8');
const mainAst = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const appAst = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const quiet = { log() {}, warn() {}, error() {} };
const results = [];
const ticks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const js = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function part(source, begin, end) {
  const a = source.indexOf(begin), b = source.indexOf(end, a + begin.length);
  assert.ok(a >= 0 && b > a, begin); return source.slice(a, b);
}
function fn(ast, name) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}
async function check(name, run) {
  const evidence = await run(); results.push({ name, evidence });
  console.log(JSON.stringify(results.at(-1)));
}

(async () => {
  await check('ProF2 actual partial intent branch preserves effective model until application', async () => {
    let candidate;
    const minimum = app.indexOf('// The same main-owned intent survives stopped, starting and busy.');
    function visit(node) {
      if (!candidate && ts.isCallExpression(node) && node.getStart(appAst) > minimum
        && node.arguments[0]?.text === 'codex:set-model-effort-intent') {
        let p = node.parent; while (p && !ts.isBlock(p)) p = p.parent; candidate = p;
      }
      ts.forEachChild(node, visit);
    }
    visit(appAst); assert.ok(candidate);
    const tab = { codexSessionId: 'S', codexModel: 'gpt-6-astra', codexEffort: 'high',
      codexLiveModel: 'gpt-6-astra', codexLiveEffort: 'high', codexLiveSettingsSessionId: 'S', codexLiveSettingsProofAt: 10 };
    let state, saved = 0, response;
    const ctx = vm.createContext({ Number, console: quiet, Date,
      tabId: 'T', tab, requestedModel: 'gpt-6-astra', requestedEffort: 'xhigh', useUIStore: {},
      ipcRenderer: { invoke: async () => ({ success: true, queued: true, intentRevision: 7 }) },
      recoverAgentDraftTransferToHistory: async () => ({}), reply: (ok, data) => { response = { ok, ...data }; },
      get: () => state, set() {}, saveTabs: () => saved++,
    });
    vm.runInContext(js('globalThis.mutators = {' + part(store, '  updateCodexState: (tabId, state', '\n  updateCodexLiveServiceTier:') + '};'), ctx);
    state = { openProjects: new Map([['P', { projectId: 'P', tabs: new Map([['T', tab]]) }]]), ...ctx.mutators };
    ctx.state = state;
    vm.runInContext(js('globalThis.partial = async () => ' + candidate.getText(appAst)), ctx);
    await ctx.partial();
    const effective = (await import(path.join(root, 'src/renderer/utils/codexEffectiveSettings.mjs'))).resolveCodexEffectiveSettings(tab);
    assert.equal(response.applied, false); assert.equal(response.queued, true);
    assert.equal(effective.effort, baseline ? 'xhigh' : 'high');
    assert.equal(saved, baseline ? 1 : 0);
    assert.equal(effective.liveOwned, !baseline);
    return { response, saved, effective };
  });

  await check('ProF3 actual starting producer and public stamp do not borrow old writer/read identity', () => {
    const webAst = ts.createSourceFile('web.js', web, ts.ScriptTarget.Latest, true);
    let emitted;
    const ctx = vm.createContext({ Number, String, Object, Map, Date, console: quiet,
      publicRuntimeSnapshots: new Map(), conversationOwners: null, fingerprintAgentSendRequest: JSON.stringify,
      terminalCommandState: new Map([['T', { isRunning: true, runSeq: 2 }]]),
      currentAiLifecycleIdentity: () => ({ terminalLifecycleGeneration: 'G2', sessionId: null }),
      publishCodexRuntimeProjection: () => ({ sessionStatus: 'starting', lifecycleGeneration: 'G2',
        sessionId: null, readSessionId: 'new-resume-source', busy: false, inputReady: false }),
      scheduleProjectActivityBroadcast() {}, path, srcMainDir: '/fixture',
      require: () => ({ webBroadcast: (tabId, payload) => { emitted = JSON.parse(JSON.stringify(ctx.stampPublicRuntimeSnapshot(tabId, payload))); } }),
      getCodexRuntimeSessionId: () => null, getCodexMcpStartupStatus: () => null,
      getCodexPublicWriterFields: () => ({ writerConfirmed: false, savedSessionId: 'new-resume-source', provenWriterSessionId: null }),
    });
    vm.runInContext(fn(webAst, 'normalizePublicRuntimeStatus') + '\n' + fn(webAst, 'stampPublicRuntimeSnapshot')
      + '\n' + fn(mainAst, '_webBroadcast') + '\n' + fn(mainAst, 'broadcastCodexStartingSnapshot'), ctx);
    ctx.stampPublicRuntimeSnapshot('T', { type: 'snapshot', coherent: true, lifecycleGeneration: 'G1',
      launchId: 'L1', sessionStatus: 'active', sessionId: 'old-writer', readSessionId: 'old-read', writerConfirmed: true });
    ctx.broadcastCodexStartingSnapshot('T');
    assert.equal(emitted.lifecycleGeneration, 'G2'); assert.equal(emitted.writerConfirmed, false);
    assert.equal(emitted.sessionId, baseline ? 'old-writer' : null);
    assert.equal(emitted.readSessionId, baseline ? 'old-read' : 'new-resume-source');
    return emitted;
  });

  for (const combined of [false, true]) for (const identityPending of [false, true]) {
    await check('ProF4 actual lock/wrapper/raw-enter callback: combined=' + combined + ', pending=' + identityPending, async () => {
      const { createCodexSettingsSendRuntime } = require(path.join(root, 'src/main/codex-settings-send.js'));
      const { classifyManualCodexSubmitAfterWriteQueue } = require(path.join(root, 'src/main/codex-writer-ownership.js'));
      let unlock, entered = false, inputRevision = 1, began = 0;
      const wait = new Promise(resolve => { unlock = resolve; }), writes = [];
      const term = { write: bytes => writes.push(bytes) };
      const ctx = vm.createContext({ console: quiet, Date, Math, String,
        terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { runSeq: 1, isRunning: true }]]),
        findTabIdForTerm: () => 'T', getTerminalInputRevision: () => inputRevision, bumpTerminalInputRevision: () => ++inputRevision,
        getTerminalLifecycleGeneration: () => 'G', getHeadlessTerminalMirror: () => null, reserveClaudeExactEmptyEvidence: () => null,
        assertKnownEmptySend() {}, isLocalSlashCommandPrompt: () => false, conversationOwners: { noteInput() {} },
        _safePasteAndSubmitInner: async (_term, content, options) => {
          entered = true; await wait; term.write(content); term.write('\r');
          options.sendOperationContext.submitted = true; options.sendOperationContext.identityPending = identityPending;
          return { success: true, submitted: true };
        },
        tabId: 'T', term, data: '\r', meta: {}, deferManualInputRevision: true,
        xtermInputOrigin: 'fixture', isTerminalProtocolResponse: false, inputReceivedAt: 0, nodePerformance: { now: () => 1 },
        classifyManualCodexSubmitAfterWriteQueue, codexWatchers: new Map(),
        tryHandleManualCodexModelMigrationEnter: () => ({ handled: false }), tryHandleManualCodexActivePickerEnter: () => ({ handled: false }),
        trackCodexInputLineForCompact: () => null, compactOperations: { getPending: () => null },
        readPendingCodexNativeRewindHandoff: () => null, isCodexRewindDraftSubmitPhase: () => false,
        prepareManualCodexStableSourceSubmit: () => ({ active: false }),
        beginCodexPromptInFlight: () => { began++; return {}; },
        markCodexPromptSubmitted() {}, activateCodexManualCompactAfterPtyWrite() {}, clearCodexPromptInFlight() {},
        queueTerminalCommandMeta() {}, captureTerminalInputForLastCommand() {}, recordComposerForensicPtyInput() {},
        prepareCodexNativeSettingsIntentInput: () => null, markCodexNativeSettingsIntentInputWritten() {},
        codexImageBindings: { handleTerminalInput() {} }, terminalProjects: new Map([['T', '/fixture']]),
        ensureCodexSubmissionWatcher: async () => ({ available: true }),
        manualOperation: { kind: 'manual-codex-enter', source: 'manual', submitted: false, queuedAt: 0 },
      });
      vm.runInContext(part(main, 'const pasteInflight = new WeakMap();', '\nfunction markActivePtySubmit(')
        + '\n' + fn(mainAst, 'markActivePtySubmit') + '\n' + fn(mainAst, 'safePasteAndSubmit')
        + '\n' + fn(mainAst, 'finishSafePasteAfterWrite'), ctx);
      const raw = mainAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleTerminalInput');
      let callback;
      function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(mainAst) === 'withPtyWriteLock'
          && node.arguments[1]?.getText(mainAst).includes('const boundaryArbitration = classifyManualCodexSubmitAfterWriteQueue')) callback = node.arguments[1];
        ts.forEachChild(node, visit);
      }
      visit(raw); assert.ok(callback);
      vm.runInContext('globalThis.rawEnter = ' + callback.getText(mainAst) + ';\nglobalThis.preceding = () => ptyLastQueuedWriteOperation.get(term);', ctx);
      const scope = () => ({ terminal: term, lifecycleGeneration: 'G', runSeq: 1, inputRevision,
        ownerId: 'S', live: true, busy: true, settingsObservationKey: null });
      const runtime = createCodexSettingsSendRuntime({ readScope: scope,
        readSettings: async () => ({ ownerId: 'S', model: 'gpt-6-astra', effort: 'high' }),
        withSettingsQueue: work => work(), withWriteLock: ctx.withPtyWriteLock,
        selectSettings: () => assert.fail('same pair cannot select'), paste: ctx.safePasteAndSubmit });
      const sending = combined ? runtime.sendPrompt({ tabId: 'T', content: 'fixture', model: 'gpt-6-astra', effort: 'high', queue: true, pasteOptions: {} })
        : ctx.safePasteAndSubmit(term, 'fixture', {});
      await ticks(); assert.equal(entered, true);
      ctx.precedingOperation = ctx.preceding(); assert.ok(ctx.precedingOperation);
      const manual = ctx.withPtyWriteLock(term, ctx.rawEnter, ctx.manualOperation);
      unlock(); await sending; await manual;
      const enterCount = writes.filter(x => x === '\r').length;
      assert.equal(enterCount, baseline && combined ? 2 : 1);
      assert.equal(began, baseline && combined ? 1 : 0);
      const during = { enterCount, began, outerKind: ctx.precedingOperation.kind,
        outerSubmitted: ctx.precedingOperation.submitted, outerIdentityPending: ctx.precedingOperation.identityPending || false };
      ctx.precedingOperation = ctx.preceding() || null;
      assert.equal(ctx.precedingOperation, null, 'audit does not retain the keyboard after write lock');
      await ctx.withPtyWriteLock(term, ctx.rawEnter, { kind: 'manual-codex-enter' });
      assert.equal(writes.filter(x => x === '\r').length, enterCount + 1, 'a later genuine Enter is not suppressed');
      return { during, laterEnterAllowed: true };
    });
  }
  if (process.env.CODEX_POLICY_PROBE_OUTPUT) fs.writeFileSync(process.env.CODEX_POLICY_PROBE_OUTPUT,
    JSON.stringify({ root, baseline, node: process.version, typescript: ts.version, results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
