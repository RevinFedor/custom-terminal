'use strict';

// PRIVATE Node-only UI fixture. Uses existing actual API/SQL/OSC/History seams,
// not a second production read authority. No Electron, provider, userData or Send.
const http = require('node:http'), url = require('node:url'), crypto = require('node:crypto'), path = require('node:path'), fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { directoryFixture } = require('./workflow-directory-sqlite.cjs');
const { host } = require('./workflow-publication-main.cjs');
const { createOscReadFixture } = require('./codex-osc-read-revoke.cjs');
const { createWorkflowOrganizationHttp, workflowOrganizationCapability } = require('../workflow-organization-http');
const { projectDirectoryRuntime } = require('../workflow-directory-runtime');
const { executionRefForInput } = require('../../shared/workflow-directory-catalog.cjs');
const { stampedEventSink } = require('../public-history-read');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function createIos35NativeFixture({ port = 0, ttlMs = 600000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 900000)
    throw Error('fixture port/TTL outside bounded scope');
  const f = await directoryFixture(), tabId = 'ios35-chat', h = host(f.database,
    process.env.IOS35_CANDIDATE_MAIN ? { mainSource: require('node:fs').readFileSync(process.env.IOS35_CANDIDATE_MAIN, 'utf8') } : {});
  const history = await createOscReadFixture(null, { tabId, fixtureCwd: f.directory, projectId: '__tab_catalog_v2__' });
  f.add(tabId, { codexSessionId: history.sessionId });
  for (let i = 0; i < 27; i++) {
    const filePath = path.join(f.directory, 'file-' + i + '.md');
    fs.writeFileSync(filePath, 'PRIVATE IOS35 FILE ' + i + '\n', { flag: 'wx' });
    f.add('ios35-file-' + i, { tabType: 'file', visualParentTabId: tabId, filePath });
  }
  h.scope.appRuntimeIdentity.instanceId = crypto.randomUUID(); h.bind(); h.flush();
  const token = 'ios35-private-fixture', serviceId = crypto.randomUUID(), holds = new Map(), streams = new Set(), inflight = new Set(), observations = new Map();
  const counts = { catalog: 0, detail: 0, detailReady: 0, basisUpdates: 0,
    runtime: 0, cards: 0, filePage: 0, history: 0, status: 0, duplicatePublication: 0,
    historyIo: 0, historyCompleted: 0, runtimeFailures: 0, cardsFailures: 0, realPublication: 0 };
  const failNext = { runtime: 0, cards: 0 }, historyRequest = new AsyncLocalStorage(), historyAttempts = new Map();
  let failFilePage = 0, runtimeMode = 'positive', lastHistory = null, organizationMutation = null, server, timer, closing;
  let basisChurnRemaining = 0; const directoryErrors = [];
  // Controlled fixture input through an actual production point-write.
  // The existing SQL trigger changes storageRevision without an org wake.
  const bumpBasis = () => f.database.updateTabContextPct(tabId, ++counts.basisUpdates);
  const wait = kind => holds.get(kind)?.promise;
  const started = kind => { counts[kind]++; observations.get(kind)?.release(); observations.delete(kind); };
  const whenRead = kind => counts[kind] > 0 ? Promise.resolve() : (() => {
    if (!observations.has(kind)) observations.set(kind, gate()); return observations.get(kind).promise;
  })();
  // Hold inside the existing actual transcript IO hook, not before HTTP
  // admission or over a fabricated DTO. Async scope joins each real request
  // to its metadata only; it does not supply any read/writer authority.
  history.holdRead(async () => {
    const attempt = historyRequest.getStore();
    if (!attempt) throw Error('fixture_history_attempt_unbound');
    const held = holds.get('history'); attempt.phase = held ? 'held' : 'reading';
    started('historyIo');
    if (held) { await held.promise; attempt.phase = 'reading'; }
  });
  const failCapture = kind => {
    if (failNext[kind] > 0) { failNext[kind]--; counts[kind + 'Failures']++;
      throw Object.assign(Error('fixture_' + kind + '_unavailable'), { statusCode: 503 }); }
  };
  h.scope.captureWorkflowDirectoryRuntime = async entries => {
    started('runtime'); await wait('runtime'); failCapture('runtime');
    const mode = runtimeMode;
    return { epoch: 'ios35-controlled-runtime', isCurrent: () => mode === runtimeMode, tabs: entries.map(entry => {
      const ref = executionRefForInput(entry), terminalId = 'ios35-pty-' + entry.tabId, provider = 'codex';
      const state = { terminalPresent: true, sdkPresent: false, liveOwnerCount: 1,
        commandRunning: true, provider, terminalId, runSeq: 7, launchId: 'L7', lifecycleGeneration: 'G:7',
        projectId: ref.namespace, cwd: ref.cwd, ownBusy: true, inheritedKnown: true, inheritedBusy: false, pending: false,
        stored: { observationKnown: true, token: 'controlled-owner-' + entry.tabId, epoch: 'ios35-controlled-owners', revision: 1,
          scope: { instanceId: 'ios35-instance', executionScope: ref.subject, provider, terminalId, runSeq: 7,
            launchId: 'L7', projectId: ref.namespace, cwd: ref.cwd } }, notification: null };
      if (mode === 'unknown') { state.lookupUnknown = true; state.stored.observationKnown = false;
        state.ownBusy = null; state.inheritedKnown = false; state.inheritedBusy = null; }
      else if (mode === 'zero') { state.commandRunning = false; state.ownBusy = false; }
      return projectDirectoryRuntime(entry, state, 'ios35-instance');
    }) };
  };
  h.scope.captureWorkflowDirectoryCards = async entries => {
    started('cards'); await wait('cards'); failCapture('cards'); return f.cards(entries);
  };
  const api = { ...h.scope.api,
    readCatalogV2: async (...args) => {
      started('catalog'); const reply = await h.scope.api.readCatalogV2(...args);
      if (basisChurnRemaining > 0) { basisChurnRemaining--; bumpBasis(); }
      await wait('catalog-response');
      return reply;
    },
    readTabDetail: async (...args) => {
      started('detail'); await wait('detail-request');
      const reply = await h.scope.api.readTabDetail(...args);
      started('detailReady'); await wait('detail-response');
      return reply; // Delay a genuine accepted 200 after the actual API capture.
    },
    readFilePage: request => {
    counts.filePage++; if (failFilePage > 0) { failFilePage--; throw Object.assign(Error('fixture_file_page_unavailable'), { statusCode: 503 }); }
    return h.scope.api.readFilePage(request);
  } };
  const checkAuth = req => req.headers.authorization === 'Bearer ' + token;
  const sendJson = (res, status, value) => {
    if (status === 409) {
      directoryErrors.push({ ordinal: directoryErrors.length + 1, code: value.error,
        basisUpdates: counts.basisUpdates });
      if (directoryErrors.length > 64) directoryErrors.shift();
    }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  };
  const readBody = async req => { let body = ''; for await (const chunk of req) { body += chunk;
    if (Buffer.byteLength(body) > 32768) throw Error('fixture body too large'); } return JSON.parse(body || '{}'); };
  const route = createWorkflowOrganizationHttp({ getProjectManager: () => ({ db: f.database, workflowOrganization: api }), checkAuth, readBody, sendJson });
  const attemptSnapshot = attempt => attempt && ({ id: attempt.id, phase: attempt.phase, readSessionId: attempt.readSessionId,
    headersSent: attempt.response.headersSent, bodyEnded: attempt.response.writableEnded,
    transportDestroyed: attempt.response.destroyed,
    statusCode: attempt.response.headersSent ? attempt.response.statusCode : null });
  const status = () => ({ privateFixture: true, providerCalls: 0, terminalInput: false, serviceId, tabId,
    workflowPublication: h.helper.snapshot(), held: [...holds.keys()], counts: { ...counts },
    runtimeMode, failNext: { ...failNext, filePage: failFilePage },
    basisChurnRemaining, directoryErrors: directoryErrors.map(value => ({ ...value })),
    organizationMutation: organizationMutation && { ...organizationMutation, publication: { ...organizationMutation.publication } },
    history: { readSessionId: history.ctx.codexRuntimeProjectionStore.read(tabId)?.readSessionId ?? null, writerConfirmed: false,
      inputEffects: history.inputEffects.length, active: [...historyAttempts.values()].map(attemptSnapshot), last: lastHistory } });
  const control = action => {
    if (/^hold-(runtime|cards|history|detail-request|detail-response|catalog-response)$/.test(action)) { const kind = action.slice(5); if (!holds.has(kind)) holds.set(kind, gate()); }
    else if (/^release-(runtime|cards|history|detail-request|detail-response|catalog-response)$/.test(action)) { const kind = action.slice(8); holds.get(kind)?.release(); holds.delete(kind); }
    else if (/^runtime-(positive|unknown|zero)$/.test(action)) runtimeMode = action.slice(8);
    else if (/^fail-(runtime|cards)-once$/.test(action)) failNext[action.slice(5, -5)] = 1;
    else if (action === 'duplicate-publication') { counts.duplicatePublication++; h.web.broadcastProjectActivity('fixture-duplicate'); }
    else if (action === 'rename-workflow') {
      const captured = h.scope.api.read(), ordinal = counts.realPublication + 1, mutationId = 'fixture-workflow-name:' + ordinal;
      h.scope.api.mutate('commitWorkspace', { mutationId, expectedRevision: captured.publication.revision,
        spaces: captured.workflows.map(workflow => ({ ...workflow.metadata, id: workflow.id, version: 1, layout: workflow.layout,
          ...(workflow.id === 'main' ? { name: 'Main fixture publication ' + ordinal } : {}) })),
        tabWorkflowMembership: Object.fromEntries(captured.tabs.map(tab => [tab.tabId,
          { workflowId: tab.membership.workflowId, expectedMembershipRevision: tab.membership.revision }])) });
      counts.realPublication = ordinal;
      organizationMutation = { mutationId, publication: h.scope.api.service.getPublication() };
      h.flush(); // Execute the existing controlled80ms broadcast callback.
    }
    else if (action === 'basis-context-update') bumpBasis();
    else if (action === 'basis-churn-two-catalogs') basisChurnRemaining = 2;
    else if (action === 'fail-file-page-once') failFilePage = 1;
    else if (action === 'history-unknown') history.boundary();
    else if (action === 'history-valid') history.installReadOwner();
    else throw Object.assign(Error('fixture_control_invalid'), { statusCode: 400 });
    return status();
  };
  const handle = async (req, res) => {
    try {
      const parsed = url.parse(req.url, true), pathname = parsed.pathname;
      if (!checkAuth(req)) return sendJson(res, 401, { error: 'unauthorized' });
      if (pathname === '/__fixture/status' && req.method === 'GET') return sendJson(res, 200, status());
      if (pathname === '/__fixture/control' && req.method === 'POST') return sendJson(res, 200, control((await readBody(req)).action));
      if (pathname === '/api/me' && req.method === 'GET') return sendJson(res, 200, {
        ok: true, service: { instanceId: serviceId, serviceId, privateFixture: true },
        capabilities: { workflowOrganization: workflowOrganizationCapability(api),
          historyRead: { version: 1, view: 'history', conditional: 'ifRevision', delta: true, deltaProviders: ['codex'], settingsBaselineVersion: 1 },
          tabEvents: { version: 1, multiplex: 'tabIds', maxTabs: 32 } } });
      if (pathname === '/api/events' && req.method === 'GET') {
        // Existing native publication consumer can receive duplicate baselines
        // over real SSE. No process/runtime event is fabricated by a timer.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.flushHeaders();
        const sink = stampedEventSink({ isAlive: () => !res.destroyed, close: () => res.end(),
          send: text => res.write('data: ' + text + '\n\n') }, serviceId);
        h.sinks.add(sink); streams.add(res); h.web.sendProjectActivitySnapshot(sink);
        res.on('close', () => { h.sinks.delete(sink); streams.delete(res); }); return;
      }
      if (req.method === 'GET' && (pathname === '/api/terminal-tabs/' + tabId + '/history'
        || pathname === '/api/terminal-tabs/' + tabId + '/status')) {
        if (pathname.endsWith('/status')) { started('status'); return await history.web.handleApi(req, res, parsed, new Map()); }
        started('history');
        const attempt = { id: 'history-' + counts.history, phase: 'admitted', response: res,
          readSessionId: history.ctx.codexRuntimeProjectionStore.read(tabId)?.readSessionId ?? null };
        historyAttempts.set(attempt.id, attempt);
        try { return await historyRequest.run(attempt, () => history.web.handleApi(req, res, parsed, new Map())); }
        finally { attempt.phase = 'settled'; lastHistory = attemptSnapshot(attempt);
          historyAttempts.delete(attempt.id); counts.historyCompleted++; }
      }
      // Only the declared read routes enter the actual HTTP router. Generic
      // mutations/creation/drag are not exposed; the private rename control
      // above captures its own exact organization transaction.
      const allowed = req.method === 'GET' && pathname === '/api/workflow-organization' && parsed.query.projection === 'catalog-v2'
        || req.method === 'POST' && (/^\/api\/workflow-organization\/(file-page|runtime-summary|card-signals)$/.test(pathname)
          || /^\/api\/tab-catalog\/[^/]+\/(detail|file-preview)$/.test(pathname));
      if (allowed && await route(req, res, parsed)) return;
      return sendJson(res, 404, { error: 'outside_private_fixture_read_scope' });
    } catch (error) { if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.message }); else res.end(); }
  };
  server = http.createServer((req, res) => {
    const work = handle(req, res); inflight.add(work); work.finally(() => inflight.delete(work));
  });
  const close = () => closing || (closing = (async () => {
    clearTimeout(timer); for (const held of holds.values()) held.release(); holds.clear();
    for (const res of streams) res.end(); streams.clear();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await Promise.allSettled([...inflight]);
    await history.cleanup(); await f.cleanup();
  })());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    server.removeAllListeners('error');
  } catch (error) { await close(); throw error; }
  timer = setTimeout(() => { close().catch(error => console.error('[IOS35Fixture] cleanup failed', error.message)); }, ttlMs);
  return { server, close, status, control, whenRead, tabId, token, root: f.directory, historyRoot: history.root,
    baseUrl: 'http://127.0.0.1:' + server.address().port };
}
if (require.main === module) {
  const flags = process.argv.slice(2), value = name => { const index = flags.indexOf(name); return index < 0 ? undefined : flags[index + 1]; };
  createIos35NativeFixture({ port: Number(value('--port') ?? 7998), ttlMs: Number(value('--ttl-ms') ?? 600000) })
    .then(fixture => {
      console.log('[IOS35Fixture] ' + JSON.stringify({ baseUrl: fixture.baseUrl, token: fixture.token,
        privateRoot: fixture.root, privateHistoryRoot: fixture.historyRoot, ...fixture.status() }));
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { fixture.close().catch(error => { console.error(error); process.exitCode = 1; }); });
    }).catch(error => { console.error('[IOS35Fixture]', error.message); process.exitCode = 1; });
}
module.exports = { createIos35NativeFixture };
