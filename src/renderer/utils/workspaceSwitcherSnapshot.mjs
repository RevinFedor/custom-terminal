import contract from '../../shared/workspace-switcher-contract.cjs';
import { captureSwitcherInputs, selectSwitcherRows } from './tabSwitcherSelector.mjs';
import { workflowFallbackColor, workflowInitial } from './workflowVisuals.mjs';
const { normalizeSwitcherRequest, switcherRequestKey } = contract;
const fail = (code, statusCode = 503) => { throw Object.assign(new Error(code), { code, statusCode }); };

// The bridge publishes metadata only. Do not clone every Tab's drafts, notes,
// task plans and process fields just to discard them again in tabDto below.
// The desktop switcher keeps captureSwitcherInputs' complete default snapshot.
const bridgeTab = tab => ({ id: tab.id, name: tab.name, tabType: tab.tabType,
  commandType: tab.commandType, filePath: tab.filePath, missing: tab.missing });

function tabDto(row, fileVerdict, iconRef) {
  const tab = row.tab;
  const fileRef = tab.tabType === 'file' && typeof tab.filePath === 'string' && tab.filePath
    ? { path: tab.filePath } : null;
  const exists = fileRef ? fileVerdict(fileRef.path) : undefined;
  const commandType = typeof tab.commandType === 'string' ? tab.commandType : null;
  return { kind: 'tab', rowId: 'tab:' + tab.id, tabId: tab.id, projectId: row.projectId,
    projectName: row.projectName, workflowId: row.workflowId,
    title: typeof tab.name === 'string' ? tab.name : '', tabType: tab.tabType || 'terminal', commandType,
    provider: ['claude', 'codex', 'gemini'].includes(commandType) ? commandType
      : tab.tabType === 'claude-sdk' || commandType === 'claude-sdk' ? 'claude' : null,
    fileRef, availability: fileRef ? exists === true ? 'available' : exists === false ? 'missing' : 'unknown' : null,
    missing: row.missing === true, selectable: row.missing !== true, projectIconId: iconRef(row.projectIcon, row.projectId) };
}
function rowsDto(rows, fileVerdict) {
  // Build the final DTO directly: no intermediate raw-icon rows followed by
  // a second map/rest-spread of every field. All state remains capture-local.
  const occurrences = new Map(), ids = new Map(), icons = {};
  const ref = value => {
    if (typeof value !== 'string' || !value) return null;
    if (!ids.has(value)) {
      const id = 'i' + ids.size; ids.set(value, id); icons[id] = value;
    }
    return ids.get(value);
  };
  // Equal image strings from different projects can require a full byte
  // comparison in Map. Resolve a project's repeated icon once per capture,
  // retaining exact value checks and first-occurrence icon numbering.
  const projectIcons = new Map();
  const projectRef = (value, projectId) => {
    const cached = projectIcons.get(projectId);
    if (cached && cached.value === value) return cached.id;
    const id = ref(value);
    projectIcons.set(projectId, { value, id });
    return id;
  };
  return { icons, rows: rows.map(row => {
    if (row.kind === 'tab') return tabDto(row, fileVerdict, projectRef);
    const index = occurrences.get(row.workflowId) || 0; occurrences.set(row.workflowId, index + 1);
    return { kind: 'workflow', rowId: 'workflow:' + row.workflowId + ':' + index,
      workflowId: row.workflowId, title: row.workflowName,
      iconFallback: row.unplaced === true ? null
        : { text: workflowInitial(row.workflowName), color: workflowFallbackColor(row.workflowId) },
      unplaced: row.unplaced === true, selectable: false, iconId: ref(row.workflowIcon) };
  }) };
}

// All accepted containers below are created by this projection/selector. Only
// immutable scalar values may come from the mutable stores; opaque values keep
// the original JSON path. In particular, this never caches a Tab/Map identity.
const jsonScalar = value => value === null || typeof value === 'string'
  || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
const scalarRecord = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && !('toJSON' in value)
  && Object.keys(value).every(key => jsonScalar(value[key]));
function scalarArray(value) {
  if (!Array.isArray(value)) return false;
  // for-of visits holes as undefined, unlike every: JSON would encode them null.
  for (const item of value) if (!jsonScalar(item)) return false;
  return true;
}
function comparablePublication([desktop, mru, catalog]) {
  if ('toJSON' in [] || 'toJSON' in desktop || 'toJSON' in catalog) return false;
  if (!Object.keys(desktop).every(key => key === 'visibleTabIds'
    ? scalarArray(desktop[key]) : jsonScalar(desktop[key]))) return false;
  for (const pair of mru) if (!Array.isArray(pair) || pair.length !== 2 || !scalarArray(pair)) return false;
  if (!scalarRecord(catalog.icons)) return false;
  for (const row of catalog.rows) {
    if ('toJSON' in row || !Object.keys(row).every(key => {
      const value = row[key];
      return key === 'fileRef' || key === 'iconFallback'
        ? value === null || scalarRecord(value) : jsonScalar(value);
    })) return false;
  }
  return true;
}
// A fast snapshot has no JSON hooks. If a hook is introduced later, encode
// that previous value with neutral private containers, not the new prototype.
function neutralPublicationValue(value) {
  if (value === null || typeof value !== 'object') return value;
  const copy = Array.isArray(value) ? Object.setPrototypeOf([], null) : Object.create(null);
  for (const key of Object.keys(value)) copy[key] = neutralPublicationValue(value[key]);
  return copy;
}
function samePublicationValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (!samePublicationValue(left[i], right[i])) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]
    || !samePublicationValue(left[a[i]], right[b[i]])) return false;
  return true;
}

// A revisioned read projection of the same store snapshots the panel consumes.
// Subscription ownership lives in App; this object has no timers/navigation.
export function createWorkspaceSwitcherSnapshot({ epoch, readWorkspace, readProjects, readReady = () => true,
  fileVerdict = () => undefined, probeFiles = async () => {}, inboxName = 'Inbox', onChanged = () => {} }) {
  if (!epoch) throw Error('switcher_epoch_required');
  let revision = 0, fingerprint = null, published = null, disposed = false;
  const capture = () => {
    if (disposed) fail('switcher_renderer_retired');
    const ws = readWorkspace();
    if (ws.isRestoring || !readReady()) fail('switcher_renderer_restoring');
    const input = captureSwitcherInputs(ws, readProjects(), {
      isFileMissing: path => fileVerdict(path) === false, inboxName, projectTab: bridgeTab,
    });
    const catalog = rowsDto(selectSwitcherRows(input).rows, fileVerdict);
    // Explicit metadata only. Never serialize the full Tab (draft/chips/body).
    const value = [input.desktop, input.globalMru.map(x => [x.projectId, x.tabId]), catalog];
    let changed;
    if (comparablePublication(value)) {
      changed = published !== null ? !samePublicationValue(published, value)
        : typeof fingerprint !== 'string' || fingerprint.startsWith('unavailable:')
          || JSON.stringify(value) !== fingerprint;
      published = value; fingerprint = null;
    } else {
      const next = JSON.stringify(value);
      changed = next !== (published !== null ? JSON.stringify(neutralPublicationValue(published)) : fingerprint);
      published = null; fingerprint = next;
    }
    if (changed) {
      revision++;
      onChanged({ version: 1, epoch, revision, available: true });
    }
    return { input, catalog: catalog.rows };
  };
  const refresh = () => {
    try { capture(); } catch (error) {
      if (disposed) return;
      published = null;
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
      const { rows, icons } = rowsDto(selected.rows, fileVerdict);
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
