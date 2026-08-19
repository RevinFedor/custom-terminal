const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { performance } = require('perf_hooks');

// ========== GEMINI EMBEDDING PROVIDER ==========

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`;
const EMBEDDING_DIMS = 768; // gemini-embedding-001 truncated to 768 (default 3072 too large for SQLite)
const MAX_BATCH_SIZE = 100; // Gemini limit per batch request
const MAX_CHUNK_TOKENS = 2048; // Gemini embedding input limit
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4; // ~4 chars per token

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function estimateEmbeddingUsage(texts) {
  const items = Array.isArray(texts) ? texts : [texts];
  let sourceChars = 0;
  for (const text of items) {
    sourceChars += String(text || '').slice(0, MAX_CHUNK_CHARS).length;
  }
  const promptTokens = Math.ceil(sourceChars / 4);
  return { sourceChars, promptTokens, totalTokens: promptTokens };
}

function mergeEmbeddingUsage(target, usage) {
  if (!usage) return target;
  target.sourceChars += Number(usage.sourceChars || 0);
  target.promptTokens += Number(usage.promptTokens || 0);
  target.totalTokens += Number(usage.totalTokens || 0);
  return target;
}

function getProjectUsageMeta(db, projectId) {
  if (!projectId) return {};
  try {
    const row = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(projectId);
    if (!row) return {};
    return { projectId: row.id, projectName: row.name || null, projectPath: row.path || null };
  } catch {
    return { projectId };
  }
}

function logEmbeddingUsage(projectManager, db, payload) {
  const usage = payload?.usage;
  if (!projectManager?.logAIPromptCall || !usage || Number(usage.sourceChars || 0) <= 0) return;
  try {
    const projectMeta = getProjectUsageMeta(db, payload.projectId);
    projectManager.logAIPromptCall({
      promptId: null,
      taskType: payload.taskType || 'Embedding',
      model: GEMINI_EMBED_MODEL,
      thinkingLevel: null,
      promptTokens: Number(usage.promptTokens || 0),
      candidateTokens: 0,
      thoughtTokens: 0,
      totalTokens: Number(usage.totalTokens || 0),
      status: payload.status || 'success',
      error: payload.error ? String(payload.error).slice(0, 500) : null,
      sourceChars: Number(usage.sourceChars || 0),
      outputChars: 0,
      ...projectMeta,
      tabId: payload.tabId || null,
      tabName: payload.tabName || null,
      toolType: 'embedding',
      sessionId: payload.sessionId || null,
      entryUuid: payload.entryUuid || null,
      iterationIndex: null,
    });
  } catch (err) {
    console.warn('[SemanticSearch] failed to log embedding usage:', err.message);
  }
}

/**
 * Embed an array of texts via Gemini batchEmbedContents.
 * Returns array of Float32Array (768 dims each).
 */
async function embedTexts(texts) {
  if (texts.length === 0) return [];

  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const requests = batch.map(text => ({
      model: `models/${GEMINI_EMBED_MODEL}`,
      content: { parts: [{ text: text.slice(0, MAX_CHUNK_CHARS) }] },
      outputDimensionality: EMBEDDING_DIMS,
    }));

    const response = await fetch(GEMINI_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`[SemanticSearch] Gemini embed failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    for (const emb of data.embeddings) {
      allEmbeddings.push(new Float32Array(emb.values));
    }
  }

  return allEmbeddings;
}

/**
 * Embed a single query text (uses RETRIEVAL_QUERY task type for better search quality).
 */
async function embedQuery(text) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text: text.slice(0, MAX_CHUNK_CHARS) }] },
        outputDimensionality: EMBEDDING_DIMS,
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[SemanticSearch] Gemini query embed failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return new Float32Array(data.embedding.values);
}

// ========== COSINE SIMILARITY ==========

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function textHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function embeddingToBlob(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function blobToEmbedding(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

// ========== JSONL CHUNKING ==========

/**
 * Parse a JSONL session file into Q+A chunks.
 * Each chunk = user message + assistant text response.
 * Long responses are split into sub-chunks of MAX_CHUNK_CHARS.
 * Returns array of { text, role, startLine, endLine }.
 */
async function chunkSessionFile(filePath) {
  const messages = [];
  try {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.message) continue;
        const role = entry.message.role || entry.role || entry.type;
        if (role !== 'user' && role !== 'assistant') continue;

        let text = '';
        const msgContent = entry.message.content;
        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
        }

        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        if (!text) continue;
        messages.push({ role, text, line: lineNumber, timestamp: entry.timestamp || null });
      } catch {}
    }
  } catch {
    return [];
  }

  // Group into Q+A pairs
  const chunks = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'user') {
      // Look for next assistant response
      let assistantText = '';
      let endLine = msg.line;
      const nextIdx = i + 1;

      if (nextIdx < messages.length && messages[nextIdx].role === 'assistant') {
        assistantText = messages[nextIdx].text;
        endLine = messages[nextIdx].line;
        i += 2;
      } else {
        i += 1;
      }

      const combined = assistantText
        ? `User: ${msg.text}\n\nAssistant: ${assistantText}`
        : `User: ${msg.text}`;

      // Split long chunks
      if (combined.length > MAX_CHUNK_CHARS) {
        const subChunks = splitLongText(combined, MAX_CHUNK_CHARS);
        for (const sub of subChunks) {
          chunks.push({
            text: sub,
            startLine: msg.line,
            endLine,
            timestamp: msg.timestamp,
          });
        }
      } else {
        chunks.push({
          text: combined,
          startLine: msg.line,
          endLine,
          timestamp: msg.timestamp,
        });
      }
    } else {
      // Standalone assistant message (no preceding user message)
      const text = `Assistant: ${msg.text}`;
      if (text.length > MAX_CHUNK_CHARS) {
        const subChunks = splitLongText(text, MAX_CHUNK_CHARS);
        for (const sub of subChunks) {
          chunks.push({ text: sub, startLine: msg.line, endLine: msg.line, timestamp: msg.timestamp });
        }
      } else {
        chunks.push({ text, startLine: msg.line, endLine: msg.line, timestamp: msg.timestamp });
      }
      i += 1;
    }
  }

  return chunks;
}

/**
 * Split long text into sub-chunks with overlap.
 */
function splitLongText(text, maxChars, overlapChars = 200) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    parts.push(text.slice(start, end));
    start = end - overlapChars;
    if (start >= text.length - overlapChars) break;
  }
  return parts;
}

// ========== SQLITE SCHEMA & OPERATIONS ==========

/**
 * Initialize semantic search tables in existing database.
 */
function initSearchTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_slug TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      text TEXT NOT NULL,
      embedding BLOB,
      timestamp TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_session ON session_chunks(session_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_project ON session_chunks(project_slug);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON session_chunks(file_hash);
  `);

  const embeddingIndexStart = performance.now();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding_present
    ON session_chunks(id)
    WHERE embedding IS NOT NULL;
  `);
  const embeddingIndexMs = performance.now() - embeddingIndexStart;
  if (embeddingIndexMs > 100) {
    console.warn(`[SemanticSearch] embedding-present index init durMs=${embeddingIndexMs.toFixed(1)}`);
  }

  // Track which files have been indexed (by hash)
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      file_size INTEGER,
      file_mtime_ms REAL,
      session_id TEXT NOT NULL,
      project_slug TEXT NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  // Existing profiles predate the metadata witness. Add it in place instead
  // of forcing a semantic-index rebuild merely to change the tracker schema.
  const indexedFileColumns = new Set(
    db.prepare('PRAGMA table_info(indexed_files)').all().map((column) => column.name),
  );
  if (!indexedFileColumns.has('file_size')) {
    db.exec('ALTER TABLE indexed_files ADD COLUMN file_size INTEGER');
  }
  if (!indexedFileColumns.has('file_mtime_ms')) {
    db.exec('ALTER TABLE indexed_files ADD COLUMN file_mtime_ms REAL');
  }

  // FTS5 for keyword fallback
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, id UNINDEXED, session_id UNINDEXED, project_slug UNINDEXED
    )
  `);

  console.log('[SemanticSearch] Tables initialized');
}

function initTabTitleSearchTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tab_history_title_index (
      history_id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_hash TEXT NOT NULL,
      embedding BLOB,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY(history_id) REFERENCES tab_history(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_title_index_project
    ON tab_history_title_index(project_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_title_index_project_hash
    ON tab_history_title_index(project_id, name_hash)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_history_project_closed_id
    ON tab_history(project_id, closed_at DESC, id DESC)
  `);
}

function initTabIterationSearchTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tab_history_iteration_index (
      history_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      tool_type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      entry_uuid TEXT NOT NULL,
      iteration_index INTEGER NOT NULL,
      summary TEXT DEFAULT NULL,
      content TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      embedding BLOB,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (history_id, entry_uuid),
      FOREIGN KEY(history_id) REFERENCES tab_history(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_iteration_index_project
    ON tab_history_iteration_index(project_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_iteration_index_session
    ON tab_history_iteration_index(tool_type, session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_iteration_index_project_history
    ON tab_history_iteration_index(project_id, history_id, iteration_index)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tab_history_iteration_scan (
      history_id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      tool_type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      iteration_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scanned',
      error TEXT DEFAULT NULL,
      scanned_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY(history_id) REFERENCES tab_history(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tab_iteration_scan_project
    ON tab_history_iteration_scan(project_id)
  `);
}

/**
 * Compute SHA256 hash of a file.
 */
function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Check if a file is already indexed with the same hash AND has embeddings.
 */
function isFileIndexed(db, filePath, hash) {
  const row = db.prepare('SELECT file_hash FROM indexed_files WHERE file_path = ?').get(filePath);
  if (!row || row.file_hash !== hash) return false;
  // Also check that embeddings actually exist (may have been indexed with broken model)
  const hasEmbeddings = db.prepare(
    'SELECT 1 FROM session_chunks WHERE file_path = ? AND embedding IS NOT NULL LIMIT 1'
  ).get(filePath);
  return !!hasEmbeddings;
}

function hasIndexedEmbeddings(db, filePath) {
  return !!db.prepare(
    'SELECT 1 FROM session_chunks WHERE file_path = ? AND embedding IS NOT NULL LIMIT 1'
  ).get(filePath);
}

/**
 * Index a single session JSONL file.
 * Returns { chunked, embedded, skipped } counts.
 */
async function indexSessionFile(db, filePath, sessionId, projectSlug) {
  const stat = fs.statSync(filePath);
  const indexed = db.prepare(
    'SELECT file_hash, file_size, file_mtime_ms FROM indexed_files WHERE file_path = ?'
  ).get(filePath);
  if (indexed
    && Number(indexed.file_size) === stat.size
    && Number(indexed.file_mtime_ms) === stat.mtimeMs
    && hasIndexedEmbeddings(db, filePath)) {
    return { chunked: 0, embedded: 0, skipped: true };
  }

  // Changed/legacy tracker: hash asynchronously so a manual index of a 111MB
  // session cannot stop the Electron main loop. A matching hash upgrades old
  // tracker rows with the cheap metadata witness for every later request.
  const hash = await fileHash(filePath);

  // Skip if already indexed with same hash
  if (isFileIndexed(db, filePath, hash)) {
    db.prepare(
      'UPDATE indexed_files SET file_size = ?, file_mtime_ms = ? WHERE file_path = ?'
    ).run(stat.size, stat.mtimeMs, filePath);
    return { chunked: 0, embedded: 0, skipped: true };
  }

  // Delete old chunks for this file (re-index) — FTS first (references chunk IDs), then chunks
  const oldIds = db.prepare('SELECT id FROM session_chunks WHERE file_path = ?').all(filePath).map(r => r.id);
  if (oldIds.length > 0) {
    const placeholders = oldIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM chunks_fts WHERE id IN (${placeholders})`).run(...oldIds);
  }
  db.prepare('DELETE FROM session_chunks WHERE file_path = ?').run(filePath);

  // Chunk the file
  const chunks = await chunkSessionFile(filePath);
  if (chunks.length === 0) {
    return { chunked: 0, embedded: 0, skipped: false };
  }

  // Embed all chunks
  const embeddingUsage = estimateEmbeddingUsage(chunks.map(c => c.text));
  let embeddings;
  let embeddingError = null;
  try {
    embeddings = await embedTexts(chunks.map(c => c.text));
  } catch (err) {
    console.error('[SemanticSearch] Embedding failed, storing chunks without vectors:', err.message);
    embeddingError = err.message;
    embeddings = null;
  }

  // Insert chunks into DB
  const insertChunk = db.prepare(`
    INSERT INTO session_chunks (id, session_id, project_slug, file_path, file_hash, start_line, end_line, text, embedding, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO chunks_fts (text, id, session_id, project_slug)
    VALUES (?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkId = crypto.randomUUID();
      const embeddingBlob = embeddings && embeddings[i]
        ? Buffer.from(embeddings[i].buffer)
        : null;

      insertChunk.run(
        chunkId, sessionId, projectSlug, filePath, hash,
        chunk.startLine, chunk.endLine, chunk.text,
        embeddingBlob, chunk.timestamp
      );
      insertFts.run(chunk.text, chunkId, sessionId, projectSlug);
    }

    // Update indexed_files tracker
    db.prepare(`
      INSERT OR REPLACE INTO indexed_files
        (file_path, file_hash, file_size, file_mtime_ms, session_id, project_slug, chunk_count, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    `).run(filePath, hash, stat.size, stat.mtimeMs, sessionId, projectSlug, chunks.length);
  });

  insertAll();

  return {
    chunked: chunks.length,
    embedded: embeddings ? chunks.length : 0,
    skipped: false,
    embeddingUsage,
    embeddingError,
  };
}

/**
 * Discover all JSONL session files across all Claude project directories.
 * Returns sorted by mtime descending (newest first).
 */
function discoverSessionFiles() {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const files = [];

  if (!fs.existsSync(claudeProjectsDir)) return files;

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const slug of projectDirs) {
    const dirPath = path.join(claudeProjectsDir, slug);
    try {
      const dirEntries = fs.readdirSync(dirPath);
      for (const file of dirEntries) {
        if (!file.endsWith('.jsonl')) continue;
        const fullPath = path.join(dirPath, file);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch {}
        files.push({
          filePath: fullPath,
          sessionId: path.basename(file, '.jsonl'),
          projectSlug: slug,
          mtimeMs,
        });
      }
    } catch {}
  }

  // Sort newest first
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

/**
 * Index session files. Skips already-indexed (by hash).
 * @param {number} limit - Max number of sessions to index (0 = all). Counts from newest.
 * Calls progressCb(current, total) for progress reporting.
 */
async function indexAllSessions(db, progressCb, limit = 0) {
  let files = discoverSessionFiles();
  if (limit > 0) {
    files = files.slice(0, limit);
  }
  const total = files.length;
  let indexed = 0, skipped = 0, failed = 0, embeddingErrors = 0;
  const embeddingUsage = { sourceChars: 0, promptTokens: 0, totalTokens: 0 };

  for (let i = 0; i < files.length; i++) {
    const { filePath, sessionId, projectSlug } = files[i];
    try {
      const result = await indexSessionFile(db, filePath, sessionId, projectSlug);
      if (result.skipped) {
        skipped++;
      } else {
        indexed++;
        mergeEmbeddingUsage(embeddingUsage, result.embeddingUsage);
        if (result.embeddingError) embeddingErrors++;
        console.log(`[SemanticSearch] Indexed ${sessionId} (${result.chunked} chunks)`);
      }
    } catch (err) {
      failed++;
      console.error(`[SemanticSearch] Failed to index ${sessionId}:`, err.message);
    }
    if (progressCb) progressCb(i + 1, total, { indexed, skipped, failed });
  }

  return { total, indexed, skipped, failed, embeddingErrors, embeddingUsage };
}

// ========== TAB NAME ENRICHMENT ==========

/**
 * Look up tab names from tab_history by claude_session_id.
 * Mutates results array, adding `tabName` field.
 */
function enrichWithTabNames(db, results) {
  if (results.length === 0) return;
  const uniqueSessionIds = [...new Set(results.map(r => r.sessionId))];
  const nameMap = new Map();

  // Query tab_history for matching session IDs
  // Also check active tabs table
  for (const sid of uniqueSessionIds) {
    const row = db.prepare(
      'SELECT name FROM tab_history WHERE claude_session_id = ? ORDER BY closed_at DESC LIMIT 1'
    ).get(sid);
    if (row) {
      nameMap.set(sid, row.name);
    } else {
      // Try active tabs
      const activeRow = db.prepare(
        'SELECT name FROM tabs WHERE claude_session_id = ? LIMIT 1'
      ).get(sid);
      if (activeRow) nameMap.set(sid, activeRow.name);
    }
  }

  for (const r of results) {
    r.tabName = nameMap.get(r.sessionId) || null;
  }
}

// ========== SEARCH ==========

/**
 * Search session chunks by semantic similarity.
 * Supports date range and project filtering.
 *
 * Returns: Array of { text, score, sessionId, projectSlug, timestamp, startLine, endLine }
 */
async function searchSessions(db, query, opts = {}) {
  const {
    maxResults = 30,
    minScore = 0.3,
    projectSlug = null,
    dateFrom = null,
    dateTo = null,
  } = opts;

  // Step 1: Embed the query
  let queryVec;
  const queryUsage = estimateEmbeddingUsage([query]);
  try {
    queryVec = await embedQuery(query);
    if (opts.onEmbeddingCall) opts.onEmbeddingCall({ usage: queryUsage, status: 'success' });
  } catch (err) {
    console.error('[SemanticSearch] Query embedding failed, falling back to FTS:', err.message);
    if (opts.onEmbeddingCall) opts.onEmbeddingCall({ usage: queryUsage, status: 'error', error: err.message });
    return ftsSearch(db, query, opts);
  }

  // Step 2: Load candidate chunks (with pre-filtering)
  let sql = 'SELECT id, session_id, project_slug, text, embedding, timestamp, start_line, end_line FROM session_chunks WHERE embedding IS NOT NULL';
  const params = [];

  if (projectSlug) {
    sql += ' AND project_slug = ?';
    params.push(projectSlug);
  }
  if (dateFrom) {
    sql += ' AND timestamp >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND timestamp <= ?';
    params.push(dateTo);
  }

  const rows = db.prepare(sql).all(...params);

  // Step 3: Compute cosine similarity for each chunk
  const scored = [];
  for (const row of rows) {
    const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const score = cosineSimilarity(queryVec, embedding);
    if (score >= minScore) {
      scored.push({
        text: row.text,
        score,
        sessionId: row.session_id,
        projectSlug: row.project_slug,
        timestamp: row.timestamp,
        startLine: row.start_line,
        endLine: row.end_line,
      });
    }
  }

  // Step 4: Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, maxResults);

  // Step 5: Enrich with tab names from tab_history
  enrichWithTabNames(db, results);

  return results;
}

/**
 * FTS5 keyword search fallback (when embedding API is unavailable).
 */
function ftsSearch(db, query, opts = {}) {
  const { maxResults = 30, projectSlug = null } = opts;

  // Extract keywords
  const keywords = query.match(/[\p{L}\p{N}_]+/gu);
  if (!keywords || keywords.length === 0) return [];

  const ftsQuery = keywords.map(k => `"${k}"`).join(' AND ');

  let sql = `
    SELECT f.id, f.text, f.session_id, f.project_slug,
           c.timestamp, c.start_line, c.end_line,
           bm25(chunks_fts) as rank
    FROM chunks_fts f
    JOIN session_chunks c ON c.id = f.id
    WHERE chunks_fts MATCH ?
  `;
  const params = [ftsQuery];

  if (projectSlug) {
    sql += ' AND f.project_slug = ?';
    params.push(projectSlug);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(maxResults);

  try {
    const rows = db.prepare(sql).all(...params);
    const ftsResults = rows.map(r => ({
      text: r.text,
      score: r.rank < 0 ? (-r.rank) / (1 + -r.rank) : 1 / (1 + Math.abs(r.rank)),
      sessionId: r.session_id,
      projectSlug: r.project_slug,
      timestamp: r.timestamp,
      startLine: r.start_line,
      endLine: r.end_line,
    }));
    enrichWithTabNames(db, ftsResults);
    return ftsResults;
  } catch (err) {
    console.error('[SemanticSearch] FTS search failed:', err.message);
    return [];
  }
}

// ========== STATS ==========

function getIndexStats(db) {
  const chunkCount = db.prepare('SELECT COUNT(*) as count FROM session_chunks').get()?.count || 0;
  const fileCount = db.prepare('SELECT COUNT(*) as count FROM indexed_files').get()?.count || 0;
  const withEmbeddings = db.prepare('SELECT COUNT(*) as count FROM session_chunks WHERE embedding IS NOT NULL').get()?.count || 0;
  const projectCount = db.prepare('SELECT COUNT(DISTINCT project_slug) as count FROM session_chunks').get()?.count || 0;
  return { chunkCount, fileCount, withEmbeddings, projectCount };
}

// ========== IPC HANDLERS ==========

let _indexingInProgress = false;
let _titleIndexingInProgress = false;
let _iterationIndexingInProgress = false;
const NON_FILE_HISTORY_PREDICATE = "(h.tab_type IS NULL OR h.tab_type != 'file')";
const NON_FILE_HISTORY_PREDICATE_UNALIASED = "(tab_type IS NULL OR tab_type != 'file')";

function cleanupTabTitleIndex(db) {
  db.prepare(`
    DELETE FROM tab_history_title_index
     WHERE history_id NOT IN (SELECT id FROM tab_history)
        OR history_id IN (SELECT id FROM tab_history WHERE tab_type = 'file')
  `).run();
}

function cleanupTabIterationIndex(db) {
  db.prepare(`
    DELETE FROM tab_history_iteration_index
     WHERE history_id NOT IN (SELECT id FROM tab_history)
        OR history_id IN (SELECT id FROM tab_history WHERE tab_type = 'file')
  `).run();
  db.prepare(`
    DELETE FROM tab_history_iteration_scan
     WHERE history_id NOT IN (SELECT id FROM tab_history)
        OR history_id IN (SELECT id FROM tab_history WHERE tab_type = 'file')
  `).run();
}

function getTabTitleIndexStats(db, projectId) {
  cleanupTabTitleIndex(db);
  const total = db.prepare(
    `SELECT COUNT(*) AS count FROM tab_history WHERE project_id = ? AND ${NON_FILE_HISTORY_PREDICATE_UNALIASED}`
  ).get(projectId)?.count || 0;
  const indexed = db.prepare(`
    SELECT COUNT(*) AS count
      FROM tab_history h
      JOIN tab_history_title_index i ON i.history_id = h.id
     WHERE h.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       AND i.embedding IS NOT NULL
  `).get(projectId)?.count || 0;
  return {
    total,
    indexed,
    unindexed: Math.max(0, total - indexed),
    model: GEMINI_EMBED_MODEL,
    dims: EMBEDDING_DIMS,
    inProgress: _titleIndexingInProgress,
  };
}

function clearTabTitleIndex(db, projectId) {
  const result = db.prepare('DELETE FROM tab_history_title_index WHERE project_id = ?').run(projectId);
  return { deleted: result.changes || 0, stats: getTabTitleIndexStats(db, projectId) };
}

async function indexTabTitles(db, projectId, progressCb, force = false) {
  cleanupTabTitleIndex(db);
  const rows = db.prepare(`
    SELECT h.id, h.project_id, h.name, i.name_hash, i.embedding
      FROM tab_history h
      LEFT JOIN tab_history_title_index i ON i.history_id = h.id
     WHERE h.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
     ORDER BY h.closed_at DESC, h.id DESC
  `).all(projectId);

  const pending = rows
    .map((row) => {
      const name = String(row.name || 'tab').trim() || 'tab';
      const hash = textHash(name);
      return { id: row.id, projectId: row.project_id, name, hash, indexedHash: row.name_hash, hasEmbedding: !!row.embedding };
    })
    .filter((row) => force || row.indexedHash !== row.hash || !row.hasEmbedding);

  const total = pending.length;
  if (total === 0) {
    if (progressCb) progressCb(0, 0);
    return { total: rows.length, indexed: 0, skipped: rows.length, failed: 0, embeddingUsage: estimateEmbeddingUsage([]) };
  }

  let indexed = 0;
  let failed = 0;
  const embeddingUsage = estimateEmbeddingUsage(pending.map((row) => row.name));
  const upsert = db.prepare(`
    INSERT INTO tab_history_title_index (history_id, project_id, name, name_hash, embedding, indexed_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(history_id) DO UPDATE SET
      project_id = excluded.project_id,
      name = excluded.name,
      name_hash = excluded.name_hash,
      embedding = excluded.embedding,
      indexed_at = excluded.indexed_at
  `);

  for (let i = 0; i < pending.length; i += MAX_BATCH_SIZE) {
    const batch = pending.slice(i, i + MAX_BATCH_SIZE);
    try {
      const embeddings = await embedTexts(batch.map((row) => row.name));
      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j];
          const embedding = embeddings[j] ? embeddingToBlob(embeddings[j]) : null;
          upsert.run(row.id, row.projectId, row.name, row.hash, embedding);
        }
      });
      tx();
      indexed += batch.length;
    } catch (err) {
      failed += batch.length;
      console.error('[TabTitleSearch] title index batch failed:', err.message);
    }
    if (progressCb) progressCb(Math.min(i + batch.length, pending.length), pending.length, { indexed, failed });
  }

  return {
    total: rows.length,
    indexed,
    skipped: rows.length - pending.length,
    failed,
    embeddingUsage,
  };
}

async function indexTabTitleHistory(db, projectId, historyId) {
  cleanupTabTitleIndex(db);
  const row = db.prepare(`
    SELECT h.id, h.project_id, h.name, i.name_hash, i.embedding
      FROM tab_history h
      LEFT JOIN tab_history_title_index i ON i.history_id = h.id
     WHERE h.project_id = ?
       AND h.id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
  `).get(projectId, historyId);
  if (!row) return { total: 0, indexed: 0, skipped: 0, failed: 0, embeddingUsage: estimateEmbeddingUsage([]) };

  const name = String(row.name || 'tab').trim() || 'tab';
  const hash = textHash(name);
  if (row.name_hash === hash && row.embedding) {
    return { total: 1, indexed: 0, skipped: 1, failed: 0, embeddingUsage: estimateEmbeddingUsage([]) };
  }

  const embeddingUsage = estimateEmbeddingUsage([name]);
  const upsert = db.prepare(`
    INSERT INTO tab_history_title_index (history_id, project_id, name, name_hash, embedding, indexed_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(history_id) DO UPDATE SET
      project_id = excluded.project_id,
      name = excluded.name,
      name_hash = excluded.name_hash,
      embedding = excluded.embedding,
      indexed_at = excluded.indexed_at
  `);

  try {
    const [embedding] = await embedTexts([name]);
    upsert.run(row.id, row.project_id, name, hash, embedding ? embeddingToBlob(embedding) : null);
    return { total: 1, indexed: 1, skipped: 0, failed: 0, embeddingUsage };
  } catch (err) {
    console.error('[TabTitleSearch] auto title index failed historyId=' + historyId + ':', err.message);
    return { total: 1, indexed: 0, skipped: 0, failed: 1, embeddingUsage };
  }
}

async function searchTabTitles(db, projectId, query, opts = {}) {
  const text = String(query || '').trim();
  if (text.length === 0) return [];
  const maxResults = opts.maxResults || 80;
  const minScore = opts.minScore ?? 0.40;
  const rows = db.prepare(`
    SELECT h.*, i.embedding
      FROM tab_history h
      JOIN tab_history_title_index i ON i.history_id = h.id
     WHERE h.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       AND i.embedding IS NOT NULL
     ORDER BY h.closed_at DESC, h.id DESC
  `).all(projectId);
  if (rows.length === 0) return [];

  const queryUsage = estimateEmbeddingUsage([text]);
  let queryVec;
  try {
    queryVec = await embedQuery(text);
    if (opts.onEmbeddingCall) opts.onEmbeddingCall({ usage: queryUsage, status: 'success' });
  } catch (err) {
    if (opts.onEmbeddingCall) opts.onEmbeddingCall({ usage: queryUsage, status: 'error', error: err.message });
    throw err;
  }

  const scored = [];
  for (const row of rows) {
    const score = cosineSimilarity(queryVec, blobToEmbedding(row.embedding));
    if (score < minScore) continue;
    const { embedding, ...entry } = row;
    scored.push({ ...entry, score });
  }
  scored.sort((a, b) => b.score - a.score || b.closed_at - a.closed_at || b.id - a.id);
  return scored.slice(0, maxResults);
}

function getHistoryIterationTarget(row) {
  if (!row) return null;
  if (row.command_type === 'codex' && row.codex_session_id) {
    return { toolType: 'codex', sessionId: row.codex_session_id };
  }
  if (row.command_type === 'claude' && row.claude_session_id) {
    return { toolType: 'claude', sessionId: row.claude_session_id };
  }
  if (row.codex_session_id) return { toolType: 'codex', sessionId: row.codex_session_id };
  if (row.claude_session_id) return { toolType: 'claude', sessionId: row.claude_session_id };
  return null;
}

function truncateIterationText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHUNK_CHARS);
}

function normalizeDateFrom(dateFrom) {
  const raw = String(dateFrom || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ts = Math.floor(new Date(`${raw}T00:00:00`).getTime() / 1000);
  return Number.isFinite(ts) ? ts : null;
}

function normalizeTimestampSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const seconds = value > 9999999999 ? Math.floor(value / 1000) : Math.floor(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return normalizeTimestampSeconds(Number(raw));
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function getPromptSummaries(db, toolType, sessionId) {
  const rows = db.prepare(`
    SELECT entry_uuid, summary
      FROM timeline_prompt_summaries
     WHERE tool_type = ?
       AND session_id = ?
  `).all(toolType, sessionId);
  const map = new Map();
  for (const row of rows) {
    if (row.entry_uuid && row.summary) map.set(row.entry_uuid, row.summary);
  }
  return map;
}

async function loadHistoryIterations(row, claudeData, codexData) {
  const target = getHistoryIterationTarget(row);
  if (!target) return [];

  if (target.toolType === 'codex') {
    const loaded = await codexData?._api?.loadSessionRecords?.(target.sessionId, row.cwd);
    if (!loaded?.success) return [];
    return (codexData?._api?.buildCodexTimeline?.(loaded.records || [], target.sessionId) || [])
      .filter((entry) => entry?.type === 'user' && entry.uuid && String(entry.content || '').trim())
      .map((entry, index) => ({
        uuid: entry.uuid,
        content: String(entry.content || ''),
        iterationIndex: Number.isFinite(entry.turnIndex) ? entry.turnIndex : index,
        ts: entry.timestamp || null,
      }));
  }

  const found = claudeData?.findSessionFile?.(target.sessionId, row.cwd);
  if (!found?.filePath) return [];
  return (claudeData?.parseTimelineEntries?.(found.filePath) || [])
    .filter((entry) => entry?.kind === 'user' && entry.uuid && String(entry.full || entry.preview || '').trim())
    .map((entry, index) => ({
      uuid: entry.uuid,
      content: String(entry.full || entry.preview || ''),
      iterationIndex: index,
      ts: entry.ts || null,
    }));
}

function getTabIterationIndexStats(db, projectId, opts = {}) {
  cleanupTabIterationIndex(db);
  const dateFromTs = normalizeDateFrom(opts.dateFrom);
  const dateWhere = dateFromTs ? ' AND h.closed_at >= ?' : '';
  const indexParams = dateFromTs ? [projectId, dateFromTs] : [projectId];
  const missingApprox = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN message_count IS NULL THEN 0 ELSE message_count END), 0) AS count
      FROM tab_history h
     WHERE h.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       AND (claude_session_id IS NOT NULL OR codex_session_id IS NOT NULL)
       ${dateWhere}
       AND id NOT IN (
         SELECT DISTINCT history_id
           FROM tab_history_iteration_index
          WHERE project_id = ?
       )
       AND id NOT IN (
         SELECT history_id
           FROM tab_history_iteration_scan
          WHERE project_id = ?
       )
  `).get(...(dateFromTs ? [projectId, dateFromTs, projectId, projectId] : [projectId, projectId, projectId]))?.count || 0;
  const indexed = db.prepare(`
    SELECT COUNT(*) AS count
      FROM tab_history_iteration_index
      JOIN tab_history h ON h.id = tab_history_iteration_index.history_id
     WHERE tab_history_iteration_index.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       ${dateWhere}
       AND embedding IS NOT NULL
  `).get(...indexParams)?.count || 0;
  const discovered = db.prepare(`
    SELECT COUNT(*) AS count
      FROM tab_history_iteration_index
      JOIN tab_history h ON h.id = tab_history_iteration_index.history_id
     WHERE tab_history_iteration_index.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       ${dateWhere}
  `).get(...indexParams)?.count || 0;
  const total = Math.max(discovered + (Number(missingApprox) || 0), indexed, discovered);
  return {
    total,
    indexed,
    discovered,
    unindexed: Math.max(0, total - indexed),
    model: GEMINI_EMBED_MODEL,
    dims: EMBEDDING_DIMS,
    inProgress: _iterationIndexingInProgress,
  };
}

function clearTabIterationIndex(db, projectId) {
  const result = db.prepare('DELETE FROM tab_history_iteration_index WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM tab_history_iteration_scan WHERE project_id = ?').run(projectId);
  return { deleted: result.changes || 0, stats: getTabIterationIndexStats(db, projectId) };
}

async function indexTabIterations(db, projectId, progressCb, force = false, claudeData, codexData, opts = {}) {
  cleanupTabIterationIndex(db);
  const dateFromTs = normalizeDateFrom(opts.dateFrom);
  const targetHistoryId = Number(opts.historyId || 0);
  const minEntryTs = normalizeTimestampSeconds(opts.minEntryTs);
  const dateWhere = dateFromTs ? ' AND h.closed_at >= ?' : '';
  const historyWhere = targetHistoryId > 0 ? ' AND h.id = ?' : '';
  const rowParams = [projectId];
  if (dateFromTs) rowParams.push(dateFromTs);
  if (targetHistoryId > 0) rowParams.push(targetHistoryId);
  const rows = db.prepare(`
    SELECT h.*, i.entry_uuid AS indexed_entry_uuid
      FROM tab_history h
      LEFT JOIN tab_history_iteration_index i ON i.history_id = h.id
     WHERE h.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       AND (h.claude_session_id IS NOT NULL OR h.codex_session_id IS NOT NULL)
       ${dateWhere}
       ${historyWhere}
     GROUP BY h.id
     ORDER BY h.closed_at DESC, h.id DESC
  `).all(...rowParams);

  if (force) {
    if (targetHistoryId > 0) {
      db.prepare('DELETE FROM tab_history_iteration_index WHERE project_id = ? AND history_id = ?').run(projectId, targetHistoryId);
      db.prepare('DELETE FROM tab_history_iteration_scan WHERE project_id = ? AND history_id = ?').run(projectId, targetHistoryId);
    } else if (dateFromTs) {
      db.prepare(`
        DELETE FROM tab_history_iteration_index
         WHERE project_id = ?
           AND history_id IN (
             SELECT id FROM tab_history
              WHERE project_id = ?
                AND closed_at >= ?
           )
      `).run(projectId, projectId, dateFromTs);
      db.prepare(`
        DELETE FROM tab_history_iteration_scan
         WHERE project_id = ?
           AND history_id IN (
             SELECT id FROM tab_history
              WHERE project_id = ?
                AND closed_at >= ?
           )
      `).run(projectId, projectId, dateFromTs);
    } else {
      db.prepare('DELETE FROM tab_history_iteration_index WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM tab_history_iteration_scan WHERE project_id = ?').run(projectId);
    }
  }

  const existingRows = db.prepare(`
    SELECT i.history_id, i.entry_uuid, i.text_hash, i.embedding
      FROM tab_history_iteration_index i
      JOIN tab_history h ON h.id = i.history_id
     WHERE i.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       ${dateWhere}
       ${historyWhere}
  `).all(...rowParams);
  const existing = new Map();
  for (const row of existingRows) {
    existing.set(`${row.history_id}:${row.entry_uuid}`, row);
  }

  const pending = [];
  let parsedRows = 0;
  let failed = 0;
  const upsertScan = db.prepare(`
    INSERT INTO tab_history_iteration_scan (
      history_id, project_id, tool_type, session_id, iteration_count, status, error, scanned_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(history_id) DO UPDATE SET
      project_id = excluded.project_id,
      tool_type = excluded.tool_type,
      session_id = excluded.session_id,
      iteration_count = excluded.iteration_count,
      status = excluded.status,
      error = excluded.error,
      scanned_at = excluded.scanned_at
  `);

  if (progressCb) {
    progressCb(0, rows.length, { phase: 'scan', parsedRows, pending: 0, failed });
    await yieldToEventLoop();
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const target = getHistoryIterationTarget(row);
    if (!target) continue;
    try {
      const summaries = getPromptSummaries(db, target.toolType, target.sessionId);
      const iterations = await loadHistoryIterations(row, claudeData, codexData);
      parsedRows += 1;
      upsertScan.run(row.id, row.project_id, target.toolType, target.sessionId, iterations.length, iterations.length > 0 ? 'scanned' : 'empty', null);
      for (let j = 0; j < iterations.length; j++) {
        const iteration = iterations[j];
        const iterationTs = normalizeTimestampSeconds(iteration.ts);
        if (minEntryTs && (!iterationTs || iterationTs < minEntryTs)) continue;
        const summary = String(summaries.get(iteration.uuid) || '').trim();
        const content = truncateIterationText(iteration.content);
        if (!content) continue;
        const embedText = truncateIterationText(summary ? `${summary}\n\n${content}` : content);
        const hash = textHash(embedText);
        const key = `${row.id}:${iteration.uuid}`;
        const prev = existing.get(key);
        if (!force && prev?.text_hash === hash && prev?.embedding) continue;
        pending.push({
          historyId: row.id,
          projectId: row.project_id,
          toolType: target.toolType,
          sessionId: target.sessionId,
          entryUuid: iteration.uuid,
          iterationIndex: Number.isFinite(iteration.iterationIndex) ? iteration.iterationIndex : j,
          summary: summary || null,
          content,
          embedText,
          hash,
        });
      }
    } catch (err) {
      failed += 1;
      upsertScan.run(row.id, row.project_id, target.toolType, target.sessionId, 0, 'error', String(err?.message || err).slice(0, 500));
      console.error('[TabIterationSearch] load failed historyId=' + row.id + ':', err.message);
    }
    if (progressCb) {
      progressCb(i + 1, rows.length, { phase: 'scan', parsedRows, pending: pending.length, failed });
      await yieldToEventLoop();
    }
  }

  const upsert = db.prepare(`
    INSERT INTO tab_history_iteration_index (
      history_id, project_id, tool_type, session_id, entry_uuid, iteration_index,
      summary, content, text_hash, embedding, indexed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(history_id, entry_uuid) DO UPDATE SET
      project_id = excluded.project_id,
      tool_type = excluded.tool_type,
      session_id = excluded.session_id,
      iteration_index = excluded.iteration_index,
      summary = excluded.summary,
      content = excluded.content,
      text_hash = excluded.text_hash,
      embedding = excluded.embedding,
      indexed_at = excluded.indexed_at
  `);

  let indexed = 0;
  let processedEmbeddings = 0;
  const embeddingUsage = estimateEmbeddingUsage(pending.map((row) => row.embedText));
  if (progressCb && pending.length > 0) {
    progressCb(0, pending.length, { phase: 'embed', parsedRows, indexed, failed, pending: pending.length });
    await yieldToEventLoop();
  }
  for (let i = 0; i < pending.length; i += MAX_BATCH_SIZE) {
    const batch = pending.slice(i, i + MAX_BATCH_SIZE);
    try {
      const embeddings = await embedTexts(batch.map((row) => row.embedText));
      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j];
          const embedding = embeddings[j] ? embeddingToBlob(embeddings[j]) : null;
          upsert.run(
            row.historyId,
            row.projectId,
            row.toolType,
            row.sessionId,
            row.entryUuid,
            row.iterationIndex,
            row.summary,
            row.content,
            row.hash,
            embedding
          );
        }
      });
      tx();
      indexed += batch.length;
    } catch (err) {
      failed += batch.length;
      console.error('[TabIterationSearch] embedding batch failed:', err.message);
    }
    processedEmbeddings += batch.length;
    if (progressCb) {
      progressCb(processedEmbeddings, pending.length, {
        phase: 'embed',
        parsedRows,
        indexed,
        failed,
        pending: Math.max(0, pending.length - i - batch.length),
      });
      await yieldToEventLoop();
    }
  }

  return {
    totalHistories: rows.length,
    parsedRows,
    indexed,
    skipped: Math.max(0, existingRows.length - pending.length),
    failed,
    embeddingUsage,
  };
}

async function searchTabIterations(db, projectId, query, opts = {}) {
  const text = String(query || '').trim();
  if (text.length === 0) return [];
  const maxResults = opts.maxResults || 80;
  const minScore = opts.minScore ?? 0.34;
  const dateFromTs = normalizeDateFrom(opts.dateFrom);
  const dateWhere = dateFromTs ? ' AND h.closed_at >= ?' : '';
  const rowParams = dateFromTs ? [projectId, dateFromTs] : [projectId];
  const rows = db.prepare(`
    SELECT h.*, i.tool_type, i.session_id, i.entry_uuid, i.iteration_index,
           i.summary, i.content, i.embedding
      FROM tab_history_iteration_index i
      JOIN tab_history h ON h.id = i.history_id
     WHERE i.project_id = ?
       AND ${NON_FILE_HISTORY_PREDICATE}
       AND i.embedding IS NOT NULL
       ${dateWhere}
     ORDER BY h.closed_at DESC, i.iteration_index ASC
  `).all(...rowParams);
  if (rows.length === 0) return [];

  const queryUsage = estimateEmbeddingUsage([text]);
  let queryVec;
  try {
    queryVec = await embedQuery(text);
    if (opts.onEmbeddingCall) opts.onEmbeddingCall({ usage: queryUsage, status: 'success' });
  } catch (err) {
    if (opts.onEmbeddingCall) opts.onEmbeddingCall({ usage: queryUsage, status: 'error', error: err.message });
    throw err;
  }
  const scored = [];
  for (const row of rows) {
    const score = cosineSimilarity(queryVec, blobToEmbedding(row.embedding));
    if (score < minScore) continue;
    const { embedding, tool_type, session_id, entry_uuid, iteration_index, summary, content, ...entry } = row;
    scored.push({
      ...entry,
      toolType: tool_type,
      sessionId: session_id,
      entryUuid: entry_uuid,
      iterationIndex: iteration_index,
      summary,
      content,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score || b.closed_at - a.closed_at || a.iterationIndex - b.iterationIndex);
  return scored.slice(0, maxResults);
}

function register({ projectManager, mainWindow, claudeData, codexData }) {
  const db = projectManager.db.db; // Access raw better-sqlite3 instance

  // Initialize tables on startup
  initSearchTables(db);
  initTabTitleSearchTables(db);
  initTabIterationSearchTables(db);

  // Search sessions
  ipcMain.handle('search:query', async (event, { query, maxResults, minScore, projectSlug, dateFrom, dateTo }) => {
    try {
      const results = await searchSessions(db, query, {
        maxResults,
        minScore,
        projectSlug,
        dateFrom,
        dateTo,
        onEmbeddingCall: (call) => logEmbeddingUsage(projectManager, db, {
          taskType: 'Embedding: transcript query',
          ...call,
        }),
      });
      return { success: true, data: results };
    } catch (error) {
      console.error('[SemanticSearch] Search error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Index a single session file (called on tab close)
  ipcMain.handle('search:index-session', async (event, { filePath, sessionId, projectSlug }) => {
    try {
      const result = await indexSessionFile(db, filePath, sessionId, projectSlug);
      logEmbeddingUsage(projectManager, db, {
        taskType: 'Embedding: transcript index',
        usage: result.embeddingUsage,
        status: result.embeddingError ? 'error' : 'success',
        error: result.embeddingError,
        sessionId,
      });
      console.log(`[SemanticSearch] Indexed session ${sessionId}: ${result.chunked} chunks`);
      return { success: true, ...result };
    } catch (error) {
      console.error('[SemanticSearch] Index session error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Index ALL sessions (bulk re-index)
  ipcMain.handle('search:index-all', async (event, opts) => {
    if (_indexingInProgress) {
      return { success: false, error: 'Indexing already in progress' };
    }

    const limit = opts?.limit || 0;
    _indexingInProgress = true;
    try {
      const result = await indexAllSessions(db, (current, total, stats) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('search:index-progress', { current, total, ...stats });
        }
      }, limit);
      logEmbeddingUsage(projectManager, db, {
        taskType: 'Embedding: transcript bulk index',
        usage: result.embeddingUsage,
        status: result.failed || result.embeddingErrors ? 'error' : 'success',
        error: result.failed || result.embeddingErrors
          ? `${result.failed || 0} file(s) failed, ${result.embeddingErrors || 0} embedding file(s) without vectors`
          : null,
      });
      console.log(`[SemanticSearch] Bulk index complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`);
      return { success: true, ...result };
    } catch (error) {
      console.error('[SemanticSearch] Bulk index error:', error.message);
      return { success: false, error: error.message };
    } finally {
      _indexingInProgress = false;
    }
  });

  // Get index stats
  ipcMain.handle('search:stats', async () => {
    try {
      return { success: true, data: getIndexStats(db) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Check if indexing is in progress
  ipcMain.handle('search:is-indexing', async () => {
    return { inProgress: _indexingInProgress };
  });

  ipcMain.handle('tab-title-index:stats', async (event, { projectId }) => {
    try {
      return { success: true, data: getTabTitleIndexStats(db, projectId) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('tab-title-index:reindex', async (event, { projectId, force }) => {
    if (_titleIndexingInProgress) {
      return { success: false, error: 'Tab title indexing already in progress' };
    }
    _titleIndexingInProgress = true;
    try {
      const result = await indexTabTitles(db, projectId, (current, total, stats) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tab-title-index:progress', {
            projectId,
            current,
            total,
            ...stats,
          });
        }
      }, !!force);
      logEmbeddingUsage(projectManager, db, {
        taskType: 'Embedding: title index',
        usage: result.embeddingUsage,
        status: result.failed ? 'error' : 'success',
        error: result.failed ? `${result.failed} title row(s) failed` : null,
        projectId,
      });
      return { success: true, ...result, stats: getTabTitleIndexStats(db, projectId) };
    } catch (error) {
      console.error('[TabTitleSearch] reindex error:', error.message);
      return { success: false, error: error.message };
    } finally {
      _titleIndexingInProgress = false;
    }
  });

  ipcMain.handle('tab-title-index:clear', async (event, { projectId }) => {
    try {
      return { success: true, ...clearTabTitleIndex(db, projectId) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('tab-title-search:semantic', async (event, { projectId, query, maxResults, minScore }) => {
    try {
      const results = await searchTabTitles(db, projectId, query, {
        maxResults,
        minScore,
        onEmbeddingCall: (call) => logEmbeddingUsage(projectManager, db, {
          taskType: 'Embedding: title query',
          projectId,
          ...call,
        }),
      });
      return { success: true, data: results };
    } catch (error) {
      console.error('[TabTitleSearch] query error:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('tab-iteration-index:stats', async (event, { projectId, dateFrom }) => {
    try {
      return { success: true, data: getTabIterationIndexStats(db, projectId, { dateFrom }) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('tab-iteration-index:reindex', async (event, { projectId, force, dateFrom }) => {
    if (_iterationIndexingInProgress) {
      return { success: false, error: 'Tab iteration indexing already in progress' };
    }
    _iterationIndexingInProgress = true;
    try {
      const result = await indexTabIterations(db, projectId, (current, total, stats) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tab-iteration-index:progress', {
            projectId,
            current,
            total,
            ...stats,
          });
        }
      }, !!force, claudeData, codexData, { dateFrom });
      logEmbeddingUsage(projectManager, db, {
        taskType: 'Embedding: iteration index',
        usage: result.embeddingUsage,
        status: result.failed ? 'error' : 'success',
        error: result.failed ? `${result.failed} iteration row(s) failed` : null,
        projectId,
      });
      return { success: true, ...result, stats: getTabIterationIndexStats(db, projectId, { dateFrom }) };
    } catch (error) {
      console.error('[TabIterationSearch] reindex error:', error.message);
      return { success: false, error: error.message };
    } finally {
      _iterationIndexingInProgress = false;
    }
  });

  ipcMain.handle('tab-iteration-index:clear', async (event, { projectId }) => {
    try {
      return { success: true, ...clearTabIterationIndex(db, projectId) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('tab-iteration-search:semantic', async (event, { projectId, query, maxResults, minScore, dateFrom }) => {
    try {
      const results = await searchTabIterations(db, projectId, query, {
        maxResults,
        minScore,
        dateFrom,
        onEmbeddingCall: (call) => logEmbeddingUsage(projectManager, db, {
          taskType: 'Embedding: iteration query',
          projectId,
          ...call,
        }),
      });
      return { success: true, data: results };
    } catch (error) {
      console.error('[TabIterationSearch] query error:', error.message);
      return { success: false, error: error.message };
    }
  });
}

async function autoIndexTabTitle(projectManager, db, projectId, historyId) {
  const result = await indexTabTitleHistory(db, projectId, historyId);
  logEmbeddingUsage(projectManager, db, {
    taskType: 'Embedding: title auto index',
    usage: result.embeddingUsage,
    status: result.failed ? 'error' : 'success',
    error: result.failed ? `${result.failed} title row(s) failed` : null,
    projectId,
  });
  return result;
}

async function autoIndexTabIterations(projectManager, db, projectId, historyId, claudeData, codexData, opts = {}) {
  const result = await indexTabIterations(db, projectId, null, false, claudeData, codexData, {
    historyId,
    minEntryTs: opts.minEntryTs,
  });
  logEmbeddingUsage(projectManager, db, {
    taskType: 'Embedding: iteration auto index',
    usage: result.embeddingUsage,
    status: result.failed ? 'error' : 'success',
    error: result.failed ? `${result.failed} iteration row(s) failed` : null,
    projectId,
  });
  return result;
}

module.exports = {
  register,
  indexSessionFile,
  autoIndexTabTitle,
  autoIndexTabIterations,
  indexTabTitleHistory,
  indexTabIterations,
};
