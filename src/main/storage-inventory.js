'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS_VERSION = 1;
const APP_STATE_KEY = 'noted-terminal-storage-retention-v1';

const SESSION_GROUPS = Object.freeze([
  'open',
  'regular',
  'fork',
  'rewrite',
  'subagent',
  'development',
  'outside',
  'recovery',
]);

const DEFAULT_RETENTION_DAYS = Object.freeze({
  regular: 1,
  fork: 1,
  rewrite: 1,
  subagent: 1,
  development: 1,
  outside: 1,
  recovery: 1,
  build: 1,
  appBackup: 30,
});

const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  enabled: true,
  provider: 'all',
  retentionDays: DEFAULT_RETENTION_DAYS,
});

const text = (value) => typeof value === 'string' ? value.trim() : '';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function normalizeRetentionDays(value, fallback) {
  if (value === null || value === 'never') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(3650, Math.round(number)));
}

function normalizeStorageRetentionSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceDays = source.retentionDays && typeof source.retentionDays === 'object'
    ? source.retentionDays
    : {};
  const retentionDays = {};
  for (const [key, fallback] of Object.entries(DEFAULT_RETENTION_DAYS)) {
    retentionDays[key] = normalizeRetentionDays(sourceDays[key], fallback);
  }
  return {
    version: SETTINGS_VERSION,
    enabled: source.enabled !== false,
    provider: ['all', 'codex', 'claude'].includes(source.provider) ? source.provider : 'all',
    retentionDays,
  };
}

function opaqueItemId(kind, targetPath) {
  return crypto.createHash('sha256')
    .update(String(kind || 'item'))
    .update('\0')
    .update(path.resolve(String(targetPath || '')))
    .digest('hex')
    .slice(0, 28);
}

function shortSessionId(sessionId) {
  const value = text(sessionId);
  return value ? value.slice(0, 8) : 'unknown';
}

function cleanPromptText(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => item && typeof item === 'object' && typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readInitialJsonLines(filePath, maxBytes = 512 * 1024, maxLines = 12) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    const length = Math.max(0, Math.min(stat.size, maxBytes));
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, read.bytesRead)
      .toString('utf8')
      .split('\n')
      .slice(0, maxLines)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    try { await handle?.close(); } catch {}
  }
}

async function walkFiles(root, predicate) {
  const results = [];
  async function visit(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return visit(fullPath);
      if (entry.isFile() && predicate(fullPath, entry.name)) results.push(fullPath);
    }));
  }
  await visit(root);
  return results;
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function diskUsageBytes(targetPath) {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', targetPath]);
    const kb = Number(String(stdout).trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

function readStorageRelations(sqlite, options = {}) {
  const target = options.target && typeof options.target === 'object' ? options.target : {};
  const bySession = target.bySession || new Map();
  const forkByChild = target.forkByChild || new Map();
  const lineageSourcesByChild = target.lineageSourcesByChild || new Map();
  const environment = options.environment === 'development' || options.environment === 'production'
    ? options.environment
    : 'current';
  const openTabs = options.openTabs !== false;
  const protectEveryRelation = options.protectEveryRelation === true;
  const add = (provider, sessionId, relation) => {
    const id = text(sessionId);
    if (!id) return;
    const key = provider + ':' + id;
    const current = bySession.get(key) || {
      provider,
      sessionId: id,
      open: false,
      notedTerminal: false,
      names: [],
      projects: [],
      cwd: null,
      closedAt: null,
      iterations: null,
      references: [],
      environments: [],
      protectedByForeignProduction: false,
    };
    current.open ||= relation.open === true;
    current.notedTerminal = true;
    current.protectedByForeignProduction ||= relation.protectedByForeignProduction === true;
    if (!current.environments.includes(environment)) current.environments.push(environment);
    if (text(relation.name) && !current.names.includes(text(relation.name))) current.names.push(text(relation.name));
    if (text(relation.projectName) && !current.projects.includes(text(relation.projectName))) current.projects.push(text(relation.projectName));
    if (!current.cwd && text(relation.cwd)) current.cwd = text(relation.cwd);
    current.closedAt = Math.max(finite(current.closedAt), finite(relation.closedAt)) || null;
    if (Number.isFinite(Number(relation.iterations))) current.iterations = Math.max(finite(current.iterations), Number(relation.iterations));
    current.references.push(relation.reference || (relation.open ? 'open-tab' : 'history'));
    bySession.set(key, current);
  };

  if (!sqlite || typeof sqlite.prepare !== 'function') {
    return { bySession, forkByChild, lineageSourcesByChild };
  }
  try {
    const openRows = sqlite.prepare(`
      SELECT t.name, t.cwd, t.command_type, t.claude_session_id,
             t.codex_session_id, t.claude_task_count,
             p.name AS project_name
      FROM tabs t LEFT JOIN projects p ON p.id = t.project_id
    `).all();
    for (const row of openRows) {
      add('claude', row.claude_session_id, {
        open: openTabs,
        protectedByForeignProduction: protectEveryRelation,
        name: row.name,
        cwd: row.cwd,
        projectName: row.project_name,
        iterations: row.claude_task_count,
        reference: 'open-tab',
      });
      add('codex', row.codex_session_id, {
        open: openTabs,
        protectedByForeignProduction: protectEveryRelation,
        name: row.name,
        cwd: row.cwd,
        projectName: row.project_name,
        iterations: row.claude_task_count,
        reference: 'open-tab',
      });
    }
  } catch {}
  try {
    const historyRows = sqlite.prepare(`
      SELECT h.name, h.cwd, h.command_type, h.claude_session_id,
             h.codex_session_id, h.closed_at, h.message_count,
             p.name AS project_name
      FROM tab_history h LEFT JOIN projects p ON p.id = h.project_id
    `).all();
    for (const row of historyRows) {
      add('claude', row.claude_session_id, {
        protectedByForeignProduction: protectEveryRelation,
        name: row.name,
        cwd: row.cwd,
        projectName: row.project_name,
        closedAt: finite(row.closed_at) * 1000,
        iterations: row.message_count,
        reference: 'home-history',
      });
      add('codex', row.codex_session_id, {
        protectedByForeignProduction: protectEveryRelation,
        name: row.name,
        cwd: row.cwd,
        projectName: row.project_name,
        closedAt: finite(row.closed_at) * 1000,
        iterations: row.message_count,
        reference: 'home-history',
      });
    }
  } catch {}
  try {
    const favorites = sqlite.prepare(`
      SELECT f.name, f.cwd, f.command_type, f.claude_session_id,
             f.codex_session_id, p.name AS project_name
      FROM favorites f LEFT JOIN projects p ON p.id = f.project_id
    `).all();
    for (const row of favorites) {
      add('claude', row.claude_session_id, { name: row.name, cwd: row.cwd, projectName: row.project_name, reference: 'favorite', protectedByForeignProduction: protectEveryRelation });
      add('codex', row.codex_session_id, { name: row.name, cwd: row.cwd, projectName: row.project_name, reference: 'favorite', protectedByForeignProduction: protectEveryRelation });
    }
  } catch {}
  try {
    const events = sqlite.prepare(`
      SELECT provider, child_session_id, source_session_id, fork_mode,
             lineage_manifest_json
      FROM session_history_events
      WHERE event_type = 'fork' AND child_session_id IS NOT NULL
      ORDER BY id
    `).all();
    for (const row of events) {
      const child = text(row.child_session_id);
      if (!child) continue;
      add(row.provider, child, {
        reference: 'fork-event-child',
        protectedByForeignProduction: protectEveryRelation,
      });
      const directSource = text(row.source_session_id);
      if (directSource) {
        add(row.provider, directSource, {
          reference: 'fork-event-source',
          protectedByForeignProduction: protectEveryRelation,
        });
      }
      const forkKey = row.provider + ':' + child;
      if (!forkByChild.has(forkKey)) {
        forkByChild.set(forkKey, {
          provider: row.provider,
          childSessionId: child,
          sourceSessionId: text(row.source_session_id) || null,
          forkMode: text(row.fork_mode) || 'unknown',
        });
      }
      let manifest = null;
      try { manifest = row.lineage_manifest_json ? JSON.parse(row.lineage_manifest_json) : null; } catch {}
      const sources = new Set();
      for (const segment of Array.isArray(manifest?.sourceSegments) ? manifest.sourceSegments : []) {
        const sourceId = text(segment?.physicalSessionId || segment?.sessionId);
        if (sourceId) {
          sources.add(sourceId);
          add(row.provider, sourceId, {
            reference: 'lineage-source',
            protectedByForeignProduction: protectEveryRelation,
          });
        }
      }
      if (sources.size > 0) {
        const known = lineageSourcesByChild.get(child) || new Set();
        for (const source of sources) known.add(source);
        lineageSourcesByChild.set(child, known);
      }
    }
  } catch {}
  return { bySession, forkByChild, lineageSourcesByChild };
}

function codexMetaFromLines(lines, filePath) {
  const record = lines.find((line) => line?.type === 'session_meta') || null;
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const fileMatch = path.basename(filePath).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  const threadSource = payload.thread_source && typeof payload.thread_source === 'object'
    ? JSON.stringify(payload.thread_source)
    : text(payload.thread_source);
  return {
    sessionId: text(payload.id) || text(fileMatch?.[0]),
    cwd: text(payload.cwd),
    parentSessionId: text(payload.parent_thread_id || payload.forked_from_id),
    forkedFromId: text(payload.forked_from_id),
    isSubagent: !!payload.parent_thread_id || /subagent/i.test(threadSource),
    firstPrompt: '',
  };
}

function claudeMetaFromLines(lines, filePath) {
  const records = Array.isArray(lines) ? lines : [];
  const firstWithSession = records.find((line) => text(line?.sessionId));
  const firstUser = records.find((line) => (
    line?.type === 'user'
      && line?.isMeta !== true
      && cleanPromptText(line?.message?.content)
  ));
  const parentDir = path.basename(path.dirname(path.dirname(filePath)));
  const nestedSubagent = path.basename(path.dirname(filePath)) === 'subagents';
  return {
    sessionId: text(firstWithSession?.sessionId)
      || text((path.basename(filePath).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i) || [])[0]),
    cwd: text(firstWithSession?.cwd),
    parentSessionId: nestedSubagent ? parentDir : '',
    forkedFromId: '',
    isSubagent: nestedSubagent || firstWithSession?.isSidechain === true || !!firstWithSession?.agentId,
    firstPrompt: cleanPromptText(firstUser?.message?.content).slice(0, 120),
  };
}

function rewriteGroupForMode(forkMode) {
  const mode = text(forkMode).toLowerCase();
  return mode === 'history_edit' || mode === 'history_delete' || mode === 'history_rewind';
}

function retentionForItem(settings, item) {
  if (item.protected) return null;
  if (item.section === 'builds') return settings.retentionDays.build;
  if (item.group === 'app-backup') return settings.retentionDays.appBackup;
  return settings.retentionDays[item.group] ?? settings.retentionDays.regular;
}

function classifySessionItem(item, relation, forkEvent) {
  if (item.protected) return 'open';
  if (item.recoveryCopy) return 'recovery';
  if (relation?.environments?.includes('development') && !relation?.environments?.includes('production')) return 'development';
  if (!relation?.notedTerminal) return 'outside';
  if (item.isSubagent) return 'subagent';
  if (rewriteGroupForMode(forkEvent?.forkMode)) return 'rewrite';
  if (item.forkedFromId || forkEvent?.sourceSessionId) return 'fork';
  return 'regular';
}

function applyOpenDependencyProtection(items, relations, runtimeProtectedIds) {
  const byProviderId = new Map();
  for (const item of items) {
    const key = item.provider + ':' + item.sessionId;
    const current = byProviderId.get(key);
    if (!current || (current.recoveryCopy && !item.recoveryCopy)) byProviderId.set(key, item);
  }
  const protectedKeys = new Set();
  for (const item of items) {
    const relation = relations.bySession.get(item.provider + ':' + item.sessionId);
    if (!item.recoveryCopy && relation?.protectedByForeignProduction) {
      protectedKeys.add(item.provider + ':' + item.sessionId);
      item.protected = true;
      item.protectedReason = 'Referenced by production Noted Terminal';
    } else if (!item.recoveryCopy && (relation?.open || runtimeProtectedIds.has(item.sessionId))) {
      protectedKeys.add(item.provider + ':' + item.sessionId);
      item.protected = true;
      item.protectedReason = 'Open in Noted Terminal';
    }
  }
  const queue = [...protectedKeys];
  while (queue.length > 0) {
    const key = queue.shift();
    const item = byProviderId.get(key);
    if (!item) continue;
    const parents = new Set();
    if (item.provider === 'codex' && item.parentSessionId) parents.add(item.parentSessionId);
    if (item.provider === 'claude' && item.isSubagent && item.parentSessionId) parents.add(item.parentSessionId);
    for (const source of relations.lineageSourcesByChild.get(item.sessionId) || []) parents.add(source);
    for (const parentId of parents) {
      const parentKey = item.provider + ':' + parentId;
      const parent = byProviderId.get(parentKey);
      if (!parent || protectedKeys.has(parentKey)) continue;
      protectedKeys.add(parentKey);
      parent.protected = true;
      parent.protectedReason = 'Required by an open session';
      queue.push(parentKey);
    }
  }
  // Claude subagent transcripts remain inspectable from their open parent.
  // They are children, not physical ancestors, so protect this one direction
  // explicitly without retaining every historical Codex descendant.
  for (const item of items) {
    if (item.provider !== 'claude' || !item.isSubagent || !item.parentSessionId || item.recoveryCopy) continue;
    if (!protectedKeys.has('claude:' + item.parentSessionId)) continue;
    item.protected = true;
    item.protectedReason = 'Subagent of an open Claude session';
    protectedKeys.add('claude:' + item.sessionId);
  }
}

function decorateCodexDeletionClosures(items) {
  const codexById = new Map();
  for (const item of items.filter((candidate) => candidate.provider === 'codex')) {
    const current = codexById.get(item.sessionId);
    if (!current || (current.recoveryCopy && !item.recoveryCopy)) codexById.set(item.sessionId, item);
  }
  const childrenByParent = new Map();
  for (const item of codexById.values()) {
    if (!item.parentSessionId) continue;
    const children = childrenByParent.get(item.parentSessionId) || [];
    children.push(item.sessionId);
    childrenByParent.set(item.parentSessionId, children);
  }
  for (const item of codexById.values()) {
    const closure = [];
    const seen = new Set([item.sessionId]);
    const queue = [...(childrenByParent.get(item.sessionId) || [])];
    while (queue.length > 0) {
      const childId = queue.shift();
      if (!childId || seen.has(childId)) continue;
      seen.add(childId);
      const child = codexById.get(childId);
      if (child) closure.push(child);
      queue.push(...(childrenByParent.get(childId) || []));
    }
    item.affectedItemIds = [item.id, ...closure.map((child) => child.id)];
    item.affectedSessionIds = [item.sessionId, ...closure.map((child) => child.sessionId)];
    item.affectedItems = item.affectedItemIds.length;
    item.affectedBytes = item.sizeBytes + closure.reduce((sum, child) => sum + child.sizeBytes, 0);
    const protectedChild = closure.find((child) => child.protected);
    if (protectedChild && !item.protected) {
      item.protected = true;
      item.protectedReason = 'Deletion would remove an open descendant';
      item.deletable = false;
    }
  }
}

async function scanSessionFile(filePath, provider) {
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch { return null; }
  const lines = await readInitialJsonLines(filePath);
  const meta = provider === 'codex'
    ? codexMetaFromLines(lines, filePath)
    : claudeMetaFromLines(lines, filePath);
  if (!meta.sessionId) return null;
  const recoveryCopy = /before-|backup|recovery/i.test(path.basename(filePath));
  return {
    id: opaqueItemId(provider + '-session', filePath),
    section: 'sessions',
    group: 'regular',
    provider,
    sessionId: meta.sessionId,
    parentSessionId: meta.parentSessionId || null,
    forkedFromId: meta.forkedFromId || null,
    isSubagent: meta.isSubagent === true,
    recoveryCopy,
    firstPrompt: meta.firstPrompt || '',
    cwd: meta.cwd || '',
    path: filePath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs || stat.mtimeMs,
    fileIdentity: `${stat.dev}:${stat.ino}`,
    notedTerminal: false,
    title: '',
    project: '',
    iterations: null,
    protected: false,
    protectedReason: null,
    deletable: true,
  };
}

function sessionTitle(item, relation) {
  const named = relation?.names?.find((name) => name && !/^tab-\d+$/i.test(name));
  if (named) return named;
  if (item.firstPrompt) return item.firstPrompt;
  const folder = text(item.cwd).split('/').filter(Boolean).pop();
  return `${item.provider === 'codex' ? 'Codex' : 'Claude'} session ${shortSessionId(item.sessionId)}${folder ? ' · ' + folder : ''}`;
}

async function scanSessions({ codexHome, claudeHome, relations, runtimeProtectedIds }) {
  const codexRoots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  const codexPaths = [];
  for (const root of codexRoots) {
    codexPaths.push(...await walkFiles(root, (_fullPath, name) => name.includes('.jsonl')));
  }
  const claudeAllPaths = await walkFiles(path.join(claudeHome, 'projects'), () => true);
  const claudePaths = claudeAllPaths.filter((filePath) => path.basename(filePath).includes('.jsonl'));
  const scanned = (await Promise.all([
    mapLimit(codexPaths, 32, (filePath) => scanSessionFile(filePath, 'codex')),
    mapLimit(claudePaths, 32, (filePath) => scanSessionFile(filePath, 'claude')),
  ])).flat().filter(Boolean);
  const claudePrimaryBySession = new Map();
  for (const item of scanned.filter((candidate) => candidate.provider === 'claude' && !candidate.recoveryCopy)) {
    if (!claudePrimaryBySession.has(item.sessionId)) claudePrimaryBySession.set(item.sessionId, item);
  }
  const auxiliary = new Map();
  for (const filePath of claudeAllPaths) {
    const parts = filePath.split(path.sep);
    const toolResultsIndex = parts.lastIndexOf('tool-results');
    if (toolResultsIndex < 1) continue;
    const sessionId = parts[toolResultsIndex - 1];
    const target = claudePrimaryBySession.get(sessionId);
    if (!target) continue;
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch { continue; }
    target.sizeBytes += stat.size;
    const directory = parts.slice(0, toolResultsIndex + 1).join(path.sep) || path.sep;
    const paths = auxiliary.get(target.id) || new Set();
    paths.add(directory);
    auxiliary.set(target.id, paths);
  }
  for (const item of scanned) {
    const paths = auxiliary.get(item.id);
    if (paths) item.auxiliaryPaths = [...paths];
  }
  applyOpenDependencyProtection(scanned, relations, runtimeProtectedIds);
  decorateCodexDeletionClosures(scanned);
  for (const item of scanned) {
    const key = item.provider + ':' + item.sessionId;
    const relation = relations.bySession.get(key) || null;
    const forkEvent = relations.forkByChild.get(key) || null;
    item.notedTerminal = relation?.notedTerminal === true;
    item.environments = relation?.environments || [];
    item.title = sessionTitle(item, relation);
    item.project = relation?.projects?.[0] || text(item.cwd).split('/').filter(Boolean).pop() || '';
    item.cwd = relation?.cwd || item.cwd;
    item.iterations = relation?.iterations ?? null;
    item.closedAt = relation?.closedAt || null;
    item.forkMode = forkEvent?.forkMode || (item.forkedFromId ? 'provider-fork' : null);
    item.group = classifySessionItem(item, relation, forkEvent);
    item.deletable = !item.protected;
  }
  return scanned;
}

async function listGitWorktrees(projectRoot) {
  if (!projectRoot) return [];
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: projectRoot });
    return stdout.split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter(Boolean);
  } catch {
    return [projectRoot];
  }
}

async function buildDirectoryItem({ targetPath, title, group, project, protectedReason = null }) {
  let stat;
  try { stat = await fs.promises.stat(targetPath); } catch { return null; }
  if (!stat.isDirectory()) return null;
  const sizeBytes = await diskUsageBytes(targetPath);
  if (sizeBytes <= 0) return null;
  return {
    id: opaqueItemId('build', targetPath),
    section: 'builds',
    group,
    provider: null,
    sessionId: null,
    title,
    project,
    cwd: path.dirname(targetPath),
    path: targetPath,
    sizeBytes,
    modifiedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs || stat.mtimeMs,
    fileIdentity: `${stat.dev}:${stat.ino}`,
    protected: !!protectedReason,
    protectedReason,
    deletable: !protectedReason,
    iterations: null,
    notedTerminal: true,
  };
}

async function scanBuilds(projectRoot) {
  if (!projectRoot) return [];
  const worktrees = [...new Set(await listGitWorktrees(projectRoot))];
  const items = [];
  for (const worktree of worktrees) {
    const label = worktree === projectRoot ? 'Current project' : 'Temporary worktree';
    for (const profile of ['debug', 'release']) {
      const item = await buildDirectoryItem({
        targetPath: path.join(worktree, 'packages', 'codex', 'codex-rs', 'target', profile),
        title: `Codex ${profile} build`,
        group: 'build',
        project: label,
      });
      if (item) items.push(item);
    }
  }
  const packaged = await buildDirectoryItem({
    targetPath: path.join(projectRoot, 'release'),
    title: 'Packaged Noted Terminal',
    group: 'build',
    project: 'Current project',
  });
  if (packaged) items.push(packaged);
  const installedCodex = path.join(os.homedir(), '.noted-terminal', 'bin', 'codex');
  try {
    const stat = await fs.promises.stat(installedCodex);
    items.push({
      id: opaqueItemId('runtime', installedCodex),
      section: 'builds',
      group: 'build',
      provider: 'codex',
      title: 'Installed Noted Codex',
      project: 'Noted Terminal',
      cwd: path.dirname(installedCodex),
      path: installedCodex,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      protected: true,
      protectedReason: 'Used by open and future Noted Terminal sessions',
      deletable: false,
      iterations: null,
      notedTerminal: true,
    });
  } catch {}
  return items;
}

async function appPathItem({ targetPath, title, group, protectedReason = null }) {
  let stat;
  try { stat = await fs.promises.stat(targetPath); } catch { return null; }
  const sizeBytes = stat.isDirectory() ? await diskUsageBytes(targetPath) : stat.size;
  return {
    id: opaqueItemId('app-data', targetPath),
    section: 'app',
    group,
    provider: null,
    title,
    project: 'Noted Terminal',
    cwd: path.dirname(targetPath),
    path: targetPath,
    sizeBytes,
    modifiedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs || stat.mtimeMs,
    fileIdentity: `${stat.dev}:${stat.ino}`,
    protected: !!protectedReason,
    protectedReason,
    deletable: !protectedReason,
    iterations: null,
    notedTerminal: true,
  };
}

async function scanAppData(appDataDir) {
  const items = [];
  let names = [];
  try { names = await fs.promises.readdir(appDataDir); } catch {}
  for (const name of names) {
    const targetPath = path.join(appDataDir, name);
    if (/^noted-terminal(?:-dev)?\.db(?:-wal|-shm)?$/.test(name)) {
      const item = await appPathItem({ targetPath, title: name.includes('-dev') ? 'Development database' : 'Production database', group: 'app-active', protectedReason: 'Active application database' });
      if (item) items.push(item);
    } else if (/^noted-terminal\.db\.(?:backup|before-)/.test(name)) {
      const item = await appPathItem({ targetPath, title: 'Database recovery backup', group: 'app-backup' });
      if (item) items.push(item);
    }
  }
  for (const [name, title, reason] of [
    ['Code Cache', 'Browser code cache', 'In use by the running app'],
    ['Cache', 'Browser cache', 'In use by the running app'],
    ['prompt-queue-assets', 'Prompt images', 'Managed by receipt and composer garbage collection'],
  ]) {
    const item = await appPathItem({ targetPath: path.join(appDataDir, name), title, group: 'app-cache', protectedReason: reason });
    if (item) items.push(item);
  }
  return items;
}

function decorateRetention(items, settings, nowMs) {
  for (const item of items) {
    const days = retentionForItem(settings, item);
    item.retentionDays = days;
    const baseAt = item.closedAt || item.modifiedAt || item.createdAt || nowMs;
    item.deleteAfter = days == null ? null : baseAt + days * DAY_MS;
    item.eligible = item.deletable === true
      && settings.enabled === true
      && item.deleteAfter != null
      && item.deleteAfter <= nowMs;
  }
  return items;
}

function summarizeInventory(items) {
  const result = {
    totalBytes: 0,
    reclaimableBytes: 0,
    eligibleBytes: 0,
    protectedBytes: 0,
    totalItems: items.length,
    sessionItems: 0,
    codexItems: 0,
    claudeItems: 0,
    groups: {},
  };
  for (const item of items) {
    result.totalBytes += finite(item.sizeBytes);
    if (item.deletable) result.reclaimableBytes += finite(item.sizeBytes);
    else result.protectedBytes += finite(item.sizeBytes);
    if (item.eligible) result.eligibleBytes += finite(item.sizeBytes);
    if (item.section === 'sessions') result.sessionItems += 1;
    if (item.provider === 'codex') result.codexItems += 1;
    if (item.provider === 'claude') result.claudeItems += 1;
    const group = result.groups[item.group] || { items: 0, bytes: 0, eligibleBytes: 0 };
    group.items += 1;
    group.bytes += finite(item.sizeBytes);
    if (item.eligible) group.eligibleBytes += finite(item.sizeBytes);
    result.groups[item.group] = group;
  }
  return result;
}

function inventoryGeneration(items, settings) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(settings));
  // The token protects destructive candidates, not the whole read-only
  // dashboard. Live protected transcripts grow continuously; including their
  // mtime/size made every confirmation stale even though none of the requested
  // delete targets changed. A session becoming open flips `deletable` and
  // therefore still changes this token before delete.
  for (const item of items.filter((candidate) => candidate.deletable === true).sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(item.id);
    hash.update(':');
    hash.update(String(item.sizeBytes));
    hash.update(':');
    hash.update(String(Math.floor(item.modifiedAt || 0)));
    hash.update(':');
    hash.update(item.protected ? '1' : '0');
    hash.update(':');
    hash.update(item.group || '');
  }
  return hash.digest('hex').slice(0, 24);
}

// A deletion confirmation owns its selected physical files, not unrelated
// sessions arriving elsewhere in the global Home inventory.
function storageItemDeletionRevision(item) {
  return crypto.createHash('sha256').update(JSON.stringify([
    item.id, item.path, item.section, item.provider || null,
    item.sessionId || null, item.fileIdentity || null,
    item.sizeBytes, item.modifiedAt, item.createdAt,
    item.deletable === true, item.protected === true,
    item.protectedReason || null, item.recoveryCopy === true,
    [...(item.auxiliaryPaths || [])].sort(),
  ])).digest('hex').slice(0, 32);
}

async function scanStorageInventory({
  sqlite,
  codexHome = path.join(os.homedir(), '.codex'),
  claudeHome = path.join(os.homedir(), '.claude'),
  projectRoot = null,
  appDataDir,
  runtimeProtectedSessionIds = [],
  currentEnvironment = 'production',
  relationDatabases = [],
  settings = DEFAULT_SETTINGS,
  nowMs = Date.now(),
} = {}) {
  const normalizedSettings = normalizeStorageRetentionSettings(settings);
  const normalizedEnvironment = currentEnvironment === 'development' ? 'development' : 'production';
  const relations = readStorageRelations(sqlite, { environment: normalizedEnvironment });
  for (const source of Array.isArray(relationDatabases) ? relationDatabases : []) {
    if (!source?.sqlite || source.sqlite === sqlite) continue;
    const environment = source.environment === 'development' ? 'development' : 'production';
    readStorageRelations(source.sqlite, {
      target: relations,
      environment,
      openTabs: environment === normalizedEnvironment,
      protectEveryRelation: normalizedEnvironment === 'development' && environment === 'production',
    });
  }
  const runtimeProtectedIds = new Set((runtimeProtectedSessionIds || []).map(text).filter(Boolean));
  const [sessions, builds, appItems] = await Promise.all([
    scanSessions({ codexHome, claudeHome, relations, runtimeProtectedIds }),
    scanBuilds(projectRoot),
    appDataDir ? scanAppData(appDataDir) : [],
  ]);
  const items = decorateRetention([...sessions, ...builds, ...appItems], normalizedSettings, nowMs);
  items.sort((a, b) => b.sizeBytes - a.sizeBytes || b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id));
  return {
    success: true,
    generation: inventoryGeneration(items, normalizedSettings),
    scannedAt: nowMs,
    settings: normalizedSettings,
    summary: summarizeInventory(items),
    items,
  };
}

module.exports = {
  APP_STATE_KEY,
  DAY_MS,
  DEFAULT_SETTINGS,
  SESSION_GROUPS,
  applyOpenDependencyProtection,
  classifySessionItem,
  decorateCodexDeletionClosures,
  inventoryGeneration,
  storageItemDeletionRevision,
  normalizeStorageRetentionSettings,
  opaqueItemId,
  readStorageRelations,
  scanStorageInventory,
  summarizeInventory,
};
