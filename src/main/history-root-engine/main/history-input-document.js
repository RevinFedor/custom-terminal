'use strict';

// A document lives in the caller's existing HistoryPagedStore. It has no
// database, worker, registry, timer or Send authority of its own. All text and
// Undo/Redo states are immutable pages. This module does not make the existing
// String-based CodeMirror/uiStore/FIFO boundary bounded; those adapters must
// explicitly adopt the descriptor before claiming complete Input acceptance.
const crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const ref = id => ({ type: 'page', id });
const integer = (n, code) => {
  if (!Number.isSafeInteger(n) || n < 0) throw fail(code);
  return n;
};
const cancelled = signal => { if (signal?.aborted) throw fail('HISTORY_READ_CANCELLED'); };

// AVL pieces. A text page is at most store.pageBytes, while branches hold only
// two references and their exact UTF-16 lengths. Splits share all untouched
// pieces; a one-character edit does not rewrite the complete historical text.
class InputPieces {
  constructor(store) { this.store = store; }
  meta(page) {
    if (!page) return { kind: 'input-empty', chars: 0, height: 0 };
    const node = this.store.json(page);
    if (!['input-leaf', 'input-branch'].includes(node.kind)
      || !Number.isSafeInteger(node.chars) || node.chars < 1
      || !Number.isSafeInteger(node.height) || node.height < 1 || node.height > 128) {
      throw fail('history_input_piece_corrupt');
    }
    return node;
  }
  leaf(value) {
    if (!value) return 0;
    const bytes = Buffer.from(value, 'utf16le');
    if (bytes.length > this.store.pageBytes) throw fail('history_input_piece_overflow');
    const body = this.store.put(bytes);
    return this.store.put({ kind: 'input-leaf', chars: value.length, height: 1, body }, [body]);
  }
  branch(left, right) {
    if (!left) return right;
    if (!right) return left;
    const a = this.meta(left), b = this.meta(right), chars = a.chars + b.chars;
    integer(chars, 'history_input_length');
    return this.store.put({ kind: 'input-branch', left, right, chars,
      height: Math.max(a.height, b.height) + 1 }, [left, right]);
  }
  balance(left, right) {
    if (!left || !right) return left || right;
    const a = this.meta(left), b = this.meta(right);
    if (a.height > b.height + 1) {
      if (a.kind !== 'input-branch') throw fail('history_input_piece_corrupt');
      const al = this.meta(a.left), ar = this.meta(a.right);
      if (al.height >= ar.height) return this.branch(a.left, this.branch(a.right, right));
      if (ar.kind !== 'input-branch') throw fail('history_input_piece_corrupt');
      return this.branch(this.branch(a.left, ar.left), this.branch(ar.right, right));
    }
    if (b.height > a.height + 1) {
      if (b.kind !== 'input-branch') throw fail('history_input_piece_corrupt');
      const bl = this.meta(b.left), br = this.meta(b.right);
      if (br.height >= bl.height) return this.branch(this.branch(left, b.left), b.right);
      if (bl.kind !== 'input-branch') throw fail('history_input_piece_corrupt');
      return this.branch(this.branch(left, bl.left), this.branch(bl.right, b.right));
    }
    return this.branch(left, right);
  }
  join(left, right) {
    if (!left || !right) return left || right;
    const a = this.meta(left), b = this.meta(right);
    if (a.height > b.height + 1) return this.balance(a.left, this.join(a.right, right));
    if (b.height > a.height + 1) return this.balance(this.join(left, b.left), b.right);
    return this.branch(left, right);
  }
  split(page, at) {
    const meta = this.meta(page);
    integer(at, 'history_input_offset');
    if (at > meta.chars) throw fail('history_input_offset');
    if (!at) return [0, page];
    if (at === meta.chars) return [page, 0];
    if (meta.kind === 'input-leaf') {
      const value = this.text(meta);
      return [this.leaf(value.slice(0, at)), this.leaf(value.slice(at))];
    }
    const length = this.meta(meta.left).chars;
    if (at < length) {
      const [first, rest] = this.split(meta.left, at);
      return [first, this.join(rest, meta.right)];
    }
    const [first, rest] = this.split(meta.right, at - length);
    return [this.join(meta.left, first), rest];
  }
  text(meta) {
    const body = this.store.read(meta.body);
    if (body.length !== meta.chars * 2 || body.length > this.store.pageBytes) {
      throw fail('history_input_piece_corrupt');
    }
    return body.toString('utf16le');
  }
  *range(page, from = 0, to = this.meta(page).chars) {
    const meta = this.meta(page);
    if (!page || from === to) return;
    if (meta.kind === 'input-leaf') { yield this.text(meta).slice(from, to); return; }
    const leftChars = this.meta(meta.left).chars;
    if (from < leftChars) yield* this.range(meta.left, from, Math.min(to, leftChars));
    if (to > leftChars) yield* this.range(meta.right, Math.max(0, from - leftChars), to - leftChars);
  }
}

class HistoryInputDocument {
  constructor(store, lease) {
    this.store = store; this.lease = lease; this.pieces = new InputPieces(store);
    this.closed = false; this.preparing = false;
    this.readState();
  }
  assertOpen() {
    if (this.closed) throw fail('history_input_closed');
    this.store.assertOpen();
  }
  readState() {
    this.assertOpen();
    const state = this.store.json(this.lease.descriptor.page);
    if (state.kind !== 'input-document-v1' || !Number.isSafeInteger(state.revision)
      || state.revision < 0 || !Number.isSafeInteger(state.root) || state.root < 0) {
      throw fail('history_input_document_corrupt');
    }
    return state;
  }
  identity() {
    const state = this.readState();
    const chunks = this.store.leafChunks(ref(state.identity));
    // Routing identity has its own fixed admission cap, never a body field.
    let value = '';
    for (const chunk of chunks) {
      if (value.length + chunk.length > 8192) throw fail('history_input_identity');
      value += chunk;
    }
    return JSON.parse(value);
  }
  descriptor() {
    const state = this.readState();
    return Object.freeze({ protocol: 'history-input-v1', ...this.identity(),
      revision: state.revision, length: this.pieces.meta(state.root).chars });
  }
  snapshot() { this.assertOpen(); return new HistoryInputDocument(this.store, this.lease.fork()); }
  checkpoint() { this.assertOpen(); return this.lease.descriptor; }
  static open(store, descriptor, expectedIdentity) {
    const document = new HistoryInputDocument(store, store.open(descriptor));
    try {
      const actual = document.identity();
      for (const key of ['documentId', 'ownerKey', 'sourceRevision', 'sourceGeneration']) {
        if (actual[key] !== expectedIdentity[key]) throw fail('history_input_owner_mismatch');
      }
      return document;
    } catch (error) { document.close(); throw error; }
  }
  static async prepare(store, { ownerKey, sourceRevision, sourceGeneration,
    documentId = crypto.randomUUID(), chunks, signal, assertCurrent = () => {},
    schedule = () => new Promise(resolve => setImmediate(resolve)), onProgress = () => {} }) {
    const identity = { documentId, ownerKey, sourceRevision, sourceGeneration };
    for (const key of Object.keys(identity)) {
      if (typeof identity[key] !== 'string' || !identity[key]) throw fail('history_input_identity');
    }
    const encodedIdentity = JSON.stringify(identity);
    if (encodedIdentity.length > 8192) throw fail('history_input_identity');
    const pieces = new InputPieces(store), releaseBuild = store.beginBuild();
    let root = 0, totalChars = 0, pages = 0, lease;
    const guard = () => { cancelled(signal); assertCurrent(); store.assertOpen(); };
    try {
      guard();
      for await (const chunk of chunks) {
        guard();
        if (typeof chunk !== 'string') throw fail('history_input_chunk');
        for (let offset = 0; offset < chunk.length; offset += store.pageBytes / 2) {
          guard();
          const part = chunk.slice(offset, offset + store.pageBytes / 2);
          root = store.transaction(() => pieces.join(root, pieces.leaf(part)));
          totalChars = integer(totalChars + part.length, 'history_input_length'); pages++;
          onProgress({ chars: totalChars, pages });
          await schedule(); guard();
        }
      }
      guard();
      store.transaction(() => {
        const identityRef = store.text(encodedIdentity);
        const page = store.put({ kind: 'input-document-v1', identity: identityRef.id,
          root, undo: 0, redo: 0, revision: 0 }, [identityRef.id, root]);
        guard(); lease = store.lease(ref(page));
      });
      return new HistoryInputDocument(store, lease);
    } catch (error) { lease?.release(); throw error; }
    finally { releaseBuild(); }
  }
  read({ offset = 0, limit = 512, creditBytes = 1024, expectedRevision } = {}) {
    const state = this.readState();
    if (expectedRevision !== undefined && expectedRevision !== state.revision) throw fail('history_input_revision');
    integer(offset, 'history_input_offset'); integer(limit, 'history_input_limit');
    integer(creditBytes, 'history_input_credit');
    if (!limit) throw fail('history_input_limit');
    if (creditBytes < 2 || creditBytes > this.store.pageBytes * 3) throw fail('history_input_credit');
    const length = this.pieces.meta(state.root).chars;
    if (offset > length) throw fail('history_input_offset');
    const end = Math.min(length, offset + limit, offset + Math.floor(creditBytes / 2));
    let text = '';
    for (const part of this.pieces.range(state.root, offset, end)) text += part;
    if (text.length !== end - offset) throw fail('history_input_piece_corrupt');
    return { ...this.descriptor(), offset, nextOffset: end, done: end === length,
      text, bytes: text.length * 2 };
  }
  *chunks() {
    const state = this.readState();
    // The held immutable snapshot protects the root while the caller reads.
    const held = this.snapshot();
    try { for (const part of this.pieces.range(state.root)) { held.assertOpen(); yield part; } }
    finally { held.close(); }
  }
  digest() {
    const hash = crypto.createHash('sha256');
    for (const part of this.chunks()) hash.update(Buffer.from(part, 'utf16le'));
    return { encoding: 'utf16le', sha256: hash.digest('hex'), length: this.descriptor().length };
  }
  commit(state, makeNext) {
    const current = this.readState();
    if (current.revision !== state.revision || this.lease.descriptor.page !== state.page) {
      throw fail('history_input_revision');
    }
    const previous = this.lease;
    let lease;
    try {
      this.store.transaction(() => {
        const next = makeNext();
        lease = this.store.lease(ref(this.store.put(next,
          [next.identity, next.root, next.undo, next.redo])));
      });
    } catch (error) { lease?.release(); throw error; }
    this.lease = lease; previous.release();
    return this.descriptor();
  }
  async replace({ from, to, chunks, expectedRevision, signal,
    assertCurrent = () => {}, schedule = () => new Promise(resolve => setImmediate(resolve)) }) {
    this.assertOpen();
    if (this.preparing) throw fail('history_input_busy');
    const state = { ...this.readState(), page: this.lease.descriptor.page };
    if (state.revision !== expectedRevision) throw fail('history_input_revision');
    integer(from, 'history_input_offset'); integer(to, 'history_input_offset');
    if (to < from || to > this.pieces.meta(state.root).chars) throw fail('history_input_offset');
    this.preparing = true;
    const endBuild = this.store.beginBuild();
    const guard = () => { this.assertOpen(); cancelled(signal); assertCurrent();
      if (this.readState().revision !== expectedRevision) throw fail('history_input_revision'); };
    let inserted = 0;
    try {
      guard();
      for await (const chunk of chunks) {
        if (typeof chunk !== 'string') throw fail('history_input_chunk');
        for (let at = 0; at < chunk.length; at += this.store.pageBytes / 2) {
          guard();
          inserted = this.store.transaction(() => this.pieces.join(inserted,
            this.pieces.leaf(chunk.slice(at, at + this.store.pageBytes / 2))));
          await schedule(); guard();
        }
      }
      guard();
      return this.commit(state, () => {
        const [before] = this.pieces.split(state.root, from);
        const [, after] = this.pieces.split(state.root, to);
        const root = this.pieces.join(this.pieces.join(before, inserted), after);
        const undo = this.store.put({ kind: 'input-history', root: state.root, next: state.undo },
          [state.root, state.undo]);
        guard();
        return { kind: state.kind, identity: state.identity, root,
          undo, redo: 0, revision: integer(state.revision + 1, 'history_input_revision') };
      });
    } finally { this.preparing = false; endBuild(); }
  }
  moveHistory(direction, expectedRevision) {
    this.assertOpen();
    if (this.preparing) throw fail('history_input_busy');
    const state = { ...this.readState(), page: this.lease.descriptor.page };
    if (state.revision !== expectedRevision) throw fail('history_input_revision');
    const selected = direction === 'undo' ? state.undo : state.redo;
    if (!selected) return { changed: false, ...this.descriptor() };
    const opposite = direction === 'undo' ? 'redo' : 'undo';
    return { changed: true, ...this.commit(state, () => {
      const item = this.store.json(selected);
      if (item.kind !== 'input-history') throw fail('history_input_history_corrupt');
      const nextOpposite = this.store.put({ kind: 'input-history', root: state.root, next: state[opposite] },
        [state.root, state[opposite]]);
      const next = { kind: state.kind, identity: state.identity, root: item.root,
        undo: state.undo, redo: state.redo, revision: integer(state.revision + 1, 'history_input_revision'),
        [direction]: item.next, [opposite]: nextOpposite };
      return next;
    }) };
  }
  undo(expectedRevision) { return this.moveHistory('undo', expectedRevision); }
  redo(expectedRevision) { return this.moveHistory('redo', expectedRevision); }
  close() { if (!this.closed) { this.closed = true; this.lease.release(); } }
}

module.exports = { HistoryInputDocument };
