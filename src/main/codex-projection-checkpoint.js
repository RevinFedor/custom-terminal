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

// Traverse one child at a time. The old breadth-first queue retained every
// visited object until EOF; measuring one wide array also pushed every child
// before consuming the first. This removes that *additional* width-sized
// frontier. The source graph, cloned result and identity table are still full
// graphs: cooperative traversal is deliberately not advertised as a heap cap.
function* projectionChildren(item) {
  if (item instanceof Map) {
    for (const [key, value] of item) yield { key, value, map: true };
  } else if (item instanceof Set) {
    for (const value of item) yield { value, set: true };
  } else {
    for (const key in item) if (Object.hasOwn(item, key)) yield { key, value: item[key] };
  }
}

function traversalControl(options, defaultUnits) {
  const assertCurrent = options.assertCurrent || (() => {});
  const schedule = options.schedule || (() => new Promise(resolve => setImmediate(resolve)));
  const maxUnits = Math.max(1, Number(options.maxUnits) || defaultUnits);
  let units = 0;
  const metrics = options.metrics;
  if (metrics) Object.assign(metrics, { units: 0, yields: 0, maxFrontier: 0, complete: false });
  return {
    assertCurrent,
    observe(frontier) { if (metrics) metrics.maxFrontier = Math.max(metrics.maxFrontier, frontier); },
    step() { if (metrics) metrics.units++; return ++units >= maxUnits; },
    async checkpoint() {
      assertCurrent();
      await schedule();
      assertCurrent();
      units = 0;
      if (metrics) metrics.yields++;
    },
    finish() { assertCurrent(); if (metrics) metrics.complete = true; },
  };
}

async function cloneProjectionGraphAsync(value, transform = (_key, item) => item, options = {}) {
  const seen = new Map();
  const stack = [];
  const control = traversalControl(options, 1000);
  control.assertCurrent();
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
    stack.push({ result, key, opaque, children: projectionChildren(item) });
    control.observe(stack.length);
    return result;
  };
  const result = copy(value);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const next = frame.children.next();
    if (next.done) stack.pop();
    else {
      const child = next.value;
      if (child.map) frame.result.set(copy(child.key, frame.key, frame.opaque), copy(child.value, frame.key, frame.opaque));
      else if (child.set) frame.result.add(copy(child.value, frame.key, frame.opaque));
      else frame.result[child.key] = copy(child.value, Array.isArray(frame.result) ? frame.key : child.key,
        frame.opaque || ['args', 'payload', 'diffHunks'].includes(child.key));
    }
    if (control.step()) await control.checkpoint();
  }
  control.finish();
  return { value: result, approxBytes };
}

async function measureProjectionGraphBytes(value, options = {}) {
  const seen = new Set();
  const stack = [];
  const control = traversalControl(options, 4000);
  control.assertCurrent();
  let bytes = 0;
  const visit = item => {
    if (!item || typeof item !== 'object') bytes += typeof item === 'string' ? 16 + item.length * 2 : 8;
    else if (!seen.has(item)) {
      seen.add(item);
      bytes += 48;
      stack.push(projectionChildren(item));
      control.observe(stack.length);
    }
  };
  visit(value);
  while (stack.length) {
    // Only optional checkpoint admission uses early exit. Default callers
    // still receive the exact original conservative graph accounting.
    if (Number.isFinite(options.stopAfterBytes) && bytes > options.stopAfterBytes) return bytes;
    const next = stack[stack.length - 1].next();
    if (next.done) stack.pop();
    else {
      if (next.value.map) visit(next.value.key);
      visit(next.value.value);
    }
    if (control.step()) await control.checkpoint();
  }
  control.finish();
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
