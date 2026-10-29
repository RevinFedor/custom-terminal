'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createJsonProjection, DEFER } = require('./codex-json-projection');
const { createReadControl, createDemandRegistry, createReadAdmission } = require('./history-read-control');

const CHUNK_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_FRAMES = 256;
const MAX_WITNESSES = 4096;
const BOUNDARIES = new Set(['task_started', 'task_complete', 'turn_aborted', 'thread_rolled_back']);
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const fail = code => Object.assign(Error(code), { code });
const backgroundLane = createReadAdmission();
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
// DEFER wrappers also discard malformed-shape scalar bodies (for example a
// multi-MB payload string). Only fixed-size value coordinates are retained.
const SCHEMA = { [DEFER]: { type: DEFER, payload: { [DEFER]: { type: DEFER } } } };

class MessageReturnVerifier {
  constructor({ timeoutMs = 30_000, now = () => performance.now(), schedule = yieldTurn, onMetrics = () => {},
    onPhase = () => {},
    log = metrics => console.log('[MessageReturnProof:Verify] ' + JSON.stringify(metrics)) } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('return_verification_timeout_invalid');
    Object.assign(this, { timeoutMs, now, schedule, onMetrics, onPhase, log });
    this.demands = createDemandRegistry(); this.cache = new Map(); this.sequence = 0;
  }
  report(metrics) {
    try { this.onMetrics({ ...metrics }); } catch {}
    if (metrics.cache !== 'hit') try { this.log(metrics); } catch {}
  }
  phase(metrics, phase) { try { this.onPhase({ id: metrics.id, proof: metrics.proof, phase, readBytes: metrics.readBytes }); } catch {} }
  async verify({ basis, selection, isCurrent, minimumSize, signal, reference, trace }) {
    if (typeof reference !== 'string' || !reference || typeof isCurrent !== 'function') return 'return_reference_unproven';
    const { begin, end, selected } = selection;
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) return 'return_structural_gap';
    if (selected.length > MAX_WITNESSES) return 'return_proof_metadata_limit';
    let metadata = JSON.stringify([reference, basis, begin, end, minimumSize, selected]);
    const metadataBytes = Buffer.byteLength(metadata);
    if (metadataBytes > MAX_METADATA_BYTES) return 'return_proof_metadata_limit';
    const key = createHash('sha256').update(metadata).digest('hex');
    metadata = null;
    const controller = new AbortController(), deadlineAt = this.now() + this.timeoutMs;
    const abort = () => controller.abort('return_verification_cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort('return_verification_deadline'), this.timeoutMs);
    const assertSourceCurrent = () => { if (!isCurrent()) throw fail('return_source_changed'); };
    const consumer = createReadControl({ signal: controller.signal, assertSourceCurrent, schedule: this.schedule });
    try {
      return await this.demands.run(key, consumer, control => this.perform({
        basis, selection, isCurrent, minimumSize, metadataBytes, key, deadlineAt, control, trace,
      }));
    } catch (error) {
      return controller.signal.aborted ? controller.signal.reason
        : /^return_/.test(error.code || '') ? error.code : 'return_source_unavailable';
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); consumer.finish();
    }
  }
  async perform({ basis, selection, isCurrent, minimumSize, metadataBytes, key, deadlineAt, control, trace }) {
    const { begin, end, selected } = selection;
    const started = performance.now();
    const metrics = { id: ++this.sequence, proof: key.slice(0, 16), ...trace, intervalBytes: end - begin,
      readBytes: 0, fieldReadBytes: 0, maxReadBytes: 0, bufferBytes: 0, maxFieldBufferBytes: 0,
      maxLatin1Bytes: 0, maxTokenBytes: 0, maxParserFrames: 0, metadataBytes,
      witnesses: selected.length, chunks: 0, yields: 0, records: 0, cache: 'miss', queueMs: 0, maxParseSliceMs: 0 };
    const check = () => {
      control.assertCurrent();
      if (!isCurrent()) throw fail('return_source_changed');
      if (this.now() >= deadlineAt) throw fail('return_verification_deadline');
    };
    const checkpoint = async () => {
      check(); metrics.yields++;
      await control.checkpoint(); check();
    };
    let release, before, reason = null;
    const remember = result => {
      this.cache.delete(key); this.cache.set(key, { signature: signature(before), reason: result });
      while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    };
    try {
      check(); before = await fs.promises.stat(basis.filePath); check();
      const valid = stat => stat.dev + ':' + stat.ino === basis.inode && stat.size >= Math.max(end, minimumSize);
      if (!valid(before)) throw fail('return_source_changed');
      const cached = this.cache.get(key);
      metrics.cacheReason = cached ? 'physical-signature-changed' : 'ram-miss';
      if (cached?.signature === signature(before)) {
        const after = await fs.promises.stat(basis.filePath); check();
        if (signature(after) !== signature(before)) throw fail('return_source_changed');
        this.cache.delete(key); this.cache.set(key, cached);
        metrics.cache = 'hit'; metrics.cacheReason = 'verified-signature'; reason = cached.reason; return reason;
      }
      const queuedAt = performance.now(), admission = backgroundLane.acquire(control);
      this.phase(metrics, 'admission');
      release = await admission; metrics.queueMs = Math.round(performance.now() - queuedAt); check();
      before = await fs.promises.stat(basis.filePath); check();
      if (!valid(before)) throw fail('return_source_changed');
      const fd = await fs.promises.open(basis.filePath, 'r');
      try {
        if (signature(await fd.stat()) !== signature(before)) throw fail('return_source_changed');
        check();
        try { reason = await this.scan(fd, selection, check, checkpoint, metrics); }
        catch (error) {
          if (!['return_record_changed', 'return_structural_gap', 'return_proof_parser_limit'].includes(error.code)) throw error;
          reason = error.code;
        }
        if (signature(await fd.stat()) !== signature(before)) throw fail('return_source_changed');
        check();
      } finally { await fd.close(); }
      const after = await fs.promises.stat(basis.filePath); check();
      if (signature(after) !== signature(before)) throw fail('return_source_changed');
      this.phase(metrics, 'verified'); check();
      // Exact-signature memoization only. Append is a cache miss, never proof
      // that the old prefix survived; it rechecks this same bounded-state range.
      remember(reason);
      return reason;
    } catch (error) {
      reason = this.now() >= deadlineAt ? 'return_verification_deadline'
        : control.signal?.aborted ? 'return_verification_cancelled'
        : /^return_/.test(error.code || '') ? error.code : 'return_source_unavailable';
      // A timeout memo is only a conservative miss, never a source proof. Do
      // not repeat the same expensive failed attempt on every status wake.
      if (reason === 'return_verification_deadline' && before && isCurrent()) remember(reason);
      return reason;
    } finally {
      release?.(); metrics.reason = reason; metrics.elapsedMs = Math.round(performance.now() - started);
      this.report(metrics);
      this.phase(metrics, 'finished');
    }
  }
  async scan(fd, { selected, begin, end }, check, checkpoint, metrics) {
    const rows = selected.map(row => ({ ...row, hash: createHash('sha256'), bytes: 0 }));
    const byStart = new Map(rows.map(row => [row.offset, row]));
    const expected = new Set(rows.filter(row => row.thin.type === 'event_msg' && BOUNDARIES.has(row.thin.payload.type)).map(row => row.offset));
    const read = async (buffer, length, position, field = false) => {
      check(); metrics.maxReadBytes = Math.max(metrics.maxReadBytes, length);
      const result = await fd.read(buffer, 0, length, position);
      metrics.readBytes += result.bytesRead;
      if (field) metrics.fieldReadBytes += result.bytesRead;
      check(); if (!result.bytesRead) throw fail('return_source_changed');
      return result.bytesRead;
    };
    // A fixed known ASCII literal has at most six encoded bytes per character.
    // Oversized strings/containers cannot equal it and need no scalar read.
    const literal = async (loc, choices) => {
      const limit = 2 + 6 * Math.max(...choices.map(value => value.length));
      if (!loc || !Number.isSafeInteger(loc.from) || !Number.isSafeInteger(loc.to)
        || loc.from < begin || loc.to > end || loc.to <= loc.from || loc.to - loc.from > limit) return null;
      const bytes = Buffer.alloc(loc.to - loc.from); let done = 0;
      metrics.maxFieldBufferBytes = Math.max(metrics.maxFieldBufferBytes, bytes.length);
      while (done < bytes.length) {
        const part = bytes.subarray(done);
        done += await read(part, part.length, loc.from + done, true);
      }
      try { const value = JSON.parse(bytes.toString('utf8')); return choices.includes(value) ? value : null; }
      catch { throw fail('return_structural_gap'); }
    };
    const newParser = () => {
      const frames = [];
      return createJsonProjection(SCHEMA, { frameStack: {
        get length() { return frames.length; }, at: index => frames.at(index), pop: () => frames.pop(),
        push(frame) {
          if (frames.length >= MAX_FRAMES) throw fail('return_proof_parser_limit');
          frames.push(frame); metrics.maxParserFrames = Math.max(metrics.maxParserFrames, frames.length);
        },
      } });
    };
    const measure = parser => {
      const stats = parser.stats();
      metrics.maxTokenBytes = Math.max(metrics.maxTokenBytes, stats.maxTokenBytes);
      metrics.maxLatin1Bytes = Math.max(metrics.maxLatin1Bytes, stats.maxChunkBytes);
    };
    let parser = newParser(), offset = begin, lineStart = begin, visited = 0;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    metrics.bufferBytes = buffer.length;
    while (offset < end) {
      const length = await read(buffer, Math.min(buffer.length, end - offset), offset);
      metrics.chunks++;
      const bytes = buffer.subarray(0, length);
      for (const row of rows) {
        const start = Math.max(row.span.start, offset), stop = Math.min(row.span.start + row.span.length, offset + length);
        if (stop > start) { row.hash.update(bytes.subarray(start - offset, stop - offset)); row.bytes += stop - start; }
      }
      let cursor = 0;
      while (cursor < length) {
        check(); const newline = bytes.indexOf(10, cursor), stop = newline < 0 ? length : newline;
        const parseStarted = performance.now();
        parser.write(bytes.subarray(cursor, stop).toString('latin1'), offset + cursor); measure(parser);
        metrics.maxParseSliceMs = Math.max(metrics.maxParseSliceMs, performance.now() - parseStarted);
        if (newline < 0) break;
        const recordEnd = offset + newline + 1, result = parser.finish(recordEnd - 1), row = byStart.get(lineStart);
        if (!result.valid && !result.empty) throw fail('return_structural_gap');
        if (row) {
          if (!result.valid || row.span.start !== lineStart || row.span.length !== recordEnd - lineStart
            || row.bytes !== row.span.length || row.hash.digest('hex') !== row.span.digest) throw fail('return_record_changed');
          visited++;
        }
        if (result.valid) {
          const projected = result.value?.value;
          const type = await literal(projected?.type, ['event_msg']);
          if (type === 'event_msg') {
            const event = await literal(projected.payload?.value?.type, [...BOUNDARIES]);
            if (event) {
              if (!row || !expected.has(lineStart) || event !== row.thin.payload.type) throw fail('return_structural_gap');
              // The full original digest above also verifies turn_id and every
              // other selected-record byte; no large turn-id scalar is decoded.
              expected.delete(lineStart);
            }
          }
        }
        lineStart = recordEnd; parser = newParser(); cursor = newline + 1;
        metrics.records++; if (metrics.records % 128 === 0) await checkpoint();
      }
      offset += length; await checkpoint();
    }
    if (lineStart !== end || visited !== rows.length || expected.size) throw fail('return_structural_gap');
    return null;
  }
}

module.exports = { MessageReturnVerifier, CHUNK_BYTES, MAX_FRAMES };
