import { historyLivePresentationIdentities } from './historyLiveProjection.mjs';

const fail = code => Object.assign(new Error(code), { code });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const mapPrototype = Map.prototype, mapHas = Map.prototype.has, mapGet = Map.prototype.get;
const mapEntries = Map.prototype.entries, mapValues = Map.prototype.values, mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next;
const mapSet = Map.prototype.set, mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const setPrototype = Set.prototype, setHas = Set.prototype.has, setValues = Set.prototype.values;
const setAdd = Set.prototype.add, setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next;
const MainFactsMap = Map, MainFactsSet = Set;
const collectionProbe = Symbol('catalog-collection-brand');
const mainFactsMaps = new WeakSet(), mainFactsSets = new WeakSet();
const mainFactRecords = new WeakSet(), objectPrototype = Object.prototype;
const scalarFactFields = ['provider', 'toolUseId', 'agentId', 'agentSessionId', 'sessionId', 'generation',
  'startedAt', 'completedAt', 'status', 'taskId', 'kind', 'label', 'command', 'acceptance', 'entryUuid'];
const scalar = value => value === null || typeof value !== 'object' && typeof value !== 'function';
// Private C snapshots also use captured iterator intrinsics. A later change
// to a public iterator prototype cannot turn a no-getter proof into user code.
function everyIntrinsicMapEntry(collection, predicate) {
  const iterator = Reflect.apply(mapEntries, collection, []);
  while (true) {
    const step = Reflect.apply(mapIteratorNext, iterator, []);
    if (step.done) return true;
    if (!predicate(step.value[0], step.value[1])) return false;
  }
}
function authenticatedFactRecord(value, allowUnfilteredIdentity = false) {
  if (!value || !mainFactRecords.has(value) || Object.getPrototypeOf(value) !== objectPrototype) return false;
  for (const field of [...scalarFactFields, 'launchSettings']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor) {
      if (Object.getOwnPropertyDescriptor(objectPrototype, field)) return false;
    } else if (!own(descriptor, 'value') || field !== 'launchSettings'
      && !(allowUnfilteredIdentity && (field === 'sessionId' || field === 'generation'))
      && !scalar(descriptor.value)) return false;
  }
  return true;
}

// These constructors are the actual Panel's Main-facts boundary. The record
// constructor runs AT the existing Main-snapshot normalization; its result
// is the ORIGINAL normalized object held by state, collections and proofs.
// Field values (including launchSettings) are not cloned or frozen. Only
// collections and records created here can authorize a
// source-dependent intrinsic lookup without retaining its historical key.
// A structural ReadonlyMap, subclass, Proxy or custom getter is not that
// authority. This new catalog API never shipped before this repair; the old
// collectors keep their broader native API for legacy/composite callers.
export function createHistoryAgentCatalogMainFact(fields) {
  const record = { ...fields }; mainFactRecords.add(record);
  // Preserve the existing event normalizer's candidate shape. Exact owner
  // filtering happens at the original collection capture; only that Map
  // may authorize intrinsic reads of scalar session/generation identities.
  if (!authenticatedFactRecord(record, true)) throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
  return record;
}
export function createHistoryAgentCatalogMainFactsMap(entries) {
  const facts = new MainFactsMap(entries);
  for (const [key, value] of facts) {
    if (typeof key !== 'string' || !authenticatedFactRecord(value)) throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
  }
  mainFactsMaps.add(facts); return facts;
}
export function createHistoryAgentCatalogMainFactsSet(values) {
  const facts = new MainFactsSet(values);
  for (const key of facts) if (typeof key !== 'string') throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
  mainFactsSets.add(facts); return facts;
}
function authenticatedFacts(receiver, kind) {
  const map = kind === 'map-get', prototype = map ? mapPrototype : setPrototype;
  const method = map ? 'get' : 'has', intrinsic = map ? mapGet : setHas;
  try {
    if (!(map ? mainFactsMaps : mainFactsSets).has(receiver)) return false;
    // Internal-slot checks reject Proxy receivers without invoking native
    // property getters. Looking up receiver.get here would call it twice.
    Reflect.apply(map ? mapHas : setHas, receiver, [collectionProbe]);
    if (Object.getPrototypeOf(receiver) !== prototype) return false;
    const descriptor = Object.getOwnPropertyDescriptor(receiver, method)
      || Object.getOwnPropertyDescriptor(prototype, method);
    if (!descriptor || !own(descriptor, 'value') || descriptor.value !== intrinsic) return false;
    // Iteration is used by orphan-background folding and the original FULL
    // witness. Do not silently authenticate an overridden getter/iterator.
    const iterator = Object.getOwnPropertyDescriptor(receiver, Symbol.iterator)
      || Object.getOwnPropertyDescriptor(prototype, Symbol.iterator);
    // The preserved terminal Main-only collector enumerates values(). Its
    // equivalence to our paged intrinsic entry traversal is authority too.
    const values = map ? Object.getOwnPropertyDescriptor(receiver, 'values')
      || Object.getOwnPropertyDescriptor(prototype, 'values') : null;
    if (map && (!values || !own(values, 'value') || values.value !== mapValues)) return false;
    return !!iterator && own(iterator, 'value')
      && iterator.value === (map ? mapEntries : setValues);
  } catch { return false; }
}

// Node's actual native proxy test is the authority for this OPTIONAL read
// optimization. The primary renderer already obtains Node builtins through
// window.require for its ORIGINAL FULL witness. Capture lazily, because the
// renderer/runtime is initialized after module import. Missing authority is
// a replay fallback, never a structural guess or a rejected CURRENT input.
function nativeProxyAuthority() {
  try {
    const nodeUtil = globalThis.window?.require?.('node:util');
    const descriptor = nodeUtil?.types && Object.getOwnPropertyDescriptor(nodeUtil.types, 'isProxy');
    return descriptor && own(descriptor, 'value') && typeof descriptor.value === 'function' ? descriptor.value : null;
  } catch { return null; }
}
const settingRowFields = ['settingsFact', 'role'], settingFactFields = ['version', 'provider', 'kind', 'value'];
function ownDataDescriptors(value, fields) {
  const descriptors = [];
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !own(descriptor, 'value')) return null;
    descriptors.push(descriptor);
  }
  return descriptors;
}
function sameDataDescriptors(value, fields, before) {
  if (Object.getPrototypeOf(value) !== objectPrototype) return false;
  return fields.every((field, index) => {
    const old = before[index], now = Object.getOwnPropertyDescriptor(value, field);
    return !!now && own(now, 'value') && Object.is(old.value, now.value)
      && old.writable === now.writable && old.enumerable === now.enumerable && old.configurable === now.configurable;
  });
}
function sameOwnDataDescriptors(value, keys, descriptors) {
  const currentKeys = Reflect.ownKeys(value);
  return currentKeys.length === keys.length && currentKeys.every((key, index) => key === keys[index])
    && sameDataDescriptors(value, keys, descriptors);
}
function intrinsicSettingSnapshot(row, isProxy) {
  if (!isProxy || row === null || typeof row !== 'object' || isProxy(row)
    || Object.getPrototypeOf(row) !== objectPrototype) return null;
  const rowFields = ownDataDescriptors(row, settingRowFields);
  if (!rowFields || rowFields[1].value !== 'slash') return null;
  const fact = rowFields[0].value;
  if (!fact || typeof fact !== 'object' || isProxy(fact) || Object.getPrototypeOf(fact) !== objectPrototype) return null;
  const factFields = ownDataDescriptors(fact, settingFactFields);
  if (!factFields || factFields[0].value !== 1 || factFields[1].value !== 'codex'
    || !['model', 'effort'].includes(factFields[2].value)
    || typeof factFields[3].value !== 'string' || !factFields[3].value) return null;
  // UUID/identity and other row data are observed as well as the settings
  // payload. Certify the whole own-data surface once, in C-sized state;
  // otherwise interleaved native callbacks could mutate an omitted field.
  const rowKeys = Reflect.ownKeys(row), factKeys = Reflect.ownKeys(fact);
  const allRowFields = ownDataDescriptors(row, rowKeys), allFactFields = ownDataDescriptors(fact, factKeys);
  if (!allRowFields || !allFactFields) return null;
  return { row, fact, rowFields, factFields, rowKeys, factKeys, allRowFields, allFactFields };
}
function originalSetting(snapshot) {
  // Captured non-Proxy objects cannot turn into Proxies. Descriptor/prototype
  // replacement is observed without invoking the replacement getter/trap.
  return sameOwnDataDescriptors(snapshot.row, snapshot.rowKeys, snapshot.allRowFields)
    && sameOwnDataDescriptors(snapshot.fact, snapshot.factKeys, snapshot.allFactFields);
}

// Literal CURRENT structural operations from buildHistoryLivePresentation.
// They run on demand: an identity-only early return must not touch positions,
// deferred status, timestamps, Task payload or an unused native getter.
function setting(entry) {
  const fact = entry?.settingsFact;
  return entry?.role === 'slash' && fact?.version === 1 && fact.provider === 'codex'
    && (fact.kind === 'model' || fact.kind === 'effort') && typeof fact.value === 'string' && fact.value
    ? fact : null;
}
function physical(entry) {
  const sourceIdentity = String(entry?.sourceIdentity || '');
  const sessionId = String(entry?.sessionId || '');
  if (!sessionId) return null;
  const recordByteOffset = Number(entry?.recordByteOffset);
  if (Number.isSafeInteger(recordByteOffset) && recordByteOffset >= 0) return { sessionId, offset: recordByteOffset };
  if (!sourceIdentity.startsWith('codex-')) return null;
  const marker = '-source-' + sessionId + '-';
  const markerIndex = sourceIdentity.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const rawOffset = sourceIdentity.slice(markerIndex + marker.length);
  if (!/^\d+$/.test(rawOffset)) return null;
  const offset = Number(rawOffset);
  return Number.isSafeInteger(offset) ? { sessionId, offset } : null;
}
function deferred(entry) {
  return entry?.role === 'queued'
    && entry?.queueStatus !== 'failed' && entry?.queueStatus !== 'cancelled'
    && (entry?.queueStatus === 'application-queued' || entry?.queueStatus === 'queued'
      || (entry?.statusAtSend === 'busy' && entry?.queueStatus !== 'sent')
      || ((entry?.statusAtSend == null || entry?.statusAtSend === 'unknown')
        && ['preparing', 'sending', 'audit-pending', 'delivery-unknown'].includes(entry?.queueStatus)));
}
function taskActions(entry, isTaskAction, mark) {
  const hydratedTasks = Array.isArray(entry.actions) ? entry.actions.filter(isTaskAction) : [];
  const stubTasks = hydratedTasks.length === 0 ? (entry.actionSummary || [])
    .filter(summary => summary.toolName === 'Task' || summary.family === 'task')
    .map(summary => mark({ tool: 'Task', description: String(summary.description || 'Agent'),
      toolUseId: summary.toolUseId, subagentStatus: summary.subagentStatus,
      agentSessionId: summary.agentSessionId, agentId: summary.agentId, taskPrompt: summary.taskPrompt,
      startedAt: summary.startedAt, completedAt: summary.completedAt, durationMs: summary.durationMs,
      launchSettings: summary.launchSettings })) : [];
  return mark([...hydratedTasks, ...stubTasks]);
}
function defaultPrimitive(value) {
  if (value === null || typeof value !== 'object' && typeof value !== 'function') return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') throw new TypeError('Cannot convert object to primitive value');
    const result = Reflect.apply(exotic, value, ['default']);
    if (result === null || typeof result !== 'object' && typeof result !== 'function') return result;
    throw new TypeError('Cannot convert object to primitive value');
  }
  for (const key of ['valueOf', 'toString']) {
    const method = value[key];
    if (typeof method !== 'function') continue;
    const result = Reflect.apply(method, value, []);
    if (result === null || typeof result !== 'object' && typeof result !== 'function') return result;
  }
  throw new TypeError('Cannot convert object to primitive value');
}
// Native continuation arguments and encoded results are immutable wire data,
// not CURRENT objects. Equality here reads only own data descriptors and does
// not stringify/hash a payload, invoke coercion or touch native getters.
function sameWireFields(left, right, nested = false) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Reflect.ownKeys(left), other = Reflect.ownKeys(right);
  if (keys.length !== other.length) return false;
  for (const key of keys) {
    const a = Object.getOwnPropertyDescriptor(left, key), b = Object.getOwnPropertyDescriptor(right, key);
    if (!a || !b || !own(a, 'value') || !own(b, 'value')) return false;
    if (!Object.is(a.value, b.value) && (!nested || !sameWireFields(a.value, b.value))) return false;
  }
  return true;
}

/** Native side of ONE staged catalog demand. Slots contain only CURRENT
 * objects and results of operations on those objects. Historical records and
 * agent keys are never collected into a renderer registry here. */
export function createHistoryAgentCatalogCurrent({ recipe, context, isLocalPromptEntry, isTaskAction,
  historyAgentKey, owns = () => true, fingerprint } = {}) {
  if (!recipe || !context || typeof isLocalPromptEntry !== 'function' || typeof isTaskAction !== 'function'
    || typeof historyAgentKey !== 'function' || typeof fingerprint !== 'function') throw fail('HISTORY_AGENT_CATALOG_CURRENT');
  const facts = [
    [context.exactActiveSubagents, 'map-get'], [context.exactActiveBackgroundTasks, 'map-get'],
    [context.terminalBackgroundTaskCalls, 'set-has'], [context.terminalFacts, 'map-get'],
  ];
  const factsCurrent = () => facts.every(([value, kind]) => value == null || authenticatedFacts(value, kind));
  if (!factsCurrent()) throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
  // This is a C-sized snapshot of the actual Main facts already held by the
  // input, captured BEFORE any historical source is visited. It contains no
  // historical request keys. An unannounced same-object mutation cannot grow
  // an N-sized transcript by returning a fresh fact/value on each lookup.
  const factSnapshots = new Map(), collectionSnapshots = new Map();
  const factFields = [...scalarFactFields, 'launchSettings'];
  for (const [collection, kind] of facts) {
    if (collection == null || Reflect.apply(mapHas, collectionSnapshots, [collection])) continue;
    const map = kind === 'map-get', snapshot = map ? new MainFactsMap() : new MainFactsSet();
    const iterator = Reflect.apply(map ? mapEntries : setValues, collection, []);
    while (true) {
      const step = Reflect.apply(map ? mapIteratorNext : setIteratorNext, iterator, []);
      if (step.done) break;
      const key = map ? step.value[0] : step.value, value = map ? step.value[1] : undefined;
      if (typeof key !== 'string' || map && !authenticatedFactRecord(value)) throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
      Reflect.apply(map ? mapSet : setAdd, snapshot, map ? [key, value] : [key]);
      if (map && !Reflect.apply(mapHas, factSnapshots, [value])) Reflect.apply(mapSet, factSnapshots, [value,
        factFields.map(field => Object.getOwnPropertyDescriptor(value, field))]);
    }
    Reflect.apply(mapSet, collectionSnapshots, [collection, { kind, snapshot }]);
  }
  const originalCollection = (collection, { kind, snapshot }) => {
    const map = kind === 'map-get', size = map ? mapSize : setSize, entries = map ? mapEntries : setValues;
    if (Reflect.apply(size, collection, []) !== Reflect.apply(size, snapshot, [])) return false;
    const actual = Reflect.apply(entries, collection, []), expected = Reflect.apply(entries, snapshot, []);
    while (true) {
      const a = Reflect.apply(map ? mapIteratorNext : setIteratorNext, actual, []);
      const b = Reflect.apply(map ? mapIteratorNext : setIteratorNext, expected, []);
      if (a.done || b.done) return a.done === b.done;
      if (map ? !Object.is(a.value[0], b.value[0]) || !Object.is(a.value[1], b.value[1]) : !Object.is(a.value, b.value)) return false;
    }
  };
  const originalFact = value => {
    const before = Reflect.apply(mapGet, factSnapshots, [value]);
    if (!before || !authenticatedFactRecord(value)) return false;
    return factFields.every((field, index) => {
      const old = before[index], now = Object.getOwnPropertyDescriptor(value, field);
      return old === undefined ? now === undefined : !!now && own(now, 'value') && Object.is(old.value, now.value)
        && old.writable === now.writable && old.enumerable === now.enumerable && old.configurable === now.configurable;
    });
  };
  const factsProof = (verifyValues = false) => {
    if (!factsCurrent()) return false;
    if (verifyValues) {
      if (!everyIntrinsicMapEntry(collectionSnapshots, originalCollection)
        || !everyIntrinsicMapEntry(factSnapshots, originalFact)) return false;
    }
    return true;
  };
  const isProxy = nativeProxyAuthority(), settingSnapshots = new Map();
  const settingsProof = () => everyIntrinsicMapEntry(settingSnapshots, (row, snapshot) => originalSetting(snapshot));
  const intrinsicProof = (verifyValues = false) => factsProof(verifyValues) && (!verifyValues || settingsProof());
  const values = [], objects = new WeakMap(), primitives = new Map(), operations = [];
  const derivedValues = new WeakSet(), mapEntryIterators = new WeakMap(), iteratorNextMethods = new WeakMap();
  let driving = false, sealed = false, invalid = false;
  const check = signal => {
    if (invalid || signal?.aborted || !factsCurrent() || owns() !== true || signal?.aborted || !factsCurrent())
      throw fail('HISTORY_READ_CANCELLED');
  };
  const slot = value => {
    const object = value !== null && (typeof value === 'object' || typeof value === 'function');
    const index = object ? objects : primitives;
    if (index.has(value)) return index.get(value);
    const at = values.length; values.push(value); index.set(value, at); return at;
  };
  const ref = value => ({ type: 'native', slot: slot(value), valueType: typeof value,
    array: Array.isArray(value), truthy: !!value });
  const encode = (value, primitive = false) => {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null' };
    const type = typeof value;
    if (type === 'boolean') return { type, value };
    if (type === 'number') return { type, value: Object.is(value, -0) ? '-0' : Number.isNaN(value) ? 'NaN'
      : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value };
    if (type === 'bigint') return { type, value: String(value) };
    if (type === 'string' && primitive) return { type, value };
    return ref(value);
  };
  const readSlot = (at, pool = values) => {
    if (!Number.isSafeInteger(at) || at < 0 || !own(pool, at)) throw fail('HISTORY_AGENT_CATALOG_NATIVE_SLOT');
    return pool[at];
  };
  const literal = (value, pool) => {
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'native') return readSlot(value.slot, pool);
    if (value.type === 'undefined') return undefined;
    if (value.type === 'null') return null;
    if (value.type === 'bigint') return BigInt(value.value);
    if (value.type === 'number') return value.value === '-0' ? -0 : value.value === 'NaN' ? NaN
      : value.value === 'Infinity' ? Infinity : value.value === '-Infinity' ? -Infinity : value.value;
    if (value.type === 'boolean' || value.type === 'string') return value.value;
    throw fail('HISTORY_AGENT_CATALOG_NATIVE_VALUE');
  };
  const key = literal;
  const evaluate = (request, pool, derived = derivedValues, entryIterators = mapEntryIterators, nextMethods = iteratorNextMethods) => {
    const mark = value => { if (value !== null && (typeof value === 'object' || typeof value === 'function')) derived.add(value); return value; };
    switch (request.kind) {
      case 'identities': return mark(historyLivePresentationIdentities(readSlot(request.rowSlot, pool)));
      case 'physical': return mark(physical(readSlot(request.rowSlot, pool)));
      case 'deferred': return deferred(readSlot(request.rowSlot, pool));
      case 'setting': return setting(readSlot(request.rowSlot, pool));
      case 'setting-conflict-clone': return mark({ ...readSlot(request.rowSlot, pool), settingsProjectionError: request.conflict });
      case 'isLastUser': { const entry = readSlot(request.rowSlot, pool);
        return entry.role === 'user' && !isLocalPromptEntry(entry); }
      case 'task-actions': return taskActions(readSlot(request.rowSlot, pool), isTaskAction, mark);
      case 'agentKey': return historyAgentKey(readSlot(request.actionSlot, pool), readSlot(request.rowSlot, pool).uuid);
      case 'strict-equal': return readSlot(request.slot, pool) === literal(request.value, pool);
      case 'subtract': return readSlot(request.slot, pool) - request.right;
      case 'property': {
        const receiver = readSlot(request.slot, pool), field = key(request.key, pool);
        if (mainFactRecords.has(receiver)) {
          if (!factFields.includes(field)) throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
          if (!originalFact(receiver)) throw fail('HISTORY_READ_CANCELLED');
          const descriptor = Object.getOwnPropertyDescriptor(receiver, field);
          if (descriptor && (!own(descriptor, 'value') || field !== 'launchSettings' && !scalar(descriptor.value)))
            throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
        }
        return receiver[field];
      }
      case 'has': return key(request.key, pool) in readSlot(request.slot, pool);
      case 'coerce': { const value = readSlot(request.slot, pool);
        if (request.hint === 'string') return String(value);
        if (request.hint === 'number') return Number(value);
        if (request.hint === 'default') return defaultPrimitive(value);
        throw fail('HISTORY_AGENT_CATALOG_NATIVE_HINT'); }
      case 'date': return Date.parse(readSlot(request.slot, pool));
      case 'map-get': case 'set-has': {
        const receiver = readSlot(request.slot, pool);
        if (!facts.some(([value, kind]) => value === receiver && kind === request.kind)
          || !authenticatedFacts(receiver, request.kind)) throw fail('HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE');
        const argument = key(request.key, pool), method = request.kind === 'map-get' ? mapGet : setHas;
        const result = Reflect.apply(method, receiver, [argument]);
        const expected = Reflect.apply(method, Reflect.apply(mapGet, collectionSnapshots, [receiver]).snapshot, [argument]);
        if (!Object.is(result, expected)) throw fail('HISTORY_READ_CANCELLED');
        if (request.kind === 'map-get' && result !== undefined && !originalFact(result))
          throw fail('HISTORY_READ_CANCELLED');
        return result;
      }
      case 'iterator': {
        if (request.method !== undefined && request.method !== 'values') throw fail('HISTORY_AGENT_CATALOG_NATIVE_OPERATION');
        const source = readSlot(request.slot, pool), method = request.method === 'values' ? source.values : source[Symbol.iterator];
        const iterator = mark(Reflect.apply(method, source, []));
        // GetIterator captures [[NextMethod]] once. Resolving next afresh on
        // every continuation could change an already-started for-of loop.
        const next = iterator.next;
        if (typeof next !== 'function') throw fail('HISTORY_AGENT_NATIVE_ITERATOR');
        nextMethods.set(iterator, next);
        if (request.method !== 'values' && method === mapEntries) {
          try { Reflect.apply(mapHas, source, [collectionProbe]); entryIterators.set(iterator, mainFactsMaps.has(source)); } catch {}
        }
        return iterator;
      }
      case 'next': {
        const iterator = readSlot(request.slot, pool), method = nextMethods.has(iterator) ? nextMethods.get(iterator) : iterator.next;
        const result = mark(Reflect.apply(method, iterator, []));
        // Builtin Map iteration creates an entries-pair array. The task held
        // in that pair is still the ORIGINAL native object, not a derived
        // clone. Replaying next() must distinguish these two identities.
        if (entryIterators.has(iterator) && method === mapIteratorNext) {
          const pair = Object.getOwnPropertyDescriptor(result, 'value')?.value;
          if (Array.isArray(pair)) {
            if (entryIterators.get(iterator) && !originalFact(pair[1])) throw fail('HISTORY_READ_CANCELLED');
            mark(pair);
          }
        }
        return result;
      }
      default: throw fail('HISTORY_AGENT_CATALOG_NATIVE_OPERATION');
    }
  };
  const rowSlot = row => {
    if (!Reflect.apply(mapHas, settingSnapshots, [row])) {
      const snapshot = intrinsicSettingSnapshot(row, isProxy);
      if (snapshot) Reflect.apply(mapSet, settingSnapshots, [row, snapshot]);
    }
    return slot(row);
  };
  const wire = { replacements: (recipe.replacements || []).map(({ ordinal, row }) => ({ ordinal, rowSlot: rowSlot(row) })),
    exclusions: (recipe.exclusions || []).slice(), insertions: (recipe.insertions || []).map(rowSlot),
    ...(recipe.segments ? { segments: recipe.segments.map(segment => 'row' in segment
      ? { rowSlot: rowSlot(segment.row) } : { start: segment.start, end: segment.end }) } : {}),
    live: (recipe.live || []).map(rowSlot), context: {
      isTurnBusy: context.isTurnBusy, agentProcessAlive: context.agentProcessAlive,
      currentSessionId: context.currentSessionId, currentProcessGeneration: context.currentProcessGeneration,
      chipToolType: context.chipToolType,
      exactActiveSubagentsSlot: context.exactActiveSubagents == null ? null : slot(context.exactActiveSubagents),
      exactActiveBackgroundTasksSlot: context.exactActiveBackgroundTasks == null ? null : slot(context.exactActiveBackgroundTasks),
      terminalBackgroundTaskCallsSlot: context.terminalBackgroundTaskCalls == null ? null : slot(context.terminalBackgroundTaskCalls),
      terminalFactsSlot: context.terminalFacts == null ? null : slot(context.terminalFacts),
    } };
  const execute = (request, signal) => {
    check(signal);
    const intrinsicSetting = request.kind === 'setting' ? Reflect.apply(mapGet, settingSnapshots, [readSlot(request.rowSlot)]) : null;
    if (intrinsicSetting && !originalSetting(intrinsicSetting)) throw fail('HISTORY_READ_CANCELLED');
    const result = evaluate(request, values);
    check(signal);
    if (intrinsicSetting && !originalSetting(intrinsicSetting)) throw fail('HISTORY_READ_CANCELLED');
    const primitive = ['coerce', 'agentKey'].includes(request.kind);
    const encoded = encode(result, primitive);
    const native = encoded.type === 'native';
    const derived = native && result !== null && (typeof result === 'object' || typeof result === 'function')
      && derivedValues.has(result);
    // Authenticated intrinsic Main facts have no getter/coercion to replay.
    // The original FULL map/value witness is checked by the publication
    // owner after native replay, then the cheap original owner fence. That
    // exact product profile needs no per-historical-key replay transcript.
    const receiver = Number.isSafeInteger(request.slot) ? readSlot(request.slot) : null;
    const builtinLookup = (request.kind === 'map-get' || request.kind === 'set-has')
      && authenticatedFacts(receiver, request.kind);
    // Main records have an independent C-sized fixed-field proof, including
    // ABSENT optional fields. Recording every absent launchSettings read on
    // a repeated historical key would still create an N-sized transcript.
    const intrinsicFactRead = request.kind === 'property' && Reflect.apply(mapHas, factSnapshots, [receiver]);
    const primitiveCoercion = ['coerce', 'date', 'strict-equal', 'subtract'].includes(request.kind)
      && (receiver === null || typeof receiver !== 'object' && typeof receiver !== 'function');
    // Strict equality between an object and a primitive is ALWAYS false. It
    // invokes neither a getter nor coercion. Do not retain a historical
    // primitive argument just to replay this type-disjoint identity test.
    const disjointEquality = request.kind === 'strict-equal' && !scalar(receiver)
      && scalar(literal(request.value, values));
    // An ordinary own data property can still change between observations
    // when another CURRENT getter runs. Only the positively captured C-sized
    // settings profile supplies an original unchanged-value proof here.
    // General reads remain in the exact transcript, including repetitions.
    let intrinsicSettingFieldRead = false;
    if (request.kind === 'property' && typeof request.key === 'string') {
      everyIntrinsicMapEntry(settingSnapshots, (row, snapshot) => {
        if ((receiver === row && snapshot.rowKeys.includes(request.key))
          || (receiver === snapshot.fact && snapshot.factKeys.includes(request.key))) {
          if (!originalSetting(snapshot)) throw fail('HISTORY_READ_CANCELLED');
          intrinsicSettingFieldRead = true;
        }
        return true;
      });
    }
    if (!builtinLookup && !intrinsicFactRead && !intrinsicSetting
      && !primitiveCoercion && !disjointEquality && !intrinsicSettingFieldRead) {
      const previous = operations.at(-1);
      if (previous && previous.repetitions < Number.MAX_SAFE_INTEGER && previous.derived === derived
        && sameWireFields(previous.request, request, true) && sameWireFields(previous.encoded, encoded)) {
        previous.repetitions++;
      } else operations.push({ request: Object.freeze({ ...request }), encoded, derived, repetitions: 1 });
    }
    check(signal); return encoded;
  };
  const replay = () => {
    try {
      check();
      if (!intrinsicProof(true)) return false;
      const pool = values.slice(), derived = new WeakSet(), entryIterators = new WeakMap(), nextMethods = new WeakMap();
      for (const operation of operations) {
       // Compression changes storage only. Every original native observation
       // is replayed in order, with the original check after EACH invocation.
       for (let repetition = 0; repetition < operation.repetitions; repetition++) {
        const result = evaluate(operation.request, pool, derived, entryIterators, nextMethods);
        const encoded = operation.encoded;
        if (encoded.type === 'native') {
          if (typeof result !== encoded.valueType || Array.isArray(result) !== encoded.array || !!result !== encoded.truthy) return false;
          if (!operation.derived && !Object.is(result, values[encoded.slot])) return false;
          pool[encoded.slot] = result;
        } else {
          if (encoded.type === 'undefined' ? result !== undefined : encoded.type === 'null' ? result !== null
            : encoded.type === 'number' ? !Object.is(result, encoded.value === '-0' ? -0 : encoded.value === 'NaN' ? NaN
              : encoded.value === 'Infinity' ? Infinity : encoded.value === '-Infinity' ? -Infinity : encoded.value)
            : encoded.type === 'bigint' ? typeof result !== 'bigint' || String(result) !== encoded.value
            : typeof result !== encoded.type || result !== encoded.value) return false;
        }
        check();
        // A replayed native getter may mutate Main facts or another CURRENT
        // settings row. A later getter must not restore that state and hide
        // an intervening changed intrinsic observation. Check C original
        // entries/fixed descriptors only; never fingerprint a full payload.
        if (!intrinsicProof(true)) return false;
       }
      }
      check(); return intrinsicProof(true);
    } catch { return false; }
  };
  return Object.freeze({ wire, values,
    async drive(stage, { signal, owns: demandOwns = () => true } = {}) {
      if (driving || sealed) throw fail('HISTORY_AGENT_CATALOG_NATIVE_DRIVER_REUSED');
      driving = true;
      try {
        while (stage.header.phase !== 'ready') {
          check(signal);
          if (demandOwns() !== true) throw fail('HISTORY_READ_CANCELLED');
          const before = stage.header;
          const request = await stage.readValue(before.nativeRequest.arguments, { signal, owns: demandOwns });
          check(signal);
          if (stage.header !== before || demandOwns() !== true || request?.kind !== before.nativeRequest.kind)
            throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
          const encoded = execute(request, signal);
          await stage.advance(encoded, { signal, owns: demandOwns });
          check(signal);
          if (stage.header === before || stage.header.sequence !== before.sequence + 1 || demandOwns() !== true)
            throw fail('HISTORY_AGENT_CATALOG_SEQUENCE');
        }
        // Slot identity belongs to this completed allocation. Native values
        // remain the original mutable objects, but a replaying getter cannot
        // retarget the compiler-owned field-reference table after sealing.
        Object.freeze(values);
        sealed = true;
        if (!replay()) throw fail('HISTORY_READ_CANCELLED');
      } catch (error) { invalid = true; throw error; }
      finally { driving = false; }
    },
    isCurrent: replay,
    // Ordinary guards inspect four collection identities/methods only. A
    // final proof checks ORIGINAL C collection contents/order, Main fields,
    // and non-Proxy own-data settings descriptors. No historical keys enter
    // those snapshots, and no full CURRENT payload fingerprint runs here.
    // Other native getter/Proxy/inherited settings keep exact ordered replay.
    hasIntrinsicReadAuthority: intrinsicProof,
  });
}
