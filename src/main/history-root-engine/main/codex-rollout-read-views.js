'use strict';

// Read-only compatibility with native Codex rollout compression. JSONL byte
// offsets always address decoded bytes, never offsets inside the zstd stream.
// Presence discovery is separate and never invokes this decoder.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { buildChildProcessEnv } = require('./child-process-env');
const { currentReadControl, createDemandRegistry, createReadAdmission } = require('./history-read-control');
const { resolveExistingRollout, plainRolloutPath, compressedRolloutPath } = require('./codex-rollout-format');

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_DISK_FLOOR = 6 * 1024 * 1024 * 1024;
const OWNER_FILE = '.noted-readview-owner.json';
const fault = (code, message = code) => Object.assign(new Error(message), { code });
const pin = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function pruneAbandonedReadViews(tempRoot) {
  for (const e of await fsp.readdir(tempRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink() || !e.name.startsWith('noted-codex-readviews-')) continue;
    const root = path.join(tempRoot, e.name), marker = path.join(root, OWNER_FILE);
    try {
      const m = await fsp.lstat(marker);
      if (!m.isFile() || m.isSymbolicLink() || m.size > 4096 || m.nlink !== 1) continue;
      const owner = JSON.parse(await fsp.readFile(marker, 'utf8'));
      if (owner.version !== 1 || owner.kind !== 'noted-codex-readviews' || !Number.isInteger(owner.pid) || owner.pid <= 0) continue;
      try { process.kill(owner.pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
      const s = await fsp.lstat(root);
      if (s.isSymbolicLink() || s.dev !== owner.dev || s.ino !== owner.ino || await fsp.realpath(root) !== root) continue;
      const fresh = await fsp.lstat(root);
      if (fresh.dev !== s.dev || fresh.ino !== s.ino) continue;
      await fsp.rm(root, { recursive: true, force: false });
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) console.warn('[CodexReadView] abandoned cache kept:', error.code || error.message); }
  }
}

async function decodeZstd(source, target, { signal, maxOutputBytes, preferNative = true,
  diskFloorBytes = DEFAULT_DISK_FLOOR } = {}) {
  let bytes = 0, checkedBytes = 0;
  const count = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > maxOutputBytes) done(fault('CODEX_COMPRESSED_READ_DISK_CAPACITY', 'Insufficient temporary disk capacity to read compressed history'));
    else if (bytes - checkedBytes >= 16 * 1024 * 1024) {
      checkedBytes = bytes;
      fsp.statfs(path.dirname(target)).then(s => {
        if (Number(s.bavail) * Number(s.bsize) < diskFloorBytes + 32 * 1024 * 1024) done(fault('CODEX_COMPRESSED_READ_DISK_CAPACITY'));
        else done(null, chunk);
      }, done);
    } else done(null, chunk);
  } });
  const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
  if (preferNative && typeof zlib.createZstdDecompress === 'function') {
    await pipeline(fs.createReadStream(source), zlib.createZstdDecompress(), count, output, { signal });
  } else {
    // Electron28's Node does not have zstd. Use the standard PATH tool, not an
    // author-specific binary or a new Codex process/turn. Credentials stay out.
    const env = buildChildProcessEnv();
    env.PATH = [...new Set([...(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean))].join(path.delimiter);
    const child = spawn('zstd', ['-d', '-c', '-q', '--', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', spawnFailure = null;
    child.stderr.on('data', chunk => { if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048 - stderr.length); });
    const closed = new Promise((resolve, reject) => {
      child.once('error', error => { spawnFailure = error; reject(error); });
      child.once('close', (code, stopped) => code === 0 ? resolve()
        : reject(fault('CODEX_COMPRESSED_READ_DECODE_FAILED', 'Compressed history decoder failed (' + (stopped || code) + ')')));
    });
    closed.catch(() => {});
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.all([pipeline(child.stdout, count, output, { signal }), closed]);
    } catch (error) {
      abort(); await closed.catch(() => {});
      if (spawnFailure?.code === 'ENOENT') throw fault('CODEX_ZSTD_DECODER_UNAVAILABLE', 'Reading compressed Codex history needs Node zstd support or the zstd command on PATH');
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  const handle = await fsp.open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return bytes;
}

class CodexRolloutReadViews {
  constructor({ maxBytes = DEFAULT_MAX_BYTES, diskFloorBytes = DEFAULT_DISK_FLOOR,
    tempRoot = os.tmpdir(), decoder = decodeZstd, admitRead = async () => {}, freeBytes = async root => {
      const s = await fsp.statfs(root); return Number(s.bavail) * Number(s.bsize);
    } } = {}) {
    this.maxBytes = maxBytes; this.diskFloorBytes = diskFloorBytes;
    this.tempRoot = tempRoot; this.decoder = decoder; this.freeBytes = freeBytes; this.admitRead = admitRead; this.sequence = 0;
    this.rootPromise = null; this.entries = new Map(); this.byView = new Map();
    this.demands = createDemandRegistry(); this.admission = createReadAdmission(); this.bytes = 0; this.closed = false;
    this.pruning = null; this.ownedRoot = null;
  }
  root() {
    this.rootPromise ||= (async () => {
      this.canonicalTempRoot = await fsp.realpath(this.tempRoot);
      await pruneAbandonedReadViews(this.canonicalTempRoot);
      const root = await fsp.mkdtemp(path.join(this.canonicalTempRoot, 'noted-codex-readviews-'));
      this.ownedRoot = root; const s = await fsp.lstat(root); this.rootIdentity = [s.dev, s.ino];
      await fsp.writeFile(path.join(root, OWNER_FILE), JSON.stringify({ version: 1, kind: 'noted-codex-readviews', pid: process.pid, dev: s.dev, ino: s.ino }), { flag: 'wx', mode: 0o600 });
      return root;
    })();
    return this.rootPromise;
  }
  retain(entry, control) {
    control?.assertCurrent(); entry.used = ++this.sequence;
    if (!control?.onSettled || entry.controls.has(control)) return;
    entry.controls.add(control); entry.pins++;
    control.onSettled(() => { entry.pins--; this.prune().catch(error => console.warn('[CodexReadView] prune failed:', error.code || error.message)); });
  }
  async remove(entry) {
    if (entry.pins || entry.handoff || entry.removal || this.entries.get(entry.key) !== entry) return;
    entry.removal = this._remove(entry);
    try { await entry.removal; } finally { entry.removal = null; }
  }
  async _remove(entry) {
    const s = await fsp.lstat(entry.filePath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (s && (!s.isFile() || s.isSymbolicLink() || !same(pin(s), entry.viewPin))) throw fault('CODEX_READ_VIEW_CHANGED');
    if (s) await fsp.unlink(entry.filePath);
    this.entries.delete(entry.key); this.byView.delete(entry.filePath); this.bytes -= entry.size;
  }
  async prune({ incoming = false } = {}) {
    if (this.pruning) { await this.pruning; if (!incoming) return; }
    this.pruning = (async () => {
      for (const entry of [...this.entries.values()].sort((a, b) => a.used - b.used)) {
        if (this.bytes <= this.maxBytes && this.entries.size <= 32 && !this.closed) break;
        if (!incoming && !this.closed && this.entries.size === 1) break;
        if (!entry.pins) await this.remove(entry);
      }
    })();
    try { await this.pruning; } finally { this.pruning = null; }
  }
  async assertCurrent(filePath) {
    const entry = this.byView.get(filePath);
    if (!entry) return;
    const physical = await resolveExistingRollout(entry.sourceFilePath);
    if (physical.state !== 'present' || physical.filePath !== entry.sourceFilePath || !same(pin(physical.sourceStat), entry.sourcePin)) {
      throw fault('CODEX_SOURCE_READ_INVALIDATED', 'Compressed history source changed');
    }
  }
  backingPaths(filePath) {
    const entry = this.byView.get(filePath);
    return entry ? [plainRolloutPath(entry.sourceFilePath), compressedRolloutPath(entry.sourceFilePath)] : [];
  }
  backingSnapshot(filePath) {
    const entry = this.byView.get(filePath);
    if (!entry) return null;
    const [dev, ino, size, mtimeMs, ctimeMs] = entry.sourcePin;
    // Capture the container read by this view, not a later stat. A disposable
    // decoded inode must never become the durable History revision identity.
    return { filePath: entry.sourceFilePath, size, mtimeMs, ctimeMs,
      fileIdentity: dev + ':' + ino, representation: 'zstd' };
  }
  async prepare(filePath, { control = currentReadControl() } = {}) {
    control?.assertCurrent();
    if (this.closed) throw fault('CODEX_READ_VIEWS_CLOSED');
    const previous = this.byView.get(filePath);
    const resolved = await resolveExistingRollout(previous?.sourceFilePath || filePath);
    if (resolved.state !== 'present') throw fault(resolved.state === 'unknown' ? 'CODEX_SOURCE_UNAVAILABLE' : 'ENOENT');
    if (resolved.representation !== 'zstd') return { filePath: resolved.filePath, representation: 'jsonl' };
    const sourceFilePath = resolved.filePath, sourcePin = pin(resolved.sourceStat);
    const key = createHash('sha256').update(sourceFilePath + JSON.stringify(sourcePin)).digest('hex');
    let entry = this.entries.get(key);
    if (entry?.removal) { await entry.removal; entry = this.entries.get(key); }
    if (entry) {
      this.retain(entry, control);
      const actual = await fsp.lstat(entry.filePath).catch(() => null);
      if (!actual || !same(pin(actual), entry.viewPin)) throw fault('CODEX_READ_VIEW_CHANGED');
    } else {
      entry = await this.demands.run(key, control, async owned => {
        const existing = this.entries.get(key); if (existing) return existing;
        await this.admitRead(owned); owned.assertCurrent();
        const releaseAdmission = await this.admission.acquire(owned);
        try {
        const root = await this.root(); owned.assertCurrent();
        await this.prune({ incoming: true }); owned.assertCurrent();
        const maxOutputBytes = Math.max(0, await this.freeBytes(root) - this.diskFloorBytes - 32 * 1024 * 1024);
        if (!maxOutputBytes) throw fault('CODEX_COMPRESSED_READ_DISK_CAPACITY');
        const partial = path.join(root, key + '.partial'), view = path.join(root, 'rollout-' + key + '-' + path.basename(plainRolloutPath(sourceFilePath)));
        try {
          const size = await this.decoder(sourceFilePath, partial, { signal: owned.signal, maxOutputBytes, diskFloorBytes: this.diskFloorBytes });
          owned.assertCurrent();
          const after = await resolveExistingRollout(sourceFilePath);
          if (after.state !== 'present' || after.filePath !== sourceFilePath || !same(pin(after.sourceStat), sourcePin)) throw fault('CODEX_SOURCE_READ_INVALIDATED');
          await fsp.rename(partial, view); owned.assertCurrent();
          await fsp.utimes(view, resolved.sourceStat.atime, resolved.sourceStat.mtime);
          const viewStat = await fsp.lstat(view);
          if (!Number.isSafeInteger(size) || size < 0 || viewStat.size !== size) throw fault('CODEX_READ_VIEW_SIZE_INVALID');
          const result = { key, filePath: view, sourceFilePath, sourcePin, viewPin: pin(viewStat), size,
            sourceMode: resolved.sourceStat.mode & 0o777,
            used: ++this.sequence, pins: 0, handoff: true, controls: new WeakSet() };
          this.entries.set(key, result); this.byView.set(view, result); this.bytes += size;
          // A result Promise is not a borrower lease. Protect publication
          // through its Promise continuations, including last-demand cancel.
          result.handoffDone = new Promise(resolve => setImmediate(() => { result.handoff = false; resolve(); }));
          return result;
        } catch (error) {
          await fsp.unlink(partial).catch(() => {}); await fsp.unlink(view).catch(() => {}); throw error;
        }
        } finally { releaseAdmission(); }
      });
    }
    this.retain(entry, control);
    await this.assertCurrent(entry.filePath); control?.assertCurrent();
    return { filePath: entry.filePath, sourceFilePath, representation: 'zstd', temporaryReadView: true };
  }
  stats() { return { entries: this.entries.size, bytes: this.bytes, pinned: [...this.entries.values()].filter(e => e.pins).length, maxBytes: this.maxBytes }; }
  async materializeForMutation(filePath) {
    const entry = this.byView.get(filePath);
    if (!entry) return { filePath };
    await this.assertCurrent(filePath);
    const before = await fsp.lstat(filePath);
    if (!same(pin(before), entry.viewPin)) throw fault('CODEX_READ_VIEW_CHANGED');
    const nativePath = plainRolloutPath(entry.sourceFilePath), temporary = nativePath + '.noted-materialize-' + randomUUID() + '.tmp';
    try {
      await fsp.copyFile(filePath, temporary, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(temporary, entry.sourceMode);
      const h = await fsp.open(temporary, 'r'); try { await h.sync(); } finally { await h.close(); }
      await this.assertCurrent(filePath);
      if (!same(pin(await fsp.lstat(filePath)), entry.viewPin)) throw fault('CODEX_READ_VIEW_CHANGED');
      // Same no-clobber publication as native Codex. Only an already-authorized
      // in-place mutation calls this, never a badge, ordinary read or COW fork.
      await fsp.link(temporary, nativePath);
      const encoded = await fsp.stat(entry.sourceFilePath);
      if (!same(pin(encoded), entry.sourcePin)) throw fault('CODEX_SOURCE_READ_INVALIDATED');
      await fsp.unlink(entry.sourceFilePath);
      await fsp.unlink(temporary);
      return { filePath: nativePath, stat: await fsp.stat(nativePath), representationMaterialized: true };
    } catch (error) {
      // If publication succeeded, leave the byte-identical native file in
      // place rather than undoing over a possible new native writer.
      if (error.code === 'EEXIST') throw fault('CODEX_SOURCE_READ_INVALIDATED');
      throw error;
    } finally { await fsp.unlink(temporary).catch(() => {}); }
  }
  async close() {
    this.closed = true;
    if (this.demands.size || this.admission.active) throw fault('CODEX_READ_VIEWS_STILL_BORROWED');
    await Promise.all([...this.entries.values()].map(entry => entry.handoffDone));
    await this.prune({ incoming: true });
    if (this.entries.size) throw fault('CODEX_READ_VIEWS_STILL_BORROWED');
    if (this.rootPromise) {
      const root = await this.rootPromise;
      await fsp.unlink(path.join(root, OWNER_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fsp.rmdir(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

let defaults, defaultAdmission = async () => {};
function defaultViews() {
  if (!defaults) {
    defaults = new CodexRolloutReadViews({ admitRead: control => defaultAdmission(control) });
    // Best-effort own generated files only; never a provider source/profile.
    process.once('beforeExit', () => defaults.close().catch(error => console.warn('[CodexReadView] close failed:', error.code || error.message)));
    process.once('exit', () => {
      const root = defaults?.ownedRoot;
      if (!root || path.dirname(root) !== defaults.canonicalTempRoot || !path.basename(root).startsWith('noted-codex-readviews-')) return;
      try { const s = fs.lstatSync(root); if (!s.isSymbolicLink() && same([s.dev, s.ino], defaults.rootIdentity) && fs.realpathSync(root) === root) fs.rmSync(root, { recursive: true, force: true }); } catch {}
    });
  }
  return defaults;
}
module.exports = { CodexRolloutReadViews, decodeZstd,
  setCodexRolloutReadViewAdmission: admission => { defaultAdmission = typeof admission === 'function' ? admission : async () => {}; },
  closeCodexRolloutReadViews: () => defaults?.close(),
  prepareCodexRolloutReadFile: (filePath, options) => defaultViews().prepare(filePath, options),
  materializeCodexRolloutForMutation: filePath => defaultViews().materializeForMutation(filePath),
  codexRolloutBackingPaths: filePath => defaults?.backingPaths(filePath) || [],
  codexRolloutReadViewBacking: filePath => defaults?.backingSnapshot(filePath) || null,
  assertCodexRolloutReadViewCurrent: filePath => defaults?.assertCurrent(filePath),
  codexRolloutReadViewStats: () => defaults?.stats() || { entries: 0, bytes: 0, pinned: 0 } };
