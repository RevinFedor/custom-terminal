'use strict';

const { createHash } = require('node:crypto');
const { capturePrimaryDependencies } = require('./history-primary-dependencies');

// Only this producer's captured cuts and cleaned exceptions can cross the
// plane as supersession. Error codes/messages and caller-supplied fields are
// never authority for this transition.
const captures = new WeakMap(), changes = new WeakMap();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validCounter = value => Number.isSafeInteger(value) && value >= 0;

function primaryDependencyScope(payload) {
  if (payload?.readProfile !== 'history-primary-v1' || payload.toolType !== 'codex'
    || typeof payload.readDemandId !== 'string' || !payload.readDemandId.trim()
    || Buffer.byteLength(payload.readDemandId) > 4096
    || typeof payload.sessionId !== 'string' || !payload.sessionId
    || payload.cwd != null && typeof payload.cwd !== 'string'
    || payload.tabId != null && typeof payload.tabId !== 'string') return null;
  return Object.freeze({ readDemandId: payload.readDemandId, toolType: 'codex',
    sessionId: payload.sessionId, cwd: payload.cwd ?? '', tabId: payload.tabId ?? '' });
}
const sameScope = (a, b) => !!a && !!b && Object.keys(a).every(key => a[key] === b[key]);

function capturePrimaryChangeDependencies(service, canonical, sessions, options = {}) {
  const prepared = options.preparedOwner;
  if (prepared && (service.promptPresentationStore !== prepared.manager
    || prepared.manager?.db !== prepared.connection
    || options.ownReadSnapshot && prepared.connection?.inTransaction !== true))
    return Object.freeze({ known: false, reason: 'prepared-sidecar-owner-changed' });
  const captured = capturePrimaryDependencies(service, canonical, sessions, options);
  if (captured.known && Array.isArray(sessions)) captures.set(captured, {
    canonical, source: digest(canonical.sourceSnapshot), tabId: options.tabId ?? '',
    sessions: Object.freeze([...sessions]),
  });
  return captured;
}

function primaryDependencyChange(error, domain, before, after, scope) {
  const a = captures.get(before), b = captures.get(after);
  if (!scope || !['prompt','timing'].includes(domain) || !a || !b
    || !before.known || !after.known || !before.sourceCurrent || !after.sourceCurrent
    || before.service !== after.service || before.manager !== after.manager
    || !before.manager || before.connection !== after.connection
    || before.runtime !== after.runtime || a.canonical !== b.canonical || a.source !== b.source
    || a.tabId !== b.tabId || a.tabId !== scope.tabId
    || a.sessions.length !== b.sessions.length || a.sessions.some((id,i) => id !== b.sessions[i])) return error;
  // Scoped sidecars include the UUID-wide timing-provider counter before
  // the tab and per-session counters. Its changes can affect a captured row
  // even when the winning interval belongs to an uncaptured session.
  const left = before.versions, right = after.versions, length = 5 + 2 * a.sessions.length;
  if (left?.mode !== 'scoped' || right?.mode !== 'scoped'
    || left.values.length !== length || right.values.length !== length
    || !left.values.every(validCounter) || !right.values.every(validCounter)
    || left.values[0] !== right.values[0]) return error;
  // schema/total_changes are fences, not domain-change proof. A rolled-back
  // local write changes total_changes only. Topology must retain this coverage.
  for (let i = 6; i < length; i += 2) if (left.values[i] !== right.values[i]) return error;
  const positions = domain === 'prompt' ? [2] : [3, 4, ...a.sessions.map((_,i) => 5 + i * 2)];
  if (positions.some(i => right.values[i] < left.values[i])
    || !positions.some(i => right.values[i] > left.values[i])) return error;
  const domainWitness = values => digest(['primary-dependency-v1', domain,
    scope.toolType, scope.sessionId, scope.cwd, scope.tabId, a.sessions,
    values[0], positions.map(i => values[i])]);
  changes.set(error, { scope, domain, cleaned: false,
    witness: Object.freeze({ mode: 'scoped', before: domainWitness(left.values), after: domainWitness(right.values) }) });
  return error;
}

function completePrimaryDependencyCleanup(error, clean) {
  const change = changes.get(error);
  if (change) { if (clean) change.cleaned = true; else changes.delete(error); }
}

function primaryDependencyOutcome(error, payload, admittedScope, generation, ownerKey) {
  const change = changes.get(error);
  if (!change?.cleaned || !sameScope(change.scope, admittedScope)
    || !sameScope(change.scope, primaryDependencyScope(payload))) return null;
  return { success: false, __notedHistoryTransport: 'primary-dependency-v1',
    outcome: 'superseded-dependency', domain: change.domain, requiredClass: 'source',
    generation, ownerKey, scope: { ...change.scope }, witness: { ...change.witness } };
}

module.exports = { primaryDependencyScope, capturePrimaryChangeDependencies,
  primaryDependencyChange, completePrimaryDependencyCleanup, primaryDependencyOutcome };
