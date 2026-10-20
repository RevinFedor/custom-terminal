'use strict';

const { performance } = require('node:perf_hooks');
const immediate = () => new Promise(resolve => setImmediate(resolve));
const micros = n => Math.max(0, Math.round(n * 1000));

// Fixed scalars only. A large indivisible unit is measured, never truncated.
function createCatalogControl({ schedule = immediate, now = () => performance.now(),
  maxSteps = 256, targetMs = 2, assertCurrent = () => {} } = {}) {
  let steps = 0, sliceStart = now(), syncSlice = 0;
  const fields = { steps: 0, yields: 0, maxUnitUs: 0, maxSliceUs: 0,
    sortUs: 0, orderUs: 0, visualUs: 0, mapUs: 0, scanUs: 0, authorityUs: 0, probeUs: 0 };
  const finishSlice = () => { fields.maxSliceUs = Math.max(fields.maxSliceUs, micros(syncSlice)); syncSlice = 0; };
  return { fields,
    async step(stage, callback = () => {}) {
      assertCurrent();
      const start = now(); let value;
      try { value = callback(); }
      finally {
        const elapsed = Math.max(0, now() - start);
        const key = stage + 'Us'; if (Object.hasOwn(fields, key)) fields[key] += micros(elapsed);
        fields.maxUnitUs = Math.max(fields.maxUnitUs, micros(elapsed));
        syncSlice += elapsed; fields.steps++; steps++;
      }
      if (steps >= maxSteps || now() - sliceStart >= targetMs) {
        finishSlice(); fields.yields++;
        await schedule(); assertCurrent(); steps = 0; sliceStart = now();
      }
      return value;
    },
    async drain(stage, iterator) {
      try { for (;;) { const next = await this.step(stage, () => iterator.next()); if (next.done) return next.value; } }
      catch (error) { try { iterator.return?.(); } catch {} throw error; }
    },
    finish() { finishSlice(); return { ...fields }; },
  };
}

function* stableSortSteps(input, compare) {
  let from = [], into = [];
  for (const item of input) { from.push(item); yield; }
  for (let width = 1; width < from.length; width *= 2) {
    for (let left = 0; left < from.length; left += width * 2) {
      const middle = Math.min(left + width, from.length), end = Math.min(left + width * 2, from.length);
      let a = left, b = middle;
      for (let i = left; i < end; i++) {
        into[i] = b >= end || (a < middle && compare(from[a], from[b]) <= 0) ? from[a++] : from[b++];
        yield;
      }
    }
    [from, into] = [into, from];
  }
  return from;
}
const stableSort = (items, compare, control) => control.drain('sort', stableSortSteps(items, compare));

async function copyMetadata(input, control) {
  if (!input || typeof input !== 'object') return input;
  const output = Array.isArray(input) ? [] : {}, stack = [[input, output]];
  while (stack.length) {
    const [source, target] = stack.pop();
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      await control.step('map', () => {
        const value = source[key];
        if (value && typeof value === 'object') {
          target[key] = Array.isArray(value) ? [] : {}; stack.push([value, target[key]]);
        } else target[key] = value;
      });
    }
  }
  return output;
}

// Bounds async FS operations shared by scanner and reads. No implicit sync port.
function createFsLimiter(limit = 4, maxWaiting = 256) {
  let active = 0, rejected = 0; const waiting = [];
  const pump = () => {
    while (active < limit && waiting.length) {
      const { run, resolve, reject } = waiting.shift(); active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return { run(run) {
    if (waiting.length >= maxWaiting) {
      rejected++;
      return Promise.reject(Object.assign(Error('prompt_catalog_unavailable'), { code: 'prompt_catalog_unavailable',
        statusCode: 503, reason: 'fs_queue_full', fsActive: active, fsWaiting: waiting.length }));
    }
    return new Promise((resolve, reject) => { waiting.push({ run, resolve, reject }); pump(); });
  }, get active() { return active; }, get waiting() { return waiting.length; }, get rejected() { return rejected; } };
}
module.exports = { createCatalogControl, stableSort, stableSortSteps, copyMetadata, createFsLimiter, immediate };
