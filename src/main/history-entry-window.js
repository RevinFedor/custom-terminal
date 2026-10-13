'use strict';

const path = require('path');
const { performance } = require('node:perf_hooks');
const {
  historyActionHeadline,
  historyActionPresentationMeta,
  historyDisplayPath,
} = require(path.join(__dirname, '..', 'shared', 'history-action-grammar.cjs'));
const {
  historyEntryHasExactIdentity,
} = require(path.join(__dirname, '..', 'shared', 'history-entry-identity.cjs'));

function normalizePositiveInt(value, fallback = null, max = 20_000) {
  if (value == null || value === '') return fallback;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function normalizeUuid(value) {
  return typeof value === 'string' && value ? value : null;
}

function findHistoryEntryIndex(entries, identity) {
  return entries.findIndex((entry) => historyEntryHasExactIdentity(entry, identity));
}

/**
 * Canonical identity of the row-level projection requested by a consumer.
 *
 * The JSONL files may stay byte-identical while the user scrolls from one
 * hydration span to another.  The normalized request therefore belongs to
 * the History revision context: "same files" is not "same response" when
 * this identity changed.  Keep the defaults here shared with the projector so
 * semantically equivalent requests keep the cheap unchanged path.
 */
function normalizeHistoryRowWindowRequest(hydrate = null) {
  if (!hydrate || typeof hydrate !== 'object') return null;
  return {
    centerUuid: normalizeUuid(hydrate.centerUuid),
    radius: normalizePositiveInt(hydrate.radius, 750, 20_000),
    alwaysHydrateTail: normalizePositiveInt(hydrate.alwaysHydrateTail, 200, 20_000),
  };
}

function normalizeHistoryEntryWindowRequest(bounds = null) {
  const aroundUuid = normalizeUuid(bounds?.aroundUuid);
  if (aroundUuid) return { aroundUuid, radius: normalizePositiveInt(bounds?.radius, 80, 500) };
  const fromUuid = normalizeUuid(bounds?.fromUuid);
  if (fromUuid) return { fromUuid };
  const afterUuid = normalizeUuid(bounds?.afterUuid);
  const beforeUuid = normalizeUuid(bounds?.beforeUuid);
  const last = normalizePositiveInt(bounds?.last, null, 20_000);
  return afterUuid || beforeUuid || last ? { afterUuid, beforeUuid, last } : null;
}

/**
 * One shared bounded-history contract for main, HTTP and renderer consumers.
 * Topology may still be resolved over the full branch, but expensive
 * presentation/dehydration and transport happen only for this window.
 *
 * Window selectors (first match wins):
 *   aroundUuid + radius — Timeline jump: the target row with context.
 *   fromUuid            — "I already hold this row and everything after it":
 *                         the desktop panel's live refresh. INCLUSIVE, unlike
 *                         afterUuid, because the renderer names a row it is
 *                         showing, not a boundary it wants to skip past.
 *   afterUuid/beforeUuid/last — cursor paging (HTTP clients, scroll-up page).
 *
 * The result reports startIndex so a virtualized consumer can place the window
 * in the full projection (Virtuoso firstItemIndex) and know whether more rows
 * exist above/below without a second request.
 */
function applyHistoryEntryWindow(entries, bounds = null) {
  const all = Array.isArray(entries) ? entries : [];
  const total = all.length;
  const aroundUuid = normalizeUuid(bounds?.aroundUuid);
  const fromUuid = normalizeUuid(bounds?.fromUuid);
  const afterUuid = normalizeUuid(bounds?.afterUuid);
  const beforeUuid = normalizeUuid(bounds?.beforeUuid);
  const last = normalizePositiveInt(bounds?.last, null, 20_000);
  const radius = normalizePositiveInt(bounds?.radius, 80, 500);
  const boundsApplied = Boolean(aroundUuid || fromUuid || afterUuid || beforeUuid || last);
  const describe = (selected, startIndex, extra = {}) => ({
    entries: selected,
    total,
    startIndex,
    dropped: Math.max(0, total - selected.length),
    truncated: selected.length < total,
    boundsApplied,
    hasMoreAbove: startIndex > 0,
    hasMoreBelow: startIndex + selected.length < total,
    firstUuid: selected[0]?.uuid || null,
    lastUuid: selected[selected.length - 1]?.uuid || null,
    ...extra,
  });

  if (!boundsApplied) return describe(all, 0);

  if (aroundUuid) {
    const index = findHistoryEntryIndex(all, aroundUuid);
    // A named row that no longer exists (rollback, rewrite, wrong branch) is
    // reported, not silently answered with an empty screen: the caller falls
    // back to the tail and knows why.
    if (index < 0) return describe([], 0, { anchorMissing: true });
    const start = Math.max(0, index - radius);
    return describe(all.slice(start, Math.min(total, index + radius + 1)), start);
  }

  if (fromUuid) {
    const index = findHistoryEntryIndex(all, fromUuid);
    if (index < 0) return describe([], 0, { anchorMissing: true });
    return describe(all.slice(index), index);
  }

  let start = 0;
  let end = total;
  if (afterUuid) {
    const index = findHistoryEntryIndex(all, afterUuid);
    if (index < 0) return describe([], 0, { anchorMissing: true });
    start = index + 1;
  }
  if (beforeUuid) {
    const index = findHistoryEntryIndex(all, beforeUuid);
    if (index < 0) return describe([], 0, { anchorMissing: true });
    end = Math.max(start, index);
  }
  if (last && end - start > last) start = end - last;
  return describe(all.slice(start, end), start);
}

/**
 * Row-level windowing: keep the FULL row list, dehydrate rows outside the
 * hydration span to identity stubs.
 *
 * Why not ship only the window's rows: everything positional in the panel —
 * measured geometry, the reading anchor, the mount wave, Timeline-jump index
 * lookup, the scrollbar — is indexed against the full projection. Shipping a
 * shorter array would force index remapping (Virtuoso `firstItemIndex`),
 * prepend bookkeeping and scroll correction into every one of those, i.e. it
 * would rewrite the parts of History that took the longest to make correct.
 *
 * A stub keeps the row's identity and its place: uuid, role, timestamp,
 * session. It carries no content, no actions, no thinking — the ~10KB of
 * presentation structures per row is exactly what made a 15.5K-row giant cost
 * ~150MB in the renderer. 15.5K stubs cost ~1.5MB; a 1500-row hydrated span
 * costs ~15MB.
 *
 * The renderer renders a stub with the SAME exact-height placeholder the
 * mount wave already uses, and asks for a new hydration span when stubs enter
 * the viewport. Row count and row order never change, so no scroll correction
 * is needed — only row CONTENT appears, which is the same invariant the delta
 * transport already relies on.
 *
 * Rows that must never be stubbed, regardless of span:
 *   - rows carrying live/background work (the chips strip derives from their
 *     actions; a stubbed running agent would vanish from the strip),
 *   - the last `alwaysHydrateTail` rows (the composer, tail-pin, live
 *     projection and "what just happened" all read the tail).
 */
const HISTORY_ROW_STUB_FIELDS = [
  'questionReplyProof',
  'settingsFact',
  'imageCount',
  'uuid', 'role', 'timestamp', 'recordTime', 'sessionId', 'messageId', 'textPhase',
  'preTokens', 'postTokens', 'compactEncrypted',
  'viewOwnerSessionId', 'physicalSessionId', 'transcriptSegmentId',
  'rawUuid', 'contentRevision', 'entryRef', 'recordByteOffset',
  'sourceIdentity', 'sourceIdentityAliases', 'sourceUuidAliases',
];
// Structural provenance keeps user-side Research grouping identical outside
// the hydration span. No generated envelope, body offsets, chips or payload.
// Tab-message/origin fields preserve the existing classifier's priority.
const HISTORY_STUB_TAG_FIELDS = ['kind', 'runId', 'runKind', 'phase', 'messageId',
  'source', 'sourceTabId', 'targetTabId', 'systemSource'];

/**
 * Grouping metadata a stub must keep. The display-side series collapsing
 * groups rows into families (read/search/git/run/edit/mcp/…); if stubs lost
 * that identity, moving the hydration window would change group composition —
 * display-list length would change from mere scrolling, and the position
 * would jump. The invariant the owner demands: grouping(any window position)
 * is structurally identical to grouping(fully hydrated rows). So the stub
 * carries exactly the fields grouping reads, and grouping may read ONLY
 * fields that exist on both stubs and full rows.
 */
// Projector actions are retained, but NOT immutable: a late result/classifier
// can enrich the same rawTool or replace/mutate args. Cache only the expensive
// semantic labels with exact shallow witnesses. Unsupported structured args
// take the original path, never an approximate hash or truncated command.
// Weak keys do not keep evicted sessions or the raw JSONL cache alive.
const stubPresentationCache = new WeakMap();
const STUB_PRESENTATION_FIELDS = ['toolName', 'family', 'bashWord', 'bashDetail', 'mcpServer', 'mcpMethod'];
function stubPresentation(raw, warmOnly = false) {
  const args = raw.args;
  const argsPlain = args == null || (typeof args === 'object'
    && (Object.getPrototypeOf(args) === Object.prototype || Object.getPrototypeOf(args) === null));
  const descriptors = argsPlain && args != null ? Object.getOwnPropertyDescriptors(args) : {};
  const names = Object.keys(descriptors);
  const cacheable = argsPlain && names.every(name => {
    const descriptor = descriptors[name];
    return Object.hasOwn(descriptor, 'value')
      && (descriptor.value == null || ['string', 'number', 'boolean', 'undefined'].includes(typeof descriptor.value));
  });
  // Structured/accessor args deliberately have no shallow memo witness.
  // Warming them would parse twice without making the final pass cheaper.
  if (warmOnly && !cacheable) return;
  const previous = cacheable ? stubPresentationCache.get(raw) : null;
  if (previous && STUB_PRESENTATION_FIELDS.every(field => Object.is(previous.fields[field], raw[field]))
    && previous.names.length === names.length
    && names.every(name => Object.hasOwn(previous.args, name)
      && Object.is(previous.args[name], descriptors[name].value))) return previous.value;
  const presentation = historyActionPresentationMeta({
    toolName: raw.toolName, args, family: raw.family,
    bashWord: raw.bashWord, bashDetail: raw.bashDetail,
    mcpServer: raw.mcpServer, mcpMethod: raw.mcpMethod,
  });
  const value = { ...presentation, subject: stubActionSubject(raw) };
  if (cacheable) {
    stubPresentationCache.set(raw, {
      fields: Object.fromEntries(STUB_PRESENTATION_FIELDS.map(field => [field, raw[field]])),
      names, args: Object.fromEntries(names.map(name => [name, descriptors[name].value])), value,
    });
  } else stubPresentationCache.delete(raw);
  return value;
}

function stubActionSummary(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return undefined;
  const summary = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    if (action.tool === '__raw__' && action.rawTool) {
      const raw = action.rawTool;
      const presentation = stubPresentation(raw);
      summary.push({
        toolUseId: raw.toolUseId,
        toolName: raw.toolName,
        recordTime: raw.recordTime,
        family: raw.family,
        bashWord: raw.bashWord,
        bashDetail: raw.bashDetail,
        mcpServer: raw.mcpServer,
        mcpMethod: raw.mcpMethod,
        // Subject of the call, so a collapsed group's digest can name the
        // FILES it touched even while the rows are still stubs (the args that
        // would yield it are exactly what a stub omits). Kept to the last two
        // path segments — the digest never shows a full path.
        subject: presentation.subject,
        aggregateKey: presentation.aggregateKey,
        targetKey: presentation.targetKey,
        targetLabel: presentation.targetLabel,
        operationLabel: presentation.operationLabel,
        docsKind: presentation.docsKind,
        isError: raw.isError === true ? true : undefined,
      });
    } else if (action.tool === 'Task') {
      summary.push({
        toolUseId: action.toolUseId,
        toolName: 'Task',
        recordTime: action.recordTime,
        family: 'task',
        description: action.description,
        subagentStatus: action.subagentStatus,
        agentSessionId: action.agentSessionId,
        agentId: action.agentId,
        taskPrompt: action.taskPrompt,
        startedAt: action.startedAt,
        completedAt: action.completedAt,
        durationMs: action.durationMs,
        ...(action.launchSettings ? { launchSettings: action.launchSettings } : {}),
      });
    }
  }
  return summary.length > 0 ? summary : undefined;
}

/** Short human subject for the group digest: a file name, a pattern, a git subcommand. */
function stubActionSubject(raw) {
  try {
    const headline = historyActionHeadline({
      toolName: raw.toolName,
      args: raw.args,
      family: raw.family,
      bashWord: raw.bashWord,
      bashDetail: raw.bashDetail,
      mcpServer: raw.mcpServer,
      mcpMethod: raw.mcpMethod,
    });
    const subject = String(headline.subject || '');
    return subject ? historyDisplayPath(subject) : undefined;
  } catch {
    return undefined;
  }
}

function makeHistoryRowStub(entry) {
  // Disk pages already carry the exact positional stub. Re-stubbing it would
  // erase hasContent/actionSummary and change grouping merely on a seek.
  if (entry?.rowStub === true) return entry;
  const stub = { rowStub: true };
  for (const field of HISTORY_ROW_STUB_FIELDS) {
    if (entry[field] !== undefined) stub[field] = entry[field];
  }
  // sourceIdentity is how live rows and durable rows recognise each other;
  // dropping it would make a live row duplicate its own durable twin.
  if (entry.sourceIdentity !== undefined) stub.sourceIdentity = entry.sourceIdentity;
  // A Codex response_item may later be promoted to its paired event_msg. The
  // earlier exact identity remains an alias of the same row and is required
  // to retire a durable local SENT/CONFIRMING card even while the old row is
  // outside the hydrated viewport.
  if (entry.sourceIdentityAliases !== undefined) {
    stub.sourceIdentityAliases = entry.sourceIdentityAliases;
  }
  if (entry.serviceCarrier !== undefined) stub.serviceCarrier = entry.serviceCarrier;
  if (Array.isArray(entry.semanticTags)) {
    stub.semanticTags = entry.semanticTags.filter(tag => tag && typeof tag === 'object')
      .map(tag => Object.fromEntries(HISTORY_STUB_TAG_FIELDS
        .filter(field => typeof tag[field] === 'string').map(field => [field, tag[field]])));
  }
  // A short caption belongs to its action group, while a long reply is a
  // boundary. Keep its exact trimmed length: hasContent alone changes that
  // decision when an old row leaves the hydration span, reindexing everything
  // below it even though the transcript has not changed.
  if (typeof entry.content === 'string') {
    stub.contentLength = entry.content.trim().length;
    if (stub.contentLength > 0) stub.hasContent = true;
  }
  // Reasoning text is heavy and stays dehydrated, but its structural presence
  // and duration participate in grouping exactly like a hydrated row.
  if (typeof entry.thinking === 'string' && entry.thinking.trim()) stub.hasThinking = true;
  if (entry.thinkingSeconds !== undefined) stub.thinkingSeconds = entry.thinkingSeconds;
  const actionSummary = stubActionSummary(entry.actions);
  if (actionSummary) stub.actionSummary = actionSummary;
  return stub;
}

/**
 * True when a row must stay hydrated because something outside the viewport
 * reads its contents. Kept deliberately narrow — every exception here is
 * memory that windowing does not save.
 */
function historyRowCarriesLiveWork(entry) {
  const actions = entry?.actions;
  if (!Array.isArray(actions) || actions.length === 0) return false;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    // A subagent card that has not reached a terminal state, or a background
    // shell cell still running: both are chips the strip must keep showing.
    if (action.tool === 'Task' && action.subagentStatus && action.subagentStatus !== 'completed') {
      return true;
    }
    const raw = action.tool === '__raw__' ? action.rawTool : null;
    if (raw && raw.backgroundStatus === 'running') return true;
    // A call with no result yet is in flight (the finalize tail materializes
    // these, but an appended output can land while the row sits mid-list).
    if (raw && raw.result === undefined && raw.resultRef === undefined) return true;
  }
  return false;
}

// Warm only the expensive semantic labels under the projector's existing
// per-session serialization. The returned rows and the revision still belong
// to the ordinary synchronous window projection. A cold/rebuilt owner has new
// rawTool identities, so the WeakMap alone cannot protect its first request.
// Yield between small groups; never wait for the cursor or for an idle tab.
async function prepareHistoryRowWindow(entries, hydrate = null, {
  yieldToMain = () => new Promise(resolve => setImmediate(resolve)),
} = {}) {
  const request = normalizeHistoryRowWindowRequest(hydrate);
  if (!request || !Array.isArray(entries) || entries.length === 0) return;
  const total = entries.length;
  const centerIndex = request.centerUuid ? findHistoryEntryIndex(entries, request.centerUuid) : -1;
  const from = centerIndex < 0 ? Math.max(0, total - request.radius)
    : Math.max(0, centerIndex - request.radius);
  const to = centerIndex < 0 ? total - 1 : Math.min(total - 1, centerIndex + request.radius);
  const tailFrom = Math.max(0, total - request.alwaysHydrateTail);
  const startedAt = performance.now();
  let sliceAt = startedAt;
  let yields = 0;
  let maxSliceMs = 0;
  for (let index = 0; index < total; index += 1) {
    const entry = entries[index];
    if (!(index >= from && index <= to) && index < tailFrom && !historyRowCarriesLiveWork(entry)) {
      for (const action of Array.isArray(entry?.actions) ? entry.actions : []) {
        if (action?.tool === '__raw__' && action.rawTool) stubPresentation(action.rawTool, true);
      }
    }
    const elapsed = performance.now() - sliceAt;
    if (elapsed >= 8 || (index + 1) % 128 === 0) {
      maxSliceMs = Math.max(maxSliceMs, elapsed);
      await yieldToMain();
      yields += 1;
      sliceAt = performance.now();
    }
  }
  maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceAt);
  return { rows: total, yields, maxSliceMs, elapsedMs: performance.now() - startedAt };
}

function historyRowWindowRange(entries, hydrate = null) {
  const all = Array.isArray(entries) ? entries : [];
  const total = all.length;
  const request = normalizeHistoryRowWindowRequest(hydrate);
  if (!request) return { applied: false, from: 0, to: Math.max(0, total - 1), tailFrom: 0, centerMissing: false };
  const index = request.centerUuid ? findHistoryEntryIndex(all, request.centerUuid) : -1;
  return {
    applied: true,
    from: index < 0 ? Math.max(0, total - request.radius) : Math.max(0, index - request.radius),
    to: index < 0 ? total - 1 : Math.min(total - 1, index + request.radius),
    tailFrom: Math.max(0, total - request.alwaysHydrateTail),
    centerMissing: !!request.centerUuid && index < 0,
  };
}

function applyHistoryRowWindow(entries, hydrate = null) {
  const all = Array.isArray(entries) ? entries : [];
  const total = all.length;
  const request = normalizeHistoryRowWindowRequest(hydrate);
  if (!request) {
    return {
      entries: all, total, hydratedCount: total, stubbedCount: 0,
      hydratedFrom: 0, hydratedTo: Math.max(0, total - 1), rowWindowApplied: false,
    };
  }
  const { from, to, tailFrom, centerMissing } = historyRowWindowRange(all, request);
  const result = new Array(total);
  let hydratedCount = 0;
  for (let index = 0; index < total; index += 1) {
    const entry = all[index];
    const inSpan = index >= from && index <= to;
    const keep = inSpan || index >= tailFrom || historyRowCarriesLiveWork(entry);
    if (keep) {
      result[index] = entry;
      hydratedCount += 1;
    } else {
      result[index] = makeHistoryRowStub(entry);
    }
  }
  return {
    entries: result,
    total,
    hydratedCount,
    stubbedCount: total - hydratedCount,
    hydratedFrom: from,
    hydratedTo: to,
    rowWindowApplied: true,
    centerMissing,
  };
}

module.exports = {
  historyRowWindowRange,
  normalizeHistoryEntryWindowRequest,
  applyHistoryEntryWindow,
  applyHistoryRowWindow,
  prepareHistoryRowWindow,
  historyRowCarriesLiveWork,
  makeHistoryRowStub,
  normalizeHistoryRowWindowRequest,
};
