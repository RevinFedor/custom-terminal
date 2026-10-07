const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROMPT_SUFFIX = '.prompt.md';
const ROOT_PARENT = '__root__';
const CACHE_TTL_MS = 1500;
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

function canonicalPath(input, fsImpl = fs, cache) {
  const resolved = path.resolve(expandHome(input));
  if (cache?.has(resolved)) return cache.get(resolved);
  let canonical = resolved;
  try {
    canonical = fsImpl.realpathSync.native
      ? fsImpl.realpathSync.native(resolved)
      : fsImpl.realpathSync(resolved);
  } catch {}
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
    return fsImpl.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink())
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
  if (readContext?.directories.has(rootPath)) return readContext.directories.get(rootPath);
  const docsPath = path.join(rootPath, 'docs');
  let rootExists = false;
  let docsExists = false;
  try { rootExists = fsImpl.statSync(rootPath).isDirectory(); } catch {}
  try { docsExists = fsImpl.statSync(docsPath).isDirectory(); } catch {}
  const value = { docsPath, exists: rootExists, docsExists };
  readContext?.directories.set(rootPath, value);
  return value;
}

function scanSource({ projectId, rootPath, sourceName, layout, fsImpl = fs, readContext }) {
  const { docsPath, exists: rootExists, docsExists } = sourceDirectoryState(rootPath, fsImpl, readContext);

  const prompts = [];
  if (docsExists) {
    const walk = (dirPath) => {
      const entries = orderDirectoryEntries(
        safeDirectoryEntries(dirPath, fsImpl),
        dirPath,
        rootPath,
        layout,
      );
      for (const entry of entries) {
        if (entry.isDirectory) {
          walk(entry.path);
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

  return {
    rootPath,
    sourceName,
    docsPath,
    exists: rootExists,
    docsExists,
    promptCount: prompts.length,
    prompts,
  };
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
  }
  // Each retained tab catalog still owns its records and attachment arrays.
  return { ...value, prompts: value.prompts.map(prompt => ({ ...prompt, file_paths: [...prompt.file_paths] })) };
}

class ProjectPromptCatalogService {
  constructor({ db, layoutStore, rootRegistry = null, onChanged = null, fsImpl = fs, watch = true } = {}) {
    if (!db) throw new Error('ProjectPromptCatalogService requires db');
    this.db = db;
    this.layoutStore = layoutStore || null;
    this.rootRegistry = rootRegistry;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.fs = fsImpl;
    this.watchEnabled = watch;
    this.cache = new Map();
    this.tabCache = new Map();
    this.watchers = new Map();
    this.watchDebounce = new Map();
    if (watch) this.refreshWatchers();
  }

  getSources(projectId, readContext) {
    const rows = this.db.getProjectPromptSources(projectId);
    return this.describeSources(rows, readContext);
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
    if (!this.rootRegistry) {
      throw Object.assign(new Error('root_registry_unavailable'), { code: 'root_registry_unavailable' });
    }
    if (typeof tabId !== 'string' || !tabId) {
      throw Object.assign(new Error('tab_id_required'), { code: 'tab_id_required' });
    }
    return this.describeSources(this.rootRegistry.sourcesForTab(tabId), readContext);
  }

  setTabSources(request) {
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
  }

  listTab(tabId, { force = false, refreshWatchers = true, readContext } = {}) {
    const allSources = this.getTabSources(tabId, readContext);
    const signature = JSON.stringify(allSources);
    const cached = this.tabCache.get(tabId);
    if (!force && cached?.signature === signature && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
    const sources = allSources.filter(source => source.enabled === true)
      .sort((a, b) => naturalCompare(a.sourceName, b.sourceName));
    const scannedSources = sources.map(source => ({
      ...source,
      ...catalogSource({
        // The namespace of the ORIGINAL binding is part of the prompt id.
        projectId: source.projectId,
        rootPath: source.rootPath,
        sourceName: source.sourceName,
        layout: this.layoutStore?.get(source.rootPath)?.layout || null,
        fsImpl: this.fs,
      }, readContext),
    }));
    const value = {
      tabId,
      sources: scannedSources.map(({ prompts, ...source }) => ({ ...source, promptCount: prompts.length })),
      prompts: scannedSources.flatMap(source => source.prompts),
      updatedAt: Date.now(),
    };
    this.tabCache.set(tabId, { signature, cachedAt: Date.now(), value });
    // Missing roots can reappear while the picker was closed.
    if (refreshWatchers) this.refreshWatchers();
    return value;
  }

  setSources(projectId, roots) {
    const normalized = normalizeSourceRoots(roots, this.fs);
    const saved = this.db.saveProjectPromptSources(projectId, normalized);
    this.invalidate([projectId], 'sources-changed');
    this.refreshWatchers();
    return saved;
  }

  listProject(projectId, { force = false, readContext } = {}) {
    const cached = this.cache.get(projectId);
    if (!force && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

    const project = this.db.getProjectById(projectId);
    if (!project) {
      const error = new Error('project_not_found');
      error.code = 'project_not_found';
      throw error;
    }
    const sources = this.getSources(projectId, readContext)
      .sort((a, b) => naturalCompare(a.sourceName, b.sourceName));
    const scannedSources = sources.map((source) => {
      const layout = this.layoutStore?.get(source.rootPath)?.layout || null;
      return catalogSource({
        projectId,
        rootPath: source.rootPath,
        sourceName: source.sourceName,
        layout,
        fsImpl: this.fs,
      }, readContext);
    });
    const prompts = scannedSources.flatMap((source) => source.prompts);
    const value = {
      project: {
        id: project.id,
        name: project.name,
        path: project.path,
        icon: project.icon || null,
      },
      sources: scannedSources.map(({ prompts: sourcePrompts, ...source }) => ({
        ...source,
        promptCount: sourcePrompts.length,
      })),
      prompts,
      updatedAt: Date.now(),
    };
    this.cache.set(projectId, { cachedAt: Date.now(), value });
    return value;
  }

  usageForRoot(rootPath) {
    // A usage request can include hundreds of open and archived tab bindings.
    // Keep the exact per-tab checks/cache, but reuse identical synchronous reads
    // inside this request. Nothing here survives into the next usage request.
    const readContext = { directories: new Map(), scans: new Map(), canonicalPaths: new Map(), projects: new Map() };
    const canonical = value => canonicalPath(value, this.fs, readContext.canonicalPaths);
    const canonicalRoot = canonical(rootPath);
    const byPath = new Map();
    if (this.rootRegistry) {
      for (const scope of this.rootRegistry.listSourceScopes()) {
        const catalog = this.listTab(scope.tabId, { refreshWatchers: false, readContext });
        for (const prompt of catalog.prompts) {
          if (!isInside(canonicalRoot, canonical(prompt.path))) continue;
          const usage = byPath.get(prompt.path) || { projects: new Map(), tabs: new Map() };
          usage.tabs.set(scope.tabId, { id: scope.tabId, name: scope.name || scope.tabId });
          if (prompt.projectId && !readContext.projects.has(prompt.projectId)) {
            readContext.projects.set(prompt.projectId, this.db.getProjectById(prompt.projectId));
          }
          const project = readContext.projects.get(prompt.projectId);
          if (project) usage.projects.set(project.id, { id: project.id, name: project.name, icon: project.icon || null });
          byPath.set(prompt.path, usage);
        }
      }
      this.refreshWatchers();
      return [...byPath.entries()].sort(([a], [b]) => naturalCompare(a, b))
        .map(([filePath, usage]) => ({
          path: filePath,
          projects: [...usage.projects.values()].sort((a, b) => naturalCompare(a.name, b.name)),
          tabs: [...usage.tabs.values()],
        }));
    }
    for (const project of this.db.getProjectsWithPromptSources()) {
      let catalog;
      try { catalog = this.listProject(project.id, { readContext }); } catch { continue; }
      for (const prompt of catalog.prompts) {
        if (!isInside(canonicalRoot, canonical(prompt.path))) continue;
        const existing = byPath.get(prompt.path) || [];
        existing.push({
          id: catalog.project.id,
          name: catalog.project.name,
          icon: catalog.project.icon || null,
        });
        byPath.set(prompt.path, existing);
      }
    }
    return [...byPath.entries()]
      .sort(([a], [b]) => naturalCompare(a, b))
      .map(([filePath, projects]) => ({
        path: filePath,
        projects: projects.sort((a, b) => naturalCompare(a.name, b.name)),
      }));
  }

  invalidate(projectIds = null, reason = 'filesystem') {
    const ids = projectIds ? [...new Set(projectIds.filter(Boolean))] : [...this.cache.keys()];
    if (projectIds) ids.forEach((projectId) => this.cache.delete(projectId));
    else this.cache.clear();
    // Old callers invalidate after shared-layout/root edits. In registry mode
    // resolve exact tab consumers instead of treating a namespace as a union.
    const tabIds = this.rootRegistry ? this.rootRegistry.listSourceScopes()
      .filter(scope => !projectIds || this.getTabSources(scope.tabId).some(source => ids.includes(source.projectId)))
      .map(scope => scope.tabId) : [];
    this.invalidateTabs(tabIds, reason, ids);
  }

  invalidateTabs(tabIds = null, reason = 'filesystem', projectIds = []) {
    const ids = tabIds ? [...new Set(tabIds.filter(Boolean))] : [...this.tabCache.keys()];
    if (tabIds) ids.forEach(tabId => this.tabCache.delete(tabId));
    else this.tabCache.clear();
    if (this.onChanged) {
      try { this.onChanged({ projectIds, ...(this.rootRegistry ? { tabIds: ids } : {}), reason, at: Date.now() }); } catch {}
    }
  }

  refreshWatchers() {
    if (!this.watchEnabled) return;
    const wanted = new Map();
    const scopes = this.rootRegistry ? this.rootRegistry.listSourceScopes() : this.db.getProjectsWithPromptSources();
    const add = (source, projectId = null, tabId = null) => {
      const target = source.docsExists ? source.docsPath : (source.exists ? source.rootPath : null);
      if (!target) return;
      const ids = wanted.get(target) || { projectIds: new Set(), tabIds: new Set() };
      if (projectId) ids.projectIds.add(projectId);
      if (tabId) ids.tabIds.add(tabId);
      wanted.set(target, ids);
    };
    for (const scope of scopes) {
      for (const source of this.rootRegistry ? this.getTabSources(scope.tabId) : this.getSources(scope.id)) {
        add(source, this.rootRegistry ? source.projectId : scope.id, scope.tabId);
      }
    }
    if (this.rootRegistry) {
      for (const source of this.describeSources(this.rootRegistry.read().roots.map(root => ({ ...root, rootPath: root.path })))) {
        add(source);
      }
    }

    for (const [target, entry] of this.watchers) {
      if (wanted.has(target)) {
        Object.assign(entry, wanted.get(target));
        wanted.delete(target);
        continue;
      }
      try { entry.watcher.close(); } catch {}
      this.watchers.delete(target);
    }

    for (const [target, scopeIds] of wanted) {
      try {
        const entry = { watcher: null, ...scopeIds };
        entry.watcher = this.fs.watch(target, { recursive: true }, () => {
          if (this.watchDebounce.has(target)) clearTimeout(this.watchDebounce.get(target));
          const timer = setTimeout(() => {
            this.watchDebounce.delete(target);
            for (const projectId of entry.projectIds) this.cache.delete(projectId);
            this.invalidateTabs([...entry.tabIds], 'filesystem', [...entry.projectIds]);
            this.refreshWatchers();
          }, 180);
          timer.unref?.();
          this.watchDebounce.set(target, timer);
        });
        this.watchers.set(target, entry);
      } catch (error) {
        console.warn('[ProjectPrompts] watcher failed path=' + target + ': ' + error.message);
      }
    }
  }

  close() {
    for (const timer of this.watchDebounce.values()) clearTimeout(timer);
    this.watchDebounce.clear();
    for (const entry of this.watchers.values()) {
      try { entry.watcher.close(); } catch {}
    }
    this.watchers.clear();
    this.cache.clear();
    this.tabCache.clear();
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
