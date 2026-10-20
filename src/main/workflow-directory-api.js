'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises'), path = require('node:path');
const { beginHttpReadDependency } = require('./http-read-diagnostics');
const { unknownDirectoryAppearance } = require('./directory-appearance');
const { DIRECTORY_CAPABILITY, createDirectoryCursorCodec, prepareDirectoryCatalog, directoryHash,
  assertFields, assertBasis, summaryIds, sameDirectoryScope, directoryFail: fail } = require('../shared/workflow-directory-catalog.cjs');
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function createWorkflowDirectoryApi({ readCapture, database, readRuntime, readCards,
  previewFs = fs, codec = createDirectoryCursorCodec() }) {
  const prepared = new WeakMap(), runtimeEpoch = crypto.randomUUID(), cardsEpoch = crypto.randomUUID();
  let runtimeRevision = 0, runtimeFingerprint = null, cardsRevision = 0, cardsFingerprint = null;
  const available = () => typeof readRuntime === 'function' && typeof readCards === 'function'
    && typeof database.getDirectoryTabDetail === 'function' && typeof database.getDirectoryProjectHeader === 'function';
  const capture = () => {
    const promise = readCapture();
    if (!prepared.has(promise)) prepared.set(promise, promise.then(core => {
      const end = beginHttpReadDependency('directory-projection');
      try { return prepareDirectoryCatalog(freeze(core), codec); } finally { end(); }
    }));
    return prepared.get(promise);
  };
  const admit = async (request, fields) => {
    if (!available()) fail('directory_unavailable', 503);
    assertFields(request, fields);
    const value = await capture(); assertBasis(value, request); return value;
  };
  const recheck = async before => { const after = await capture(); assertBasis(after, before); return after; };
  const entry = (current, tabId, request) => {
    const detail = current.detail(tabId);
    if (request.workflowId !== detail.membership.workflowId) fail('directory_tab_binding_changed');
    return detail;
  };
  const coverage = (current, ids) => ({ complete: true, membershipHash: current.membershipHash,
    memberCount: Object.keys(current.index).length, requestedTabIds: ids, rowTabIds: ids });
  return {
    catalogV2Capability: () => available() ? DIRECTORY_CAPABILITY : null,
    async readCatalogV2() {
      if (!available()) fail('directory_unavailable', 503);
      return (await capture()).initial();
    },
    async readFilePage(request) {
      if (!available()) fail('directory_unavailable', 503);
      assertFields(request, ['cursor']);
      return (await capture()).page(request.cursor);
    },
    async readTabDetail(tabId, request) {
      const before = await admit(request, ['sourceEpoch','catalogClock','workflowId']);
      const detail = entry(before, tabId, request);
      const executionTab = detail.tabType === 'file' ? null : database.getDirectoryTabDetail(detail.executionRef);
      if (detail.tabType !== 'file' && !executionTab) fail('directory_tab_binding_changed');
      const project = database.getDirectoryProjectHeader(detail.executionRef.namespace);
      if (!project) fail('directory_namespace_not_found', 404);
      const after = await recheck(before); entry(after, tabId, request);
      return { version: 1, sourceEpoch: before.sourceEpoch, catalogClock: before.catalogClock,
        tabId, workflowId: request.workflowId, detail: before.publicDetail(tabId), project, executionTab };
    },
    async readFilePreview(tabId, request) {
      const before = await admit(request, ['sourceEpoch','catalogClock','workflowId']);
      const detail = entry(before, tabId, request), filePath = detail.filePath;
      if (detail.tabType !== 'file' || !path.isAbsolute(filePath || '')) fail('directory_file_binding_unavailable', 404);
      const stat = await previewFs.stat(filePath);
      if (!stat.isFile()) fail('directory_not_file', 400);
      if (stat.size > 1024 * 1024) fail('directory_preview_too_large', 413);
      const bytes = await previewFs.readFile(filePath);
      if (bytes.length > 1024 * 1024) fail('directory_preview_too_large', 413);
      const content = bytes.toString('utf8');
      const after = await recheck(before); entry(after, tabId, request);
      return { version: 1, sourceEpoch: before.sourceEpoch, catalogClock: before.catalogClock,
        tabId, workflowId: request.workflowId, executionRef: detail.executionRef,
        file: { path: filePath, name: path.basename(filePath), ext: path.extname(filePath).toLowerCase(), size: bytes.length, content } };
    },
    async readRuntimeSummary(request) {
      const before = await admit(request, ['sourceEpoch','catalogClock','tabIds']);
      const ids = summaryIds(request.tabIds, before.index);
      const entries = Object.values(before.core.executionInputs).filter(item => before.index[item.tabId].tabType !== 'file');
      const observed = await readRuntime(entries);
      await recheck(before);
      const current = typeof observed?.isCurrent === 'function' && observed.isCurrent() === true;
      const byId = new Map((current ? observed.tabs : []).filter(row => before.refs[row.tabId]
        && sameDirectoryScope(row.executionScope, before.refs[row.tabId].subject)
        && (!(row.liveKnown === true && row.live === true) || row.ownerToken && row.ownerOrder
          && row.provider === before.index[row.tabId].commandType)).map(row => [row.tabId, row]));
      const unknown = tabId => ({ tabId, liveKnown: false, live: null, busyKnown: false, ownBusy: null,
        inheritedBusy: null, notificationKnown: false, notification: null, reason: 'runtime_owner_unproven' });
      const publicRow = row => ({ tabId: row.tabId, executionRef: before.refs[row.tabId], provider: row.provider ?? null,
        ownerToken: row.ownerToken ?? null, ownerOrder: row.ownerOrder ?? null,
        lifecycleGeneration: row.lifecycleGeneration ?? null, terminalRunSeq: row.terminalRunSeq ?? null, launchId: row.launchId ?? null,
        liveKnown: row.liveKnown === true, live: row.liveKnown === true ? row.live : null,
        busyKnown: row.busyKnown === true, ownBusy: row.ownBusy ?? null, inheritedBusy: row.inheritedBusy ?? null,
        notificationKnown: row.notificationKnown === true, notification: row.notificationKnown === true ? row.notification : null,
        reason: row.reason ?? null, reasons: row.reasons || { live: row.liveKnown ? null : 'runtime-owner-unproven',
          busy: row.busyKnown ? null : 'runtime-owner-unproven', notification: row.notificationKnown ? null : 'runtime-owner-unproven' },
        proof: row.proof || 'unproven' });
      const all = entries.map(item => byId.get(item.tabId) || unknown(item.tabId));
      const fingerprint = directoryHash([before.catalogClock, observed?.epoch || null, all]);
      if (fingerprint !== runtimeFingerprint) { runtimeFingerprint = fingerprint; runtimeRevision++; }
      const workflows = before.core.workflows.map(workflow => {
        const members = all.filter(row => before.index[row.tabId].membership.workflowId === workflow.id);
        const summary = { workflowId: workflow.id, nonFileCount: members.length };
        for (const field of ['live','busy','notification']) {
          summary[field + 'Known'] = members.every(row => row[field + 'Known'] === true);
          summary[field + 'Count'] = summary[field + 'Known'] ? members.filter(row => field === 'busy'
            ? row.ownBusy === true || row.inheritedBusy === true : row[field] === true).length : null;
        }
        return summary;
      });
      return { version: 1, sourceEpoch: before.sourceEpoch, catalogClock: before.catalogClock,
        runtimeEpoch, revision: runtimeRevision, producerEpoch: observed?.epoch || null,
        coverage: coverage(before, ids), workflows,
        tabs: ids.map(tabId => publicRow(before.index[tabId].tabType === 'file'
          ? { tabId, liveKnown: true, live: false, busyKnown: true, ownBusy: false, inheritedBusy: false,
            notificationKnown: true, notification: false, reason: 'file-not-runtime' }
          : byId.get(tabId) || unknown(tabId))) };
    },
    async readCardSignals(request) {
      const before = await admit(request, ['sourceEpoch','catalogClock','tabIds']);
      const ids = summaryIds(request.tabIds, before.index);
      const observed = await readCards(ids.map(id => before.core.executionInputs[id]));
      await recheck(before);
      if (typeof observed?.isCurrent !== 'function' || observed.isCurrent() !== true) fail('directory_card_owner_changed');
      const rows = new Map((observed.tabs || []).map(row => [row.tabId, row]));
      if (rows.size !== ids.length || ids.some(id => !rows.has(id))) fail('directory_card_coverage_incomplete', 503);
      const value = { producerEpoch: observed.epoch, producerRevision: Number.isSafeInteger(observed.revision) ? observed.revision : null,
        directoryAppearance: observed.directoryAppearance || unknownDirectoryAppearance(),
        taskStatuses: observed.taskStatuses,
        taskStatusMarker: observed.taskStatusMarker, tabs: ids.map(tabId => {
          const row = rows.get(tabId);
          if (!sameDirectoryScope(row.executionScope, before.refs[tabId].subject)) fail('directory_card_owner_changed');
          return { tabId, fast: row.fast, plan: row.plan, pendingContext: row.pendingContext, executionRef: before.refs[tabId] };
        }) };
      const fingerprint = directoryHash([before.catalogClock, value]);
      if (fingerprint !== cardsFingerprint) { cardsFingerprint = fingerprint; cardsRevision++; }
      return { version: 1, sourceEpoch: before.sourceEpoch, catalogClock: before.catalogClock,
        cardsEpoch, revision: cardsRevision, coverage: coverage(before, ids), ...value };
    },
  };
}
module.exports = { createWorkflowDirectoryApi };
