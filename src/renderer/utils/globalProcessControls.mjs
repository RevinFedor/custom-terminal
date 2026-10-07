// Process observations and UI intent are separate: confirmation freezes the
// exact observed targets, never "whatever is external when Apply runs".
export function processControlRows(inventory, scope = 'agents') {
  if (!inventory || ['claude', 'gemini', 'codex', 'mcp', 'electronDev'].some(key => !Array.isArray(inventory[key]))) {
    throw new Error('Process inventory unavailable');
  }
  const rows = scope === 'mcp-orphans' || scope === 'mcp'
    ? inventory.mcp.filter(row => scope==='mcp' || row.isAlive === false).map(row => ({ ...row, kind: 'mcp', provider: 'mcp' }))
    : [
      ...['claude', 'gemini', 'codex'].flatMap(provider => inventory[provider].map(row => ({ ...row, kind: 'ai', provider }))),
      ...inventory.electronDev.map(row => ({ ...row, kind: 'electron', provider: 'electron' })),
    ];
  return rows.map(row => Object.freeze(row));
}

export function processControlKey(row) {
  return `${row.kind}:${row.provider}:${row.pid}`;
}

export function canStopObservedProcess(row, bulk = false) {
  if (!Number.isInteger(row?.pid) || row.pid <= 1 || !Number.isInteger(row.ppid)
    || !row.command || !row.startTime || row.killable === false) return false;
  if (row.kind === 'electron') return !bulk;
  if (!['current', 'custom-terminal', 'external'].includes(row.ownerInstance)
    || typeof row.protectedByApp !== 'boolean' || typeof row.killable !== 'boolean') return false;
  if (row.kind === 'mcp') return bulk ? row.isAlive===false && row.protectedByApp!==true
    : row.ownerInstance==='current' || row.protectedByApp!==true;
  if (row.kind !== 'ai') return false;
  if (bulk) return !row.tabId && row.protectedByApp !== true;
  if (row.tabId) return row.ownerInstance === 'current';
  return !(row.protectedByApp === true && row.ownerInstance === 'custom-terminal');
}

export function observedProcessIdentity(row) {
  // CPU/MEM and display name may change normally. Process/owner fields must
  // match. Main's current startTime is HH:MM, not an OS birth token; this is
  // an observable-identity reread, not an atomic PID-reuse proof.
  return JSON.stringify([
    row.kind, row.provider, row.pid, row.ppid, row.startTime, row.command,
    row.cwd ?? null, row.tabId ?? null, row.ownerInstance ?? null,
    row.ownerPid ?? null, row.protectedByApp ?? null, row.killable ?? null,
    row.launcherPid ?? null, row.isOrphan ?? null, row.isAlive ?? null,
    row.processStartedAt ?? null,
  ]);
}

export function freezeProcessStopTargets(rows, bulk = false) {
  const unique = new Map();
  for (const row of rows) {
    if (!canStopObservedProcess(row, bulk)) continue;
    unique.set(processControlKey(row), Object.freeze({ ...row, bulk }));
  }
  return Object.freeze([...unique.values()]);
}

export async function executeObservedProcessStops(targets, { readInventory, invoke, findTab, isCurrent = () => true }) {
  const results = [];
  for (const target of targets) {
    if (!isCurrent()) break;
    try {
      const inventory = await readInventory();
      if (!isCurrent()) break;
      const scope = target.kind === 'mcp' ? 'mcp' : 'agents';
      const fresh = processControlRows(inventory, scope).find(row => processControlKey(row) === processControlKey(target));
      if (!fresh || observedProcessIdentity(fresh) !== observedProcessIdentity(target)
        || !canStopObservedProcess(fresh, target.bulk)) {
        results.push({ pid: target.pid, success: false, error: 'Process or owner changed. Refresh and confirm again.' });
        continue;
      }
      let result;
      if (fresh.kind === 'ai' && fresh.tabId) {
        // Main inventory proves a current-instance PTY parent. A loaded local
        // entry must agree, but unopened background tabs still retain Stop.
        const tab = findTab?.(fresh.tabId);
        if (tab && (tab.tabType === 'file' || (tab.commandType && tab.commandType !== fresh.provider))) {
          results.push({ pid: fresh.pid, success: false, error: 'Current tab owner changed.' });
          continue;
        }
        result = await invoke('terminal:stop-ai-process', {
          tabId: fresh.tabId, toolType: fresh.provider, reason: 'manual-global-process-controls',
        });
      } else {
        result = await invoke(fresh.kind === 'electron' ? 'system:kill-electron-dev-process' : 'system:kill-process',
          fresh.processStartedAt?{pid:fresh.pid,expectedProcess:fresh}:fresh.pid);
      }
      results.push({ pid: fresh.pid, success: result?.success === true,
        error: result?.success === true ? null : result?.error || 'Stop not confirmed.' });
    } catch (error) {
      results.push({ pid: target.pid, success: false, error: String(error?.message || error) });
    }
  }
  return results;
}
