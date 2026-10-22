'use strict';

const { randomUUID } = require('node:crypto');
const { streamLimits } = require('./history-stream-codec');
const { historyReadCancelled } = require('./history-read-control');
const protocolError = () => Object.assign(new Error('History stream protocol invalid'), { code: 'HISTORY_STREAM_PROTOCOL_INVALID' });
const isByteView = value => value instanceof Uint8Array || Buffer.isBuffer(value);

// A stream belongs to one RPC in one process boot. Credit is a cumulative byte
// position, not an additive grant: duplicate/lost ACKs cannot grow a window.
class HistoryByteSender {
  constructor({ id, send, control, assertCurrent = () => {}, frameBytes, credits, token = randomUUID(), stats = {} }) {
    this.id = id; this.token = token; this.send = send; this.control = control; this.assertSource = assertCurrent;
    Object.assign(this, streamLimits({ frameBytes, credits }));
    this.sentBytes = 0; this.consumedBytes = 0; this.sequence = 0; this.admitted = false;
    this.boundaries = []; this.waiter = null; this.error = null; this.closed = false;
    this.stats = Object.assign(stats, { sentBytes: 0, maxOutstandingBytes: 0, maxBoundaryCount: 0, frames: 0 });
    this.abort = () => this.cancel(historyReadCancelled());
    control?.signal?.addEventListener('abort', this.abort, { once: true });
    this.removeSettled = control?.onSettled?.(() => this.cancel(historyReadCancelled('stream-owner-settled')));
  }
  assertCurrent() {
    if (this.error) throw this.error;
    if (this.closed) throw historyReadCancelled('stream-closed');
    this.control?.assertCurrent(); this.assertSource();
  }
  credit(message) {
    if (message.streamToken !== this.token || this.closed || this.error) return false;
    try {
      const value = message.consumedBytes;
      if (!Number.isSafeInteger(value) || value < 0 || value > this.sentBytes
        || message.windowBytes !== this.windowBytes) throw protocolError();
      // An out-of-order old ACK is harmless. A future/non-boundary ACK is not
      // proof that the consumer released bytes.
      if (value < this.consumedBytes) return false;
      if (value !== this.consumedBytes && !this.boundaries.includes(value)) throw protocolError();
      this.consumedBytes = value; this.admitted = true;
      while (this.boundaries.length && this.boundaries[0] <= value) this.boundaries.shift();
      this.waiter?.(); return true;
    } catch (error) { this.cancel(error); return false; }
  }
  async capacity(required = this.frameBytes) {
    for (;;) {
      this.assertCurrent();
      if (this.admitted && this.sentBytes - this.consumedBytes + required <= this.windowBytes
        && (required === this.windowBytes || this.boundaries.length < this.credits)) return;
      await new Promise(resolve => { this.waiter = resolve; });
      this.waiter = null;
    }
  }
  async pump(iterable, metadata, readProof) {
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      this.assertCurrent();
      this.send({ event: 'stream-open', id: this.id, streamToken: this.token,
        limits: { frameBytes: this.frameBytes, credits: this.credits, windowBytes: this.windowBytes }, metadata, readProof });
      for (;;) {
        // Reserve capacity BEFORE advancing the encoder/cursor. A stalled
        // receiver must not trigger an unbounded source read-ahead.
        await this.capacity();
        const item = await iterator.next();
        this.assertCurrent();
        if (item.done) break;
        const bytes = item.value;
        if (!isByteView(bytes) || !bytes.byteLength || bytes.byteLength > this.frameBytes) throw protocolError();
        const offset = this.sentBytes;
        this.sentBytes += bytes.byteLength; this.boundaries.push(this.sentBytes); this.sequence++;
        this.stats.sentBytes = this.sentBytes; this.stats.frames = this.sequence;
        this.stats.maxOutstandingBytes = Math.max(this.stats.maxOutstandingBytes, this.sentBytes - this.consumedBytes);
        this.stats.maxBoundaryCount = Math.max(this.stats.maxBoundaryCount, this.boundaries.length);
        this.send({ event: 'stream-frame', id: this.id, streamToken: this.token, sequence: this.sequence, offset, data: bytes });
      }
      // Encoding completion/postMessage is not consumption. The generation
      // borrower and cold lane stay owned until the actual consumer ACK.
      await this.capacity(this.windowBytes);
      this.assertCurrent();
      // Main must retain its pending demand until the child observes the last
      // credit. Publishing end earlier could leave a lost-final-ACK producer
      // alive after Main had already removed its cancellation subscription.
      this.send({ event: 'stream-end', id: this.id, streamToken: this.token, bytes: this.sentBytes, frames: this.sequence });
      return { ...this.stats };
    } catch (error) {
      this.cancel(error);
      try { this.send({ event: 'stream-error', id: this.id, streamToken: this.token,
        error: { message: error.message, code: error.code } }); } catch {}
      throw error;
    } finally {
      this.closed = true; this.control?.signal?.removeEventListener('abort', this.abort);
      this.removeSettled?.();
      this.waiter?.(); this.waiter = null;
      await iterator.return?.();
    }
  }
  cancel(error = historyReadCancelled()) {
    if (!this.error) this.error = error;
    this.waiter?.();
  }
}

// The iterator grants credit only after the previous next() value has been
// consumed (the following next() call). No aggregate JSON.parse/array exists
// here; HTTP can await drain before advancing it.
class HistoryByteReceiver {
  constructor({ id, send, assertCurrent = () => {}, onSettled = () => {}, frameBytes, credits, stats = {} }) {
    this.id = id; this.send = send; this.assertSource = assertCurrent; this.onSettled = onSettled;
    Object.assign(this, streamLimits({ frameBytes, credits }));
    this.queue = []; this.receivedBytes = 0; this.consumedBytes = 0; this.sequence = 0;
    this.heldEnd = 0; this.streamToken = null; this.metadata = null; this.readProof = null;
    this.error = null; this.ended = false; this.settled = false; this.pulling = false;
    this.waiter = null; this.started = false;
    this.stats = Object.assign(stats, { receivedBytes: 0, maxOutstandingBytes: 0, maxQueuedBytes: 0, maxQueuedFrames: 0 });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
  }
  current() { if (this.error) throw this.error; this.assertSource(); }
  accept(message) {
    if (this.settled) return false;
    try {
      if (message.event === 'stream-open') {
        if (this.streamToken || typeof message.streamToken !== 'string' || message.streamToken.length > 100
          || message.limits?.frameBytes !== this.frameBytes || message.limits?.windowBytes !== this.windowBytes
          || message.limits?.credits !== this.credits) throw protocolError();
        this.streamToken = message.streamToken; this.metadata = message.metadata; this.readProof = message.readProof;
        this.current(); this.resolveReady(this); this.waiter?.(); return true;
      }
      if (!this.streamToken || message.streamToken !== this.streamToken) return false;
      this.current();
      if (message.event === 'stream-error') {
        throw Object.assign(new Error(message.error?.message || 'History stream failed'), { code: message.error?.code });
      }
      if (message.event === 'stream-frame') {
        const bytes = message.data;
        if (!this.started || this.ended || !isByteView(bytes) || bytes.byteLength < 1 || bytes.byteLength > this.frameBytes
          || message.sequence !== this.sequence + 1 || message.offset !== this.receivedBytes
          || this.queue.length + Number(this.heldEnd > 0) >= this.credits
          || this.receivedBytes + bytes.byteLength - this.consumedBytes > this.windowBytes) throw protocolError();
        this.sequence++; this.receivedBytes += bytes.byteLength;
        this.queue.push({ bytes, end: this.receivedBytes });
        this.stats.receivedBytes = this.receivedBytes;
        this.stats.maxOutstandingBytes = Math.max(this.stats.maxOutstandingBytes, this.receivedBytes - this.consumedBytes);
        this.stats.maxQueuedBytes = Math.max(this.stats.maxQueuedBytes, this.queue.reduce((n, item) => n + item.bytes.byteLength, 0));
        this.stats.maxQueuedFrames = Math.max(this.stats.maxQueuedFrames, this.queue.length);
      } else if (message.event === 'stream-end') {
        if (this.ended || message.bytes !== this.receivedBytes || message.frames !== this.sequence) throw protocolError();
        this.ended = true;
      } else throw protocolError();
      this.waiter?.(); return true;
    } catch (error) { this.fail(error); return true; }
  }
  credit() {
    this.current();
    this.send({ event: 'stream-credit', id: this.id, streamToken: this.streamToken,
      consumedBytes: this.consumedBytes, windowBytes: this.windowBytes });
  }
  async next() {
    if (this.pulling) throw Object.assign(new Error('History stream allows one pending pull'), { code: 'HISTORY_STREAM_CONCURRENT_PULL' });
    this.pulling = true;
    try {
      await this.ready;
      this.current();
      if (this.settled) return { done: true, value: undefined };
      if (!this.started || this.heldEnd) {
        this.started = true;
        if (this.heldEnd) { this.consumedBytes = this.heldEnd; this.heldEnd = 0; }
        this.credit();
      }
      for (;;) {
        this.current();
        if (this.queue.length) {
          const item = this.queue.shift(); this.heldEnd = item.end;
          return { value: item.bytes, done: false };
        }
        if (this.ended) { this.finish(); return { done: true, value: undefined }; }
        await new Promise(resolve => { this.waiter = resolve; });
        this.waiter = null;
      }
    } catch (error) { this.fail(error); throw error; }
    finally { this.pulling = false; }
  }
  finish() {
    if (this.settled) return; this.settled = true;
    this.waiter?.(); this.onSettled(this.error);
  }
  fail(error) {
    if (this.settled) return;
    this.error = error; this.queue.length = 0; this.heldEnd = 0;
    this.rejectReady(error);
    try { this.send({ event: 'cancel', id: this.id }); } catch {}
    this.finish();
  }
  close() { this.fail(historyReadCancelled('stream-consumer-closed')); }
  async return() { this.close(); return { done: true, value: undefined }; }
  [Symbol.asyncIterator]() { return this; }
}

module.exports = { HistoryByteSender, HistoryByteReceiver, protocolError };
