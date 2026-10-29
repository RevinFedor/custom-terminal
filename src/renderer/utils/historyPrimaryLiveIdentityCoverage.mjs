import { historyLivePresentationIdentities } from './historyLiveProjection.mjs';
import { withHistoryPrimaryCanonicalConsumer, selectHistoryPrimaryCanonicalValue as selected } from './historyPrimaryCanonicalConsumers.mjs';

const fail = code => Object.assign(new Error(code), { code });
const settingFact = entry => {
  const fact = entry?.settingsFact;
  return entry?.role === 'slash' && fact?.version === 1 && fact.provider === 'codex'
    && (fact.kind === 'model' || fact.kind === 'effort')
    && typeof fact.value === 'string' && fact.value ? fact : null;
};

// The existing graph witness covers own fields and cycles. Live semantics
// additionally observe inherited array elements and nonenumerable identity /
// settings properties; replay the actual native identity oracle every time.
// This object belongs only to a current claim observation, never a cache.
export function captureHistoryPrimaryLiveClaimWitness(entry) {
  const fact = settingFact(entry);
  return { entry, identities: historyLivePresentationIdentities(entry),
    setting: fact ? { kind: fact.kind, value: fact.value, sessionId: entry?.sessionId } : null };
}

// The strings here belong only to the current <=3 caller claims. A historical
// identity is a signed document, compared in chunks and then released. Keeping
// one boolean per CURRENT identity also reproduces last-write settings facts
// without a native durable Set/Map or a retained visited-claim registry.
async function matchParts(context, states, parts, visit, operation = 'string-falsy') {
  const matching = states.map(state => state.identities.map(() => true));
  let offset = 0;
  for (const part of parts) {
    await context.withText(part, async document => {
      for (let claim = 0; claim < states.length; claim++) {
        for (let id = 0; id < matching[claim].length; id++) {
          if (offset + document.length > states[claim].identities[id].length) matching[claim][id] = false;
        }
      }
      // Complete every selected coercion and signed document, even after an
      // early overlap. A later alias/row may throw or override a settings fact.
      await context.scanText(document, (text, at) => {
        for (let claim = 0; claim < states.length; claim++) {
          for (let id = 0; id < matching[claim].length; id++) {
            if (matching[claim][id]
              && text !== states[claim].identities[id].slice(offset + at, offset + at + text.length)) {
              matching[claim][id] = false;
            }
          }
        }
      });
      offset += document.length;
    }, operation);
    context.check();
  }
  for (let claim = 0; claim < states.length; claim++) {
    for (let id = 0; id < matching[claim].length; id++) {
      if (matching[claim][id] && offset === states[claim].identities[id].length) visit(claim, id);
    }
  }
}

async function visitIdentities(context, row, states, visit) {
  await matchParts(context, states, [selected(row, 'sourceIdentity')], visit);
  context.check();
  const aliases = selected(row, 'sourceIdentityAliases');
  if (await context.kind(aliases) === 'array') {
    const length = await context.number(aliases, 'array-length');
    if (!Number.isSafeInteger(length) || length < 0) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_ALIASES');
    for (let index = 0; index < length; index++) {
      await matchParts(context, states, [selected(row, 'sourceIdentityAliases', index)], visit);
      context.check();
    }
  }
  // This operation calls the original queue grammar. Its empty result is not
  // an identity; no sourceUuidAliases or raw assistant UUID fallback is added.
  await matchParts(context, states, [row], visit, 'queue-identity');
  const role = await context.role(row); context.check();
  if (['assistant', 'user', 'slash', 'provider-error', 'usage-limit'].includes(role)) {
    const uuid = selected(row, 'uuid');
    const truth = await context.smallText(uuid, 5, 'truthy'); context.check();
    if (truth !== 'true' && truth !== 'false') throw fail('HISTORY_PRIMARY_LIVE_UUID_TRUTH');
    if (truth === 'true') {
      const parts = ['assistant', 'user'].includes(role) ? [role + '-uuid:', uuid]
        : [role + '-uuid:', selected(row, 'sessionId'), ':', uuid];
      await matchParts(context, states, parts, visit); context.check();
    }
  }
}

async function strictSessionEquals(context, row, expected) {
  // Live objects are renderer-owned; independently decoded durable containers
  // cannot be the same reference. Never turn strict session equality into a
  // deep comparison, or coerce a number/null into a string session ID.
  const type = expected === null ? 'null' : typeof expected;
  if (!['string', 'number', 'bigint', 'boolean', 'null', 'undefined'].includes(type)
    || type === 'number' && Number.isNaN(expected)) return false;
  const value = selected(row, 'sessionId');
  if (await context.kind(value) !== type) return false;
  if (type === 'null' || type === 'undefined') return true;
  if (type === 'number') return await context.number(value) === expected;
  return context.equals(value, String(expected || ''));
}

/** Full native live reconciliation semantics for one bounded CURRENT batch.
 * The result is prepared canonical membership, not a Panel data commit. */
export async function readHistoryPrimaryLiveIdentityCoverage(model, view, claims, options, fingerprint) {
  if (!Array.isArray(claims) || claims.length > 3) throw fail('HISTORY_PRIMARY_LIVE_CLAIMS_LIMIT');
  if (options.signal?.aborted || model.closed || model.view !== view
    || options.owns && options.owns() !== true) throw fail('HISTORY_READ_CANCELLED');
  const entries = claims.slice(), witnesses = entries.map(captureHistoryPrimaryLiveClaimWitness);
  const fingerprints = witnesses.map(witness => fingerprint(witness));
  const dataSubject = model.getReceiptDataSubject();
  if (!dataSubject || dataSubject !== view.receiptDataSubject) throw fail('HISTORY_PRIMARY_LIVE_DATA_SUBJECT');
  // Delegated ownership must be synchronous and explicitly true. Promise or
  // undefined results cannot authorize an asynchronous current-live proof.
  const current = () => (options.owns ? options.owns() === true : true)
    && model.getReceiptDataSubject() === dataSubject
    && claims.length === entries.length
    && entries.every((entry, index) => Object.is(claims[index], entry));
  const states = witnesses.map((witness, index) => ({ entry: witness.entry, fingerprint: fingerprints[index],
    identities: witness.identities, fact: witness.setting,
    lastConflicts: [], coveredIdentity: false }));
  for (const state of states) state.lastConflicts = state.identities.map(() => false);
  // The scan uses captured primitive identities/settings, never mutable live
  // bodies. Recheck owner/cut/references after every await, then compare fresh
  // full graph+grammar witnesses before exposing the result. Hashing the whole
  // live payload on every historical field/chunk would multiply its cost by N.
  let checkCurrentCut;
  const proof = await withHistoryPrimaryCanonicalConsumer(model, view, { ...options, owns: current }, async context => {
    checkCurrentCut = context.check;
    if (states.some(state => state.fact)) {
      // The old reducer builds the settings Map BEFORE its durable identity
      // Set. Complete this pass, including every valid fact's identities.
      await context.find('canonical', async row => {
        const kind = await context.smallText(row, 6, 'live-setting-kind'); context.check();
        if (kind === '') return false;
        if (kind !== 'model' && kind !== 'effort') throw fail('HISTORY_PRIMARY_LIVE_SETTING_KIND');
        const matched = states.map(state => state.identities.map(() => false));
        await visitIdentities(context, row, states, (claim, id) => { matched[claim][id] = true; });
        for (let claim = 0; claim < states.length; claim++) {
          const state = states[claim];
          if (!state.fact || !matched[claim].some(Boolean)) continue;
          const sameSession = await strictSessionEquals(context, row, state.fact.sessionId); context.check();
          const sameValue = sameSession && kind === state.fact.kind
            && await context.withText(row, async document => {
              if (document.length !== state.fact.value.length) return false;
              return context.scanText(document, (text, at) => text === state.fact.value.slice(at, at + text.length));
            }, 'live-setting-value');
          context.check();
          const conflict = sameSession && (kind !== state.fact.kind || !sameValue);
          for (let id = 0; id < matched[claim].length; id++) {
            // A later valid fact from another session clears the previous
            // conflicting fact for THIS identity, just as Map.set does.
            if (matched[claim][id]) state.lastConflicts[id] = conflict;
          }
        }
        return false;
      });
      context.check();
    }
    // No positive result short-circuits this complete second pass. No-ID
    // claims remain uncovered, and plain coverage ignores settings conflicts.
    await context.find('canonical', async row => {
      await visitIdentities(context, row, states, claim => { states[claim].coveredIdentity = true; });
      return false;
    });
    context.check();
    return Object.freeze({ header: context.header, dataSubject, claims: Object.freeze(states.map(state => Object.freeze({
      entry: state.entry, fingerprint: state.fingerprint, coveredIdentity: state.coveredIdentity,
      settingsConflict: !!state.fact && state.lastConflicts.some(Boolean),
    }))) });
  });
  // Reuse the held parent's exact signal/sequence/view/header/reader/root
  // guard after the helper's final await. Native identity coercion may itself
  // reenter cleanup, so guard once more after every full witness is checked.
  checkCurrentCut();
  const valuesCurrent = entries.every((entry, index) =>
    fingerprint(captureHistoryPrimaryLiveClaimWitness(entry)) === fingerprints[index]);
  checkCurrentCut();
  if (!valuesCurrent) {
    throw fail('HISTORY_READ_CANCELLED');
  }
  return proof;
}
