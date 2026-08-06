const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROMPT_SUFFIX = '.prompt.md';
const ROOT_PARENT = '__root__';
const CACHE_TTL_MS = 1500;

function naturalCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function expandHome(input) {
  const value = String(input || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function canonicalPath(input, fsImpl = fs) {
  const resolved = path.resolve(expandHome(input));
  try {
    return fsImpl.realpathSync.native
      ? fsImpl.realpathSync.native(resolved)
      : fsImpl.realpathSync(resolved);
  } catch {
    return resolved;
  }
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

function scanSource({ projectId, rootPath, sourceName, layout, fsImpl = fs }) {
  const docsPath = path.join(rootPath, 'docs');
  let rootExists = false;
  let docsExists = false;
  try { rootExists = fsImpl.statSync(rootPath).isDirectory(); } catch {}
  try { docsExists = fsImpl.statSync(docsPath).isDirectory(); } catch {}

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

class ProjectPromptCatalogService {
  constructor({ db, layoutStore, onChanged = null, fsImpl = fs, watch = true } = {}) {
    if (!db) throw new Error('ProjectPromptCatalogService requires db');
    this.db = db;
    this.layoutStore = layoutStore || null;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.fs = fsImpl;
    this.watchEnabled = watch;
    this.cache = new Map();
    this.watchers = new Map();
    this.watchDebounce = new Map();
    if (watch) this.refreshWatchers();
  }

  getSources(projectId) {
    const rows = this.db.getProjectPromptSources(projectId);
    // Preserve the configured spelling for the shared layout key. A symlinked
    // root and its real path are the same source identity, but the explorer's
    // manual order is intentionally keyed by the exact root the user opened.
    const roots = rows.map((row) => resolvedSourcePath(row.rootPath));
    const labels = sourceDisplayLabels(roots);
    return rows.map((row, index) => {
      const rootPath = roots[index];
      const docsPath = path.join(rootPath, 'docs');
      let exists = false;
      let docsExists = false;
      try { exists = this.fs.statSync(rootPath).isDirectory(); } catch {}
      try { docsExists = this.fs.statSync(docsPath).isDirectory(); } catch {}
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

  setSources(projectId, roots) {
    const normalized = normalizeSourceRoots(roots, this.fs);
    const saved = this.db.saveProjectPromptSources(projectId, normalized);
    this.invalidate([projectId], 'sources-changed');
    this.refreshWatchers();
    return saved;
  }

  listProject(projectId, { force = false } = {}) {
    const cached = this.cache.get(projectId);
    if (!force && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

    const project = this.db.getProjectById(projectId);
    if (!project) {
      const error = new Error('project_not_found');
      error.code = 'project_not_found';
      throw error;
    }
    const sources = this.getSources(projectId)
      .sort((a, b) => naturalCompare(a.sourceName, b.sourceName));
    const scannedSources = sources.map((source) => {
      const layout = this.layoutStore?.get(source.rootPath)?.layout || null;
      return scanSource({
        projectId,
        rootPath: source.rootPath,
        sourceName: source.sourceName,
        layout,
        fsImpl: this.fs,
      });
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
    const canonicalRoot = canonicalPath(rootPath, this.fs);
    const byPath = new Map();
    for (const project of this.db.getProjectsWithPromptSources()) {
      let catalog;
      try { catalog = this.listProject(project.id); } catch { continue; }
      for (const prompt of catalog.prompts) {
        if (!isInside(canonicalRoot, canonicalPath(prompt.path, this.fs))) continue;
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
    if (this.onChanged) {
      try { this.onChanged({ projectIds: ids, reason, at: Date.now() }); } catch {}
    }
  }

  refreshWatchers() {
    if (!this.watchEnabled) return;
    const wanted = new Map();
    for (const project of this.db.getProjectsWithPromptSources()) {
      for (const source of this.getSources(project.id)) {
        const target = source.docsExists ? source.docsPath : (source.exists ? source.rootPath : null);
        if (!target) continue;
        const ids = wanted.get(target) || new Set();
        ids.add(project.id);
        wanted.set(target, ids);
      }
    }

    for (const [target, entry] of this.watchers) {
      if (wanted.has(target)) {
        entry.projectIds = wanted.get(target);
        wanted.delete(target);
        continue;
      }
      try { entry.watcher.close(); } catch {}
      this.watchers.delete(target);
    }

    for (const [target, projectIds] of wanted) {
      try {
        const entry = { watcher: null, projectIds };
        entry.watcher = this.fs.watch(target, { recursive: true }, () => {
          if (this.watchDebounce.has(target)) clearTimeout(this.watchDebounce.get(target));
          const timer = setTimeout(() => {
            this.watchDebounce.delete(target);
            this.invalidate([...entry.projectIds], 'filesystem');
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
