// LOCAL provenance only. Electron/producer codes, messages and lookalike fields
// cannot decide whether interrupt recovery may fall through to another read.
const readFailures = new WeakSet();
const cancelled = () => Object.assign(new Error('Canonical prompt recovery owner changed'), { code: 'HISTORY_READ_CANCELLED' });
export function canonicalPromptRecoveryReadError(cause) {
  if (isCanonicalPromptRecoveryReadError(cause)) return cause;
  const error = new Error('Canonical prompt recovery proof unavailable', { cause });
  if (typeof cause?.code === 'string') error.code = cause.code;
  readFailures.add(error);
  return error;
}
export function isCanonicalPromptRecoveryReadError(error) {
  return !!error && (typeof error === 'object' || typeof error === 'function') && readFailures.has(error);
}

// Each layout setup creates a fresh owner, including StrictMode's second setup.
// Never reuse an AbortController created by render or a previous cleanup.
export function activateCanonicalPromptRecoveryOwner(ref, key) {
  const controller = new AbortController();
  const owner = { key, signal: controller.signal,
    isCurrent: () => ref.current === owner && !controller.signal.aborted,
    assertCurrent() { if (!owner.isCurrent()) throw canonicalPromptRecoveryReadError(cancelled()); } };
  ref.current = owner;
  return () => { if (ref.current === owner) ref.current = null; controller.abort(); };
}
export function captureCanonicalPromptRecoveryOwner(ref, key) {
  const owner = ref.current;
  if (!owner || owner.key !== key) throw canonicalPromptRecoveryReadError(cancelled());
  owner.assertCurrent();
  return owner;
}

export function canonicalPromptRecoveryIdentities(identity) {
  const uuid = typeof identity?.auditEntryUuid === 'string' ? identity.auditEntryUuid.trim() : '';
  const source = typeof identity?.sourceIdentity === 'string' ? identity.sourceIdentity.trim() : '';
  return uuid ? source && source !== uuid ? [uuid, source] : [uuid] : source ? [source] : [];
}

// A per-demand subscription/cancellation bridge. Never releases a retained
// model/reader/root or an independent Full document. Body-only notifications
// leave the captured header alone; a different header invalidates this demand.
export async function readCanonicalPromptRecoveryProof({ root, header, identities, signal, ownerSignal, owns }) {
  const demand = new AbortController();
  const abort = () => demand.abort();
  const current = () => !demand.signal.aborted && !signal?.aborted && !ownerSignal?.aborted
    && owns() && root?.header === header && header?.root === capturedRoot;
  const capturedRoot = header?.root;
  const check = () => { if (!current()) throw cancelled(); };
  let unsubscribe = null, rejectAbort, primary;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const onAbort = () => rejectAbort(cancelled());
  demand.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  ownerSignal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted || ownerSignal?.aborted) abort();
    check();
    if (!header || !capturedRoot || !Number.isSafeInteger(header.canonicalEntryCount) || header.canonicalEntryCount < 0
      || typeof root?.subscribe !== 'function'
      || typeof root.findCanonicalPromptIdentity !== 'function') {
      throw Object.assign(new Error('Held canonical prompt query required'), { code: 'HISTORY_PRIMARY_VIEW_REQUIRED' });
    }
    unsubscribe = root.subscribe(() => { if (!current()) abort(); });
    check(); // Close the subscribe/current-check gap without another read.
    for (const identity of identities) {
      check();
      const work = Promise.resolve().then(() => {
        check(); return root.findCanonicalPromptIdentity(identity, { signal: demand.signal, owns: current });
      });
      const found = await Promise.race([work, aborted]);
      check();
      if (found === null) continue;
      if (!found || !Number.isSafeInteger(found.ordinal) || found.ordinal < 0
        || found.ordinal >= header.canonicalEntryCount || found.row?.protocol !== 'history-root-v1'
        || found.row.kind !== 'object' || typeof found.row.nodeToken !== 'string' || !found.row.nodeToken
        || ['leaseId', 'ownerKey', 'revision', 'generation'].some(key => found.row[key] !== header[key])) {
        throw Object.assign(new Error('Invalid canonical prompt point result'), { code: 'HISTORY_PRIMARY_PROMPT_RECOVERY_RESULT' });
      }
      return true;
    }
    check(); return false;
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    try { unsubscribe?.(); }
    catch (cause) { if (!primary) throw cause; }
    finally {
      signal?.removeEventListener('abort', abort);
      ownerSignal?.removeEventListener('abort', abort);
      demand.signal.removeEventListener('abort', onAbort);
      demand.abort(); // This demand only, also fences a late point result.
    }
  }
}
