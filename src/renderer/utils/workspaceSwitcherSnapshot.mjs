import contract from '../../shared/workspace-switcher-contract.cjs';
import { captureSwitcherInputs, selectSwitcherRows } from './tabSwitcherSelector.mjs';
import { workflowFallbackColor, workflowInitial } from './workflowVisuals.mjs';
const { normalizeSwitcherRequest, switcherRequestKey } = contract;
const fail = (code, statusCode = 503) => { throw Object.assign(new Error(code), { code, statusCode }); };

function tabDto(row, fileVerdict) {
  const tab = row.tab;
  const fileRef = tab.tabType === 'file' && typeof tab.filePath === 'string' && tab.filePath
    ? { path: tab.filePath } : null;
  const exists = fileRef ? fileVerdict(fileRef.path) : undefined;
  const commandType = typeof tab.commandType === 'string' ? tab.commandType : null;
  return { kind: 'tab', rowId: 'tab:' + tab.id, tabId: tab.id, projectId: row.projectId,
    projectName: row.projectName, projectIcon: row.projectIcon, workflowId: row.workflowId,
    title: typeof tab.name === 'string' ? tab.name : '', tabType: tab.tabType || 'terminal', commandType,
    provider: ['claude', 'codex', 'gemini'].includes(commandType) ? commandType
      : tab.tabType === 'claude-sdk' || commandType === 'claude-sdk' ? 'claude' : null,
    fileRef, availability: fileRef ? exists === true ? 'available' : exists === false ? 'missing' : 'unknown' : null,
    missing: row.missing === true, selectable: row.missing !== true };
}
function rowsDto(rows, fileVerdict) {
  const occurrences = new Map();
  return rows.map(row => {
    if (row.kind === 'tab') return tabDto(row, fileVerdict);
    const index = occurrences.get(row.workflowId) || 0; occurrences.set(row.workflowId, index + 1);
    return { kind: 'workflow', rowId: 'workflow:' + row.workflowId + ':' + index,
      workflowId: row.workflowId, title: row.workflowName, icon: row.workflowIcon,
      iconFallback: row.unplaced === true ? null
        : { text: workflowInitial(row.workflowName), color: workflowFallbackColor(row.workflowId) },
      unplaced: row.unplaced === true, selectable: false };
  });
}

function compactIcons(rows) {
  const ids = new Map(), icons = {};
  const ref = value => {
    if (typeof value !== 'string' || !value) return null;
    if (!ids.has(value)) {
      const id = 'i' + ids.size; ids.set(value, id); icons[id] = value;
    }
    return ids.get(value);
  };
  return { icons, rows: rows.map(row => {
    if (row.kind === 'workflow') {
      const { icon, ...rest } = row; return { ...rest, iconId: ref(icon) };
    }
    const { projectIcon, ...rest } = row; return { ...rest, projectIconId: ref(projectIcon) };
  }) };
}

// A revisioned read projection of the same store snapshots the panel consumes.
// Subscription ownership lives in App; this object has no timers/navigation.
export function createWorkspaceSwitcherSnapshot({ epoch, readWorkspace, readProjects, readReady = () => true,
  fileVerdict = () => undefined, probeFiles = async () => {}, inboxName = 'Inbox', onChanged = () => {} }) {
  if (!epoch) throw Error('switcher_epoch_required');
  let revision = 0, fingerprint = null, disposed = false;
  const capture = () => {
    if (disposed) fail('switcher_renderer_retired');
    const ws = readWorkspace();
    if (ws.isRestoring || !readReady()) fail('switcher_renderer_restoring');
    const input = captureSwitcherInputs(ws, readProjects(), { isFileMissing: path => fileVerdict(path) === false, inboxName });
    const catalog = rowsDto(selectSwitcherRows(input).rows, fileVerdict);
    // Explicit metadata only. Never serialize the full Tab (draft/chips/body).
    const next = JSON.stringify([input.desktop, input.globalMru.map(x => [x.projectId, x.tabId]), compactIcons(catalog)]);
    if (next !== fingerprint) {
      fingerprint = next; revision++;
      onChanged({ version: 1, epoch, revision, available: true });
    }
    return { input, catalog };
  };
  const refresh = () => {
    try { capture(); } catch (error) {
      if (disposed) return;
      const next = 'unavailable:' + error.code;
      if (fingerprint !== next) {
        fingerprint = next; revision++;
        onChanged({ version: 1, epoch, revision, available: false, reason: error.code });
      }
    }
  };
  const validateContext = (request, catalog) => {
    if (request.scope !== 'native') return;
    const ids = new Set(catalog.filter(row => row.kind === 'tab').map(row => row.tabId));
    if ((request.anchorTabId && !ids.has(request.anchorTabId)) || request.visibleTabIds.some(id => !ids.has(id))) {
      fail('switcher_context_stale', 409);
    }
  };
  return {
    epoch,
    refresh,
    dispose() { disposed = true; },
    async read(raw) {
      if (raw.epoch !== epoch) fail('switcher_renderer_retired', 409);
      const request = normalizeSwitcherRequest(raw);
      const first = capture(); validateContext(request, first.catalog);
      await probeFiles(first.catalog.flatMap(row => row.fileRef ? [row.fileRef.path] : []));
      const { input, catalog } = capture(); validateContext(request, catalog);
      const context = request.scope === 'desktop' ? input.desktop : request;
      const selected = selectSwitcherRows(input, { hideOnScreen: true, context });
      const { rows, icons } = compactIcons(rowsDto(selected.rows, fileVerdict));
      return { version: 1, iconCatalogVersion: 1, icons, epoch, revision, known: true, requestKey: switcherRequestKey(request), scope: request,
        view: { anchorTabId: selected.anchorTabId, visibleTabIds: selected.visibleTabIds,
          activeSpaceId: input.desktop.activeSpaceId },
        rows: rows.map(row => ({ ...row, ...(row.kind === 'tab' ? { anchor: row.tabId === selected.anchorTabId } : {}) })),
        totalTabs: rows.filter(row => row.kind === 'tab').length, truncated: false,
        initialIndex: selected.initialIndex,
        initialTabId: selected.initialIndex >= 0 ? rows[selected.initialIndex].tabId : null };
    },
  };
}
