'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const OWNED = /^raw-[a-f0-9-]{36}$/;
const FILES = new Set(['stream.part', 'stream.bin', 'manifest.json', 'manifest.part']);
// Aliases arrive after the initial prefix. Reserve BOTH old and replacement
// manifests before accepting payload bytes; atomic publication temporarily
// owns both. Otherwise the final prune can delete this very incident.
const MAX_MANIFEST_BYTES = 32 * 1024;
const MANIFEST_RESERVE_BYTES = 2 * MAX_MANIFEST_BYTES;

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw Object.assign(Error('zero-byte-write'), { code: 'EIO' });
    offset += bytesWritten;
  }
}

function createTerminalRawArtifactStore({ directory, maxBytes = 128 * 1024 * 1024,
  maxArtifacts = 10, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  const active = new Map(); let initialized = false, removed = 0;
  const init = async () => {
    if (initialized) return;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('raw-directory-not-regular');
    initialized = true;
  };
  const inventory = async () => {
    const records = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !OWNED.test(entry.name)) continue;
      const folder = path.join(directory, entry.name), children = await fs.readdir(folder, { withFileTypes: true });
      // Never follow or delete unknown files/symlinks in a diagnostic directory.
      if (children.some(child => !child.isFile() || !FILES.has(child.name))) continue;
      let size = 0, mtime = 0;
      for (const child of children) { const s = await fs.lstat(path.join(folder, child.name)); size += s.size; mtime = Math.max(mtime, s.mtimeMs); }
      let manifest = null;
      try { manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')); } catch {}
      records.push({ folder, id: entry.name.slice(4), size, mtime, sealed: manifest?.state === 'sealed' });
    }
    return records;
  };
  const prune = async (reserveBytes = 0, reserveCount = 0) => {
    const rows = (await inventory()).sort((a, b) => a.mtime - b.mtime);
    let bytes = rows.reduce((n, row) => n + row.size, 0), count = rows.length;
    for (const row of rows) {
      const old = now() - row.mtime > maxAgeMs;
      if (active.has(row.id) || (!row.sealed && !old)) continue;
      if (!old && bytes + reserveBytes <= maxBytes && count + reserveCount <= maxArtifacts) continue;
      // The exact UUID subtree was inventoried above, has known regular files,
      // is not active, and is removed only by the diagnostic retention contract.
      for (const name of await fs.readdir(row.folder)) await fs.unlink(path.join(row.folder, name));
      await fs.rmdir(row.folder); bytes -= row.size; count--; removed++;
    }
    return bytes + reserveBytes <= maxBytes && count + reserveCount <= maxArtifacts;
  };
  const manifest = async state => {
    const value = { kind: 'terminal-raw-window', version: 1, state: state.sealed ? 'sealed' : 'partial',
      representation: 'UTF-16LE framed decoded app onData; not kernel bytes',
      summary: state.summary, recordsWritten: state.records, payloadBytesWritten: state.bytes,
      persistenceLost: state.lost, finalized: state.sealed, endReason: state.summary?.end?.reason || null,
      createdAt: state.createdAt, updatedAt: now(), fsynced: state.sealed,
      rawWindowCompleteWithinAdvertisedRange: state.summary?.pre?.completeWithinRetainedRange === true
        && state.summary?.tail?.complete === true && state.summary?.persistenceComplete === true && state.lost.events === 0,
      stream: state.sealed ? 'stream.bin' : 'stream.part' };
    const partial = path.join(state.folder, 'manifest.part');
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    if (bytes.length > MAX_MANIFEST_BYTES) throw Error('raw-manifest-metadata-budget');
    const handle = await fs.open(partial, 'w', 0o600);
    try { await handle.writeFile(bytes); if (state.sealed) await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(partial, path.join(state.folder, 'manifest.json'));
  };
  const entries = async (state, list) => {
    const input = list || [];
    let completed = 0, writingRecord = false;
    try {
    const batch = input.map(item => {
      const body = Buffer.from(item.buffer.buffer, item.buffer.byteOffset, item.buffer.byteLength);
      const header = Buffer.from(JSON.stringify(item.descriptor), 'utf8');
      if (header.length > 16 * 1024) throw Error('raw-record-header-budget');
      const prefix = Buffer.alloc(8); prefix.writeUInt32LE(header.length, 0); prefix.writeUInt32LE(body.length, 4);
      return { item, body, header, prefix, charge: prefix.length + header.length + body.length };
    });
    // One retention scan per bounded worker batch, not one directory read/stat
    // cascade per PTY chunk. Reserve room for the final manifest as before.
    const reserve = MANIFEST_RESERVE_BYTES, requested = batch.reduce((n, row) => n + row.charge, 0);
    const fits = await prune(requested + reserve);
    let available = fits ? requested : Math.max(0, maxBytes - reserve
      - (await inventory()).reduce((n, row) => n + row.size, 0));
    for (const { item, body, header, prefix, charge } of batch) {
      if (charge > available) {
        state.lost.events++; state.lost.codeUnits += body.length / 2;
        state.lost.fromSeq ??= item.descriptor.seq; state.lost.toSeq = item.descriptor.seq;
        state.lost.reason = 'disk-budget'; completed++; continue;
      }
      writingRecord = true;
      await writeAll(state.handle, prefix); await writeAll(state.handle, header); await writeAll(state.handle, body);
      writingRecord = false;
      available -= charge;
      state.records++; state.bytes += body.length; completed++;
    }
    } catch (error) {
      // A failed header/inventory scan can reject the WHOLE batch before the
      // first write. A mid-record error also loses every unattempted successor.
      // A later seal must not advertise either gap as a complete raw range.
      for (const item of input.slice(completed)) {
        state.lost.events++; state.lost.codeUnits += item.buffer.byteLength / 2;
        state.lost.fromSeq ??= item.descriptor?.seq; state.lost.toSeq = item.descriptor?.seq;
      }
      state.lost.reason = String(error.code || error.message || 'disk-write-error').slice(0, 64);
      if (writingRecord) state.lost.partialRecordPossible = true;
      throw error;
    }
  };
  return {
    async process(message) {
      await init(); const { kind, id } = message;
      if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('invalid-raw-id');
      if (kind === 'start') {
        if (active.has(id)) throw Error('raw-incident-already-started');
        if (!(await prune(MANIFEST_RESERVE_BYTES, 1))) throw Error('raw-disk-admission-budget');
        const folder = path.join(directory, 'raw-' + id);
        await fs.mkdir(folder, { mode: 0o700 });
        const handle = await fs.open(path.join(folder, 'stream.part'), 'wx', 0o600);
        const state = { folder, id, handle, createdAt: now(), summary: message.summary,
          records: 0, bytes: 0, sealed: false, lost: { events: 0, codeUnits: 0, fromSeq: null, toSeq: null } };
        active.set(id, state);
        await entries(state, message.entries); await handle.sync(); await manifest(state);
      } else {
        const state = active.get(id); if (!state) throw Error('raw-incident-not-started');
        if (kind === 'append') await entries(state, message.entries);
        else if (kind === 'seal') {
          state.summary = message.summary;
          await state.handle.sync(); await state.handle.close();
          await fs.rename(path.join(state.folder, 'stream.part'), path.join(state.folder, 'stream.bin'));
          state.sealed = true; await manifest(state); active.delete(id); await prune();
        } else throw Error('unknown-raw-operation');
      }
      return { state: kind === 'seal' ? 'sealed' : 'partial', manifestPath: path.join(directory, 'raw-' + id, 'manifest.json') };
    },
    async close() { for (const state of active.values()) await state.handle.close().catch(() => {}); active.clear(); },
    async stats() { await init(); const rows = await inventory(); return { artifacts: rows.length, bytes: rows.reduce((n, x) => n + x.size, 0), removed, active: active.size }; },
  };
}

if (!isMainThread) {
  const store = createTerminalRawArtifactStore(workerData);
  let chain = Promise.resolve();
  parentPort.on('message', message => {
    // Synchronous chain admission preserves begin/append/seal across async I/O.
    chain = chain.then(async () => {
      try { parentPort.postMessage({ requestId: message.requestId, ...(await store.process(message)) }); }
      catch (error) { parentPort.postMessage({ requestId: message.requestId, error: String(error.code || error.message).slice(0, 128) }); }
    });
  });
}
module.exports = { createTerminalRawArtifactStore, writeAll };
