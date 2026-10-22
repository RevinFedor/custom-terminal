'use strict';

// Read projection only. Full membership/tree remains the existing canonical
// projector's output; window coverage is not an organization mutation.
const crypto = require('node:crypto');
const { stableJson } = require('./workflow-organization.cjs');
const { WINDOW_LAYOUT_CAPABILITY } = require('./workflow-window-presentation.cjs');
const FIRST_FILES = 5, FILE_PAGE_SIZE = 20, MAX_SUMMARY_ROWS = 256;
const CAPABILITY = Object.freeze({ version: 2, treeVersion: 1, inventory: 'active-membership',
  endpoint: '/api/workflow-organization?projection=catalog-v2', indexComplete: true,
  initialFileCount: FIRST_FILES, filePageSize: FILE_PAGE_SIZE, maxSummaryRows: MAX_SUMMARY_ROWS,
  filePage: '/api/workflow-organization/file-page', tabDetail: '/api/tab-catalog/:tabId/detail',
  filePreview: '/api/tab-catalog/:tabId/file-preview', runtime: '/api/workflow-organization/runtime-summary',
  cards: '/api/workflow-organization/card-signals', sourceBindings: 'tab',
  presentation: 'canonical-tree-v1', windowPresentation: false,
  // Additive read sidecar. Clients without this capability keep the full tree.
  windowLayout: WINDOW_LAYOUT_CAPABILITY,
  failurePolicy: 'unavailable-retain-readable-cache', automaticLegacyFallback: false });
const READ_POSTS = Object.freeze([
  ['/api/workflow-organization/file-page', '/api/workflow-organization/file-page'],
  ['/api/workflow-organization/runtime-summary', '/api/workflow-organization/runtime-summary'],
  ['/api/workflow-organization/card-signals', '/api/workflow-organization/card-signals'],
]);
function directoryReadRoute(method, pathname) {
  if (method !== 'POST') return null;
  const exact = READ_POSTS.find(([route]) => route === pathname);
  if (exact) return exact[1];
  const tab = /^\/api\/tab-catalog\/[^/]+\/(detail|file-preview)$/.exec(pathname);
  return tab ? '/api/tab-catalog/:id/' + tab[1] : null;
}
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const hash = value => crypto.createHash('sha256').update(stableJson(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function assertFields(value, fields) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) fail('directory_request_invalid', 400);
}
function assertBasis(capture, request) {
  if (request?.sourceEpoch !== capture.sourceEpoch) fail('directory_source_changed');
  if (request?.catalogClock !== capture.catalogClock) fail('directory_catalog_changed');
}
function summaryIds(value, index) {
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_ROWS || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !Object.hasOwn(index, id))) fail('directory_tab_scope_invalid', 400);
  return [...value];
}
function executionRefForInput(entry) {
  const source = entry.executionSubject, row = entry.nativeRow || entry.legacyRow;
  const subject = source.version === 2
    ? { version: 2, tabId: entry.tabId, subjectId: source.subjectId, executionNamespace: source.executionNamespace, cwd: source.cwd ?? null }
    : { version: 1, tabId: entry.tabId, projectId: source.projectId, cwd: source.cwd ?? null };
  return { subjectVersion: entry.subjectVersion, subject,
    namespace: subject.version === 2 ? subject.executionNamespace : subject.projectId,
    tabId: entry.tabId, cwd: row.cwd ?? source.cwd ?? null,
    storageId: row.id ?? null, storageRevision: row.execution_storage_revision ?? null };
}
function sameDirectoryScope(left, right) {
  return !!left && !!right && left.version === right.version && left.tabId === right.tabId
    && left.cwd === right.cwd && (left.version === 2
      ? !!left.subjectId && left.subjectId === right.subjectId && left.executionNamespace === right.executionNamespace
      : left.version === 1 && !!left.projectId && left.projectId === right.projectId);
}
function createDirectoryCursorCodec({ secret = crypto.randomBytes(32), sourceEpoch = crypto.randomUUID() } = {}) {
  const sign = bytes => crypto.createHmac('sha256', secret).update(bytes).digest();
  return { sourceEpoch,
    encode(value) { const bytes = Buffer.from(JSON.stringify({ ...value, v: 1, sourceEpoch })).toString('base64url');
      return bytes + '.' + sign(bytes).toString('base64url'); },
    decode(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('file_cursor_invalid', 400);
      const [bytes, signature] = token.split('.'), actual = Buffer.from(signature, 'base64url'), expected = sign(bytes);
      if (actual.toString('base64url') !== signature || actual.length !== expected.length
        || !crypto.timingSafeEqual(actual, expected)) fail('file_cursor_invalid', 400);
      let value;
      try { value = JSON.parse(Buffer.from(bytes, 'base64url').toString('utf8')); } catch { fail('file_cursor_invalid', 400); }
      if (!object(value) || value.v !== 1) fail('file_cursor_invalid', 400);
      if (value.sourceEpoch !== sourceEpoch) fail('directory_source_changed');
      return value;
    } };
}
function canonicalFileBuckets(workflows, rows) {
  const buckets = [];
  for (const workflow of workflows) {
    const byId = new Map(workflow.nodes.map(node => [node.id, node]));
    for (const parent of workflow.nodes) {
      if (parent.kind !== 'tab') continue;
      const nodeIds = parent.childIds.filter(id => {
        const node = byId.get(id);
        return node?.kind === 'tab' && rows[node.tabId]?.tabType === 'file' && node.childIds.length === 0;
      });
      if (nodeIds.length > FIRST_FILES) buckets.push({ workflowId: workflow.id, parentNodeId: parent.id, nodeIds });
    }
  }
  return buckets;
}
function prepareDirectoryCatalog(core, codec) {
  const sourceEpoch = codec.sourceEpoch, index = Object.create(null), refs = Object.create(null);
  for (const [tabId, row] of Object.entries(core.rows)) {
    const { name, tabType, commandType, color, sessionStatus, isUtility, membership } = row;
    index[tabId] = { name, tabType, commandType, color, sessionStatus, isUtility, membership };
    refs[tabId] = executionRefForInput(core.executionInputs[tabId]);
  }
  const clocks = { ...core.clocks,
    descriptors: { kind: 'content-hash', value: hash({ rows: core.rows, refs }) },
    tree: { kind: 'content-hash', value: hash(core.workflows) } };
  const catalogClock = hash({ index, refs, rows: core.rows, workflows: core.workflows,
    groups: core.groups, provenanceCounts: core.provenanceCounts, clocks,
    ...(core.windowLayout ? { windowLayout: core.windowLayout } : {}) });
  // Compatibility witness for the UNCHANGED nativeDrag v1 admission. This is
  // exactly full readCapture's tree hash, not the v2 directory content clock.
  // Main still captures all execution refs itself; no hidden ref is invented.
  const nativeDragExpected = { organizationRevision: core.clocks.organization.revision,
    groupsRevision: core.clocks.groups.revision,
    tree: hash(core.workflows.map(({ id, memberTabIds, rootIds, nodes }) => ({ id, memberTabIds, rootIds, nodes }))) };
  const basis = { sourceEpoch, catalogClock }, buckets = canonicalFileBuckets(core.workflows, core.rows);
  const byNode = new Map(core.workflows.flatMap(workflow => workflow.nodes.map(node => [node.id, node])));
  const detail = tabId => {
    if (!Object.hasOwn(index, tabId)) fail('directory_tab_not_found', 404);
    return { ...core.rows[tabId], executionRef: refs[tabId] };
  };
  const publicDetail = tabId => {
    const row = detail(tabId);
    return { tabId, filePath: row.filePath, parentTabId: row.parentTabId,
      visualParentTabId: row.visualParentTabId, executionRef: row.executionRef };
  };
  const next = (bucket, loaded) => loaded >= bucket.nodeIds.length ? null : codec.encode({ catalogClock,
    workflowId: bucket.workflowId, parentNodeId: bucket.parentNodeId, offset: loaded, afterNodeId: bucket.nodeIds[loaded - 1] });
  const window = (bucket, loaded) => ({ workflowId: bucket.workflowId, parentNodeId: bucket.parentNodeId,
    nodeIds: bucket.nodeIds, total: bucket.nodeIds.length, loaded, remaining: bucket.nodeIds.length - loaded, nextCursor: next(bucket, loaded) });
  const hidden = new Set(buckets.flatMap(bucket => bucket.nodeIds.slice(FIRST_FILES).map(id => byNode.get(id).tabId)));
  const initial = () => ({ version: 2, projection: 'catalog-v2', inventory: 'active-membership', ...basis,
    index, workflows: core.workflows, groups: core.groups,
    ...(core.windowLayout ? { windowLayout: { ...core.windowLayout, ...basis } } : {}),
    details: Object.fromEntries(Object.keys(index).filter(id => !hidden.has(id)).map(id => [id, publicDetail(id)])),
    fileWindows: buckets.map(bucket => window(bucket, FIRST_FILES)), provenanceCounts: core.provenanceCounts, clocks, nativeDragExpected,
    initialFileCount: FIRST_FILES, filePageSize: FILE_PAGE_SIZE, excludedSignals: core.excludedSignals, sourceBindings: 'tab',
    // Initial read sidecar only: excluded from content clocks, cursors and drag.
    ...(core.workflowPublication ? { workflowPublication: { ...core.workflowPublication } } : {}) });
  const page = requestCursor => {
    const cursor = codec.decode(requestCursor); assertBasis(basis, cursor);
    const bucket = buckets.find(b => b.workflowId === cursor.workflowId && b.parentNodeId === cursor.parentNodeId);
    if (!bucket || !Number.isSafeInteger(cursor.offset) || cursor.offset < FIRST_FILES || cursor.offset >= bucket.nodeIds.length
      || (cursor.offset - FIRST_FILES) % FILE_PAGE_SIZE !== 0 || cursor.afterNodeId !== bucket.nodeIds[cursor.offset - 1]) fail('file_cursor_invalid', 400);
    const nodeIds = bucket.nodeIds.slice(cursor.offset, cursor.offset + FILE_PAGE_SIZE), loaded = cursor.offset + nodeIds.length;
    return { version: 1, ...basis, requestCursor, start: cursor.offset, ...window(bucket, loaded), nodeIds,
      details: Object.fromEntries(nodeIds.map(id => { const tabId = byNode.get(id).tabId; return [tabId, publicDetail(tabId)]; })) };
  };
  return { ...basis, index, refs, core, detail, publicDetail, initial, page,
    membershipHash: hash(core.workflows.map(w => ({ workflowId: w.id, tabIds: w.memberTabIds }))) };
}

module.exports = { DIRECTORY_CAPABILITY: CAPABILITY, FIRST_FILES, FILE_PAGE_SIZE, MAX_SUMMARY_ROWS,
  directoryReadRoute, assertFields, assertBasis, summaryIds, executionRefForInput, sameDirectoryScope,
  createDirectoryCursorCodec, canonicalFileBuckets, prepareDirectoryCatalog, directoryHash: hash, directoryFail: fail };
