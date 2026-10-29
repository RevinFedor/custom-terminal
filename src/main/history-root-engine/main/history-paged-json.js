'use strict';

// Storage sink for the existing validating JSON parser, not a second parser.
// The rooted file producer uses this sink before a complete JSON line exists.
// Legacy selective projections retain their original DTO contracts.
const { ALL, createJsonProjection } = require('./codex-json-projection');

function createPagedJsonProjection(store, options = {}) {
  const releaseBuild = store.beginBuild();
  let current = null, parent = 0, length = 0;
  const frames = {
    get length() { return length; },
    at(index) {
      if (index !== -1) throw new Error('history_parser_stack_access');
      return current;
    },
    push(frame) {
      if (current) {
        // ALL has one recursive schema identity. No copy of a schema tree or
        // token body enters the persisted parser frame.
        const { schema, originalSchema, value, ...saved } = current;
        const valuePage = store.put(value, [value?.items?.page || 0, value?.fields?.page || 0, value?.numeric?.page || 0]);
        parent = store.put({ frame: saved, valuePage, parent }, [parent, current.key?.id || 0, valuePage]);
      }
      current = frame; length++;
    },
    pop() {
      const popped = current;
      if (parent) {
        const saved = store.json(parent);
        current = { ...saved.frame, value: store.json(saved.valuePage), schema: ALL, originalSchema: ALL };
        parent = saved.parent;
      } else current = null;
      length--;
      return popped;
    },
  };
  const sink = {
    container: kind => store.container(kind),
    append: (parent, value) => store.append(parent, value),
    field: (parent, key, value) => store.setField(parent, key, value),
    finish: parent => store.finishContainer(parent),
    scalar: value => store.scalar(value),
    text: () => store.leafWriter(),
  };
  const parser = createJsonProjection(ALL, { ...options, valueSink: sink, frameStack: frames });
  let finished = false;
  return {
    write(bytes, offset) {
      if (finished) throw new Error('history_paged_parser_finished');
      // Finite writes commit completed pages. No parser/reference contains
      // the entire encoded record, decoded field or a growing value array.
      try {
        store.transaction(() => parser.write(typeof bytes === 'string' ? bytes : bytes.toString('latin1'), offset));
      } catch (error) { finished = true; current = null; releaseBuild(); throw error; }
    },
    finish(end) {
      if (finished) throw new Error('history_paged_parser_finished');
      finished = true;
      try {
        return store.transaction(() => {
          const result = parser.finish(end);
          return { valid: result.valid, empty: result.empty,
            lease: result.valid ? store.lease(result.value) : null };
        });
      } finally { current = null; releaseBuild(); }
    },
    abort() { finished = true; current = null; releaseBuild(); },
    stats: () => ({ ...parser.stats(), ...store.stats(), canonicalReducerRouted: options.canonicalReducerRouted === true,
      parserDepthBounded: true, residentParserFrames: current ? 1 : 0, numericTokenBounded: true }),
  };
}

module.exports = { createPagedJsonProjection };
