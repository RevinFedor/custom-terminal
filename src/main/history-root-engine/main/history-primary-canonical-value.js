'use strict';

// Selected, frozen values for the canonical consumers. This is NOT a
// generic DTO decoder: text remains UTF16 pages, property/prototype walks and
// coercion yield every 64 work units, and suspended array joins live in the
// existing quota-controlled store. An independent text pin owns the result.
const { HistoryPagedCursor, historyPagedCursorAddress } = require('./history-paged-store');
const { createJsonNumber } = require('./history-json-number');
const { normalizePrimaryPromptIdentity } = require('./history-primary-prompt-normalize');
const ENCODING = 'history-canonical-consumer-text-v1';
const FIELDS = ['role', 'content', 'recordByteOffset', 'sourceIdentity', 'sourceIdentityAliases', 'sourceUuidAliases', 'semanticTags', 'liveProjection', 'promptChips', 'imagePaths', 'uuid', 'sessionId', 'timestamp'];
const NONE = Object.freeze({ type: 'undefined' });
const vector = () => ({ page: 0, depth: 0, length: 0 });
const fail = code => Object.assign(new Error(code), { code });
const tick = () => new Promise(resolve => setImmediate(resolve));
const sameIndex = (a, b) => (a?.page || 0) === (b?.page || 0)
  && (a?.depth || 0) === (b?.depth || 0) && (a?.length || 0) === (b?.length || 0);
const sameNode = (a, b) => a.ref.type === 'page' && b.ref.type === 'page' && a.ref.id === b.ref.id
  && sameIndex(a.owners, b.owners) && sameIndex(a.imported, b.imported);

function selectedValues(store, current, control, metrics) {
  let work = 0;
  const step = async () => {
    current();
    if (++work % 64 === 0) {
      metrics.canonicalValueCheckpoints = (metrics.canonicalValueCheckpoints || 0) + 1;
      if (control?.checkpoint) await control.checkpoint(); else await tick();
      current();
    }
  };
  const address = value => historyPagedCursorAddress(value);
  const child = (node, ref) => address(new HistoryPagedCursor(store, ref, current, node.owners, node.imported));
  const raw = node => node.ref.type === 'page' && store.json(node.ref.id).kind === 'scalar-root'
    ? store.json(node.ref.id).value : node.ref;
  const kind = node => {
    const ref = raw(node);
    if (ref.type === 'page') return store.json(ref.id).kind === 'text' ? 'string' : store.json(ref.id).kind;
    return ref.type === 'scalar' ? ref.value === null ? 'null' : typeof ref.value : ref.type;
  };
  const truth = node => {
    const type = kind(node), ref = raw(node);
    if (type === 'undefined' || type === 'null') return false;
    if (type === 'boolean') return ref.value;
    if (type === 'number') return !!Number(ref.value);
    if (type === 'bigint') return ref.value !== '0';
    if (type === 'string') return store.json(ref.id).totalChars > 0;
    return true;
  };
  const undefinedNode = node => ({ ...node, ref: NONE });
  // Own fields shadow intrinsics even when undefined/non-callable. Source
  // functions/symbols are already represented as undefined by the store; the
  // only callable methods in its frozen data graph are these intrinsics.
  async function property(node, key) {
    let at = node;
    for (;;) {
      await step();
      const type = kind(at);
      if (!['object', 'array', 'map', 'set'].includes(type)) return { node: undefinedNode(at) };
      const meta = store.json(at.ref.id);
      if (type === 'array' && key === 'length') return { node: { ...at, ref: { type: 'number', value: String(meta.length) } } };
      const index = /^(0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff ? Number(key) : -1;
      if (type === 'array' && index >= 0 && index < meta.length) {
        const page = store.vectorGet(meta.items, index);
        if (page) return { node: child(at, store.json(page).value) };
      }
      for (let ordinal = 0; ordinal < (meta.fields?.length || 0); ordinal++) {
        await step();
        const field = store.json(store.vectorGet(meta.fields, ordinal));
        if (!field.deleted && store.textEqualsString(field.key, key)) return { node: child(at, field.value) };
      }
      if (meta.nullPrototype) return { node: undefinedNode(at) };
      if (meta.prototype) { at = child(at, meta.prototype); continue; }
      if (key === 'toString') return { intrinsic: type === 'array' ? 'array-string' : 'object-string' };
      if (key === 'valueOf') return { intrinsic: 'object-value' };
      if (key === 'join' && type === 'array') return { intrinsic: 'array-join' };
      if (key === 'map' && type === 'array') return { intrinsic: 'array-map' };
      if (key === 'some' && type === 'array') return { intrinsic: 'array-some' };
      if (key === 'constructor') return { intrinsic: 'constructor' };
      return { node: undefinedNode(at) };
    }
  }
  async function objectTag(node) {
    let at = node;
    for (;;) {
      await step();
      const meta = store.json(at.ref.id);
      if (meta.prototype) { at = child(at, meta.prototype); continue; }
      // Map/Set tags are inherited Symbol.toStringTag constants. A custom/null
      // prototype can remove them; ordinary arrays retain their builtin tag.
      const tag = !meta.nullPrototype && ['map', 'set'].includes(meta.kind)
        ? meta.kind === 'map' ? 'Map' : 'Set' : kind(node) === 'array' ? 'Array' : 'Object';
      return '[object ' + tag + ']';
    }
  }
  async function write(pieces) {
    const writer = store.leafWriter();
    for await (const part of pieces) {
      for (let at = 0; at < part.length; at += 128) {
        await step(); store.transaction(() => writer.write(part.slice(at, at + 128)));
      }
    }
    await step(); return store.transaction(() => writer.finish());
  }
  const literal = value => write([value]);
  async function* pieces(ref, from = 0, to = store.json(ref.id).totalChars) {
    for (let at = from; at < to; at += 128) {
      await step();
      for (const part of store.leafRange(ref, at, Math.min(128, to - at))) yield part;
    }
  }
  const reader = ref => {
    const length = store.json(ref.id).totalChars; let start = -1, window = '';
    return { length, at(index) {
      if (index < 0 || index >= length) return undefined;
      if (index < start || index >= start + window.length) {
        start = Math.floor(index / 128) * 128; window = '';
        for (const part of store.leafRange(ref, start, Math.min(128, length - start))) window += part;
      }
      return window[index - start];
    } };
  };
  async function numeric(ref) {
    const r = reader(ref); let start = 0, end = r.length;
    while (start < end && /\s/u.test(r.at(start))) { start++; await step(); }
    while (end > start && /\s/u.test(r.at(end - 1))) { end--; await step(); }
    if (start === end) return 0;
    let at = start, negative = false, signed = false;
    if (r.at(at) === '+' || r.at(at) === '-') { signed = true; negative = r.at(at++) === '-'; }
    if (end - at === 8) {
      let word = ''; for (let index = at; index < end; index++) word += r.at(index);
      if (word === 'Infinity') return negative ? -Infinity : Infinity;
    }
    if (!signed && r.at(at) === '0' && /[xXoObB]/.test(r.at(at + 1) || '')) {
      const base = r.at(at + 1).toLowerCase(), width = base === 'x' ? 4 : base === 'o' ? 3 : 1, radix = 1 << width;
      at += 2; if (at === end) return NaN;
      let head = 0n, bits = 0, sticky = false;
      for (; at < end; at++) {
        await step(); const code = r.at(at).charCodeAt(0);
        const digit = code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55
          : code >= 97 && code <= 102 ? code - 87 : -1;
        if (digit < 0 || digit >= radix) return NaN;
        for (let shift = width - 1; shift >= 0; shift--) {
          const bit = digit >> shift & 1;
          if (!bits && !bit) continue;
          if (++bits <= 54) head = head * 2n + BigInt(bit); else if (bit) sticky = true;
        }
      }
      if (bits <= 53) return Number(head);
      let rounded = head >> 1n;
      if ((head & 1n) && (sticky || (rounded & 1n))) rounded++;
      return bits > 1024 ? Infinity : Number(rounded) * 2 ** (bits - 53);
    }
    const value = createJsonNumber(); if (negative) value.write('-');
    const integer = at;
    while (at < end && /[0-9]/.test(r.at(at))) { value.write(r.at(at++)); await step(); }
    const integerDigits = at - integer; let fractionDigits = 0;
    if (r.at(at) === '.') {
      if (!integerDigits) value.write('0'); value.write('.'); at++;
      const fraction = at;
      while (at < end && /[0-9]/.test(r.at(at))) { value.write(r.at(at++)); await step(); }
      fractionDigits = at - fraction;
    }
    if (!integerDigits && !fractionDigits) return NaN;
    if (r.at(at) === 'e' || r.at(at) === 'E') {
      value.write('e'); at++;
      if (r.at(at) === '+' || r.at(at) === '-') value.write(r.at(at++));
      const exponent = at;
      while (at < end && /[0-9]/.test(r.at(at))) { value.write(r.at(at++)); await step(); }
      if (at === exponent) return NaN;
    }
    return at === end ? value.finish() : NaN;
  }
  const save = frame => store.transaction(() => store.put(frame, [frame.parent, frame.parts?.page || 0,
    frame.node.ref.type === 'page' ? frame.node.ref.id : 0, frame.node.owners?.page || 0, frame.node.imported?.page || 0]));
  async function primitiveText(node, mode = 'string', falsy = false) {
    let frame = { node, mode, falsy, parent: 0, phase: 'start', depth: 1 }, result;
    for (;;) {
      await step();
      metrics.canonicalValueResidentFrames = Math.max(metrics.canonicalValueResidentFrames || 0, 2);
      metrics.canonicalValueDepth = Math.max(metrics.canonicalValueDepth || 0, frame.depth);
      if (frame.phase === 'start') {
        const type = kind(frame.node), ref = raw(frame.node);
        result = undefined;
        if (frame.falsy && !truth(frame.node)) result = { text: await literal('') };
        else if (type === 'string') result = frame.mode === 'string' ? { text: ref } : { number: await numeric(ref) };
        else if (['undefined', 'null', 'boolean', 'number', 'bigint'].includes(type)) {
          if (frame.mode !== 'string') {
            if (type === 'bigint' && frame.mode === 'length') throw new TypeError('Cannot convert a BigInt value to a number');
            const number = type === 'bigint' ? await numeric(await literal(ref.value))
              : type === 'undefined' ? NaN : type === 'null' ? 0 : type === 'boolean' ? Number(ref.value) : Number(ref.value);
            result = { number };
          } else result = { text: await literal(type === 'undefined' ? 'undefined' : type === 'null' ? 'null'
            : type === 'number' ? String(Number(ref.value)) : String(ref.value)) };
        } else {
          // Object.valueOf always returns the receiver in this data graph;
          // both hints therefore reach the same callable toString or throw.
          const method = await property(frame.node, 'toString');
          if (!method.intrinsic) throw new TypeError('Cannot convert object to primitive value');
          if (method.intrinsic === 'object-string') result = { text: await literal(await objectTag(frame.node)) };
          else {
            const join = await property(frame.node, 'join');
            if (join.intrinsic !== 'array-join') result = { text: await literal(await objectTag(frame.node)) };
            else {
              let cyclic = false;
              for (let at = frame.parent; at;) {
                await step(); const ancestor = store.json(at);
                if (sameNode(frame.node, ancestor.node)) {
                  if (ancestor.phase === 'join-result') cyclic = true;
                  else if (ancestor.phase === 'length-result') throw new RangeError('Maximum call stack size exceeded');
                }
                at = ancestor.parent;
              }
              if (cyclic) result = { text: await literal('') };
              else {
                const length = await property(frame.node, 'length');
                frame.phase = 'length-result';
                const parent = save(frame);
                frame = { node: length.node, mode: 'length', falsy: false, parent, phase: 'start', depth: frame.depth + 1 };
                continue;
              }
            }
          }
          if (result?.text && frame.mode !== 'string') result = { number: await numeric(result.text) };
        }
      } else if (frame.phase === 'join') {
        if (frame.index < frame.length) {
          const item = await property(frame.node, String(frame.index++));
          const type = kind(item.node);
          if (type === 'null' || type === 'undefined') continue;
          frame.phase = 'join-result'; const parent = save(frame);
          frame = { node: item.node, mode: 'string', falsy: false, parent, phase: 'start', depth: frame.depth + 1 };
          continue;
        }
        const completed = frame;
        const text = await write((async function* () {
          let next = 0;
          for (const at of store.vectorValues(completed.parts)) {
            await step(); const part = store.json(at);
            const commas = part.index - next;
            for (let remaining = commas; remaining > 0; remaining -= 128) { await step(); yield ','.repeat(Math.min(128, remaining)); }
            yield* pieces(part.ref); next = part.index;
          }
          for (let remaining = Math.max(0, completed.length - 1 - next); remaining > 0; remaining -= 128) {
            await step(); yield ','.repeat(Math.min(128, remaining));
          }
        })());
        result = frame.mode === 'string' ? { text } : { number: await numeric(text) };
      } else throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_STATE');
      if (!frame.parent) return result;
      frame = store.json(frame.parent);
      if (frame.phase === 'length-result') {
        const length = result.number;
        frame.length = Number.isNaN(length) || length <= 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, Math.floor(length));
        frame.index = 0; frame.parts = vector(); frame.phase = 'join';
      } else if (frame.phase === 'join-result') {
        const part = store.transaction(() => store.put({ index: frame.index - 1, ref: result.text }, [result.text.id]));
        frame.parts = store.transaction(() => store.vectorSet(frame.parts, frame.parts.length, part));
        frame.phase = 'join';
      } else throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_STATE');
    }
  }
  async function starts(ref, prefix) {
    if (store.json(ref.id).totalChars < prefix.length) return false;
    let value = ''; for await (const part of pieces(ref, 0, prefix.length)) value += part;
    return value === prefix;
  }
  async function exact(node, value) {
    return kind(node) === 'string' && store.json(raw(node).id).totalChars === value.length && await starts(raw(node), value);
  }
  async function find(ref, needle, from) {
    let tail = '', offset = from;
    for await (const part of pieces(ref, from)) {
      const joined = tail + part, at = joined.indexOf(needle);
      if (at >= 0) return offset - tail.length + at;
      tail = joined.slice(Math.max(0, joined.length - needle.length + 1)); offset += part.length;
    }
    return -1;
  }
  async function replace(ref, needle) {
    return write((async function* () {
      let tail = '';
      for await (const part of pieces(ref)) {
        const joined = tail + part; let at = 0, match;
        while ((match = joined.indexOf(needle, at)) >= 0) {
          await step(); if (match > at) yield joined.slice(at, match); at = match + needle.length;
        }
        const safe = Math.max(at, joined.length - needle.length + 1);
        if (safe > at) yield joined.slice(at, safe); tail = joined.slice(safe);
      }
      if (tail) yield tail;
    })());
  }
  async function queue(node) {
    if (!await exact((await property(node, 'role')).node, 'queued')) return literal('');
    const uuid = (await primitiveText((await property(node, 'uuid')).node, 'string', true)).text;
    if (await starts(uuid, 'local-prompt-')) return literal('');
    const source = (await primitiveText((await property(node, 'sourceIdentity')).node, 'string', true)).text;
    if (await starts(source, 'claude-queue:')) return source;
    const session = (await primitiveText((await property(node, 'sessionId')).node, 'string', true)).text;
    const timestamp = (await primitiveText((await property(node, 'timestamp')).node, 'string', true)).text;
    const content = (await property(node, 'content')).node;
    const selectedText = async item => {
      if (kind(item) === 'string') return raw(item);
      if (!['object', 'map', 'set'].includes(kind(item))) return null;
      const value = (await property(item, 'text')).node;
      return kind(value) === 'string' ? raw(value) : null;
    };
    let extracted;
    if (kind(content) !== 'array') extracted = await selectedText(content) || await literal('');
    else {
      // extractText calls the actual Array#map before filter/join. An own
      // non-callable method, or a primitive constructor other than undefined,
      // must retain the native refusal, even when timestamp is empty. The
      // frozen data graph has no callable user functions or Symbol.species.
      const map = await property(content, 'map');
      if (map.intrinsic !== 'array-map') throw new TypeError('value.map is not a function');
      const constructor = await property(content, 'constructor');
      if (!constructor.intrinsic && !['undefined', 'object', 'array', 'map', 'set'].includes(kind(constructor.node))) {
        throw new TypeError('object.constructor[Symbol.species] is not a constructor');
      }
      extracted = await write((async function* () {
      const length = store.json(content.ref.id).length; let any = false;
      for (let index = 0; index < length; index++) {
        await step(); const item = (await property(content, String(index))).node;
        if (kind(item) !== 'string' && (!['object', 'map', 'set'].includes(kind(item))
          || !await exact((await property(item, 'type')).node, 'text'))) continue;
        const text = await selectedText(item);
        if (!text || !store.json(text.id).totalChars) continue;
        if (any) yield '\n'; any = true; yield* pieces(text);
      }
      })());
    }
    const removed = await write((async function* () {
      let from = 0;
      for (;;) {
        const start = await find(extracted, '<system-reminder>', from); if (start < 0) break;
        const end = await find(extracted, '</system-reminder>', start + 17); if (end < 0) break;
        yield* pieces(extracted, from, start); from = end + 18;
      }
      yield* pieces(extracted, from);
    })());
    const clean = await replace(await replace(removed, '[200~'), '~]');
    let hash = 0x811c9dc5, nonempty = false, space = false;
    const add = unit => { hash ^= unit; hash = Math.imul(hash, 0x01000193) >>> 0; };
    for await (const chunk of pieces(clean)) for (let index = 0; index < chunk.length; index++) {
      if (/\s/u.test(chunk[index])) { if (nonempty) space = true; continue; }
      if (space) add(32); space = false; nonempty = true; add(chunk.charCodeAt(index));
    }
    if (!nonempty || !store.json(timestamp.id).totalChars) return literal('');
    return write((async function* () {
      yield 'claude-queue:'; yield* pieces(session); yield ':'; yield* pieces(timestamp);
      yield ':'; yield hash.toString(16).padStart(8, '0');
    })());
  }
  // These two fixed projections are the actual codexSettingFact predicate,
  // not a general nested-field decoder. Preserve strict primitive types and
  // full value bytes. Invalid/non-Codex facts produce the explicit empty
  // result; they do not participate in last-write settings reconciliation.
  async function liveSetting(node, select) {
    if (!await exact((await property(node, 'role')).node, 'slash')) return literal('');
    const fact = (await property(node, 'settingsFact')).node;
    const version = (await property(fact, 'version')).node;
    if (kind(version) !== 'number' || Number(raw(version).value) !== 1
      || !await exact((await property(fact, 'provider')).node, 'codex')) return literal('');
    const settingKind = (await property(fact, 'kind')).node;
    if (!await exact(settingKind, 'model') && !await exact(settingKind, 'effort')) return literal('');
    const value = (await property(fact, 'value')).node;
    if (kind(value) !== 'string' || !store.json(raw(value).id).totalChars) return literal('');
    await step();
    return raw(select === 'kind' ? settingKind : value);
  }
  // One matched row's identity projection. The selected graph is an explicit
  // native consumer sink; it is never a canonical N inventory or a row body
  // decoder. Encode directly from paged references so cycles, prototypes,
  // sparse arrays and cross-property aliases survive the signed text wire.
  async function selectedIdentity(node) {
    const nodes = [null], seen = new Map();
    const keyOf = value => JSON.stringify([value.ref, value.owners, value.imported]);
    // Back-references to the original row resolve this scoped identity
    // projection. Unselected row content/actions/timestamp are never encoded.
    seen.set(keyOf(node), 0);
    const fields = [];
    for (const name of ['uuid', 'sessionId', 'sourceIdentity', 'sourceIdentityAliases', 'sourceUuidAliases'])
      fields.push([name, (await property(node, name)).node]);
    const flags = [];
    for (const name of ['promptChips', 'imagePaths']) {
      const value = (await property(node, name)).node;
      const present = kind(value) === 'string' ? store.json(raw(value).id).totalChars > 0
        : truth((await property(value, 'length')).node);
      flags.push([name === 'promptChips' ? 'hasPromptChips' : 'hasImagePaths', present]);
    }
    const quote = async function* (value) {
      yield '"';
      for await (const part of pieces(value)) yield JSON.stringify(part).slice(1, -1);
      yield '"';
    };
    const quoted = async function* (value) {
      // Metadata strings (e.g. BigInt digits) can themselves be long. The
      // codec never gives JSON.stringify more than 128 UTF16 code units.
      yield '"';
      for (let at = 0; at < value.length; at += 128) {
        await step(); yield JSON.stringify(value.slice(at, at + 128)).slice(1, -1);
      }
      yield '"';
    };
    const value = async function* (item) {
      await step(); const type = kind(item), ref = raw(item);
      if (type === 'undefined' || type === 'null') { yield '["' + type + '"]'; return; }
      if (type === 'boolean') { yield '["boolean",' + String(ref.value) + ']'; return; }
      if (type === 'number' || type === 'bigint') {
        yield '["' + type + '",';
        const number = type === 'number' ? Number(ref.value) : 0;
        yield* quoted(type === 'bigint' ? ref.value : Object.is(number, -0) ? '-0' : String(number));
        yield ']'; return;
      }
      if (type === 'string') { yield '["string",'; yield* quote(ref); yield ']'; return; }
      const key = keyOf(item);
      if (!seen.has(key)) {
        seen.set(key, nodes.length); nodes.push(item);
        metrics.canonicalSelectedIdentityGraphNodes = Math.max(metrics.canonicalSelectedIdentityGraphNodes || 0, nodes.length);
      }
      yield '["ref",' + seen.get(key) + ']';
    };
    return write((async function* () {
      yield '{"version":"primary-prompt-selected-identity-v1","root":0,"nodes":[';
      yield '{"kind":"object","identity":'; yield* quoted(keyOf(node));
      yield ',"prototype":["default"],"properties":[';
      let first = true;
      for (const [name, item] of fields) {
        if (!first) yield ','; first = false;
        yield '[' + JSON.stringify(name) + ','; yield* value(item); yield ']';
      }
      for (const [name, present] of flags) yield ',[' + JSON.stringify(name) + ',["boolean",' + present + ']]';
      yield ']}';
      for (let id = 1; id < nodes.length; id++) {
        await step(); const item = nodes[id], meta = store.json(item.ref.id);
        if (!['object', 'array', 'map', 'set'].includes(meta.kind)) throw fail('HISTORY_PRIMARY_SELECTED_IDENTITY_GRAPH');
        yield ',{"kind":' + JSON.stringify(meta.kind) + ',"identity":'; yield* quoted(keyOf(item)); yield ',"prototype":';
        if (meta.prototype) yield* value(child(item, meta.prototype));
        else yield meta.nullPrototype ? '["null"]' : '["default"]';
        if (meta.kind === 'array') yield ',"length":' + meta.length;
        yield ',"properties":['; let any = false;
        if (meta.kind === 'array') for (const present of store.vectorPresent(meta.items)) {
          await step(); if (present.ordinal >= meta.length) continue;
          if (any) yield ','; any = true;
          yield '[' + JSON.stringify(String(present.ordinal)) + ',';
          yield* value(child(item, store.json(present.page).value)); yield ']';
        }
        for (let ordinal = 0; ordinal < (meta.fields?.length || 0); ordinal++) {
          await step(); const field = store.json(store.vectorGet(meta.fields, ordinal));
          if (field.deleted) continue;
          if (any) yield ','; any = true;
          yield '['; yield* quote(field.key); yield ','; yield* value(child(item, field.value)); yield ']';
        }
        yield ']';
        if (meta.kind === 'map' || meta.kind === 'set') {
          yield ',"entries":['; any = false;
          const cursor = new HistoryPagedCursor(store, item.ref, current, item.owners, item.imported);
          for (const [mapKey, mapValue] of cursor.pairs()) {
            await step(); if (any) yield ','; any = true;
            if (meta.kind === 'map') yield '[';
            yield* value(address(mapKey));
            if (meta.kind === 'map') { yield ','; yield* value(address(mapValue)); yield ']'; }
          }
          yield ']';
        }
        yield '}';
      }
      yield ']}';
    })());
  }

  const promptIdentity = async node => normalizePrimaryPromptIdentity({
    ref: (await primitiveText(node, 'string', true)).text, store, reader, pieces, write, step, find, replace,
  });
  const arraySomeCheck = async node => {
    if (kind(node) !== 'array' || (await property(node, 'some')).intrinsic !== 'array-some')
      throw new TypeError('value.some is not a function');
    return literal('true');
  };
  const graphIdentity = node => ['object', 'array', 'map', 'set'].includes(kind(node))
    ? literal(JSON.stringify([node.ref, node.owners, node.imported])) : literal('');
  return { kind, truth, property, child, primitiveText, literal, queue, liveSetting, promptIdentity, selectedIdentity, graphIdentity, arraySomeCheck, step };
}

async function forkPrimaryCanonicalConsumerValue(plane, request, { consumerKey, control } = {}) {
  plane.assertCapacity(); control?.assertCurrent();
  const keys = ['leaseId', 'ownerKey', 'revision', 'generation', 'nodeToken', 'encoding', 'operation', 'field', 'index', 'memberField',
    '_historyRootConsumerKey', 'readDemandId', 'diagnosticReadId', 'diagnosticActionId'];
  if (!request || Object.keys(request).some(key => !keys.includes(key)) || request.encoding !== ENCODING
    || !['string-falsy', 'number', 'queue-identity', 'kind', 'array-length',
      'truthy', 'live-setting-kind', 'live-setting-value', 'prompt-identity', 'prompt-selected-identity', 'graph-identity', 'array-some-check'].includes(request.operation)
    || request.field !== undefined && !FIELDS.includes(request.field)
    || request.index !== undefined && (!Number.isSafeInteger(request.index) || request.index < 0)
    || request.memberField !== undefined && (request.field !== 'semanticTags' || request.index === undefined
      || !['kind', 'runId', 'phase'].includes(request.memberField))
    || Buffer.byteLength(JSON.stringify(request)) > 65536) throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_QUERY');
  const parent = plane.state(request, consumerKey);
  if (!parent.primaryPresentation?.semanticSnapshotComplete) throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_PRIMARY');
  let node = historyPagedCursorAddress(plane.cursor(parent, request.nodeToken));
  const current = () => { control?.assertCurrent(); if (plane.state(request, consumerKey) !== parent) throw fail('HISTORY_ROOT_OWNER_MISMATCH'); };
  let lease, installed, transferred = false, primary, endBuild, released = false;
  const release = () => { if (!released) { released = true; lease?.release(); } };
  plane.opening++;
  try {
    endBuild = plane.store.beginBuild();
    const values = selectedValues(plane.store, current, control, plane.metrics);
    if (['queue-identity', 'live-setting-kind', 'live-setting-value', 'prompt-selected-identity'].includes(request.operation)
      && (values.kind(node) !== 'object' || request.field !== undefined || request.index !== undefined))
      throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_QUERY');
    if (request.field !== undefined) {
      if (values.kind(node) !== 'object') throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_QUERY');
      node = (await values.property(node, request.field)).node; current();
    }
    if (request.index !== undefined) {
      if (values.kind(node) !== 'array') throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_QUERY');
      node = (await values.property(node, String(request.index))).node; current();
    }
    if (request.memberField !== undefined) {
      node = (await values.property(node, request.memberField)).node; current();
    }
    let ref;
    if (request.operation === 'array-some-check') ref = await values.arraySomeCheck(node);
    else if (request.operation === 'graph-identity') ref = await values.graphIdentity(node);
    else if (request.operation === 'prompt-selected-identity') ref = await values.selectedIdentity(node);
    else if (request.operation === 'prompt-identity') ref = await values.promptIdentity(node);
    else if (request.operation === 'kind') ref = await values.literal(values.kind(node));
    else if (request.operation === 'truthy') ref = await values.literal(String(values.truth(node)));
    else if (request.operation === 'array-length') {
      if (values.kind(node) !== 'array') throw fail('HISTORY_PRIMARY_CANONICAL_VALUE_QUERY');
      ref = await values.literal(String(plane.store.json(node.ref.id).length));
    }
    else if (request.operation === 'queue-identity') ref = await values.queue(node);
    else if (request.operation === 'live-setting-kind' || request.operation === 'live-setting-value')
      ref = await values.liveSetting(node, request.operation === 'live-setting-kind' ? 'kind' : 'value');
    else {
      const result = await values.primitiveText(node, request.operation === 'number' ? 'number' : 'string', request.operation === 'string-falsy');
      ref = result.text || await values.literal(Object.is(result.number, -0) ? '-0' : String(result.number));
    }
    current(); plane.store.transaction(() => { lease = plane.store.lease(ref); });
    installed = plane.install({ root: lease }, lease.cursor(), { consumerKey, ownerKey: parent.ownerKey,
      revision: parent.revision, source: parent.source, release });
    const response = { success: true, __notedHistoryTransport: 'root-v1', ...plane.identity(installed.state),
      payloadDocument: installed.descriptor, totalChars: installed.descriptor.length, encoding: ENCODING, operation: request.operation };
    if (Buffer.byteLength(JSON.stringify(response)) > 65536) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL');
    current(); plane.state(response, consumerKey);
    const finish = endBuild; endBuild = null; finish(); transferred = true; return response;
  } catch (error) { primary = error; throw error; }
  finally {
    let secondary;
    try { if (!transferred) { if (installed) plane.drop(installed.state); else release(); } } catch (error) { secondary = error; }
    try { endBuild?.(); } catch (error) { secondary ||= error; } finally { plane.opening--; }
    if (secondary) { if (!primary) throw secondary; plane.metrics.cleanupErrors = (plane.metrics.cleanupErrors || 0) + 1; }
  }
}

module.exports = { forkPrimaryCanonicalConsumerValue, HISTORY_PRIMARY_CANONICAL_VALUE_ENCODING: ENCODING };
