'use strict';
// This is an operational-prompt policy, NOT a Browser lease, Send receipt or
// permission to stop an executor. It never changes completion delivery.
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(value);
const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const STARTUP_ARGUMENT = '--research-maintenance-operation';
function startupFromArgv(argv) {
  const matches = argv.filter(value => value === STARTUP_ARGUMENT || value.startsWith(STARTUP_ARGUMENT + '='));
  if (!matches.length) return null;
  const operationId = matches.length === 1 && matches[0].startsWith(STARTUP_ARGUMENT + '=')
    ? matches[0].slice(STARTUP_ARGUMENT.length + 1) : null;
  return validId(operationId) ? { version: 1, operationId }
    : { version: 1, error: 'research_maintenance_startup_invalid' };
}
function startupArguments(operationId) {
  if (!validId(operationId)) throw error('research_maintenance_startup_invalid', 'A stable startup operation is required', 400);
  return ['--args', STARTUP_ARGUMENT + '=' + operationId];
}
function normalize(value) {
  if (value == null) return { version: 1, operations: [] };
  if (value.version !== 1 || !Array.isArray(value.operations)) throw error('research_maintenance_invalid', 'Invalid saved maintenance policy');
  const ids = new Set(); let active = 0;
  for (const operation of value.operations) {
    if (!validId(operation.operationId) || ids.has(operation.operationId)
      || !['active', 'completed'].includes(operation.state)
      || !Number.isSafeInteger(operation.startedAt) || operation.startedAt < 1
      || (operation.state === 'completed' && (!Number.isSafeInteger(operation.completedAt)
        || operation.completedAt < operation.startedAt))) throw error('research_maintenance_invalid', 'Invalid saved maintenance operation');
    ids.add(operation.operationId); if (operation.state === 'active') active++;
  }
  if (active > 1) throw error('research_maintenance_invalid', 'More than one maintenance owner');
  return { version: 1, operations: value.operations.map(operation => ({ operationId: operation.operationId,
    kind: 'build-install', state: operation.state, startedAt: operation.startedAt,
    ...(operation.state === 'completed' ? { completedAt: operation.completedAt } : {}) })) };
}
const activeId = value => value.operations.find(operation => operation.state === 'active')?.operationId || null;
function transition(value, { action, operationId } = {}, now = Date.now()) {
  if (!validId(operationId) || !['begin', 'complete'].includes(action)) throw error('research_maintenance_request_invalid', 'action and stable operationId are required', 400);
  const next = normalize(value), previous = next.operations.find(operation => operation.operationId === operationId);
  const active = activeId(next);
  if (action === 'begin') {
    if (previous) return { value: next, repeated: true, operation: clone(previous) };
    if (active) throw error('research_maintenance_busy', 'Another planned maintenance operation is active');
    // Receipts are retained so an old begin can never reopen a completed cut.
    next.operations.push({ operationId, kind: 'build-install', state: 'active', startedAt: now });
  } else {
    if (!previous) throw error('research_maintenance_unknown', 'This maintenance operation was not begun');
    if (previous.state === 'completed') return { value: next, repeated: true, operation: clone(previous) };
    if (active !== operationId) throw error('research_maintenance_owner_changed', 'Maintenance owner changed');
    previous.state = 'completed'; previous.completedAt = Math.max(now, previous.startedAt);
  }
  return { value: next, repeated: false, operation: clone(next.operations.find(operation => operation.operationId === operationId)) };
}
// A Noted Main that boots under its own install handover is proof that a
// DIFFERENT Noted install no longer controls this app: the old installer quit
// the app and never relaunched it. Only one installer owns the app lifecycle,
// so its stale `active` record would otherwise make every later startup
// `begin` fail with research_maintenance_busy — forever, because the operator
// `complete` that clears it also requires that same startup handover first.
//
// Scar 01Nov: `npm run build:i-c` was started from a PTY inside Noted. It
// began install:noted:continue:3b09b59d, quit Main 89986, and died with the
// PTY it had just closed — no compile, no relaunch, no complete. The user's
// own reinstall then booted Main 70442 under install:noted:432ed5e8, whose
// startup begin failed; AutoResume, Resume, every Send and even
// orchestration:list-active failed with "Another planned maintenance
// operation is active".
//
// The stale record is completed, not deleted: receipts are retained so an old
// begin can never reopen it. A non-Noted operation (e.g. an SC Desktop
// install:sc-* window) is NOT touched — a Noted restart proves nothing about
// another app's installer — so that window keeps its existing busy guard.
const NOTED_INSTALL_PREFIX = 'install:noted:';
function supersedeStaleNotedInstall(value, startupOperationId, now = Date.now()) {
  const next = normalize(value);
  const active = activeId(next);
  if (!active || active === startupOperationId
    || typeof startupOperationId !== 'string' || !startupOperationId.startsWith(NOTED_INSTALL_PREFIX)
    || !active.startsWith(NOTED_INSTALL_PREFIX)) return { value: next, superseded: null };
  const stale = next.operations.find(operation => operation.operationId === active);
  stale.state = 'completed';
  stale.completedAt = Math.max(now, stale.startedAt);
  return { value: next, superseded: active };
}
module.exports = { normalize, activeId, transition, startupFromArgv, startupArguments, supersedeStaleNotedInstall };
