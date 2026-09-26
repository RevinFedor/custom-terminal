import { historySnapshotCache, makeHistorySnapshotKey, type HistorySnapshotOwner } from './historySnapshotCache';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';
import { getHistoryReadingAnchor, setHistoryReadingAnchor } from './historyReadingAnchor';
import { historyLivePresentationKey } from './historyLiveProjection.mjs';
import rewriteIdentities from '../../shared/codex-rewrite-identities.cjs';
const { createProjectionIdentityMap, remapHistoryRowIdentity, hasProvenRewritePayloads } = rewriteIdentities;

type Row = Record<string, any>;
export function historyFileWasReplaced(previous: { ownerKey: string; value: string }, ownerKey: string, value: string) {
  return previous.ownerKey === ownerKey && !!previous.value && !!value && previous.value !== value;
}
// Physical identity and payload generation are different domains. A generation
// may contain a physical identity, but it is an opaque token: never split it
// or compare it with a watcher's dev:ino string.
export function historySnapshotFileIdentity(revision: unknown, sessionId: string, filePath?: string): string {
  if (!revision || typeof revision !== 'object') return '';
  const sources = (revision as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return '';
  const matching = sources.filter(source => source && source.sessionId === sessionId
    && (!filePath || source.filePath === filePath));
  const tails = matching.filter(source => source.linkKind === 'end');
  const primary = tails.length === 1 ? tails : matching;
  return primary.length === 1 && typeof primary[0].fileIdentity === 'string' ? primary[0].fileIdentity : '';
}
export function historyPayloadCacheKey(context: { toolType: string; sessionId: string; payloadGeneration?: string } | null, ref: { payloadId: string; recordLine?: number } | undefined) {
  return context && ref
    ? context.toolType + ':' + context.sessionId + ':' + (context.payloadGeneration || '') + ':' + ref.payloadId + ':' + (ref.recordLine ?? '') : '';
}
type Capture = {
  listKey: string;
  geometryTick: number;
  painted: boolean;
  anchor: { uuid: string; offsetPx: number; followBottom: boolean } | null;
  carryPayloads?: (change: { sessionId: string; sourceGeneration: string; payloadGeneration: string; pairs: { before: Row; after: Row }[] }) => void;
};
const captures = new Map<string, () => Capture>();
export function registerHistoryRewriteCapture(ownerKey: string, capture: () => Capture) {
  captures.set(ownerKey, capture);
  return () => { if (captures.get(ownerKey) === capture) captures.delete(ownerKey); };
}

// Preserve equal subtrees (especially args, tools and text presentation) while
// replacing physical addresses. No fuzzy/sampled equality and no mutation of
// the source snapshot: other tabs may still be displaying that branch.
function shareEqualTree(previous: any, next: any): any {
  if (previous === next) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object'
    || Array.isArray(previous) !== Array.isArray(next)) return next;
  const keys = Object.keys(next);
  let equal = keys.length === Object.keys(previous).length;
  const result: any = Array.isArray(next) ? [] : {};
  for (const key of keys) {
    result[key] = shareEqualTree(previous[key], next[key]);
    if (!Object.hasOwn(previous, key) || result[key] !== previous[key]) equal = false;
  }
  return equal ? previous : result;
}

export function reuseHistoryRewriteRows(previous: readonly Row[], next: readonly Row[], receipt: any) {
  const mapping = createProjectionIdentityMap(receipt.sourceSessionId, receipt.sessionId, receipt.records);
  const oldByNewUuid = new Map<string, Row>();
  for (const row of previous) {
    if (row.sessionId !== receipt.sourceSessionId) continue;
    try {
      const uuid = mapping.identity(row.uuid);
      if (uuid !== row.uuid) oldByNewUuid.set(uuid, row);
    } catch { /* Outside the proven prefix. */ }
  }
  const unchanged = new Set<string>();
  const entries = next.map((row) => {
    const old = oldByNewUuid.get(row.uuid);
    if (!old) return row;
    let candidate: Row;
    try { candidate = { ...remapHistoryRowIdentity(old, mapping) }; } catch { return row; }
    delete candidate.rewriteRenderKey;
    delete candidate.rewriteLayoutUuid;
    const shared = shareEqualTree(candidate, row);
    if (shared === candidate && hasProvenRewritePayloads(candidate)) unchanged.add(row.uuid);
    return { ...shared, rewriteRenderKey: historyLivePresentationKey(old), rewriteLayoutUuid: old.rewriteLayoutUuid || old.uuid };
  });
  return { entries, unchanged, mapUuid: mapping.identity };
}

export function carryHistoryRewriteRenderKeys(previous: readonly Row[], entries: readonly Row[]) {
  const keys = new Map(previous.filter((row) => row.rewriteRenderKey).map((row) => [row.uuid, row]));
  if (!keys.size) return entries;
  return entries.map((row) => keys.has(row.uuid) && !row.rewriteRenderKey
    ? { ...row, rewriteRenderKey: keys.get(row.uuid)?.rewriteRenderKey, rewriteLayoutUuid: keys.get(row.uuid)?.rewriteLayoutUuid } : row);
}

export function applyHistoryRewriteDelta(previous: readonly Row[], result: any) {
  const receipt = result.rewriteReceipt;
  const mapping = createProjectionIdentityMap(receipt.sourceSessionId, receipt.sessionId, receipt.records);
  const before = new Map(previous.map((row) => [row.uuid, row]));
  const next = new Map<string, Row>();
  const unchanged = new Set<string>();
  for (const pair of result.carriedEntries || []) {
    const row = before.get(pair.sourceUuid);
    if (!row || !hasProvenRewritePayloads(row) || row.sessionId !== receipt.sourceSessionId || mapping.identity(row.uuid) !== pair.uuid
      || next.has(pair.uuid)) throw new Error('invalid_rewrite_delta_carry');
    next.set(pair.uuid, { ...remapHistoryRowIdentity(row, mapping),
      rewriteRenderKey: historyLivePresentationKey(row), rewriteLayoutUuid: row.rewriteLayoutUuid || row.uuid });
    unchanged.add(pair.uuid);
  }
  for (const row of result.changedEntries || []) {
    if (next.has(row.uuid)) throw new Error('duplicate_rewrite_delta_row');
    next.set(row.uuid, row);
  }
  if (!Array.isArray(result.order) || new Set(result.order).size !== result.order.length
    || result.order.length !== next.size || result.order.some((uuid: string) => !next.has(uuid))) {
    throw new Error('incomplete_rewrite_delta_order');
  }
  return { entries: result.order.map((uuid: string) => next.get(uuid)!), unchanged, mapUuid: mapping.identity };
}

// Prepare before the binding CAS, publish only after it succeeds. Failure is
// a normal cold presentation, NOT a rollback of the committed user action.
export async function prepareHistoryRewriteSnapshot({ tabId, sessionId, sourceSessionId, cwd, invoke }: {
  tabId: string; sessionId: string; sourceSessionId: string; cwd: string;
  invoke: (channel: string, payload: any) => Promise<any>;
}) {
  const from: HistorySnapshotOwner = { tabId, toolType: 'codex', sessionId: sourceSessionId, cwd };
  const to = { ...from, sessionId };
  const fromKey = makeHistorySnapshotKey(from);
  const before = historySnapshotCache.peek<Row>(from);
  const revision = before?.revision as Row | null;
  if (!before || !revision?.token) return null;
  let hydrate = null;
  try { hydrate = JSON.parse(revision.context || '{}').rowWindowRequest || null; } catch { /* old version */ }
  const capture = captures.get(fromKey)?.();
  if (capture?.anchor && !capture.anchor.followBottom && hydrate) hydrate = { ...hydrate, centerUuid: capture.anchor.uuid };
  const result = await readHistoryThroughIpc(invoke, 'agent-transcript:get-history', {
    toolType: 'codex', sessionId, cwd, tabId, dehydrate: true, deltaOk: true,
    rewriteFrom: { sessionId: sourceSessionId, revision }, hydrate,
  });
  if (!result?.success || (!result.rewriteDelta && !Array.isArray(result.entries)) || !result.revision
    || result.revision.sessionId !== sessionId || result.revision.cwd !== cwd) return null;
  const receipt = result.rewriteReceipt;
  if (receipt?.schema !== 'codex-rewrite-prefix-v1' || receipt.sourceSessionId !== sourceSessionId
    || receipt.sessionId !== sessionId || !receipt.records?.length) return null;
  const reused = result.rewriteDelta
    ? applyHistoryRewriteDelta(before.entries, result)
    : reuseHistoryRewriteRows(before.entries, result.entries, receipt);
  return () => {
    // A late response cannot adopt an obsolete hydration window or reading
    // position. Source cache and physical owner must still be the captured ones.
    if (historySnapshotCache.peek(from) !== before) return false;
    const current = captures.get(fromKey)?.();
    const oldAnchor = current?.anchor || getHistoryReadingAnchor(tabId + ':' + sourceSessionId);
    let anchor = null;
    try {
      if (oldAnchor) {
        const uuid = reused.mapUuid(oldAnchor.uuid);
        if (reused.entries.some((row) => row.uuid === uuid)) anchor = { ...oldAnchor, uuid, savedAt: Date.now() };
      }
    } catch { /* The reading row was deleted; normal tail restore owns it. */ }
    const stored = historySnapshotCache.set(to, {
      entries: reused.entries, revision: result.revision,
      payloadGeneration: result.payloadGeneration || '',
      rewrite: current ? {
        fromOwnerKey: fromKey, listKey: current.listKey, geometryTick: current.geometryTick,
        // This is existing painted DOM with unchanged content, not a loader
        // timeout. Removed/changed/unmounted rows still require paint proof.
        anchorPreserved: current.painted && !!anchor && !anchor.followBottom && reused.unchanged.has(anchor.uuid),
        followBottom: anchor?.followBottom ?? true,
      } : undefined,
    });
    if (!stored.stored) return false;
    if (current?.carryPayloads) {
      const next = new Map(reused.entries.map((row: Row) => [row.uuid, row]));
      const pairs: { before: Row; after: Row }[] = [];
      for (const row of before.entries) {
        try {
          const uuid = reused.mapUuid(row.uuid);
          if (reused.unchanged.has(uuid) && next.has(uuid)) pairs.push({ before: row, after: next.get(uuid)! });
        } catch { /* Not a proven prefix row. */ }
      }
      try { current.carryPayloads({ sessionId, sourceGeneration: before.payloadGeneration || '', payloadGeneration: result.payloadGeneration || '', pairs }); }
      catch (error) { console.warn('[HistoryRewrite] payload cache carry skipped', error); }
    }
    if (anchor) setHistoryReadingAnchor(tabId + ':' + sessionId, anchor);
    console.warn('[HistoryRewrite] tab=' + tabId.slice(-12) + ' source=' + sourceSessionId.slice(0, 8)
      + ' child=' + sessionId.slice(0, 8) + ' reusedRows=' + reused.unchanged.size + ' total=' + reused.entries.length);
    return true;
  };
}
