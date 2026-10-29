const failure = code => Object.assign(new Error(code), { code });
const JOB_DEADLINE_MS = 30_000;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const scopeOf = input => ({ ownerKey: input?.ownerKey ?? input?.publication?.ownerKey,
  generation: input?.generation ?? input?.publication?.generation });
const subjectOf = input => input.subject || input;
const sameScope = (left, right) => !!left && !!right
  && left.ownerKey === right.ownerKey && left.generation === right.generation;
const missing = key => Object.freeze({ kind: 'unknown', key, record: null });
const unknownMembership = (request, status = 'pending') => Object.freeze({ status,
  entries: Object.freeze(request.entries.map(value => Object.freeze({ value, found: null }))),
  calls: Object.freeze(request.calls.map(value => Object.freeze({ value, found: null }))),
  any: Object.freeze(request.any.map(value => Object.freeze({ id: value.id, found: null }))) });
const emptyMembershipRequest = () => Object.freeze({ entries: Object.freeze([]), calls: Object.freeze([]), any: Object.freeze([]) });
const emptySnapshot = (scope, selectedKey, subject) => Object.freeze({ ...scope, subject, status: 'pending', counts: null,
  rows: Object.freeze([]), section: 'roster', pageStart: 0, pageSize: 64,
  backgroundRows: Object.freeze([]), backgroundStart: 0, backgroundPageSize: 32,
  membership: unknownMembership(emptyMembershipRequest()), selected: missing(selectedKey), error: null, errorStage: null });

/** One actual catalog presentation lane. There is at most one running build
 * or selected read and one replaceable pending demand. React publishes only
 * after rechecking the original proof INSIDE its queued state updater. */
export function createHistoryPrimaryAgentCatalogOwner({ onChange = () => {}, onReleaseError = () => {} } = {}) {
  if (typeof onChange !== 'function' || typeof onReleaseError !== 'function') throw failure('HISTORY_AGENT_CATALOG_CALLBACK');
  let closed = false, input = null, inputRevision = 0, demandRevision = 0, pending = false;
  let active = null, working = null, published = null, snapshot = null, failed = null, committedProof = null;
  let roster = { section: 'roster', offset: 0, limit: 64 };
  let background = { section: 'background', offset: 0, limit: 32 }, selectedKey = null;
  let memberships = emptyMembershipRequest();
  const release = reader => {
    if (!reader) return;
    Promise.resolve().then(() => reader.close()).catch(error => { try { onReleaseError(error); } catch {} });
  };
  const currentInput = (candidate, revision) => !closed && input === candidate && inputRevision === revision;
  const ownerFence = (candidate, verifyIntrinsic = false) => {
    const intrinsicAuthority = candidate.current?.hasIntrinsicReadAuthority;
    if (typeof intrinsicAuthority === 'function' && intrinsicAuthority(verifyIntrinsic) !== true) return false;
    if (typeof candidate.owns === 'function' && candidate.owns() !== true) return false;
    if (typeof candidate.ownerFence === 'function' && candidate.ownerFence() !== true) return false;
    // FULL witness / original fence callbacks can reenter. Ordinary guards
    // inspect four identities; final proof additionally checks original C
    // Main collection contents/fields and intrinsic settings descriptors. This
    // cannot execute a getter, visits no historical keys and never replaces the ORIGINAL FULL payload witness.
    return typeof intrinsicAuthority !== 'function' || intrinsicAuthority(verifyIntrinsic) === true;
  };
  const check = (candidate, revision, signal, verifyIntrinsic = false) => {
    if (!currentInput(candidate, revision) || signal?.aborted || !ownerFence(candidate, verifyIntrinsic)
      || !currentInput(candidate, revision) || signal?.aborted) throw failure('HISTORY_READ_CANCELLED');
  };
  const finalProof = (candidate, revision, signal) => {
    check(candidate, revision, signal);
    // The order is deliberate. Native getters/coercions can reenter owner
    // cleanup; the final cheap original fence must follow BOTH full checks.
    const replay = candidate.replay || candidate.current?.isCurrent;
    if (typeof replay !== 'function' || replay() !== true) throw failure('HISTORY_READ_CANCELLED');
    if (typeof candidate.fullWitness !== 'function' || candidate.fullWitness() !== true) throw failure('HISTORY_READ_CANCELLED');
    if (!ownerFence(candidate, true)) throw failure('HISTORY_READ_CANCELLED');
    check(candidate, revision, signal, true);
  };
  const enqueue = (candidate, revision, update) => {
    try { onChange(previous => {
      if (!currentInput(candidate, revision)) return previous;
      const beforeDemand = demandRevision;
      const next = update(previous || snapshot);
      // A native replay/full witness can synchronously publish another owner
      // from inside this queued callback. Never return the stale A result.
      if (!currentInput(candidate, revision) || demandRevision !== beforeDemand) return snapshot || previous;
      if (next !== previous) snapshot = next;
      return next;
    }); } catch (error) { try { onReleaseError(error); } catch {} }
  };
  const waiting = (candidate, revision, error = null, errorStage = error ? 'read' : null) => {
    const scope = scopeOf(candidate), key = selectedKey, originalDemand = demandRevision;
    enqueue(candidate, revision, previous => {
      if (demandRevision !== originalDemand || selectedKey !== key
        || !ownerFence(candidate) || !currentInput(candidate, revision)) return previous;
      const old = sameScope(previous, scope) ? previous : emptySnapshot(scope, key, subjectOf(candidate));
      const selected = key && old.selected?.key === key && old.selected.record
        ? Object.freeze({ kind: 'unknown', key, record: old.selected.record }) : missing(key);
      return Object.freeze({ ...old, ...scope, subject: subjectOf(candidate), status: error ? 'error' : 'pending',
        selected, membership: unknownMembership(memberships, error ? 'error' : 'pending'), error, errorStage });
    });
  };
  const query = async (reader, candidate, revision, signal, originalDemand) => {
    const rosterRequest = { ...roster }, backgroundRequest = { ...background }, key = selectedKey;
    const originalMembership = memberships;
    const owns = () => {
      check(candidate, revision, signal);
      if (demandRevision !== originalDemand) throw failure('HISTORY_READ_CANCELLED');
      return true;
    };
    const clamp = request => {
      const count = reader.counts[request.section === 'all' ? 'total' : request.section];
      return { ...request, offset: Math.min(request.offset, Math.max(0, count - 1)) };
    };
    const rows = await reader.readPage({ ...clamp(rosterRequest), signal, owns });
    owns();
    const backgroundRows = await reader.readPage({ ...clamp(backgroundRequest), signal, owns });
    owns();
    const selected = key === null ? missing(null) : await reader.lookup(key, { signal, owns });
    owns();
    const queryValues = async (kind, values) => {
      const records = [];
      for (let offset = 0; offset < values.length; offset += 3) {
        const result = await reader.membership(kind, values.slice(offset, offset + 3), { signal, owns });
        owns(); records.push(...result);
      }
      return Object.freeze(records);
    };
    const entries = await queryValues('entry', originalMembership.entries);
    const calls = await queryValues('call', originalMembership.calls), any = [];
    for (const request of originalMembership.any) {
      owns(); const values = request.values(); owns();
      let found = false, batch = [];
      for (const value of values) {
        owns();
        if (typeof value !== 'string') throw failure('HISTORY_AGENT_CATALOG_MEMBERSHIP_VALUE');
        batch.push(value);
        if (batch.length === 3) {
          const results = await reader.membership(request.kind, batch, { signal, owns }); owns();
          if (results.some(item => item.found)) { found = true; break; }
          batch = [];
        }
      }
      if (!found && batch.length) {
        const results = await reader.membership(request.kind, batch, { signal, owns }); owns();
        found = results.some(item => item.found);
      }
      owns(); any.push(Object.freeze({ id: request.id, found }));
    }
    return { rows, backgroundRows, selected, key,
      membership: Object.freeze({ status: 'ready', entries, calls, any: Object.freeze(any) }) };
  };
  const pump = () => {
    if (closed || active || !pending || !input) return;
    pending = false;
    // A native driver belongs to one allocation, including failed/cancelled
    // completion. Page/selection changes cannot restart that source scan.
    if (failed && failed.input === input && failed.revision === inputRevision) {
      waiting(input, inputRevision, failed.error, failed.errorStage); return;
    }
    const candidate = input, revision = inputRevision, controller = new AbortController();
    const startedAt = Date.now();
    const deadlineAt = Number.isFinite(candidate.deadlineAt)
      ? Math.min(candidate.deadlineAt, startedAt + JOB_DEADLINE_MS) : startedAt + JOB_DEADLINE_MS;
    const job = { controller, phase: 'build', candidate, revision, deadlineAt, timedOut: false };
    // One absolute bound covers allocation, native continuations and selected
    // reads. Native steps/page changes during the build never renew it.
    const deadline = setTimeout(() => { job.timedOut = true; controller.abort(); }, Math.max(0, deadlineAt - startedAt));
    deadline.unref?.();
    const checkDeadline = () => {
      if (job.timedOut || Date.now() >= deadlineAt) throw failure('HISTORY_AGENT_CATALOG_DEADLINE');
    };
    active = job;
    const task = (async () => {
      let source;
      try {
        check(candidate, revision, controller.signal);
        checkDeadline();
        if (candidate.sourceError) throw candidate.sourceError;
        // No Root means UNKNOWN history. The synchronous CURRENT strip is
        // supplied by the actual native caller while source ownership forms.
        if (!working || working.input !== candidate || working.revision !== revision) {
          if (!candidate.prepared) { waiting(candidate, revision); return; }
          source = candidate.prepared.retain({ signal: controller.signal,
            owns: () => { check(candidate, revision, controller.signal); return true; } });
          const reader = await source.openAgentCatalog(candidate.current, { signal: controller.signal,
            owns: () => { check(candidate, revision, controller.signal); return true; } });
          try { check(candidate, revision, controller.signal); }
          catch (error) { release(reader); throw error; }
          if (working && working !== published) release(working.reader);
          working = { reader, input: candidate, revision };
        }
        check(candidate, revision, controller.signal);
        job.phase = 'query';
        // Page/selection changes received during the build are consumed by
        // this query; they do not schedule a duplicate read after completion.
        pending = false;
        const held = working, originalDemand = demandRevision;
        const result = await query(held.reader, candidate, revision, controller.signal, originalDemand);
        check(candidate, revision, controller.signal);
        if (demandRevision !== originalDemand || working !== held) throw failure('HISTORY_READ_CANCELLED');
        finalProof(candidate, revision, controller.signal);
        enqueue(candidate, revision, previous => {
          if (working !== held || held.reader.closed || demandRevision !== originalDemand) return previous;
          try { checkDeadline(); finalProof(candidate, revision, controller.signal); checkDeadline(); }
          catch (error) {
            if (!currentInput(candidate, revision) || demandRevision !== originalDemand) return previous;
            if (working === held && held !== published) {
              working = null; release(held.reader);
              failed = { input: candidate, revision, error, errorStage: 'presentation' }; pending = false;
            }
            // UNKNOWN never means missing and never clears the old detail.
            const old = sameScope(previous, scopeOf(candidate)) ? previous : emptySnapshot(scopeOf(candidate), selectedKey, subjectOf(candidate));
            return Object.freeze({ ...old, subject: subjectOf(candidate), status: 'error', error, errorStage: 'presentation',
              membership: unknownMembership(memberships, 'error'),
              selected: old.selected?.key === selectedKey && old.selected.record
                ? Object.freeze({ kind: 'unknown', key: selectedKey, record: old.selected.record }) : missing(selectedKey) });
          }
          // The proof itself can select another key without changing the
          // source owner. Do not retire the previously committed detail
          // subject until this exact page/selection demand still owns commit.
          if (!currentInput(candidate, revision) || demandRevision !== originalDemand
            || working !== held || held.reader.closed) return previous;
          const old = published;
          published = held;
          if (old && old !== held) release(old.reader);
          const next = Object.freeze({ ...scopeOf(candidate), subject: subjectOf(candidate), status: 'ready', counts: held.reader.counts,
            rows: result.rows.rows, section: result.rows.section, pageStart: result.rows.offset, pageSize: roster.limit,
            backgroundRows: result.backgroundRows.rows, backgroundStart: result.backgroundRows.offset,
            backgroundPageSize: background.limit, selected: result.selected, membership: result.membership, error: null, errorStage: null });
          committedProof = { snapshot: next, input: candidate, revision, demand: originalDemand, key: result.key, held };
          return next;
        });
      } catch (error) {
        // A replaced demand will run exactly once from the pending slot.
        // A genuine failure is terminal until a real caller/source change.
        if (currentInput(candidate, revision) && (!controller.signal.aborted || job.timedOut)) {
          const terminalError = job.timedOut ? failure('HISTORY_AGENT_CATALOG_DEADLINE') : error;
          const errorStage = candidate.sourceError === error ? 'source' : job.phase === 'build' ? 'model' : 'read';
          if (working && working !== published && working.input === candidate) {
            const failed = working; working = null; release(failed.reader);
          }
          if (!working || working.input !== candidate) failed = { input: candidate, revision, error: terminalError, errorStage };
          pending = false;
          waiting(candidate, revision, terminalError, errorStage);
        }
      } finally {
        clearTimeout(deadline);
        if (source) release(source);
        if (active === job) active = null;
        if (pending && !closed) pump();
      }
    })();
    task.catch(error => { try { onReleaseError(error); } catch {} });
  };
  const scheduleQuery = () => {
    if (!input || closed) return;
    ++demandRevision; pending = true;
    if (active?.phase === 'query') active.controller.abort();
    waiting(input, inputRevision);
    pump();
  };
  return Object.freeze({
    update(next) {
      if (closed) throw failure('HISTORY_READ_CANCELLED');
      const scope = scopeOf(next);
      if (!next || typeof scope.ownerKey !== 'string' || !Number.isSafeInteger(scope.generation)
        || (!next.current && !(next.current === null && next.sourceError))
        || typeof next.fullWitness !== 'function') throw failure('HISTORY_AGENT_CATALOG_PUBLICATION');
      if (next === input) return;
      const previousScope = scopeOf(input);
      input = next; ++inputRevision; ++demandRevision; pending = true; failed = null; committedProof = null;
      active?.controller.abort();
      if (working && working !== published) release(working.reader);
      working = published?.input === next ? published : null;
      if (!sameScope(previousScope, scope)) {
        selectedKey = null;
        roster = { section: 'roster', offset: 0, limit: 64 };
        background = { section: 'background', offset: 0, limit: 32 };
        if (published) release(published.reader);
        published = null;
      }
      waiting(next, inputRevision); pump();
    },
    requestPage({ section = 'roster', offset = 0, limit = section === 'background' ? 32 : 64 } = {}) {
      if (closed) return;
      if (!['all', 'roster', 'running', 'completed', 'interrupted', 'background'].includes(section)
        || !integer(offset) || !integer(limit) || limit < 1 || limit > 64) throw failure('HISTORY_AGENT_CATALOG_RANGE');
      const previous = section === 'background' ? background : roster;
      if (previous.section === section && previous.offset === offset && previous.limit === limit) return;
      if (section === 'background') background = { section, offset, limit }; else roster = { section, offset, limit };
      scheduleQuery();
    },
    select(key) {
      if (closed) return;
      if (key !== null && (typeof key !== 'string' || !key)) throw failure('HISTORY_AGENT_CATALOG_KEY');
      if (selectedKey === key) return;
      selectedKey = key; scheduleQuery();
    },
    requestMembership({ entries = [], calls = [], any = [] } = {}) {
      if (closed) return;
      if (!Array.isArray(entries) || !Array.isArray(calls) || !Array.isArray(any)
        || [...entries, ...calls].some(value => typeof value !== 'string')
        || any.some(value => !value || typeof value.id !== 'string' || !value.id
          || !['entry', 'call'].includes(value.kind) || typeof value.values !== 'function')) {
        throw failure('HISTORY_AGENT_CATALOG_MEMBERSHIP_DEMAND');
      }
      const equalValues = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
      if (equalValues(entries, memberships.entries) && equalValues(calls, memberships.calls)
        && any.length === memberships.any.length && any.every((value, index) => value.id === memberships.any[index].id
          && value.kind === memberships.any[index].kind && value.values === memberships.any[index].values)) return;
      memberships = Object.freeze({ entries: Object.freeze(entries.slice()), calls: Object.freeze(calls.slice()),
        any: Object.freeze(any.map(({ id, kind, values }) => Object.freeze({ id, kind, values }))) });
      scheduleQuery();
    },
    snapshot() { return snapshot; },
    isCurrent(candidateSnapshot) {
      const proof = committedProof;
      const sameIdentity = () => !!proof && !closed && committedProof === proof
        && candidateSnapshot === snapshot && candidateSnapshot === proof.snapshot
        && candidateSnapshot.status === 'ready' && candidateSnapshot.selected.key === proof.key
        && published === proof.held && currentInput(proof.input, proof.revision)
        && demandRevision === proof.demand && selectedKey === proof.key;
      const same = () => {
        if (!sameIdentity()) return false;
        const readerClosed = proof.held.reader.closed;
        return !readerClosed && sameIdentity();
      };
      try {
        if (!same()) return false;
        // A cleanup updater is another actual publication boundary. Fresh
        // native replay must precede the original FULL caller witness and
        // cheap owner fence even when every object identity is unchanged.
        finalProof(proof.input, proof.revision);
        return same();
      } catch { return false; }
    },
    state() { return Object.freeze({ closed, running: active?.phase || null, pending,
      held: !!published, candidate: !!working && working !== published }); },
    close() {
      if (closed) return;
      closed = true; pending = false; ++inputRevision; ++demandRevision;
      active?.controller.abort();
      if (working && working !== published) release(working.reader);
      if (published) release(published.reader);
      working = null; published = null; input = null; snapshot = null; failed = null; committedProof = null; memberships = emptyMembershipRequest();
    },
  });
}
