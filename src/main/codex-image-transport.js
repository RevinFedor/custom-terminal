const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ASSET_ID_RE = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const IMAGE_PATH_MARKER_RE = /\[imagePath:\s*([^\]\r\n]+?)\s*\]/gi;

function safeExtension(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  return /^\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/.test(extension) ? extension : '.png';
}

function aliasNameForRef(ref, sourcePath, stat) {
  const assetId = typeof ref?.assetId === 'string' ? path.basename(ref.assetId) : '';
  if (ASSET_ID_RE.test(assetId)) return assetId.toLowerCase();
  const fingerprint = [sourcePath, stat.size, stat.mtimeMs].join('\n');
  return crypto.createHash('sha256').update(fingerprint).digest('hex') + safeExtension(sourcePath);
}

function buildCodexImagePastePlan(text, stageImagePath) {
  if (typeof stageImagePath !== 'function') {
    throw new TypeError('stageImagePath must be a function');
  }

  const input = String(text || '');
  const segments = [];
  const staged = [];
  const missing = [];
  let replaced = 0;
  let cursor = 0;

  const pushText = (value) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous?.kind === 'text') {
      previous.text += value;
    } else {
      segments.push({ kind: 'text', text: value });
    }
  };

  for (const match of input.matchAll(IMAGE_PATH_MARKER_RE)) {
    const index = match.index ?? 0;
    pushText(input.slice(cursor, index));
    replaced += 1;

    const rawPath = match[1];
    const result = stageImagePath(rawPath);
    if (result?.success && typeof result.inputPath === 'string' && result.inputPath) {
      staged.push(result);
      segments.push({
        kind: 'image',
        text: result.inputPath,
        sourcePath: result.path || String(rawPath || '').trim(),
      });
    } else {
      missing.push({
        path: result?.path || String(rawPath || '').trim(),
        error: result?.error || 'stage_failed',
      });
      pushText(match[0]);
    }
    cursor = index + match[0].length;
  }

  pushText(input.slice(cursor));
  if (segments.length === 0 && input) segments.push({ kind: 'text', text: input });

  return {
    text: segments.map(segment => segment.text).join(''),
    segments,
    replaced,
    staged,
    missing,
  };
}

class CodexImageTransport {
  constructor({ rootDir, now = () => Date.now(), retentionMs = DEFAULT_RETENTION_MS } = {}) {
    if (!rootDir) throw new Error('CodexImageTransport rootDir is required');
    this.rootDir = path.resolve(rootDir);
    if (/\s/.test(this.rootDir)) {
      throw new Error('CodexImageTransport rootDir must not contain whitespace');
    }
    this.now = now;
    this.retentionMs = retentionMs;
    this.lastPruneAt = 0;
  }

  ensureRootSync() {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    if (this.now() - this.lastPruneAt < 60 * 60 * 1000) return;
    this.lastPruneAt = this.now();
    this.pruneSync();
  }

  pruneSync() {
    const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const aliasPath = path.join(this.rootDir, entry.name);
      let remove = !entry.isSymbolicLink() && !entry.isFile();
      let stat = null;
      try { stat = fs.lstatSync(aliasPath); } catch { remove = true; }
      if (stat && this.now() - stat.mtimeMs >= this.retentionMs) remove = true;
      if (entry.isSymbolicLink()) {
        try { fs.statSync(aliasPath); } catch { remove = true; }
      }
      if (remove) {
        try { fs.unlinkSync(aliasPath); } catch {}
      }
    }
  }

  stageSync(ref = {}) {
    const rawSourcePath = typeof ref.path === 'string' ? ref.path.trim() : '';
    if (!rawSourcePath || !path.isAbsolute(rawSourcePath)) {
      return { success: false, error: 'invalid_image_path', path: rawSourcePath || null };
    }
    const sourcePath = path.resolve(rawSourcePath);
    let sourceStat = null;
    try { sourceStat = fs.statSync(sourcePath); } catch {}
    if (!sourceStat?.isFile()) {
      return { success: false, error: 'image_path_missing', path: sourcePath };
    }

    try {
      this.ensureRootSync();
      const aliasPath = path.join(this.rootDir, aliasNameForRef(ref, sourcePath, sourceStat));
      let reuse = false;
      try {
        const aliasStat = fs.lstatSync(aliasPath);
        if (aliasStat.isSymbolicLink()) {
          const target = fs.readlinkSync(aliasPath);
          reuse = path.resolve(path.dirname(aliasPath), target) === sourcePath;
        }
        if (!reuse) fs.unlinkSync(aliasPath);
      } catch {}

      if (!reuse) {
        try {
          fs.symlinkSync(sourcePath, aliasPath, 'file');
        } catch (error) {
          // Some Windows environments disallow symlinks. A hard link still
          // avoids copying image bytes and keeps the transport path whitespace-free.
          try {
            fs.linkSync(sourcePath, aliasPath);
          } catch (hardLinkError) {
            return {
              success: false,
              error: hardLinkError?.code || error?.code || 'image_alias_failed',
              path: sourcePath,
            };
          }
        }
      } else if (typeof fs.lutimesSync === 'function') {
        const touchedAt = new Date(this.now());
        try { fs.lutimesSync(aliasPath, touchedAt, touchedAt); } catch {}
      }

      return {
        success: true,
        path: aliasPath,
        sourcePath,
        size: sourceStat.size,
      };
    } catch (error) {
      return { success: false, error: error?.code || error?.message || 'image_alias_failed', path: sourcePath };
    }
  }
}

module.exports = {
  CodexImageTransport,
  aliasNameForRef,
  buildCodexImagePastePlan,
};
