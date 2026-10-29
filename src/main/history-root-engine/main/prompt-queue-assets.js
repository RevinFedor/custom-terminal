const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ASSET_ID_RE = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
const DOCUMENT_ASSET_ID_RE = /^[a-f0-9]{64}\.document\.[a-z0-9]{1,16}$/i;
const MEDIA_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/bmp', 'bmp'],
  ['image/tiff', 'tiff'],
]);

function normalizeAssetId(value) {
  const assetId = typeof value === 'string' ? path.basename(value.trim()) : '';
  return ASSET_ID_RE.test(assetId) ? assetId.toLowerCase() : null;
}

// Documents share the file owner/GC, but are not image-preview capabilities.
function normalizeStoredAssetId(value) {
  const id = typeof value === 'string' ? path.basename(value.trim()) : '';
  return ASSET_ID_RE.test(id) || DOCUMENT_ASSET_ID_RE.test(id) ? id.toLowerCase() : null;
}

function normalizeExtension(filePath, mediaType) {
  const byMedia = MEDIA_EXTENSIONS.get(String(mediaType || '').toLowerCase());
  if (byMedia) return byMedia;
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  if (/^(?:png|jpe?g|gif|webp|bmp|tiff?)$/.test(ext)) {
    return ext === 'jpeg' ? 'jpg' : ext;
  }
  return 'png';
}

function mediaTypeFromExtension(extension) {
  const ext = String(extension || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
  return 'image/png';
}

function isPathInside(rootDir, candidate) {
  if (!rootDir || !candidate) return false;
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function collectReferencedAssetIds(queueState) {
  let parsed = queueState;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return new Set(); }
  }
  const out = new Set();
  if (!parsed || typeof parsed !== 'object') return out;
  for (const queue of Object.values(parsed)) {
    if (!queue || !Array.isArray(queue.items)) continue;
    for (const item of queue.items) {
      if (!item || !Array.isArray(item.imagePaths)) continue;
      for (const ref of item.imagePaths) {
        const assetId = normalizeAssetId(ref?.assetId) || normalizeAssetId(ref?.path);
        if (assetId) out.add(assetId);
      }
    }
  }
  return out;
}

function collectComposerDraftAssetIds(draftState) {
  let parsed = draftState;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return new Set(); }
  }
  const out = new Set();
  if (!parsed || typeof parsed !== 'object') return out;
  for (const draft of Object.values(parsed)) {
    if (!draft || !Array.isArray(draft.images)) continue;
    for (const ref of draft.images) {
      const assetId = normalizeAssetId(ref?.assetId) || normalizeAssetId(ref?.path);
      if (assetId) out.add(assetId);
    }
  }
  return out;
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

class PromptQueueAssetStore {
  constructor({ rootDir, logger = console, now = () => Date.now() }) {
    if (!rootDir) throw new Error('PromptQueueAssetStore rootDir is required');
    this.rootDir = path.resolve(rootDir);
    this.logger = logger;
    this.now = now;
    this.pendingLeases = new Map();
    this.leaseRevision = 0;
    this.collecting = new Map();
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  assetPath(assetId) {
    const normalized = normalizeStoredAssetId(assetId);
    return normalized ? path.join(this.rootDir, normalized) : null;
  }

  async existingManagedRef(ref) {
    const explicitAssetId = normalizeAssetId(ref?.assetId);
    let pathAssetId = isPathInside(this.rootDir, ref?.path) ? normalizeAssetId(ref?.path) : null;
    if (!explicitAssetId && !pathAssetId && typeof ref?.path === 'string' && path.isAbsolute(ref.path)) {
      const target = await fs.promises.realpath(ref.path).catch(() => null);
      const root = await fs.promises.realpath(this.rootDir).catch(() => null);
      if (root && isPathInside(root, target)) pathAssetId = normalizeAssetId(target);
    }
    const assetId = explicitAssetId || pathAssetId;
    if (!assetId) return null;
    const filePath = this.assetPath(assetId);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) return null;
    const touchedAt = new Date(this.now());
    await fs.promises.utimes(filePath, touchedAt, touchedAt).catch(() => {});
    const extension = path.extname(assetId).slice(1);
    return {
      ...ref,
      assetId,
      path: filePath,
      mediaType: ref?.mediaType || mediaTypeFromExtension(extension),
      size: stat.size,
      availability: 'available',
      error: undefined,
    };
  }

  existingManagedRefSync(ref) {
    const explicitAssetId = normalizeAssetId(ref?.assetId);
    let pathAssetId = isPathInside(this.rootDir, ref?.path) ? normalizeAssetId(ref?.path) : null;
    if (!explicitAssetId && !pathAssetId && typeof ref?.path === 'string' && path.isAbsolute(ref.path)) {
      try {
        const target = fs.realpathSync(ref.path);
        const root = fs.realpathSync(this.rootDir);
        if (isPathInside(root, target)) pathAssetId = normalizeAssetId(target);
      } catch {}
    }
    const assetId = explicitAssetId || pathAssetId;
    if (!assetId) return null;
    const filePath = this.assetPath(assetId);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const touchedAt = new Date(this.now());
    fs.utimes(filePath, touchedAt, touchedAt, () => {});
    const extension = path.extname(assetId).slice(1);
    return {
      ...ref,
      assetId,
      path: filePath,
      mediaType: ref?.mediaType || mediaTypeFromExtension(extension),
      size: stat.size,
      availability: 'available',
      error: undefined,
    };
  }

  async lease(assetId) {
    const id = normalizeStoredAssetId(assetId);
    if (!id) throw new Error('invalid_asset_id');
    // GC may already have committed an asynchronous unlink. Wait for that
    // exact deletion before publishing a new copy/ref; never ACK bytes that
    // an older collector is still about to remove.
    while (this.collecting.has(id)) await this.collecting.get(id);
    this.pendingLeases.set(id, (this.pendingLeases.get(id) || 0) + 1);
    this.leaseRevision += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pendingLeases.get(id) || 0) - 1;
      if (remaining > 0) this.pendingLeases.set(id, remaining);
      else this.pendingLeases.delete(id);
      this.leaseRevision += 1;
    };
  }

  async finalizeTemporaryFile(tempPath, ref = {}, { document = false, lease = false } = {}) {
    const digest = await hashFile(tempPath);
    const sourceExtension = path.extname(String(ref.name || ref.path || '')).slice(1).toLowerCase();
    const extension = document
      ? (/^[a-z0-9]{1,16}$/.test(sourceExtension) ? sourceExtension : 'bin')
      : normalizeExtension(ref.path, ref.mediaType);
    const assetId = digest + (document ? '.document.' : '.') + extension;
    const release = lease ? await this.lease(assetId) : null;
    try {
      const filePath = this.assetPath(assetId);
      const existing = await fs.promises.lstat(filePath).catch(() => null);
      if (existing && !existing.isFile()) throw new Error('asset_destination_invalid');
      if (existing) {
        await fs.promises.unlink(tempPath).catch(() => {});
        const touchedAt = new Date(this.now());
        await fs.promises.utimes(filePath, touchedAt, touchedAt).catch(() => {});
      } else {
        await fs.promises.rename(tempPath, filePath);
        await fs.promises.chmod(filePath, 0o600).catch(() => {});
      }
      const stat = await fs.promises.stat(filePath);
      return {
        ...ref,
        assetId,
        path: filePath,
        mediaType: ref.mediaType || (document ? 'application/octet-stream' : mediaTypeFromExtension(extension)),
        size: stat.size,
        availability: 'available',
        error: undefined,
        ...(release ? { release } : {}),
      };
    } catch (error) { release?.(); throw error; }
  }

  async materializeBuffer(buffer, ref = {}) {
    await this.ensureRoot();
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (bytes.length === 0) {
      return { ...ref, availability: 'missing', error: 'empty_image' };
    }
    const tempPath = path.join(
      this.rootDir,
      '.pending-' + process.pid + '-' + this.now() + '-' + crypto.randomBytes(6).toString('hex'),
    );
    try {
      await fs.promises.writeFile(tempPath, bytes, { mode: 0o600, flag: 'wx' });
      return await this.finalizeTemporaryFile(tempPath, ref);
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      return { ...ref, availability: 'missing', error: error?.code || error?.message || 'asset_write_failed' };
    }
  }

  async materializeRef(ref = {}) {
    await this.ensureRoot();
    const managed = await this.existingManagedRef(ref);
    if (managed) return managed;

    const sourcePath = typeof ref.path === 'string' ? ref.path.trim() : '';
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      return { ...ref, availability: 'missing', error: 'invalid_image_path' };
    }
    const sourceStat = await fs.promises.stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) {
      return { ...ref, availability: 'missing', error: 'image_path_missing' };
    }

    const tempPath = path.join(
      this.rootDir,
      '.pending-' + process.pid + '-' + this.now() + '-' + crypto.randomBytes(6).toString('hex'),
    );
    try {
      await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(tempPath, 0o600).catch(() => {});
      return await this.finalizeTemporaryFile(tempPath, {
        ...ref,
        mediaType: ref.mediaType || mediaTypeFromExtension(path.extname(sourcePath).slice(1)),
        size: sourceStat.size,
      });
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      return { ...ref, availability: 'missing', error: error?.code || error?.message || 'asset_copy_failed' };
    }
  }

  // Caller supplies an ALREADY authorized upload file handle. Never resolve an
  // arbitrary client path here; the upload admission checks its physical root.
  // One immutable copy serves both image and document execution after deletion
  // of the upload. A lease lasts only until the caller commits durable refs.
  async importUploadHandle(handle, ref = {}) {
    await this.ensureRoot();
    const temporary = path.join(this.rootDir, '.pending-upload-' + crypto.randomBytes(16).toString('hex'));
    let output;
    try {
      const before = await handle.stat();
      if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > 25 * 1024 * 1024) {
        throw new Error('attachment_source_invalid');
      }
      output = await fs.promises.open(temporary, 'wx', 0o600);
      const buffer = Buffer.alloc(128 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        if (position + bytesRead > 25 * 1024 * 1024) throw new Error('attachment_source_changed');
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, position + written);
          if (!result.bytesWritten) throw new Error('attachment_copy_incomplete');
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      const after = await handle.stat();
      if (position !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino || after.dev !== before.dev) {
        throw new Error('attachment_source_changed');
      }
      await output.sync();
      await output.close(); output = null;
      const { release, ...owned } = await this.finalizeTemporaryFile(temporary, ref,
        { document: ref.kind === 'file', lease: true });
      try {
        // Existing deduplicated bytes must be verified, not trusted by name.
        await this.verifyOwnedRef(owned);
        const directory = await fs.promises.open(this.rootDir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        return { ref: owned, release };
      } catch (error) { release(); throw error; }
    } catch (error) {
      if (output) await output.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async verifyOwnedRef(ref, { touch = false } = {}) {
    const id = normalizeStoredAssetId(ref?.assetId);
    if (!id) throw new Error('attachment_asset_invalid');
    const filePath = this.assetPath(id);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.size
      || await hashFile(filePath) !== id.slice(0, 64)) throw new Error('attachment_asset_changed');
    if (touch) {
      const usedAt = new Date(this.now());
      await fs.promises.utimes(filePath, usedAt, usedAt);
    }
    return { ...ref, path: filePath, availability: 'available' };
  }

  async materializeRefs(refs) {
    const input = Array.isArray(refs) ? refs : [];
    const output = [];
    const bySource = new Map();
    for (const ref of input) {
      const key = normalizeAssetId(ref?.assetId) || (typeof ref?.path === 'string' ? path.resolve(ref.path) : '');
      let result = key ? bySource.get(key) : null;
      if (!result) {
        result = await this.materializeRef(ref);
        if (key && result.availability === 'available') bySource.set(key, result);
      }
      output.push({
        ...result,
        id: Number.isFinite(Number(ref?.id)) ? Number(ref.id) : Number(result?.id) || 0,
      });
    }
    return output;
  }

  async garbageCollect(referencedAssetIds, { minAgeMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    const leaseRevision = this.leaseRevision;
    await this.ensureRoot();
    const referenced = referencedAssetIds instanceof Set
      ? referencedAssetIds
      : new Set(Array.isArray(referencedAssetIds) ? referencedAssetIds : []);
    const entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const removed = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const assetId = normalizeStoredAssetId(entry.name);
      if (!assetId || referenced.has(assetId) || this.pendingLeases.has(assetId)) continue;
      const filePath = path.join(this.rootDir, entry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat || this.now() - stat.mtimeMs < minAgeMs) continue;
      // The caller's durable inventory is a snapshot. A newly admitted Send
      // may already have released its temporary lease after committing SQLite
      // while this collector awaited stat, so checking only active leases is
      // insufficient. Defer collection on any intervening import/admission.
      if (leaseRevision !== this.leaseRevision) break;
      if (this.pendingLeases.has(assetId) || this.collecting.has(assetId)) continue;
      let finishCollection;
      this.collecting.set(assetId, new Promise(resolve => { finishCollection = resolve; }));
      try {
        await fs.promises.unlink(filePath);
        removed.push(assetId);
      } catch (error) {
        this.logger.warn?.('[PromptQueueAssets] cleanup failed asset=' + assetId + ' error=' + (error?.message || error));
      } finally {
        this.collecting.delete(assetId);
        finishCollection();
      }
    }
    return { removed, kept: entries.length - removed.length };
  }
}

module.exports = {
  PromptQueueAssetStore,
  normalizeStoredAssetId,
  collectComposerDraftAssetIds,
  collectReferencedAssetIds,
  isPathInside,
  mediaTypeFromExtension,
  normalizeAssetId,
};
