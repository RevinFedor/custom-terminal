'use strict';

// Diagnostic context only: never an auth/source/cache key or an input lease.
// No files, timers, retries, transport cancellation or response-body copies.
const { AsyncLocalStorage } = require('node:async_hooks');
const { errorMonitor } = require('node:events');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parse: parseUrl } = require('node:url');
const { directoryReadRoute } = require('../shared/workflow-directory-catalog.cjs');
const context = new AsyncLocalStorage();
const ID = /^[a-z0-9-]{1,90}$/;
const cleanId = value => typeof value === 'string' && ID.test(value) ? value : null;
const currentHttpReadContext = () => context.getStore() || null;
const sat = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
function httpReadCorrelation(value = currentHttpReadContext()) {
  if (!value) return null;
  const result = {};
  for (const key of ['actionId','readId','attemptId','serverRequestId','ingressId','serviceId','clockId']) result[key] = cleanId(value[key]);
  return result;
}
function readRoute(req) {
  const pathname = parseUrl(String(req.url || '')).pathname || '';
  // Only the exact v2 routes whose handler has read effect. Never all POSTs.
  const directoryRead = directoryReadRoute(req.method, pathname);
  if (directoryRead) return directoryRead;
  if (req.method !== 'GET') return null;
  if (/^\/api\/(me|projects|project-activity|history-freshness|agent-usage|agent-models|workspace-switcher)$/.test(pathname)) return pathname;
  if (/^\/api\/(?:workflow-organization(?:\/(?:catalog|state|roots|groups))?|workflows|tab-catalog|directory-roots)$/.test(pathname)) return '/api/workflow-read';
  if (/^\/api\/projects\/[^/]+\/tabs$/.test(pathname)) return '/api/projects/:id/tabs';
  const tab = pathname.match(/^\/api\/terminal-tabs\/[^/]+\/(history|timeline|history-payload|payload|status|timing|params|queue|pending-question)$/);
  return tab ? '/api/terminal-tabs/:id/' + tab[1] : null;
}
function beginHttpReadDependency(stage, fields) {
  return currentHttpReadContext()?.owner.begin(stage, fields) || (() => {});
}
function createHttpReadDiagnostics({ serviceId, enabled = true, log = line => console.log(line),
  now = () => performance.now(), wall = () => Date.now(), newId = randomUUID,
  activeLimit = 128, completedLimit = 64, eventLimit = 48,
  detailPerMinute = 240, terminalPerMinute = 120 } = {}) {
  const byResponse = new WeakMap(), active = new Map(), completed = [];
  const clockId = newId();
  let sequence = 0, windowAt = -Infinity, details = 0, terminals = 0;
  const losses = { activeOverflow: 0, completedEvicted: 0, eventLimit: 0, rateLimit: 0, terminalRate: 0,
    sinkError: 0, setupError: 0, oversized: 0 };
  const lossRanges = [];
  function lost(reason, seq) {
    losses[reason] = sat(losses[reason]);
    if (!seq) return;
    const last = lossRanges.at(-1);
    if (last?.reason === reason && last.to === seq - 1) last.to = seq;
    else { lossRanges.push({ reason, from: seq, to: seq }); if (lossRanges.length > 8) lossRanges.shift(); }
  }
  function emit(span, event, fields, essential = false) {
    if (!span) return;
    try {
      span.lastPhase = event; span.lastPhaseMonoMs = now();
      const seq = sequence = sat(sequence);
      span.lastSeq = seq;
      if (span.events >= eventLimit && !essential) { lost('eventLimit', seq); return; }
      if (span.lastPhaseMonoMs - windowAt >= 60000) { windowAt = span.lastPhaseMonoMs; details = 0; terminals = 0; }
      if (essential ? terminals >= terminalPerMinute : details >= detailPerMinute) { lost(essential ? 'terminalRate' : 'rateLimit', seq); return; }
      if (essential) terminals++; else details++;
      span.events++;
      const optional = typeof fields === 'function' ? fields() : fields || {};
      const scalar = {};
      for (const key of ['status','utf8Bytes','wireBytes','elapsedMs','finished','headersSent','destroyed',
        'accepted','code','stage','count','source','queueDepth','outcome','phaseId','bridgeRequestId','terminal']) {
        const value = optional[key];
        if (typeof value === 'boolean' || value === null || typeof value === 'number' && Number.isFinite(value)) scalar[key] = value;
        else if (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,90}$/.test(value)) scalar[key] = value;
      }
      const core = { schema: 1, producer: 'main-http', producerBoot: clockId, event, clockId, seq,
        wallMs: wall(), monoMs: span.lastPhaseMonoMs, ...httpReadCorrelation(span), route: span.route,
        omittedEvents: losses.eventLimit + losses.rateLimit, omittedTerminals: losses.terminalRate,
        sinkErrors: losses.sinkError, activeOverflow: losses.activeOverflow };
      let line = '[HttpRead] ' + JSON.stringify({ ...core, ...scalar });
      if (Buffer.byteLength(line) > 2048) { lost('oversized', seq); line = '[HttpRead] ' + JSON.stringify({ ...core, detailOmitted: true }); }
      try { log(line); span.lastDeliveredSeq = seq; } catch { lost('sinkError', seq); }
    } catch { lost('sinkError', sequence); }
  }
  function terminal(span, kind) {
    if (span.httpTerminal) return false;
    span.httpTerminal = kind;
    active.delete(span.serverRequestId); completed.push(span);
    if (completed.length > completedLimit) { completed.shift(); lost('completedEvicted'); }
    return true;
  }
  function phase(res, event, fields) { emit(byResponse.get(res), event, fields); }
  function event(name, fields) { const span=currentHttpReadContext(); if (span?.owner === owner) emit(span,name,fields); }
  function bind() { const span = currentHttpReadContext();
    return (name, fields) => { if (span?.owner === owner) emit(span, name, fields); }; }
  function begin(stage, fields) {
    const span = currentHttpReadContext();
    if (!span || span.owner !== owner) return () => {};
    let start, phaseId;
    try { start = now(); phaseId = cleanId(newId()); } catch { lost('setupError'); return () => {}; }
    emit(span, 'dependency-begin', () => ({ ...(typeof fields === 'function' ? fields() : fields), stage, phaseId }));
    let ended = false;
    return (outcome = 'returned', finalFields) => {
      if (ended) return; ended = true;
      emit(span, 'dependency-end', () => ({ ...(typeof finalFields === 'function' ? finalFields() : finalFields),
        stage, phaseId, outcome, elapsedMs: now() - start }));
    };
  }
  const owner = { begin };
  function run(req, res, operation) {
    let observe, route;
    try { observe = typeof enabled === 'function' ? enabled() : enabled; route = observe ? readRoute(req) : null; }
    catch { lost('setupError'); return operation(); }
    if (!observe || !route || res.writableEnded || res.destroyed) return operation();
    if (active.size >= activeLimit) { lost('activeOverflow'); return operation(); }
    let span;
    try {
      span = { owner, serverRequestId: cleanId(newId()) || randomUUID(), route, serviceId: cleanId(serviceId), clockId,
        actionId: cleanId(req.headers?.['x-noted-action-id']), readId: cleanId(req.headers?.['x-noted-read-id']),
        attemptId: cleanId(req.headers?.['x-noted-read-attempt']), ingressId: cleanId(req.headers?.['x-noted-ingress-id']),
        startedMonoMs: now(), lastPhase: 'http-enter', httpTerminal: null, events: 0, lastDeliveredSeq: null };
      byResponse.set(res, span); active.set(span.serverRequestId, span);
      req.once('aborted', () => emit(span, 'request-aborted'));
      res.once(errorMonitor, error => emit(span, 'http-error', () => ({ code: error?.code || 'response-error' }), true));
      res.once('finish', () => {
        const first = terminal(span, 'response-finished');
        emit(span, 'http-finish', () => ({ status: res.statusCode, elapsedMs: now() - span.startedMonoMs,
          finished: true, terminal: first }), first);
      });
      res.once('close', () => {
        const finished = res.writableFinished === true, first = terminal(span, finished ? 'response-finished' : 'response-closed-incomplete');
        emit(span, 'http-close', { status: res.statusCode, finished, headersSent: res.headersSent === true, terminal: first }, first);
      });
      // Optional observation headers never replace the existing instance/PID fence.
      try {
        res.setHeader('X-Noted-Server-Request-Id', span.serverRequestId);
        if (span.serviceId) res.setHeader('X-Noted-Service-Instance', span.serviceId);
        if (span.attemptId) res.setHeader('X-Noted-Read-Attempt', span.attemptId);
      } catch { lost('setupError'); }
      emit(span, 'http-enter');
    } catch {
      lost('setupError');
      if (span) { active.delete(span.serverRequestId); byResponse.delete(res); }
      return operation();
    }
    // Business exceptions must escape this diagnostic setup catch unchanged.
    return context.run(span, operation);
  }
  function snapshot() {
    const compact = span => ({ ...httpReadCorrelation(span), route: span.route, httpTerminal: span.httpTerminal,
      lastPhase: span.lastPhase, lastSeq: span.lastSeq, lastDeliveredSeq: span.lastDeliveredSeq,
      ageMs: Math.max(0, now() - span.startedMonoMs) });
    return { schema: 1, clockId, seq: sequence,
      limits: { active: activeLimit, completed: completedLimit, eventsPerRead: eventLimit, detailPerMinute, terminalPerMinute },
      active: [...active.values()].map(compact), completed: completed.map(compact),
      losses: { ...losses }, lossRanges: lossRanges.map(x=>({...x})),
      coverage: 'Main callback entry, not kernel accept; missing terminal is unknown; finish is not phone ACK' };
  }
  return { run, phase, event, bind, begin, snapshot };
}
module.exports = { createHttpReadDiagnostics, currentHttpReadContext, httpReadCorrelation, cleanId, readRoute, beginHttpReadDependency };
