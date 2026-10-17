// Private, in-memory parser checkpoints. Never serialize these into a rollout.
// Copy the object graph (including cross-references between cards and pending
// calls), not strings: JSON/structuredClone duplicates giant tool payloads.
function cloneProjectionGraph(value, transform = (_key, item) => item) {
  const seen = new Map();
  const copy = (item, key = '', opaque = false) => {
    if (!opaque) item = transform(key, item);
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return seen.get(item);
    const result = item instanceof Map ? new Map()
      : item instanceof Set ? new Set() : Array.isArray(item) ? [] : {};
    seen.set(item, result);
    if (item instanceof Map) {
      for (const [k, v] of item) result.set(copy(k, key, opaque), copy(v, key, opaque));
    } else if (item instanceof Set) {
      for (const v of item) result.add(copy(v, key, opaque));
    } else {
      for (const k of Object.keys(item)) {
        result[k] = copy(item[k], Array.isArray(item) ? key : k,
          opaque || ['args', 'payload', 'diffHunks'].includes(k));
      }
    }
    return result;
  };
  return copy(value);
}

const { createProjectionIdentityMap } = require('../shared/codex-rewrite-identities.cjs');

// Count container items as well as objects: a single huge primitive array/Map
// also has to yield. Object.keys and one transform remain indivisible; this is
// a work-unit budget, not a hard slice-time guarantee. Strings stay shared.
async function cloneProjectionGraphAsync(value, transform = (_key, item) => item) {
  const seen = new Map();
  const queue = [];
  let approxBytes = 0;
  const copy = (item, key = '', opaque = false) => {
    if (!opaque) item = transform(key, item);
    if (!item || typeof item !== 'object') {
      approxBytes += typeof item === 'string' ? 16 + item.length * 2 : 8;
      return item;
    }
    if (seen.has(item)) return seen.get(item);
    const result = item instanceof Map ? new Map() : item instanceof Set ? new Set()
      : Array.isArray(item) ? [] : {};
    approxBytes += 48;
    seen.set(item, result);
    queue.push({ item, result, key, opaque });
    return result;
  };
  const result = copy(value);
  let units = 0;
  const pause = () => new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < queue.length; index += 1) {
    const { item, result, key, opaque } = queue[index];
    if (item instanceof Map) {
      for (const [k, v] of item) {
        result.set(copy(k, key, opaque), copy(v, key, opaque));
        if (++units % 1000 === 0) await pause();
      }
    } else if (item instanceof Set) {
      for (const v of item) {
        result.add(copy(v, key, opaque));
        if (++units % 1000 === 0) await pause();
      }
    } else {
      for (const k of Object.keys(item)) {
        result[k] = copy(item[k], Array.isArray(item) ? key : k,
          opaque || ['args', 'payload', 'diffHunks'].includes(k));
        if (++units % 1000 === 0) await pause();
      }
    }
    if (++units % 1000 === 0) await pause();
  }
  return { value: result, approxBytes };
}

async function measureProjectionGraphBytes(value) {
  const seen = new Set();
  const pending = [value];
  let bytes = 0, units = 0;
  const pause = () => new Promise(resolve => setImmediate(resolve));
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') bytes += typeof item === 'string' ? 16 + item.length * 2 : 8;
    else if (!seen.has(item)) {
      seen.add(item);
      bytes += 48;
      // Expanding ONE giant container is work too. The byte cost and graph
      // identity semantics are unchanged; optional checkpoint retention is not
      // weakened just because the graph is expensive to measure.
      if (item instanceof Map) {
        for (const [key, value] of item) {
          pending.push(key, value);
          if (++units % 4000 === 0) await pause();
        }
      } else if (item instanceof Set) {
        for (const value of item) {
          pending.push(value);
          if (++units % 4000 === 0) await pause();
        }
      } else {
        for (const key of Object.keys(item)) {
          pending.push(item[key]);
          if (++units % 4000 === 0) await pause();
        }
      }
    }
    if (++units % 4000 === 0) await pause();
  }
  return bytes;
}

// Keep a few evenly spaced restart points AND the newest one. Their full
// conservative byte cost is charged to the existing projector budget.
function retainCheckpoint(checkpoints, checkpoint, max = 4) {
  checkpoints.push(checkpoint);
  while (checkpoints.length > max) {
    let victim = 0;
    let smallestGap = Infinity;
    for (let index = 0; index < checkpoints.length - 1; index += 1) {
      const before = index ? checkpoints[index - 1].count : 0;
      const gap = checkpoints[index + 1].count - before;
      if (gap < smallestGap) { smallestGap = gap; victim = index; }
    }
    checkpoints.splice(victim, 1);
  }
}

module.exports = { cloneProjectionGraph, cloneProjectionGraphAsync, measureProjectionGraphBytes, createProjectionIdentityMap, retainCheckpoint };
