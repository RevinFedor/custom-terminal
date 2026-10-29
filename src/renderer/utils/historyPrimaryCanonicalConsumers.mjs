import { HistoryRootClient, historyRootIdentity } from './historyRootReadClient.mjs';
import { createDocumentUtf16Digest } from './documentUtf16Digest.mjs';

const PROFILE = 'primary-canonical-consumers-v1';
const CHARS = 1024;
const fail = code => Object.assign(new Error(code), { code });
const descriptor = value => value && typeof value === 'object' && typeof value.protocol === 'string';
const SELECTION = Symbol('canonical-consumer-selection');
const selected = (node, field, index, memberField) => ({ [SELECTION]: true, node, field, index, memberField });
const KINDS = ['string', 'number', 'bigint', 'boolean', 'null', 'undefined', 'object', 'array', 'map', 'set'];
const whitespace = value => /\s/u.test(value);

// This is a demand on the existing immutable parent, not another owner of it.
// Generic page refusal/abort retires only this local probe. Text forks below
// are independently leased and close exactly once even after a lost owner.
class CanonicalConsumerProbe extends HistoryRootClient {
  close() { return this.abandon(); }
}

function capture(model, view, { signal, owns = () => true } = {}) {
  const header = view?.header, parent = view?.reader, root = view?.root, sequence = model.sequence;
  const check = () => {
    if (signal?.aborted || model.closed || model.view !== view || view.header !== header
      || view.reader !== parent || view.root !== root || model.sequence !== sequence || owns() !== true) {
      throw fail('HISTORY_READ_CANCELLED');
    }
    parent.assertOpen();
  };
  check();
  if (header.canonicalConsumers?.profile !== PROFILE || header.canonicalConsumers.maxItems !== 3
    || header.canonicalConsumers.valueEncoding !== 'history-canonical-consumer-text-v1') {
    throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMERS_PROFILE_REQUIRED');
  }
  return { header, parent, root, check, signal };
}

async function withConsumer(model, view, options, consume) {
  const held = capture(model, view, options);
  return model.pull(async () => {
    held.check();
    const parent = held.parent;
    const probe = new CanonicalConsumerProbe((channel, payload) => channel === parent.pageChannel
      ? model.transport.readHistoryThroughIpc(parent.invoke, channel, payload, { signal: held.signal })
      : parent.invoke(channel, payload), held.root, {
      pageBytes: parent.pageBytes, pageItems: Math.min(3, parent.pageItems),
      pageChannel: parent.pageChannel, releaseChannel: parent.releaseChannel, forkChannel: parent.forkChannel,
    });
    const forkInvoke = async (channel, payload) => {
      // Work-bearing coercion uses the ordinary demand/cancel transport. Keep
      // the raw reply visible for exactly-once cleanup when that transport
      // abandons before a newly allocated independent lease arrives.
      let observed, abandoned = false, released = false;
      const discard = result => {
        if (released || result?.success !== true) return;
        let identity;
        try { identity = historyRootIdentity(result); } catch { return; }
        if (identity.leaseId === parent.identity.leaseId
          || ['ownerKey','revision','generation'].some(key => identity[key] !== parent.identity[key])) return;
        released = true;
        try { Promise.resolve(parent.invoke(parent.releaseChannel, identity)).catch(() => {}); } catch {}
      };
      const raw = (method, request) => {
        const result = parent.invoke(method, request);
        if (method !== channel) return result;
        return Promise.resolve(result).then(reply => {
          observed = reply; if (abandoned) discard(reply); return reply;
        });
      };
      try { return await model.transport.readHistoryThroughIpc(raw, channel, payload, { signal: held.signal }); }
      catch (error) { abandoned = true; discard(observed); throw error; }
    };
    const context = createConsumerContext(probe, { ...held, forkInvoke });
    let primary;
    try { const result = await consume(context); held.check(); return result; }
    catch (error) { primary = error; throw error; }
    finally { await probe.abandon(); if (!primary) held.check(); }
  });
}

function createConsumerContext(reader, { root, header, check, signal, forkInvoke }) {
  const project = async (node, fields) => {
    const result = Object.create(null);
    // These are at most three known unit/header fields, never a source field
    // list. A configured producer cap may return fewer than the requested 3.
    for (let offset = 0; offset < fields.length;) {
      check();
      const page = await reader.project(node, fields, { offset, limit: Math.min(3, fields.length - offset) });
      check();
      if (page.length !== fields.length || page.nextOffset !== offset + page.items.length
        || page.nextOffset <= offset || page.nextOffset > fields.length || page.done !== (page.nextOffset === fields.length)
        || page.items.some((item, at) => item.name !== fields[offset + at])) {
        throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_UNIT_FIELDS');
      }
      for (const item of page.items) result[item.name] = item.value;
      offset = page.nextOffset;
    }
    return result;
  };
  const withText = async (value, consume, operation = 'string-falsy') => {
    check();
    if (!descriptor(value) && !value?.[SELECTION]) {
      // Wire scalars are already finite; this does not decode a historical
      // container or copy a long document into a native String.
      const text = operation === 'number' ? String(Number(value)) : String(value || '');
      const document = { length: text.length, digest: null,
        read: async (offset, limit) => ({ text: text.slice(offset, offset + limit),
          nextOffset: Math.min(text.length, offset + limit) }) };
      const result = await consume(document); check(); return result;
    }
    const selection = value?.[SELECTION] ? value : null;
    const document = !selection && operation === 'string-falsy' && value.kind === 'text'
      ? await reader.forkText(value, { signal })
      : await reader.forkCanonicalConsumerValue(selection?.node || value, { operation, signal, invoke: forkInvoke,
        ...(selection?.field !== undefined ? { field: selection.field } : {}),
        ...(selection?.index !== undefined ? { index: selection.index } : {}),
        ...(selection?.memberField !== undefined ? { memberField: selection.memberField } : {}) });
    let primary;
    try { check(); const result = await consume(document); check(); return result; }
    catch (error) { primary = error; throw error; }
    finally {
      try { await document.close(); if (!primary) check(); }
      catch (error) {
        if (!primary) throw error;
        console.warn('[HistoryPrimary] canonical-consumer-release-failed code=' + String(error?.code || 'UNKNOWN'));
      }
    }
  };
  const scanText = async (document, consume, { from = 0, to = document.length, verify = true } = {}) => {
    check();
    const digest = verify && document.digest ? await createDocumentUtf16Digest() : null;
    check();
    let offset = from, matched = true;
    while (offset < to) {
      const part = await document.read(offset, Math.min(CHARS, to - offset), { signal });
      check();
      if (typeof part.text !== 'string' || !part.text.length || part.text.length > CHARS
        || part.nextOffset !== offset + part.text.length || part.nextOffset > to) {
        throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_TEXT_PROGRESS');
      }
      digest?.update(part.text);
      if (matched && consume(part.text, offset) === false) matched = false;
      offset = part.nextOffset;
    }
    if (digest && (from !== 0 || to !== document.length || digest.digest() !== document.digest)) {
      throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
    }
    check(); return matched;
  };
  const equals = (value, expected) => withText(value, async document => {
    if (document.length !== expected.length) return false;
    return scanText(document, (part, offset) => part === expected.slice(offset, offset + part.length));
  });
  const equalsChoices = (value, expected, operation = 'string-falsy') => withText(value, async document => {
    // At most two caller-owned selector views: canonical, and the terminal
    // assistant-uuid fallback. Their long strings are never concatenated.
    const matching = expected.map(item => item.length === document.length);
    if (matching.some(Boolean)) await scanText(document, (part, offset) => {
      for (let index = 0; index < matching.length; index++) {
        if (matching[index] && part !== expected[index].slice(offset, offset + part.length)) matching[index] = false;
      }
      return matching.some(Boolean);
    });
    return matching.reduce((mask, value, index) => mask | (value ? 1 << index : 0), 0);
  }, operation);
  const equalsPartsChoices = async (parts, expected) => {
    const matching = expected.map(() => true);
    let offset = 0;
    for (const value of parts) {
      await withText(value, async document => {
        for (let index = 0; index < matching.length; index++) {
          if (offset + document.length > expected[index].length) matching[index] = false;
        }
        if (matching.some(Boolean)) await scanText(document, (part, at) => {
          for (let index = 0; index < matching.length; index++) {
            if (matching[index] && part !== expected[index].slice(offset + at, offset + at + part.length)) matching[index] = false;
          }
          return matching.some(Boolean);
        });
        // Coerce every fragment even after a mismatch: the actual identity
        // builder computes String(uuid), including its possible error.
        offset += document.length;
      });
      check();
    }
    return matching.reduce((mask, value, index) => mask | (value && offset === expected[index].length ? 1 << index : 0), 0);
  };
  const smallText = (value, maximum, operation = 'string-falsy') => withText(value, async document => {
    if (document.length > maximum) return null;
    let text = '';
    await scanText(document, part => { text += part; });
    return text;
  }, operation);
  const kind = async value => {
    const type = await smallText(value, 9, 'kind');
    if (!KINDS.includes(type)) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_KIND');
    return type;
  };
  const rawStringEquals = async (value, expected) => await kind(value) === 'string' && equals(value, expected);
  const role = async row => {
    const value = selected(row, 'role');
    return await kind(value) === 'string' ? smallText(value, 14) : null;
  };
  const truthy = async value => {
    const type = await kind(value);
    if (['object', 'array', 'map', 'set'].includes(type)) return true;
    return withText(value, document => document.length > 0);
  };
  const number = (value, operation = 'number') => withText(value, async document => {
    // The number operation produces only Number.prototype.toString (plus
    // -0). This is a fixed scalar vocabulary, never a source-sized token.
    if (document.length > 32) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_NUMBER');
    let token = '';
    await scanText(document, part => { token += part; });
    const numeric = Number(token);
    if (token !== String(numeric) && !(token === '-0' && Object.is(numeric, -0))) {
      throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_NUMBER');
    }
    return numeric;
  }, operation);
  const documentsEqual = async (left, right) => {
    if (left.length !== right.length) return false;
    const leftDigest = await createDocumentUtf16Digest(); check();
    const rightDigest = await createDocumentUtf16Digest(); check();
    let matched = true;
    for (let offset = 0; offset < left.length;) {
      const limit = Math.min(CHARS, left.length - offset);
      const parts = await Promise.all([left.read(offset, limit, { signal }), right.read(offset, limit, { signal })]);
      check();
      for (const part of parts) if (typeof part.text !== 'string' || !part.text.length || part.text.length > limit
        || part.nextOffset !== offset + part.text.length) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_TEXT_PROGRESS');
      if (parts[0].text.length !== parts[1].text.length) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_TEXT_PROGRESS');
      if (parts[0].text !== parts[1].text) matched = false;
      leftDigest.update(parts[0].text); rightDigest.update(parts[1].text); offset = parts[0].nextOffset;
    }
    if (leftDigest.digest() !== left.digest || rightDigest.digest() !== right.digest) throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
    return matched;
  };
  const readUnit = async headerNode => {
    const unit = (await project(headerNode, ['unit'])).unit;
    if (!descriptor(unit) || unit.kind !== 'object') throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_UNIT');
    const fields = await project(unit, ['kind', 'entry', 'entries']);
    if (fields.kind === 'entry') {
      if (!descriptor(fields.entry) || fields.entry.kind !== 'object') throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_UNIT');
      return fields;
    }
    if (fields.kind !== 'group' || !descriptor(fields.entries) || fields.entries.kind !== 'array') {
      throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_UNIT');
    }
    return fields;
  };
  const unitSome = async (headerNode, predicate) => {
    const fields = await readUnit(headerNode); check();
    if (fields.kind === 'entry') { const matched = await predicate(fields.entry); check(); return matched; }
    for (let offset = 0; offset < fields.entries.length;) {
      const page = await reader.range(fields.entries, { offset, limit: 3 });
      check();
      if (page.length !== fields.entries.length || page.nextOffset !== offset + page.items.length
        || page.nextOffset > fields.entries.length || page.done !== (page.nextOffset === fields.entries.length)
        || page.items.some((item, at) => item.ordinal !== offset + at || item.present !== true
          || !descriptor(item.value) || item.value.kind !== 'object')) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_UNIT_ROWS');
      for (const item of page.items) {
        const matched = await predicate(item.value); check(); if (matched) return true;
      }
      offset = page.nextOffset;
    }
    return false;
  };
  const target = (row, identity) => withText(selected(row, 'uuid'), async expected => {
    if (!expected.length) return null;
    let chosen = null;
    // Reproduce the actual Panel Map: every group member and every entry
    // writes its raw UUID in display order, including expanded group rows.
    // Two leased documents compare the first row's String(uuid) to each
    // string Map key. No giant selector String or UUID index is constructed.
    for (let offset = 0; offset < header.totalEntries;) {
      check();
      const page = await reader.primaryPresentationAddresses(root, { header, mode: 'range', offset, limit: 3, signal });
      check();
      for (const item of page.items) {
        if (await unitSome(item.header, async member => {
          const uuid = selected(member, 'uuid');
          return await kind(uuid) === 'string' && withText(uuid, actual => documentsEqual(expected, actual));
        })) chosen = item;
      }
      offset = page.nextOffset;
    }
    if (!chosen || !await unitSome(chosen.header, member => liveIdentityMatches(context, member, identity))) return null;
    // One proven selected target is the existing address result owner. This
    // full identity string is deliberately still a selected scalar OPEN
    // sink; it is allocated only after all streamed selection proofs pass.
    let canonicalUuid = '';
    await scanText(expected, part => { canonicalUuid += part; });
    const unit = await readUnit(chosen.header); check();
    let first = unit.entry;
    if (unit.kind === 'group') {
      const firstPage = await reader.range(unit.entries, { offset: 0, limit: 1 });
      check();
      if (firstPage.length !== unit.entries.length || firstPage.nextOffset !== 1 || firstPage.items.length !== 1
        || firstPage.items[0].ordinal !== 0 || firstPage.items[0].present !== true) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_UNIT_ROWS');
      first = firstPage.items[0].value;
    }
    const materializeSelected = value => withText(value, async document => {
      let text = ''; await scanText(document, part => { text += part; }); return text;
    });
    const domUuid = await materializeSelected(selected(first, 'uuid'));
    if (!domUuid) return null;
    const fields = await project(chosen.header, ['physicalKey', 'key']);
    const physicalKey = await materializeSelected(fields.physicalKey);
    if (!physicalKey) throw fail('HISTORY_PRIMARY_ADDRESS_KEY');
    const groupKey = unit.kind === 'group' ? await materializeSelected(fields.key) : null;
    check();
    return Object.freeze({ canonicalUuid, unitIndex: chosen.rank, domUuid, groupKey,
      presentationKind: unit.kind, physicalKey });
  });
  const find = async (scope, predicate) => {
    const node = scope === 'canonical' ? header.durableMetadata : header.sourceMetadata;
    let offset = 0;
    for (;;) {
      check();
      // Even the zero-row case requires this dedicated producer proof.
      const page = await reader.primaryCanonicalConsumers(node, { header, scope,
        offset, limit: Math.min(3, reader.pageItems), signal });
      check();
      for (const item of page.items) {
        const matched = await predicate(item.row, item.ordinal); check();
        if (matched) return { row: item.row, ordinal: item.ordinal };
      }
      if (page.done) return null;
      offset = page.nextOffset;
    }
  };
  const strictText = value => typeof value === 'string' || descriptor(value) && value.kind === 'text';
  const wireTruth = value => descriptor(value) ? value.kind !== 'text' || value.length > 0 : !!value;
  const scalar = async value => {
    if (!descriptor(value)) return value;
    if (value.kind !== 'text') throw fail('HISTORY_PRIMARY_CONFIRMED_RECEIPT_SCALAR');
    return withText(value, async document => {
      let result = ''; await scanText(document, part => { result += part; }); return result;
    });
  };
  const identityMatches = async (fields, selector) => {
    const exact = typeof selector === 'string' ? selector.trim() : '';
    if (!exact) return false;
    for (const name of ['uuid', 'sourceIdentity']) {
      if (strictText(fields[name]) && await equals(fields[name], exact)) return true;
    }
    for (const name of ['sourceIdentityAliases', 'sourceUuidAliases']) {
      const aliases = fields[name];
      if (!descriptor(aliases) || aliases.kind !== 'array') continue;
      for (let offset = 0; offset < aliases.length;) {
        check(); const page = await reader.range(aliases, { offset, limit: Math.min(3, reader.pageItems) }); check();
        if (page.length !== aliases.length || page.nextOffset !== offset + page.items.length
          || page.nextOffset <= offset || page.nextOffset > aliases.length
          || page.done !== (page.nextOffset === aliases.length)
          || page.items.some((item, index) => item.ordinal !== offset + index || typeof item.present !== 'boolean')) {
          throw fail('HISTORY_PRIMARY_CONFIRMED_RECEIPT_ALIASES');
        }
        for (const item of page.items) if (item.present && strictText(item.value) && await equals(item.value, exact)) return true;
        offset = page.nextOffset;
      }
    }
    return false;
  };
  const confirmedReceipt = async input => {
    let selectedFields;
    const match = await find('canonical', async row => {
      const fields = await project(row, ['role', 'uuid', 'sourceIdentity', 'sourceIdentityAliases',
        'sourceUuidAliases', 'sessionId', 'liveProjection']);
      // Same committed-row filter as Panel, before the receipt predicate.
      if (strictText(fields.role) && await equals(fields.role, 'queued')) {
        if (!strictText(fields.uuid)) throw new TypeError('entry.uuid.startsWith is not a function');
        const local = await withText(fields.uuid, async document => {
          const prefix = 'local-prompt-'; let matched = document.length >= prefix.length;
          await scanText(document, (part, at) => {
            if (at < prefix.length && part.slice(0, prefix.length - at) !== prefix.slice(at, at + part.length)) matched = false;
          });
          return matched;
        });
        if (local) return false;
      }
      if (wireTruth(fields.liveProjection)) return false;
      if (input.sessionId && wireTruth(fields.sessionId)
        && (!strictText(fields.sessionId) || !await equals(fields.sessionId, input.sessionId))) return false;
      for (const identity of input.identities) if (await identityMatches(fields, identity)) {
        selectedFields = fields; return true;
      }
      return false;
    });
    if (!match) return Object.freeze({ header, found: false, ordinal: null, acknowledgement: null });
    const a = input.ack;
    const entryMatched = !!a.auditEntryUuid && await identityMatches(selectedFields, a.auditEntryUuid);
    const sourceMatched = !!a.auditSourceIdentity && await identityMatches(selectedFields, a.auditSourceIdentity);
    const sessionId = a.sessionId || await scalar(selectedFields.sessionId);
    let acknowledgement = null;
    if (a.operationKey && a.attemptId && a.handoffId && a.provider && sessionId && (entryMatched || sourceMatched)) {
      acknowledgement = Object.freeze({ operationKey: a.operationKey, attemptId: a.attemptId,
        handoffId: a.handoffId, provider: a.provider, sessionId,
        entryUuid: a.auditEntryUuid || await scalar(selectedFields.uuid),
        sourceIdentity: a.auditSourceIdentity || await scalar(selectedFields.sourceIdentity) || null });
    }
    check();
    return Object.freeze({ header, found: true, ordinal: match.ordinal, acknowledgement });
  };
  const context = { header, check, withText, scanText, smallText, equals, equalsChoices, equalsPartsChoices, kind, role, truthy, rawStringEquals, number, find, target, confirmedReceipt };
  return context;
}

// Shared held-root/child-lease machinery; this is not a second receipt query
// or a certificate that canonical data has reached a Panel data commit.
export { withConsumer as withHistoryPrimaryCanonicalConsumer, selected as selectHistoryPrimaryCanonicalValue };

async function normalizedExpected(text, check) {
  let start = 0, end = text.length, chunks = 0;
  check();
  // The local receipt already owns this native input. Its potentially giant
  // trim scan still yields: at most 64 chunks of 128 code units per turn.
  // No user candidate means this normalization is never invoked.
  while (start < end) {
    const stop = Math.min(end, start + 128);
    while (start < stop && whitespace(text[start])) start++;
    check();
    if (start < stop) break;
    if (++chunks % 64 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); check(); }
  }
  while (end > start) {
    const stop = Math.max(start, end - 128);
    while (end > stop && whitespace(text[end - 1])) end--;
    check();
    if (end > stop) break;
    if (++chunks % 64 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); check(); }
  }
  return (function* () {
    for (let at = start; at < end; at++) {
      if (text[at] === '\r' && text[at + 1] === '\n') at++;
      yield text[at];
    }
  })();
}

async function normalizedTextEquals(context, value, expected) {
  const iterator = await normalizedExpected(expected, context.check); context.check();
  return context.withText(value, async document => {
    let next = iterator.next(), started = false, pendingCR = false, matches = true;
    if (next.done) return false;
    const put = char => {
      if (!started && whitespace(char)) return true;
      started = true;
      if (next.done) return whitespace(char);
      if (next.value !== char) return false;
      next = iterator.next(); return true;
    };
    const complete = await context.scanText(document, part => {
      for (let index = 0; index < part.length; index++) {
        const char = part[index];
        if (pendingCR) {
          pendingCR = false;
          if (!put(char === '\n' ? '\n' : '\r')) { matches = false; return false; }
          if (char === '\n') continue;
        }
        if (char === '\r') pendingCR = true;
        else if (!put(char)) { matches = false; return false; }
      }
    });
    if (pendingCR && !put('\r')) matches = false;
    return complete && matches && started && next.done;
  });
}

function prefixedSelector(prefix, value) {
  return { length: prefix.length + value.length, slice(from, to) {
    const left = from < prefix.length ? prefix.slice(from, Math.min(to, prefix.length)) : '';
    const right = to > prefix.length ? value.slice(Math.max(0, from - prefix.length), to - prefix.length) : '';
    return left + right;
  } };
}

async function liveIdentityMatches(context, row, identity) {
  const role = await context.role(row);
  const choices = role === 'assistant' ? [identity, prefixedSelector('assistant-uuid:', identity)] : [identity];
  let matches = await context.equalsChoices(selected(row, 'sourceIdentity'), choices);
  const aliases = selected(row, 'sourceIdentityAliases');
  if (await context.kind(aliases) === 'array') {
    const length = await context.number(aliases, 'array-length');
    if (!Number.isSafeInteger(length) || length < 0) throw fail('HISTORY_PRIMARY_CANONICAL_CONSUMER_ALIASES');
    for (let index = 0; index < length; index++) {
      matches |= await context.equalsChoices(selected(row, 'sourceIdentityAliases', index), choices);
    }
  }
  // Build all native identity branches before testing inclusion, preserving
  // String coercion/errors even when an earlier alias already matched.
  if (role === 'queued') matches |= await context.equalsChoices(row, choices, 'queue-identity');
  const uuid = selected(row, 'uuid');
  if (['assistant', 'user', 'slash', 'provider-error', 'usage-limit'].includes(role) && await context.truthy(uuid)) {
    const parts = ['assistant', 'user'].includes(role) ? [role + '-uuid:', uuid]
      : [role + '-uuid:', selected(row, 'sessionId'), ':', uuid];
    matches |= await context.equalsPartsChoices(parts, choices);
  }
  if (matches & 1) return true;
  return role === 'assistant' && (await context.equals(uuid, identity) || !!(matches & 2));
}

async function trimmedContentHash(context, value) {
  return context.withText(value, async document => {
    let first = -1, last = 0;
    // Find the exact ECMAScript trim boundaries and verify the full source.
    // A long whitespace suffix remains counters, not a pending string.
    await context.scanText(document, (part, offset) => {
      for (let at = 0; at < part.length; at++) if (!whitespace(part[at])) {
        if (first < 0) first = offset + at;
        last = offset + at + 1;
      }
    });
    context.check();
    const builtin = 'node:crypto';
    const { createHash } = typeof window !== 'undefined' && typeof window.require === 'function'
      ? window.require(builtin) : await import(/* @vite-ignore */ builtin);
    context.check();
    const hash = createHash('sha256');
    let high = '';
    if (first >= 0) await context.scanText(document, part => {
      let chunk = high + part; high = '';
      if (/[\uD800-\uDBFF]/u.test(chunk.at(-1) || '')) { high = chunk.at(-1); chunk = chunk.slice(0, -1); }
      hash.update(chunk, 'utf8');
    }, { from: first, to: last, verify: false });
    if (high) hash.update(high, 'utf8');
    context.check(); return hash.digest('hex');
  });
}

/** The exact not-submitted recovery predicate; this never grants Send truth. */
export async function readHistoryPrimaryLaterCanonicalReceipt(model, view, record, options = {}) {
  const held = capture(model, view, options);
  if (record?.state !== 'not-submitted' || record?.surface !== 'desktop-history') return false;
  const matched = await withConsumer(model, view, options, context => context.find('canonical', async row => {
    const role = await context.role(row); context.check();
    if (role !== 'user') return false;
    // Evaluation order is part of the legacy predicate. A mismatched text
    // must not coerce an offset; an empty expected text still coerces the
    // actual content before returning false. No role candidate means neither.
    const receipt = record?.receipt && typeof record.receipt === 'object' ? record.receipt : {};
    const boundary = record?.transcriptBoundary && typeof record.transcriptBoundary === 'object' ? record.transcriptBoundary : {};
    const expected = String(receipt.promptText || '');
    const textMatches = await normalizedTextEquals(context, selected(row, 'content'), expected); context.check();
    if (!textMatches) return false;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const boundarySessionId = typeof boundary.sessionId === 'string' ? boundary.sessionId : '';
    if (!sessionId) return false;
    const sessionMatches = await context.rawStringEquals(selected(row, 'sessionId'), sessionId); context.check();
    if (!sessionMatches) return false;
    if (boundarySessionId && boundarySessionId !== sessionId) return false;
    const boundaryOffset = Number(boundary.fileSize);
    const offset = await context.number(selected(row, 'recordByteOffset'));
    context.check();
    return boundary.available !== false && Number.isSafeInteger(boundaryOffset) && boundaryOffset >= 0
      && Number.isSafeInteger(offset) && offset >= boundaryOffset;
  }));
  held.check(); return !!matched;
}

/** Canonical existence, prepared membership, text integrity and address stay distinct. */
export async function readHistoryPrimaryTerminalPreviewMembership(model, view, identity, options = {}) {
  const held = capture(model, view, options);
  const exact = String(identity || '');
  if (!exact) return Object.freeze({ header: held.header, canonicalPresent: false,
    preparedPresent: false, preparedTextHash: null, target: null });
  const proof = await withConsumer(model, view, options, async context => {
    const canonical = await context.find('canonical', row => liveIdentityMatches(context, row, exact));
    const prepared = await context.find('prepared', row => liveIdentityMatches(context, row, exact));
    let preparedTextHash = null;
    if (prepared) preparedTextHash = await trimmedContentHash(context, selected(prepared.row, 'content'));
    const target = prepared ? await context.target(prepared.row, exact) : null;
    context.check(); return { canonicalPresent: !!canonical, prepared, preparedTextHash, target };
  });
  held.check();
  return Object.freeze({ header: held.header, canonicalPresent: proof.canonicalPresent,
    preparedPresent: !!proof.prepared, preparedTextHash: proof.preparedTextHash, target: proof.target });
}

/** First eligible canonical row for the unchanged confirmed-receipt predicate.
 * This is selected read evidence; the existing Panel commit/receipt owners and
 * Main's presentation CAS still decide whether to acknowledge or consume. */
export async function readHistoryPrimaryConfirmedCanonicalReceipt(model, view, record, options = {}) {
  const held = capture(model, view, options);
  if (record?.state !== 'confirmed' || record?.presentation) {
    return Object.freeze({ header: held.header, found: false, ordinal: null, acknowledgement: null });
  }
  const receipt = record?.receipt && typeof record.receipt === 'object' ? record.receipt : {};
  const audit = record?.auditIdentity && typeof record.auditIdentity === 'object' ? record.auditIdentity : {};
  const entryUuid = typeof receipt.entryUuid === 'string' && receipt.entryUuid ? receipt.entryUuid
    : typeof audit.entryUuid === 'string' ? audit.entryUuid : '';
  const sourceIdentity = typeof receipt.sourceIdentity === 'string' && receipt.sourceIdentity ? receipt.sourceIdentity
    : typeof audit.sourceIdentity === 'string' ? audit.sourceIdentity : '';
  const sessionId = typeof receipt.sessionId === 'string' && receipt.sessionId ? receipt.sessionId
    : typeof record.sessionId === 'string' ? record.sessionId : '';
  // ACK's original caller uses || BEFORE the helper's type checks. Capture
  // that separately: a malformed truthy receipt selector must not be cleaned
  // into the predicate's typed audit fallback and gain ACK authority.
  const ackSession = receipt.sessionId || record.sessionId;
  const ackEntry = receipt.entryUuid || audit.entryUuid;
  const ackSource = receipt.sourceIdentity || audit.sourceIdentity;
  const input = Object.freeze({ sessionId, identities: Object.freeze([entryUuid, sourceIdentity]),
    ack: Object.freeze({ operationKey: typeof record.operationKey === 'string' ? record.operationKey.trim() : '',
      attemptId: typeof record.attemptId === 'string' ? record.attemptId.trim() : '',
      handoffId: typeof record.handoffId === 'string' ? record.handoffId.trim() : '',
      provider: record.provider === 'claude' || record.provider === 'codex' ? record.provider : null,
      sessionId: typeof ackSession === 'string' && ackSession ? ackSession : null,
      auditEntryUuid: typeof ackEntry === 'string' ? ackEntry : '',
      auditSourceIdentity: typeof ackSource === 'string' ? ackSource : '' }) });
  const result = await withConsumer(model, view, options, context => context.confirmedReceipt(input));
  held.check(); return result;
}
