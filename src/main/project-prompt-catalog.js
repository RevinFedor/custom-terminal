const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { causal } = require('./perf-causal-context');

const { PROMPT_SOURCE_FOLDER, PROMPT_SUFFIX, includePromptSourceEntry } = require('../shared/prompt-source-policy.cjs');
const { PreparedPromptCatalog } = require('./prompt-catalog-preparation');
const ROOT_PARENT = '__root__';
// Reuse the same natural-order rules across the whole catalog scan. Passing
// options to localeCompare builds a collator for every pair in Array.sort.
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function naturalCompare(a, b) {
  return naturalCollator.compare(String(a || ''), String(b || ''));
}

function expandHome(input) {
  const value = String(input || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function canonicalPath(input, fsImpl = fs, cache, knownPaths) {
  const resolved = path.resolve(expandHome(input));
  if (cache?.has(resolved)) {
    causal.count('canonicalHits');
    return cache.get(resolved);
  }
  causal.count('canonicalReads');
  let canonical = resolved;
  try {
    canonical = fsImpl.realpathSync.native
      ? fsImpl.realpathSync.native(resolved)
      : fsImpl.realpathSync(resolved);
    knownPaths?.set(resolved, true);
  } catch { knownPaths?.set(resolved, false); }
  cache?.set(resolved, canonical);
  return canonical;
}

function resolvedSourcePath(input) {
  return path.resolve(expandHome(input));
}

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function sourceOverlap(a, b) {
  return isInside(a, b) || isInside(b, a);
}

function normalizeSourceRoots(roots, fsImpl = fs) {
  const normalized = [];
  const seen = new Set();
  for (const value of Array.isArray(roots) ? roots : []) {
    const raw = typeof value === 'string' ? value : value?.rootPath;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const rootPath = resolvedSourcePath(raw);
    const identityPath = canonicalPath(rootPath, fsImpl);
    if (seen.has(identityPath)) continue;
    seen.add(identityPath);
    normalized.push({ rootPath, identityPath });
  }
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (sourceOverlap(normalized[i].identityPath, normalized[j].identityPath)) {
        const error = new Error('overlapping_prompt_sources');
        error.code = 'overlapping_prompt_sources';
        error.paths = [normalized[i].rootPath, normalized[j].rootPath];
        throw error;
      }
    }
  }
  return normalized.map((source) => source.rootPath);
}

function sourceDisplayLabels(sourcePaths) {
  const basenameCounts = new Map();
  for (const rootPath of sourcePaths) {
    const basename = path.basename(rootPath) || rootPath;
    basenameCounts.set(basename.toLocaleLowerCase(), (basenameCounts.get(basename.toLocaleLowerCase()) || 0) + 1);
  }
  return new Map(sourcePaths.map((rootPath) => {
    const basename = path.basename(rootPath) || rootPath;
    const duplicate = (basenameCounts.get(basename.toLocaleLowerCase()) || 0) > 1;
    return [rootPath, duplicate ? `${basename} · ${path.dirname(rootPath)}` : basename];
  }));
}

function safeDirectoryEntries(dirPath, fsImpl = fs) {
  try {
    causal.count('directoryReads');
    return fsImpl.readdirSync(dirPath, { withFileTypes: true })
      .filter(includePromptSourceEntry)
      .map((entry) => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
      }));
  } catch {
    return [];
  }
}

function baseEntryCompare(a, b) {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return naturalCompare(a.name, b.name);
}

// Mirrors the shared explorer's manual sibling ordering, including visual
// file children. The layout is keyed by the exact configured source root.
function orderDirectoryEntries(entries, dirPath, rootPath, rawLayout) {
  const layout = rawLayout && typeof rawLayout === 'object' ? rawLayout : {};
  const parentKey = dirPath === rootPath ? ROOT_PARENT : dirPath;
  const base = [...entries].sort(baseEntryCompare);
  const byPath = new Map(base.map((entry) => [entry.path, entry]));
  const requested = Array.isArray(layout.orderByParent?.[parentKey])
    ? layout.orderByParent[parentKey]
    : [];
  const ordered = [];
  const used = new Set();
  for (const filePath of requested) {
    const entry = byPath.get(filePath);
    if (!entry || used.has(filePath)) continue;
    ordered.push(entry);
    used.add(filePath);
  }
  for (const entry of base) {
    if (!used.has(entry.path)) ordered.push(entry);
  }

  const visualParents = layout.visualParentByPath || {};
  const childrenByParent = new Map();
  const roots = [];
  for (const entry of ordered) {
    const parentPath = visualParents[entry.path];
    const parent = parentPath ? byPath.get(parentPath) : null;
    if (!entry.isDirectory && parent && !parent.isDirectory && parentPath !== entry.path) {
      const list = childrenByParent.get(parentPath) || [];
      list.push(entry);
      childrenByParent.set(parentPath, list);
    } else {
      roots.push(entry);
    }
  }

  const result = [];
  const seen = new Set();
  const visit = (entry) => {
    if (!entry || seen.has(entry.path)) return;
    seen.add(entry.path);
    result.push(entry);
    for (const child of childrenByParent.get(entry.path) || []) visit(child);
  };
  roots.forEach(visit);
  ordered.forEach(visit);
  return result;
}

function sourceDirectoryState(rootPath, fsImpl, readContext) {
  if (readContext?.directories.has(rootPath)) {
    causal.count('directoryHits');
    return readContext.directories.get(rootPath);
  }
  const docsPath = path.join(rootPath, PROMPT_SOURCE_FOLDER);
  let rootExists = false;
  let docsExists = false;
  causal.count('statReads', 2);
  try { rootExists = fsImpl.statSync(rootPath).isDirectory(); } catch {}
  try { docsExists = fsImpl.statSync(docsPath).isDirectory(); } catch {}
  const value = { docsPath, exists: rootExists, docsExists };
  readContext?.directories.set(rootPath, value);
  return value;
}

// A usage-only scan may omit unrelated subtrees. Such records must never warm
// the complete picker catalog. Weak metadata leaves every public DTO unchanged.
const partialUsageScans = new WeakSet();
function scanSource({ projectId, rootPath, sourceName, layout, fsImpl = fs, readContext }) {
  causal.count('sourceScans');
  const { docsPath, exists: rootExists, docsExists } = sourceDirectoryState(rootPath, fsImpl, readContext);

  const prompts = [];
  let partial = false;
  if (docsExists) {
    const walk = (dirPath, scanWholeSubtree = false) => {
      const usageRoot = readContext?.usageRoot;
      if (usageRoot && !scanWholeSubtree) {
        const real = canonicalPath(dirPath, fsImpl, readContext.canonicalPaths, readContext.canonicalKnown);
        // Failed realpath is UNKNOWN, not proof of disjointness. Preserve the
        // original full walk in that case, including its read/error behavior.
        if (readContext.canonicalKnown.get(path.resolve(dirPath)) === true) {
          // A known directory realpath does not prove that every leaf realpath
          // will succeed. Preserve the final filter's configured-path fallback.
          if (!sourceOverlap(usageRoot, real) && !sourceOverlap(usageRoot, path.resolve(dirPath))) {
            partial = true; causal.count('usageSubtreesSkipped'); return;
          }
          scanWholeSubtree = isInside(usageRoot, real);
        } else { scanWholeSubtree = true; causal.count('usageCanonicalUnknown'); }
      }
      const entries = orderDirectoryEntries(
        safeDirectoryEntries(dirPath, fsImpl),
        dirPath,
        rootPath,
        layout,
      );
      for (const entry of entries) {
        if (entry.isDirectory) {
          walk(entry.path, scanWholeSubtree);
          continue;
        }
        if (!entry.name.toLocaleLowerCase().endsWith(PROMPT_SUFFIX)) continue;
        const relativePath = path.relative(rootPath, entry.path);
        const title = entry.name.slice(0, -PROMPT_SUFFIX.length) || entry.name;
        prompts.push({
          id: `project-prompt:${projectId}:${crypto.createHash('sha1').update(entry.path).digest('hex').slice(0, 16)}`,
          title,
          content: '',
          position: prompts.length,
          group_id: null,
          file_paths: [entry.path],
          path: entry.path,
          relativePath,
          sourceRoot: rootPath,
          sourceName,
          projectId,
        });
      }
    };
    walk(docsPath);
  }

  const result = {
    rootPath,
    sourceName,
    docsPath,
    exists: rootExists,
    docsExists,
    promptCount: prompts.length,
    prompts,
  };
  if (partial) partialUsageScans.add(result);
  return result;
}

function catalogSource(input, readContext) {
  if (!readContext) return scanSource(input);
  // Prompt IDs include the namespace; labels/manual layout use the configured
  // path, not its realpath. Share only exact equivalents during this one read.
  const key = JSON.stringify([typeof input.projectId, input.projectId, input.rootPath, input.sourceName, input.layout]);
  let value = readContext.scans.get(key);
  if (!value) {
    value = scanSource({ ...input, readContext });
    readContext.scans.set(key, value);
  } else causal.count('scanHits');
  // Each retained tab catalog still owns its records and attachment arrays.
  const result = { ...value, prompts: value.prompts.map(prompt => ({ ...prompt, file_paths: [...prompt.file_paths] })) };
  if (partialUsageScans.has(value)) partialUsageScans.add(result);
  return result;
}

class ProjectPromptCatalogService {
  constructor({ db, layoutStore, rootRegistry = null, onChanged = null, fsImpl = fs, watch = true,
    asyncFs, controlOptions, authorityFence } = {}) {
    if (!db) throw new Error('ProjectPromptCatalogService requires db');
    this.db = db; this.layoutStore = layoutStore || null; this.rootRegistry = rootRegistry;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.fs = fsImpl; this.watchEnabled = watch;
    // Compatibility maps contain no retained tab/project catalogs.
    this.cache = new Map(); this.tabCache = new Map(); this.watchDebounce = new Map();
    this.resolveSourcePath = resolvedSourcePath; this.inside = isInside;
    this.preparationOptions = { asyncFs, controlOptions, authorityFence };
    this.prepared = new PreparedPromptCatalog(this, this.preparationOptions);
    this.watchers = this.prepared.watchers;
  }

  preparation() {
    // Explicit reuse after close creates a new lifetime; old callbacks stay sealed.
    if (this.prepared.closed) {
      this.prepared = new PreparedPromptCatalog(this, this.preparationOptions);
      this.watchers = this.prepared.watchers;
    }
    return this.prepared;
  }

  getSources(projectId, readContext) {
    const work = () => {
      const rows = this.db.getProjectPromptSources(projectId);
      return this.describeSources(rows, readContext);
    };
    return causal.hasWork() ? work() : causal.syncWork('catalog.getSources', {}, work);
  }

  describeSources(rows, readContext) {
    // Preserve the configured spelling for the shared layout key. A symlinked
    // root and its real path are the same source identity, but the explorer's
    // manual order is intentionally keyed by the exact root the user opened.
    const roots = rows.map((row) => resolvedSourcePath(row.rootPath));
    const labels = sourceDisplayLabels(roots);
    return rows.map((row, index) => {
      const rootPath = roots[index];
      const { docsPath, exists, docsExists } = sourceDirectoryState(rootPath, this.fs, readContext);
      return {
        ...row,
        rootPath,
        sourceName: labels.get(rootPath),
        docsPath,
        exists,
        docsExists,
      };
    });
  }

  getTabSources(tabId, readContext) {
    const work = () => {
      if (!this.rootRegistry) {
        throw Object.assign(new Error('root_registry_unavailable'), { code: 'root_registry_unavailable' });
      }
      if (typeof tabId !== 'string' || !tabId) {
        throw Object.assign(new Error('tab_id_required'), { code: 'tab_id_required' });
      }
      const sources = readContext?.sourcesForTab
        ? readContext.sourcesForTab(tabId) : this.rootRegistry.sourcesForTab(tabId);
      return this.describeSources(sources, readContext);
    };
    return causal.hasWork() ? work() : causal.syncWork('catalog.getTabSources', { tabId }, work);
  }

  setTabSources(request) {
    const work = () => {
      const current = this.getTabSources(request?.tabId);
      const snapshot = this.rootRegistry.read();
      const roots = snapshot.roots;
      const byId = new Map([...current, ...roots.map(root => ({ ...root, rootPath: root.path }))]
        .map(root => [root.rootId || root.id, root]));
      const selected = (Array.isArray(request.rootIds) ? request.rootIds : []).map(id => byId.get(id));
      // Preserve unavailable registrations; path existence is not binding validity.
      const known = selected.filter(Boolean);
      // A committed retry has an older revision. Let the registry return its
      // durable receipt before validating paths that may since have changed.
      if (request.expectedRevision === snapshot.revision && normalizeSourceRoots(known, this.fs).length !== known.length) {
        throw Object.assign(new Error('overlapping_prompt_sources'), {
          code: 'overlapping_prompt_sources', paths: known.map(source => source.rootPath),
        });
      }
      const result = this.rootRegistry.setTabSources(request);
      this.invalidateTabs([request.tabId], 'sources-changed');
      this.refreshWatchers();
      return result;
    };
    return causal.hasWork() ? work() : causal.syncWork('catalog.setTabSources', {}, work);
  }

  listTab(tabId, options = {}) { return this.preparation().list('tab', tabId, options); }

  setSources(projectId, roots) {
    const work = () => {
      const normalized = normalizeSourceRoots(roots, this.fs);
      const saved = this.db.saveProjectPromptSources(projectId, normalized);
      this.invalidate([projectId], 'sources-changed');
      this.refreshWatchers();
      return saved;
    };
    return causal.hasWork() ? work() : causal.syncWork('catalog.setSources', {}, work);
  }

  listProject(projectId, options = {}) { return this.preparation().list('project', projectId, options); }

  usageForRoot(rootPath) { return this.preparation().usage(rootPath); }

  invalidate(projectIds = null, reason = 'filesystem') {
    this.preparation().invalidate(null, reason, projectIds || []);
  }

  invalidateTabs(tabIds = null, reason = 'filesystem', projectIds = []) {
    this.preparation().invalidate(tabIds, reason, projectIds);
  }

  refreshWatchers(options) {
    // Constructor, composition and committed mutation callers only schedule.
    this.preparation().refreshWatchers(options);
  }

  onLayoutCommitted(rootPath) {
    // Called AFTER the layout owner's ok:true commit. No FS/SQL traversal and
    // no exception may rewrite that already committed CAS result.
    try {
      return this.preparation().onLayoutCommitted(resolvedSourcePath(rootPath));
    } catch {
      return { scheduled: false, state: 'unavailable' };
    }
  }

  close() { this.prepared.close(); this.cache.clear(); this.tabCache.clear(); }

  readLayout(rootPath) {
    if (this.layoutStore) causal.count('layoutReads');
    return this.layoutStore?.get(rootPath)?.layout || null;
  }
}

module.exports = {
  PROMPT_SUFFIX,
  ProjectPromptCatalogService,
  canonicalPath,
  isInside,
  normalizeSourceRoots,
  orderDirectoryEntries,
  scanSource,
};
