'use strict';
// One explicitly requested private E2E cleanup, before any renderer/PTY restore.
// This does not settle, retry or remove an earlier selection Stop journal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const insist = (value, code) => { if (!value) throw Object.assign(Error(code), { code }); };

function readRequest(env, { isPackaged, userData, bundle }) {
  const file = env.NOTED_E2E_STARTUP_CLOSE_REQUEST;
  if (!file) return null;
  const data = env.NOTED_E2E_CLI_ISOLATION_ROOT;
  insist(isPackaged === true && env.NOTED_E2E_TEST === 'true' && data
    && path.isAbsolute(data) && fs.realpathSync(data) === data
    && userData === data + '/user-data' && env.NOTED_USER_DATA_DIR === userData,
  'owned_close_private_profile_required');
  insist(path.dirname(file) === data + '/fixture' && /^owned-startup-close-[a-f0-9-]+\.json$/.test(path.basename(file)),
    'owned_close_request_path');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let request;
  try {
    const st = fs.fstatSync(fd);
    insist(st.isFile() && st.nlink === 1 && st.size > 0 && st.size <= 8192, 'owned_close_request_file');
    request = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const end = fs.lstatSync(file);
    insist(end.dev === st.dev && end.ino === st.ino && end.size === st.size
      && end.mtimeMs === st.mtimeMs && end.ctimeMs === st.ctimeMs && !end.isSymbolicLink(), 'owned_close_request_changed');
  } finally { fs.closeSync(fd); }
  insist(request.version === 1 && request.operation === 'owned-pre-restore-close-only'
    && request.userData === userData && request.bundle === bundle
    && /^[a-f0-9-]{36}$/.test(request.operationId)
    && ['tabId', 'namespace', 'sessionId', 'cwd', 'workflowId', 'originalStopMutationId'].every(k => typeof request[k] === 'string' && request[k])
    && request.cwd === data + '/fixture' && request.namespace === '__tab_catalog_v2__'
    && request.originalOutcome === 'UNKNOWN', 'owned_close_request_invalid');
  return { request, file, data };
}

function parseCensus(ps, opened, { selfPid, scopes }) {
  const rows = new Map();
  for (const line of ps.split('\n').filter(line => line.trim())) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    insist(match && !rows.has(+match[1]), 'owned_close_process_census_unknown');
    rows.set(+match[1], { pid: +match[1], ppid: +match[2], command: match[3] });
  }
  insist(rows.has(selfPid) && rows.size > 1, 'owned_close_process_census_incomplete');
  const ours = new Set([selfPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows.values()) if (ours.has(row.ppid) && !ours.has(row.pid)) { ours.add(row.pid); changed = true; }
  }
  const aliases = scopes.flatMap(scope => [scope, ...(scope.startsWith('/private/tmp/') ? [scope.slice(8)] : [])]);
  const hit = value => aliases.some(scope => value.includes(scope));
  const foreign = [];
  for (const row of rows.values()) if (!ours.has(row.pid) && hit(row.command)) foreign.push({ pid: row.pid, via: 'argv' });
  let pid;
  for (const line of opened.split('\n')) {
    if (/^p\d+$/.test(line)) pid = +line.slice(1);
    else if (line.startsWith('n')) {
      insist(pid, 'owned_close_fd_census_unknown');
      if (hit(line.slice(1))) {
        insist(rows.has(pid), 'owned_close_scoped_process_unknown');
        if (!ours.has(pid)) foreign.push({ pid, via: 'namedFD/cwd' });
      }
    } else insist(!line || /^f/.test(line), 'owned_close_fd_census_unknown');
  }
  insist(foreign.length === 0, 'owned_close_foreign_scope_consumer');
  return { captured: rows.size, ownPids: [...ours], foreign };
}

async function physicalCensus({ bundle, profile }) {
  const [ps, opened] = await Promise.all([
    exec('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,command='], { timeout: 5000, maxBuffer: 8 * 1024 ** 2 }),
    exec('/usr/sbin/lsof', ['-nP', '-Fpn'], { timeout: 15000, maxBuffer: 16 * 1024 ** 2 }),
  ]);
  insist(!ps.stderr.trim() && !opened.stderr.trim(), 'owned_close_census_warning');
  return parseCensus(ps.stdout, opened.stdout, { selfPid: process.pid, scopes: [bundle, profile] });
}

async function recoverOwnedStartupClose(request, ports) {
  const { database, selection, organization, captureOwner, observe, census, archive, finalize } = ports;
  const key = 'owned-startup-close.v1:' + request.operationId, requestHash = sha(request);
  const previous = database.getAppState(key);
  if (previous) {
    insist(previous.requestHash === requestHash && previous.phase === 'completed', 'owned_close_previous_outcome_unknown');
    insist(database.getExecutionTabV2({ executionNamespace: request.namespace, tabId: request.tabId })?.archived === true
      && sha(selection.command(request.originalStopMutationId)) === previous.originalStopHash, 'owned_close_completed_source_changed');
    return previous;
  }
  const original = selection.command(request.originalStopMutationId), step = original.steps?.[request.tabId];
  const oldMember = original.members.find(member => member.tabId === request.tabId);
  insist(original.action === 'stop' && original.kind === 'selection' && oldMember?.namespace === request.namespace
    && oldMember.execution?.codexSessionId === request.sessionId && step?.started === true
    && step.state === 'started' && step.error === 'selection_stop_receipt_unknown', 'owned_close_original_stop_changed');
  const originalStopHash = sha(original);
  const native = database.getExecutionTabV2({ executionNamespace: request.namespace, tabId: request.tabId });
  insist(native && !native.archived && native.tab.commandType === 'codex' && native.tab.cwd === request.cwd
    && native.tab.codexSessionId === request.sessionId && organization.getMembership(request.tabId)?.workflowId === request.workflowId,
  'owned_close_source_changed');
  const member = selection.capture(request.tabId), scope = selection.captureStopScope(member), before = captureOwner(request.tabId);
  insist(!before.terminalId && !before.sdkOwnerId && !before.pendingLaunch && before.runSeq === 0,
    'owned_close_replacement_runtime');
  const familyAbsent = () => insist(database.db.prepare(`SELECT tab_id FROM tabs WHERE execution_archived=0
    AND (visual_parent_tab_id=? OR (tab_type='file' AND parent_tab_id=?))`).all(request.tabId, request.tabId).length === 0,
  'owned_close_unexpected_family');
  familyAbsent();
  const guard = () => {
    insist(exact(before, captureOwner(request.tabId)) && selection.currentStopScope(member, scope), 'owned_close_source_changed');
    insist(sha(selection.command(request.originalStopMutationId)) === originalStopHash, 'owned_close_original_stop_changed');
    familyAbsent();
  };
  const physical = await census(); guard();
  const observation = await observe(member); guard();
  insist(observation?.known === true && observation.identity?.processStatus === 'absent', 'owned_close_process_not_absent');
  // Started is durable BEFORE the first archive write. A lost outcome never
  // permits a second close, Stop, input, journal reset or restoration attempt.
  const intent = { version: 1, phase: 'started', requestHash, originalStopHash,
    tabId: request.tabId, namespace: request.namespace, sessionId: request.sessionId, before, physical };
  database.setAppState(key, intent); guard();
  const expectedNamespaces = [{ namespace: request.namespace, tabIds: database.getProjectTabIds(request.namespace) }];
  const closeRequest = { version: 1, mutationId: request.operationId, namespace: request.namespace,
    tabId: request.tabId, subjectId: native.executionSubject.subjectId, expectedNamespaces };
  // Execution storage is JSON. Its native adapter also adds optional undefined
  // convenience fields; the archive's existing exact JSON intent cannot own
  // those non-durable properties. Preserve every persisted value/column.
  const tab = JSON.parse(JSON.stringify({ ...native.tab, processWasRunning: false }));
  const payload = { projectId: request.namespace, tab, closeRequest };
  const archived = await archive(payload, guard);
  insist(archived?.success === true && archived.closeReceipt, 'owned_close_archive_unknown');
  insist(exact(before, captureOwner(request.tabId)) && sha(selection.command(request.originalStopMutationId)) === originalStopHash,
    'owned_close_post_archive_changed');
  const closeScope = database.assertArchivedCloseReceipt(archived.closeReceipt);
  // This test cleanup is deliberately exact: unexpected attached families or
  // children require their own normal owner flow, never a guessed cascade.
  insist(closeScope.files.length === 0 && closeScope.children.length === 0, 'owned_close_unexpected_family');
  const current = database.getExecutionNamespace(request.namespace);
  insist(current && exact([...current.tabs.map(tab => tab.tabId)].sort(), expectedNamespaces[0].tabIds.filter(id => id !== request.tabId).sort()),
    'owned_close_namespace_changed');
  const final = await finalize({ receipt: archived.closeReceipt, snapshots: [{ projectId: request.namespace,
    expectedTabIds: expectedNamespaces[0].tabIds, tabs: current.tabs }], groupCloseGuard: null });
  insist(final?.success === true && exact(final.closedTabIds, [request.tabId])
    && sha(selection.command(request.originalStopMutationId)) === originalStopHash, 'owned_close_finalization_unknown');
  const result = { ...intent, phase: 'completed', archiveReceipt: archived.closeReceipt,
    closedTabIds: final.closedTabIds, originalStopOutcome: 'UNKNOWN', oldStopReplayed: false, inputOrResume: false };
  database.setAppState(key, result);
  return result;
}

module.exports = { readRequest, parseCensus, physicalCensus, recoverOwnedStartupClose };
