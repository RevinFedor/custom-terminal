// Semantic Index Status — отслеживает состояние .semantic-index.json для
// открытых проектов. Состоит из трёх частей:
//
//   1) fs.watch по docs/**/*.md и .semantic-index.json — рекурсивный.
//      На FS-событие (debounced 300ms) пересчитываем fresh / stale / new / removed.
//   2) IPC push 'semantic-index:status' { projectId, fresh, stale, new, removed }.
//   3) IPC handle 'semantic-index:rebuild' — calls knowledge MCP docs_reindex
//      with this project's path and pushes running/final state to renderer.
//
// Watcher запускается по 'semantic-index:watch' (с указанием projectId+path)
// и снимается по 'semantic-index:unwatch'. Один watcher на проект.

const { ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const INDEX_FILE_NAME = '.semantic-index.json';
const DOCS_SUBDIR = 'docs';
const EXCLUDED_DOC_DIRS = new Set(['tmp', 'prompts']);
const REINDEX_PROGRESS_MARKER = '__KNOWLEDGE_REINDEX_PROGRESS__';

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
        if (EXCLUDED_DOC_DIRS.has(item.name) || item.name.startsWith('.')) continue;
        walk(full);
      } else if (item.isFile() && item.name.endsWith('.md') && item.name !== '_intro.md') {
        out.push(full);
      }
    }
  };
  walk(docsDir);
  return out;
}

function isManagedDocIndexPath(relPath) {
  if (typeof relPath !== 'string') return false;
  if (!relPath.startsWith(`${DOCS_SUBDIR}/`)) return false;
  if (!relPath.endsWith('.md')) return false;
  if (relPath.split('/').some((part) => EXCLUDED_DOC_DIRS.has(part))) return false;
  return path.basename(relPath) !== '_intro.md';
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
  const currentDocPaths = new Set();

  for (const fullPath of docsFiles) {
    const relPath = path.relative(projectPath, fullPath);
    currentDocPaths.add(relPath);
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

  let removed = 0;
  for (const relPath of indexedByPath.keys()) {
    if (isManagedDocIndexPath(relPath) && !currentDocPaths.has(relPath)) {
      removed += 1;
    }
  }

  return {
    fresh,
    stale,
    new: neu,
    removed,
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

  // 1) Watch the index file itself (atomic rewrite by docs_reindex)
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
        if (item.isDirectory() && !item.name.startsWith('.') && !EXCLUDED_DOC_DIRS.has(item.name)) {
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

function buildToolPath() {
  const homeDir = os.homedir();
  const extraPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.codex', 'bin'),
  ];
  return [...extraPaths, process.env.PATH || ''].filter(Boolean).join(':');
}

function extractMcpTextResult(msg) {
  const content = msg?.result?.content;
  if (!Array.isArray(content)) return '';
  const part = content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
  return part?.text || '';
}

function parseReindexSummary(summary) {
  const text = String(summary || '');
  const m = text.match(/Files indexed:\s+(\d+)\/(\d+)\s+\(cached:\s+(\d+),\s+skip:\s+(\d+),\s+warn:\s+(\d+),\s+err:\s+(\d+)\)/);
  if (!m) return null;
  return {
    indexed: parseInt(m[1], 10),
    total: parseInt(m[2], 10),
    cached: parseInt(m[3], 10),
    skipped: parseInt(m[4], 10),
    warnings: parseInt(m[5], 10),
    errors: parseInt(m[6], 10),
  };
}

function parseReindexProgressLine(line) {
  const idx = line.indexOf(REINDEX_PROGRESS_MARKER);
  if (idx === -1) return null;
  const raw = line.slice(idx + REINDEX_PROGRESS_MARKER.length).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function callKnowledgeDocsReindex(projectPath, parallelism, onProcess, onProgress) {
  return new Promise((resolve, reject) => {
    const serverPath = process.env.KNOWLEDGE_MCP_SERVER
      || path.join(os.homedir(), '.claude', 'mcp', 'knowledge-server.mjs');
    if (!fs.existsSync(serverPath)) {
      reject(new Error(`knowledge MCP server not found: ${serverPath}`));
      return;
    }

    const proc = spawn('node', [serverPath, '--project', projectPath], {
      cwd: projectPath,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        PATH: buildToolPath(),
        KNOWLEDGE_DISABLE_GEMINI: 'true',
        KNOWLEDGE_DISABLE_CLAUDE_P: 'true',
        KNOWLEDGE_ROUTER_PROVIDER: 'codex',
        KNOWLEDGE_INDEX_PROVIDER: 'codex',
        KNOWLEDGE_CODEX_MODEL: process.env.KNOWLEDGE_CODEX_MODEL || 'gpt-5.4-mini',
        KNOWLEDGE_CODEX_EFFORT: process.env.KNOWLEDGE_CODEX_EFFORT || 'low',
      },
    });
    if (typeof onProcess === 'function') onProcess(proc);

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let stderrTail = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error(`docs_reindex timed out after 15 minutes${stderrTail ? ` — ${stderrTail.trim().slice(-1000)}` : ''}`));
    }, 15 * 60 * 1000);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { proc.kill('SIGTERM'); } catch {}
      if (err) reject(err);
      else resolve(result);
    };

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 2) continue;
        if (msg.error) {
          finish(new Error(msg.error.message || JSON.stringify(msg.error)));
          return;
        }
        const text = extractMcpTextResult(msg);
        try {
          finish(null, JSON.parse(text));
        } catch (err) {
          finish(new Error(`docs_reindex returned non-JSON result: ${err.message}`));
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-4000);
      stderrBuf += text;
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        const progress = parseReindexProgressLine(line);
        if (progress && typeof onProgress === 'function') {
          onProgress(progress);
        }
      }
    });

    proc.on('error', (err) => finish(err));
    proc.on('exit', (code, signal) => {
      if (settled) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(new Error(`knowledge MCP exited before docs_reindex response (${reason})${stderrTail ? ` — ${stderrTail.trim().slice(-1000)}` : ''}`));
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'noted-terminal', version: '1.0.0' },
      },
    }) + '\n');
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'docs_reindex',
        arguments: {
          projectPath,
          parallel: parallelism,
          provider: 'codex',
        },
      },
    }) + '\n');
    proc.stdin.end();
  });
}

function rebuildIndex(projectId, mainWindow, opts = {}) {
  const state = watchedProjects.get(projectId);
  if (!state) {
    return { success: false, error: 'Project not being watched' };
  }
  if (state.isRebuilding) {
    return { success: false, error: 'Rebuild already in progress' };
  }

  state.isRebuilding = true;

  // Parallelism — приходит из renderer (Settings → Системные). Не доверяем raw,
  // clamp на main-стороне; иначе любой UI bypass воткнёт N=1000 в --parallel.
  const rawN = Number(opts.parallelism);
  const parallelism = Number.isFinite(rawN) ? Math.max(1, Math.min(20, Math.round(rawN))) : 10;

  const preStatus = computeStatus(state.projectPath);
  const outdatedAtStart = (preStatus.stale || 0) + (preStatus.new || 0) + (preStatus.removed || 0);
  const displayParallelism = outdatedAtStart > 0 ? Math.min(parallelism, outdatedAtStart) : parallelism;
  const initialParallelism = outdatedAtStart > 0 ? 1 : Math.min(1, parallelism);
  state.rebuildParallelism = initialParallelism;

  let outdatedTotal = outdatedAtStart;   // seeded from computeStatus; grows if more files launch than estimated
  let outdatedCompleted = 0;

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
        activeWorkers: payload.activeWorkers ?? state.rebuildProgress?.activeWorkers ?? 0,
        workerLimit: payload.workerLimit ?? state.rebuildProgress?.workerLimit ?? null,
      };
      if (typeof payload.parallelism === 'number') {
        state.rebuildParallelism = payload.parallelism;
      }
    } else if (event === 'semantic-index:rebuild-started') {
      state.rebuildProgress = {
        outdatedTotal: payload.outdatedTotal ?? 0,
        outdatedCompleted: 0,
        currentFile: '',
        activeWorkers: 0,
        workerLimit: payload.workerLimit ?? null,
      };
    } else if (event === 'semantic-index:rebuild-done') {
      state.rebuildProgress = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(event, { projectId, ...payload });
    }
  };

  send('semantic-index:rebuild-started', {
    parallelism: initialParallelism,
    workerLimit: displayParallelism,
    outdatedTotal,
  });
  send('semantic-index:progress', {
    phase: 'mcp-docs-reindex',
    total: preStatus.docsTotal || 0,
    completed: 0,
    outdatedTotal,
    outdatedCompleted: 0,
    activeWorkers: 0,
    workerLimit: displayParallelism,
    parallelism: initialParallelism,
  });

  callKnowledgeDocsReindex(state.projectPath, parallelism, (proc) => {
    state.rebuildProc = proc;
  }, (progress) => {
    const workTotal = numberOrNull(progress.workTotal);
    const completed = numberOrNull(progress.completed);
    const activeWorkers = numberOrNull(progress.active);
    const workerLimit = numberOrNull(progress.workerLimit ?? progress.parallelism);
    const totalDocs = numberOrNull(progress.total);

    if (workTotal !== null) {
      outdatedTotal = Math.max(outdatedTotal, workTotal);
    }
    if (completed !== null) {
      outdatedCompleted = Math.min(outdatedTotal, Math.max(0, completed));
    }

    const liveParallelism = activeWorkers && activeWorkers > 0 ? activeWorkers : 1;

    send('semantic-index:progress', {
      phase: progress.phase || 'mcp-docs-reindex',
      total: totalDocs ?? preStatus.docsTotal ?? 0,
      completed: completed ?? 0,
      outdatedTotal,
      outdatedCompleted,
      file: progress.file,
      activeWorkers: activeWorkers ?? 0,
      workerLimit: workerLimit ?? displayParallelism,
      parallelism: liveParallelism,
    });
  }).then((result) => {
    state.isRebuilding = false;
    state.rebuildProc = null;
    const summaryStats = parseReindexSummary(result?.summary);
    const summaryErrors = summaryStats?.errors || 0;
    const summaryWarnings = summaryStats?.warnings || 0;
    const failedFiles = Array.isArray(result?.failures)
      ? result.failures.map((failure) => `${failure.path || 'unknown'}:${failure.error || 'failed'}`).slice(0, 10)
      : [];
    const success = !!result?.success;
    if (success) {
      outdatedCompleted = outdatedTotal;
      send('semantic-index:progress', {
        phase: 'summary',
        ...(summaryStats || {}),
        outdatedTotal,
        outdatedCompleted,
      });
    }
    console.log(
      '[SemanticIndexStatus] Rebuild via docs_reindex',
      projectId,
      'success=', success,
      'summaryErr=', summaryErrors,
      'summaryWarn=', summaryWarnings,
      result?.error ? `error=${result.error}` : ''
    );
    send('semantic-index:rebuild-done', {
      success,
      code: success ? 0 : 1,
      signal: null,
      error: success ? null : (result?.error || 'docs_reindex failed'),
      stats: {
        sawSummary: !!summaryStats,
        summaryErrors,
        summaryWarnings,
        perFileBad: failedFiles.length,
        outdatedTotal,
        outdatedCompleted,
        failedFiles,
      },
    });
    scheduleRecompute(state, mainWindow, projectId);
  }).catch((err) => {
    console.error('[SemanticIndexStatus] docs_reindex error:', err.message);
    state.isRebuilding = false;
    state.rebuildProc = null;
    send('semantic-index:rebuild-done', {
      success: false,
      code: 1,
      signal: null,
      error: err.message,
      stats: {
        sawSummary: false,
        summaryErrors: 1,
        summaryWarnings: 0,
        perFileBad: 0,
        outdatedTotal,
        outdatedCompleted,
        failedFiles: [],
      },
    });
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
