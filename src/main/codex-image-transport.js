const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { maskPromptWebImageReferences } = require('../shared/prompt-web-images.cjs');

const ASSET_ID_RE = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const IMAGE_PATH_MARKER_RE = /\[imagePath:\s*([^\]\r\n]+?)\s*\]/gi;

function isPortableImagePath(rawPath) {
  const candidate = String(rawPath || '').trim();
  return candidate.length > 0 && path.isAbsolute(candidate);
}

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

function buildCodexImagePastePlan(text, stageImagePath, {
  missingCode = 'codex_image_path_unavailable',
  authoringTransport = null,
  includeSourceRanges = false,
} = {}) {
  if (typeof stageImagePath !== 'function') {
    throw new TypeError('stageImagePath must be a function');
  }

  const input = String(text || '');
  let imageMatches;
  if (authoringTransport !== null) {
    const reject = () => { throw Object.assign(new Error('structured_image_plan_invalid'), { code: 'structured_image_plan_invalid', submitted: false }); };
    if (!authoringTransport || authoringTransport.sourceHash !== crypto.createHash('sha256').update(input).digest('hex')
      || !Array.isArray(authoringTransport.imageRanges)) reject();
    let previousEnd = 0;
    imageMatches = authoringTransport.imageRanges.map(range => {
      if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end)
        || range.start < previousEnd || range.end <= range.start || range.end > input.length) reject();
      const match = new RegExp('^' + IMAGE_PATH_MARKER_RE.source + '$', 'i').exec(input.slice(range.start, range.end));
      if (!match || match[1] !== range.path || !isPortableImagePath(range.path)) reject();
      previousEnd = range.end;
      match.index = range.start;
      return match;
    });
  } else imageMatches = maskPromptWebImageReferences(input).matchAll(IMAGE_PATH_MARKER_RE);
  const segments = [];
  const staged = [];
  const missing = [];
  const outcomes = [];
  let replaced = 0;
  let cursor = 0;
  let outputLength = 0;

  const pushText = (value) => {
    if (!value) return;
    outputLength += value.length;
    const previous = segments[segments.length - 1];
    if (previous?.kind === 'text') {
      previous.text += value;
    } else {
      segments.push({ kind: 'text', text: value });
    }
  };

  for (const match of imageMatches) {
    const index = match.index ?? 0;
    pushText(input.slice(cursor, index));
    const rawPath = match[1];
    if (!isPortableImagePath(rawPath)) {
      // The renderer/import contract intentionally leaves relative paths and
      // prose examples untouched: their filesystem base cannot be proven at
      // the destination. Terminal MCP must use the same boundary instead of
      // silently turning documentation into an attachment/error slot.
      pushText(match[0]);
      cursor = index + match[0].length;
      continue;
    }

    replaced += 1;
    const result = stageImagePath(rawPath, { marker: match[0], start: index, end: index + match[0].length });
    const outputStart = outputLength;
    if (result?.success && typeof result.inputPath === 'string' && result.inputPath) {
      staged.push(result);
      segments.push({
        kind: 'image',
        text: result.inputPath,
        sourcePath: result.path || String(rawPath || '').trim(),
        ...(includeSourceRanges ? { sourceRange: { start: index, end: index + match[0].length } } : {}),
      });
      outputLength += result.inputPath.length;
      outcomes.push({ occurrence: replaced, sourceRange: { start: index, end: index + match[0].length },
        marker: match[0], sourcePath: rawPath.trim(), kind: 'image', text: result.inputPath,
        outputRange: { start: outputStart, end: outputLength }, refIndex: staged.length - 1 });
    } else {
      missing.push({
        path: result?.path || String(rawPath || '').trim(),
        error: result?.error || 'stage_failed',
      });
      const emitted = `[imageError: ${missingCode} #${replaced}]`;
      pushText(emitted);
      outcomes.push({ occurrence: replaced, sourceRange: { start: index, end: index + match[0].length },
        marker: match[0], sourcePath: rawPath.trim(), kind: 'unavailable', text: emitted,
        outputRange: { start: outputStart, end: outputLength }, error: result?.error || 'stage_failed' });
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
    transform: { stage: 'staging', inputHash: crypto.createHash('sha256').update(input).digest('hex'),
      inputLength: input.length, outputHash: crypto.createHash('sha256').update(segments.map(segment => segment.text).join('')).digest('hex'),
      outputLength, outcomes },
  };
}

function buildUnavailableImagePathPlan(text, missing = [], authoringTransport = null) {
  const unavailable = new Map(missing.map(item => [String(item?.path || '').trim(), item?.error || 'image_path_missing']));
  const plan = buildCodexImagePastePlan(text, (rawPath, occurrence) => unavailable.has(rawPath.trim())
    ? { success: false, path: rawPath.trim(), error: unavailable.get(rawPath.trim()) }
    : { success: true, path: rawPath.trim(), inputPath: occurrence.marker },
  { missingCode: 'queue_image_path_unavailable', authoringTransport });
  const outcomes = plan.transform.outcomes.map(outcome => outcome.kind === 'image'
    ? { ...outcome, kind: 'retained' } : outcome);
  const imageRanges = outcomes.filter(outcome => outcome.kind === 'retained').map(outcome => ({
    start: outcome.outputRange.start, end: outcome.outputRange.end,
    path: /\[imagePath:\s*([^\]\r\n]+?)\s*\]/i.exec(outcome.marker)[1],
  }));
  let fileRanges = authoringTransport?.fileRanges;
  if (fileRanges) {
    const { editAuthoringTransport } = require('./structured-authoring');
    let delta = 0;
    const edits = outcomes.filter(outcome => outcome.kind === 'unavailable').map(outcome => {
      const edit = { start: outcome.sourceRange.start + delta, end: outcome.sourceRange.end + delta, text: outcome.text };
      delta += outcome.text.length - (outcome.sourceRange.end - outcome.sourceRange.start); return edit;
    });
    fileRanges = editAuthoringTransport(String(text), authoringTransport, edits).authoringTransport.fileRanges;
  }
  return { text: plan.text, transform: { ...plan.transform, stage: 'preflight', outcomes },
    authoringTransport: { sourceHash: crypto.createHash('sha256').update(plan.text).digest('hex'), imageRanges,
      ...(fileRanges ? { fileRanges } : {}) } };
}

function replaceUnavailableImagePathMarkers(
  text,
  missing = [],
  missingCode = 'queue_image_path_unavailable',
) {
  const unavailablePaths = new Set(
    (Array.isArray(missing) ? missing : [])
      .map((item) => String(item?.path || '').trim()),
  );
  let slot = 0;
  const input = String(text || '');
  let output = '', cursor = 0;
  for (const match of maskPromptWebImageReferences(input).matchAll(IMAGE_PATH_MARKER_RE)) {
    const marker = match[0], rawPath = match[1];
    output += input.slice(cursor, match.index);
    cursor = match.index + marker.length;
    if (!isPortableImagePath(rawPath)) { output += marker; continue; }
    slot += 1;
    output += unavailablePaths.has(String(rawPath || '').trim())
      ? `[imageError: ${missingCode} #${slot}]`
      : marker;
  }
  return output + input.slice(cursor);
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
  buildUnavailableImagePathPlan,
  isPortableImagePath,
  replaceUnavailableImagePathMarkers,
};
