const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ========== GEMINI EMBEDDING PROVIDER ==========

const GEMINI_API_KEY = 'REDACTED_GEMINI_KEY';
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`;
const EMBEDDING_DIMS = 768; // gemini-embedding-001 truncated to 768 (default 3072 too large for SQLite)
const MAX_BATCH_SIZE = 100; // Gemini limit per batch request
const MAX_CHUNK_TOKENS = 2048; // Gemini embedding input limit
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4; // ~4 chars per token

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

// ========== JSONL CHUNKING ==========

/**
 * Parse a JSONL session file into Q+A chunks.
 * Each chunk = user message + assistant text response.
 * Long responses are split into sub-chunks of MAX_CHUNK_CHARS.
 * Returns array of { text, role, startLine, endLine }.
 */
function chunkSessionFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const messages = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
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

      // Strip system reminders from user messages
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (!text) continue;

      messages.push({ role, text, line: i + 1, timestamp: entry.timestamp || null });
    } catch {}
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

  // Track which files have been indexed (by hash)
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_slug TEXT NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // FTS5 for keyword fallback
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, id UNINDEXED, session_id UNINDEXED, project_slug UNINDEXED
    )
  `);

  console.log('[SemanticSearch] Tables initialized');
}

/**
 * Compute SHA256 hash of a file.
 */
function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
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

/**
 * Index a single session JSONL file.
 * Returns { chunked, embedded, skipped } counts.
 */
async function indexSessionFile(db, filePath, sessionId, projectSlug) {
  const hash = fileHash(filePath);

  // Skip if already indexed with same hash
  if (isFileIndexed(db, filePath, hash)) {
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
  const chunks = chunkSessionFile(filePath);
  if (chunks.length === 0) {
    return { chunked: 0, embedded: 0, skipped: false };
  }

  // Embed all chunks
  let embeddings;
  try {
    embeddings = await embedTexts(chunks.map(c => c.text));
  } catch (err) {
    console.error('[SemanticSearch] Embedding failed, storing chunks without vectors:', err.message);
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
      INSERT OR REPLACE INTO indexed_files (file_path, file_hash, session_id, project_slug, chunk_count, indexed_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    `).run(filePath, hash, sessionId, projectSlug, chunks.length);
  });

  insertAll();

  return { chunked: chunks.length, embedded: embeddings ? chunks.length : 0, skipped: false };
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
  let indexed = 0, skipped = 0, failed = 0;

  for (let i = 0; i < files.length; i++) {
    const { filePath, sessionId, projectSlug } = files[i];
    try {
      const result = await indexSessionFile(db, filePath, sessionId, projectSlug);
      if (result.skipped) {
        skipped++;
      } else {
        indexed++;
        console.log(`[SemanticSearch] Indexed ${sessionId} (${result.chunked} chunks)`);
      }
    } catch (err) {
      failed++;
      console.error(`[SemanticSearch] Failed to index ${sessionId}:`, err.message);
    }
    if (progressCb) progressCb(i + 1, total, { indexed, skipped, failed });
  }

  return { total, indexed, skipped, failed };
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
  try {
    queryVec = await embedQuery(query);
  } catch (err) {
    console.error('[SemanticSearch] Query embedding failed, falling back to FTS:', err.message);
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

function register({ projectManager, mainWindow }) {
  const db = projectManager.db.db; // Access raw better-sqlite3 instance

  // Initialize tables on startup
  initSearchTables(db);

  // Search sessions
  ipcMain.handle('search:query', async (event, { query, maxResults, minScore, projectSlug, dateFrom, dateTo }) => {
    try {
      const results = await searchSessions(db, query, { maxResults, minScore, projectSlug, dateFrom, dateTo });
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
}

module.exports = { register, indexSessionFile };
