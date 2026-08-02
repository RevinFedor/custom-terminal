const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ASSET_ID_RE = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
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
  }

  async ensureRoot() {
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  assetPath(assetId) {
    const normalized = normalizeAssetId(assetId);
    return normalized ? path.join(this.rootDir, normalized) : null;
  }

  async existingManagedRef(ref) {
    const explicitAssetId = normalizeAssetId(ref?.assetId);
    const pathAssetId = isPathInside(this.rootDir, ref?.path) ? normalizeAssetId(ref?.path) : null;
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

  async finalizeTemporaryFile(tempPath, ref = {}) {
    const digest = await hashFile(tempPath);
    const extension = normalizeExtension(ref.path, ref.mediaType);
    const assetId = digest + '.' + extension;
    const filePath = this.assetPath(assetId);
    const existing = await fs.promises.stat(filePath).catch(() => null);
    if (existing?.isFile()) {
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
      mediaType: ref.mediaType || mediaTypeFromExtension(extension),
      size: stat.size,
      availability: 'available',
      error: undefined,
    };
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
    await this.ensureRoot();
    const referenced = referencedAssetIds instanceof Set
      ? referencedAssetIds
      : new Set(Array.isArray(referencedAssetIds) ? referencedAssetIds : []);
    const entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const removed = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const assetId = normalizeAssetId(entry.name);
      if (!assetId || referenced.has(assetId)) continue;
      const filePath = path.join(this.rootDir, entry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat || this.now() - stat.mtimeMs < minAgeMs) continue;
      try {
        await fs.promises.unlink(filePath);
        removed.push(assetId);
      } catch (error) {
        this.logger.warn?.('[PromptQueueAssets] cleanup failed asset=' + assetId + ' error=' + (error?.message || error));
      }
    }
    return { removed, kept: entries.length - removed.length };
  }
}

module.exports = {
  PromptQueueAssetStore,
  collectComposerDraftAssetIds,
  collectReferencedAssetIds,
  isPathInside,
  mediaTypeFromExtension,
  normalizeAssetId,
};
