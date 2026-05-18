// Semantic Index Status — отслеживает состояние .semantic-index.json для
// открытых проектов. Состоит из трёх частей:
//
//   1) fs.watch по docs/**/*.md и .semantic-index.json — рекурсивный.
//      На FS-событие (debounced 300ms) пересчитываем fresh / stale / new.
//   2) IPC push 'semantic-index:status' { projectId, fresh, stale, new }.
//   3) IPC handle 'semantic-index:rebuild' — spawn build-index.sh,
//      стримим прогресс в 'semantic-index:progress'.
//
// Watcher запускается по 'semantic-index:watch' (с указанием projectId+path)
// и снимается по 'semantic-index:unwatch'. Один watcher на проект.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const INDEX_FILE_NAME = '.semantic-index.json';
const DOCS_SUBDIR = 'docs';

// projectId → {
//   projectPath, watchers: fs.FSWatcher[], debounceTimer,
//   isRebuilding, rebuildProc,
//   rebuildProgress: { outdatedTotal, outdatedCompleted, currentFile }   // snapshot of latest progress
// }
const watchedProjects = new Map();

function shaFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function listDocsFiles(projectPath) {
  const docsDir = path.join(projectPath, DOCS_SUBDIR);
  if (!fs.existsSync(docsDir)) return [];

  const out = [];
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name === 'tmp' || item.name.startsWith('.')) continue;
        walk(full);
      } else if (item.isFile() && item.name.endsWith('.md') && item.name !== '_intro.md') {
        out.push(full);
      }
    }
  };
  walk(docsDir);
  return out;
}

function computeStatus(projectPath) {
  const indexPath = path.join(projectPath, INDEX_FILE_NAME);
  let indexedByPath = new Map();

  if (fs.existsSync(indexPath)) {
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      const arr = JSON.parse(raw);
      for (const entry of arr) {
        if (entry && entry.path && entry.hash) {
          indexedByPath.set(entry.path, entry.hash);
        }
      }
    } catch (err) {
      console.error('[SemanticIndexStatus] Failed to parse', indexPath, err.message);
    }
  }

  const docsFiles = listDocsFiles(projectPath);
  let fresh = 0;
  let stale = 0;
  let neu = 0;

  for (const fullPath of docsFiles) {
    const relPath = path.relative(projectPath, fullPath);
    const onDiskHash = shaFile(fullPath);
    if (!onDiskHash) continue;

    const indexedHash = indexedByPath.get(relPath);
    if (!indexedHash) {
      neu += 1;
    } else if (indexedHash === onDiskHash) {
      fresh += 1;
    } else {
      stale += 1;
    }
  }

  return {
    fresh,
    stale,
    new: neu,
    indexExists: fs.existsSync(indexPath),
    docsTotal: docsFiles.length,
    indexedTotal: indexedByPath.size,
  };
}

function pushStatus(mainWindow, projectId, status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('semantic-index:status', { projectId, ...status });
}

function scheduleRecompute(state, mainWindow, projectId) {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    const status = computeStatus(state.projectPath);
    pushStatus(mainWindow, projectId, status);
  }, 300);
}

function startWatching(projectId, projectPath, mainWindow) {
  // Already watching — ignore.
  if (watchedProjects.has(projectId)) return;

  const state = {
    projectPath,
    watchers: [],
    debounceTimer: null,
    isRebuilding: false,
    rebuildProc: null,
    rebuildProgress: null,
  };
  watchedProjects.set(projectId, state);

  const onEvent = () => scheduleRecompute(state, mainWindow, projectId);

  // 1) Watch the index file itself (atomic rewrite by build-index.sh)
  try {
    const indexPath = path.join(projectPath, INDEX_FILE_NAME);
    const w = fs.watch(path.dirname(indexPath), { persistent: true }, (_evt, filename) => {
      if (filename === INDEX_FILE_NAME) onEvent();
    });
    state.watchers.push(w);
  } catch (err) {
    console.error('[SemanticIndexStatus] Cannot watch project root:', err.message);
  }

  // 2) Walk docs/ recursively, attach watcher to every dir
  const docsDir = path.join(projectPath, DOCS_SUBDIR);
  const attachDocsWatcher = (dir) => {
    try {
      const w = fs.watch(dir, { persistent: true }, (_evt, filename) => {
        if (!filename) return;
        if (!filename.endsWith('.md')) {
          // Could be a newly created subdir → re-walk later via debounce
          // For simplicity: any change in docs/ triggers a recompute.
        }
        onEvent();
      });
      state.watchers.push(w);
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'tmp') {
          attachDocsWatcher(path.join(dir, item.name));
        }
      }
    } catch {
      /* dir may not exist yet */
    }
  };
  if (fs.existsSync(docsDir)) attachDocsWatcher(docsDir);

  console.log('[SemanticIndexStatus] Watching project:', projectId, 'at', projectPath, '(' + state.watchers.length + ' watchers)');

  // Initial push so renderer doesn't show stale numbers
  const initial = computeStatus(projectPath);
  pushStatus(mainWindow, projectId, initial);
}

function stopWatching(projectId) {
  const state = watchedProjects.get(projectId);
  if (!state) return;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  for (const w of state.watchers) {
    try { w.close(); } catch {}
  }
  if (state.rebuildProc) {
    try { state.rebuildProc.kill('SIGTERM'); } catch {}
  }
  watchedProjects.delete(projectId);
  console.log('[SemanticIndexStatus] Stopped watching:', projectId);
}

function rebuildIndex(projectId, mainWindow, opts = {}) {
  const state = watchedProjects.get(projectId);
  if (!state) {
    return { success: false, error: 'Project not being watched' };
  }
  if (state.isRebuilding) {
    return { success: false, error: 'Rebuild already in progress' };
  }

  const scriptPath = path.join(state.projectPath, 'scripts', 'ai', 'build-index.sh');
  if (!fs.existsSync(scriptPath)) {
    return { success: false, error: 'scripts/ai/build-index.sh not found' };
  }

  // Pre-flight: warn if CLAUDE.md.bak left over from a crashed previous run.
  const claudeBak = path.join(state.projectPath, 'CLAUDE.md.bak');
  if (fs.existsSync(claudeBak)) {
    return { success: false, error: 'CLAUDE.md.bak exists — delete it before rebuilding (previous run crashed)' };
  }

  state.isRebuilding = true;

  // Parallelism — приходит из renderer (Settings → Системные). Не доверяем raw,
  // clamp на main-стороне; иначе любой UI bypass воткнёт N=1000 в --parallel.
  const rawN = Number(opts.parallelism);
  const parallelism = Number.isFinite(rawN) ? Math.max(1, Math.min(20, Math.round(rawN))) : 10;
  state.rebuildParallelism = parallelism;

  const proc = spawn('bash', [scriptPath, '--parallel', String(parallelism)], {
    cwd: state.projectPath,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  state.rebuildProc = proc;

  let total = 0;          // total files the script will look at
  let completed = 0;      // all file-done events (incl. cached) — kept for debugging
  let currentFile = '';
  let stderrTail = '';
  // Outdated tracking: how many files were actually re-indexed (not cached).
  // outdatedTotal grows as we see [launched ...] events; outdatedCompleted grows
  // when a launched file reports its result. Cached files never go into either.
  const launchedFiles = new Set();
  let outdatedTotal = 0;
  let outdatedCompleted = 0;
  // Strict success validation — never claim success unless we positively observed it.
  // build-index.sh ALWAYS exits 0 even when N files failed, so exit code is not enough.
  let sawSummary = false;
  let summaryErrors = 0;
  let summaryWarnings = 0;
  let perFileBad = 0;        // counts error|missing|wrapped events
  const failedFiles = [];    // names of files that failed

  const send = (event, payload) => {
    // Persist a snapshot of the latest progress on the state so that a renderer
    // mounting *after* progress started (e.g. user switched away and back to this
    // project) can reconstruct the running indicator without waiting for the next
    // stdout line. Without this snapshot, switching back mid-rebuild shows '…' until
    // the next file finishes — which can be minutes for slow files.
    if (event === 'semantic-index:progress') {
      state.rebuildProgress = {
        outdatedTotal: payload.outdatedTotal ?? state.rebuildProgress?.outdatedTotal ?? 0,
        outdatedCompleted: payload.outdatedCompleted ?? state.rebuildProgress?.outdatedCompleted ?? 0,
        currentFile: payload.file ?? state.rebuildProgress?.currentFile ?? '',
      };
    } else if (event === 'semantic-index:rebuild-started') {
      state.rebuildProgress = { outdatedTotal: 0, outdatedCompleted: 0, currentFile: '' };
    } else if (event === 'semantic-index:rebuild-done') {
      state.rebuildProgress = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(event, { projectId, ...payload });
    }
  };

  send('semantic-index:rebuild-started', { parallelism });

  const handleLine = (line) => {
    // Strip ANSI escape codes (\e[XXm) — script uses them via $RED/$GREEN/etc.
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!stripped) return;

    // "Found 90 files to index" / "Found 90 files to index (incremental mode)" / "(force reindex)"
    let m = stripped.match(/^Found\s+(\d+)\s+files? to index/);
    if (m) {
      total = parseInt(m[1], 10);
      send('semantic-index:progress', { phase: 'start', total, completed: 0, outdatedTotal: 0, outdatedCompleted: 0 });
      return;
    }

    // "[launched 5/90] docs/knowledge/..." — these are the files that will actually be
    // re-indexed (cached ones never appear here). Add to the launchedFiles set so we can
    // distinguish their completion from cached completions.
    m = stripped.match(/^\[launched\s+(\d+)\/(\d+)\]\s+(.+)$/);
    if (m) {
      currentFile = m[3];
      launchedFiles.add(currentFile);
      outdatedTotal = launchedFiles.size;
      send('semantic-index:progress', {
        phase: 'launched',
        launched: parseInt(m[1], 10),
        total: parseInt(m[2], 10),
        file: currentFile,
        completed,
        outdatedTotal,
        outdatedCompleted,
      });
      return;
    }

    // "  ok docs/... [3s]" / "  cached docs/..." / "  wrapped docs/... [Ns]" / "  error docs/..." / "  missing docs/..."
    m = stripped.match(/^(ok|cached|wrapped|error|missing)\s+(.+?)(?:\s+\[[^\]]+\])?$/);
    if (m) {
      const kind = m[1];
      const file = m[2];
      completed += 1;
      currentFile = file;
      // Only files that were actually launched count toward outdatedCompleted.
      // (cached files emit a "cached <path>" line but were never launched.)
      if (kind !== 'cached' && launchedFiles.has(file)) {
        outdatedCompleted += 1;
      }
      // Per-file failure tracking — used in the strict success check at exit.
      if (kind === 'error' || kind === 'missing' || kind === 'wrapped') {
        perFileBad += 1;
        if (failedFiles.length < 10) failedFiles.push(`${kind}:${file}`);
      }
      send('semantic-index:progress', {
        phase: 'file-done',
        kind,
        file,
        completed,
        total,
        outdatedTotal,
        outdatedCompleted,
      });
      return;
    }

    // "Files indexed: 87/90 (cached: 80, skip: 0, warn: 0, err: 3)"
    m = stripped.match(/^Files indexed:\s+(\d+)\/(\d+)\s+\(cached:\s+(\d+),\s+skip:\s+(\d+),\s+warn:\s+(\d+),\s+err:\s+(\d+)\)/);
    if (m) {
      sawSummary = true;
      summaryWarnings = parseInt(m[5], 10);
      summaryErrors = parseInt(m[6], 10);
      send('semantic-index:progress', {
        phase: 'summary',
        indexed: parseInt(m[1], 10),
        total: parseInt(m[2], 10),
        cached: parseInt(m[3], 10),
        skipped: parseInt(m[4], 10),
        warnings: summaryWarnings,
        errors: summaryErrors,
      });
      return;
    }
  };

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    stderrTail = (stderrTail + s).slice(-2000);
  });

  proc.on('error', (err) => {
    console.error('[SemanticIndexStatus] Spawn error:', err.message);
    state.isRebuilding = false;
    state.rebuildProc = null;
    send('semantic-index:rebuild-done', { success: false, error: err.message });
  });

  proc.on('exit', (code, signal) => {
    state.isRebuilding = false;
    state.rebuildProc = null;

    // Strict, deterministic success check — never claim success unless we positively
    // observed all of these signals. build-index.sh exits 0 even when many files
    // failed (the script "completed", but did not actually index them), so exit code
    // is necessary but not sufficient.
    const reasons = [];
    if (code !== 0) reasons.push(`exit code ${code}`);
    if (signal) reasons.push(`killed by signal ${signal}`);
    if (code === 0 && !signal) {
      if (!sawSummary) reasons.push('summary line missing (script aborted before merge)');
      if (summaryErrors > 0) reasons.push(`${summaryErrors} file error(s) in summary`);
      if (summaryWarnings > 0) reasons.push(`${summaryWarnings} wrapped file(s) in summary`);
      if (perFileBad > 0) reasons.push(`${perFileBad} per-file failure(s): ${failedFiles.slice(0, 5).join(', ')}`);
    }
    const success = reasons.length === 0;

    console.log(
      '[SemanticIndexStatus] Rebuild', projectId,
      'exit code', code, 'signal', signal,
      'sawSummary=', sawSummary,
      'summaryErr=', summaryErrors,
      'summaryWarn=', summaryWarnings,
      'perFileBad=', perFileBad,
      'success=', success,
      reasons.length ? `reasons=[${reasons.join('; ')}]` : ''
    );

    send('semantic-index:rebuild-done', {
      success,
      code,
      signal,
      error: success ? null : (reasons.join('; ') || stderrTail || 'unknown failure'),
      stats: {
        sawSummary,
        summaryErrors,
        summaryWarnings,
        perFileBad,
        outdatedTotal,
        outdatedCompleted,
        failedFiles: failedFiles.slice(0, 10),
      },
    });
    // Watcher will pick up new .semantic-index.json and emit fresh status on its own.
    // Force one more recompute defensively (in case fs.watch missed the rewrite).
    scheduleRecompute(state, mainWindow, projectId);
  });

  return { success: true };
}

function register({ getMainWindow }) {
  const mw = () => getMainWindow();

  ipcMain.handle('semantic-index:watch', (event, { projectId, projectPath }) => {
    try {
      if (!projectId || !projectPath) {
        return { success: false, error: 'projectId and projectPath required' };
      }
      startWatching(projectId, projectPath, mw());
      return { success: true };
    } catch (err) {
      console.error('[SemanticIndexStatus] watch error:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('semantic-index:unwatch', (event, { projectId }) => {
    stopWatching(projectId);
    return { success: true };
  });

  ipcMain.handle('semantic-index:get-status', (event, { projectId }) => {
    const state = watchedProjects.get(projectId);
    if (!state) return { success: false, error: 'Not watching' };
    return {
      success: true,
      status: computeStatus(state.projectPath),
      // Include current rebuild state so a renderer mounting / switching tabs
      // mid-rebuild can restore the spinner + counter without waiting for the
      // next stdout event.
      isRebuilding: state.isRebuilding,
      rebuildProgress: state.rebuildProgress,
      rebuildParallelism: state.rebuildParallelism || null,
    };
  });

  ipcMain.handle('semantic-index:rebuild', (event, { projectId, parallelism }) => {
    return rebuildIndex(projectId, mw(), { parallelism });
  });

  ipcMain.handle('semantic-index:cancel-rebuild', (event, { projectId }) => {
    const state = watchedProjects.get(projectId);
    if (!state || !state.rebuildProc) return { success: false, error: 'No rebuild in progress' };
    try {
      state.rebuildProc.kill('SIGTERM');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Cleanup on app quit
  const cleanupAll = () => {
    for (const projectId of Array.from(watchedProjects.keys())) {
      stopWatching(projectId);
    }
  };
  process.on('exit', cleanupAll);
}

module.exports = { register };
