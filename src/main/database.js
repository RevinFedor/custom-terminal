const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

class DatabaseManager {
  constructor() {
    const userDataPath = app.getPath('userData');
    // Use different database for dev vs prod
    const dbName = app.isPackaged ? 'noted-terminal.db' : 'noted-terminal-dev.db';
    const dbPath = path.join(userDataPath, dbName);

    console.log(`[Database] Mode: ${app.isPackaged ? 'PROD' : 'DEV'}, Path: ${dbPath}`);

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
    this.createDefaultPrompts();
  }

  initTables() {
    // Projects table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        gemini_prompt TEXT DEFAULT 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
        notes_global TEXT DEFAULT '',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Global commands table (shared across all projects)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        position INTEGER DEFAULT 0
      )
    `);

    // Prompts table (insertable text snippets via context menu)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Quick actions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quick_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // Tabs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tabs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        visual_snapshot TEXT DEFAULT NULL,
        color TEXT DEFAULT NULL,
        is_utility INTEGER DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // Migrations
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN color TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN is_utility INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN claude_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN was_interrupted INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN gemini_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN overlay_dismissed INTEGER DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN notes TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }

    // Project sidebar state
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN sidebar_open INTEGER DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN open_file_path TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }

    // Gemini history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gemini_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        selected_text TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // AI Sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        tool_type TEXT NOT NULL CHECK(tool_type IN ('gemini', 'claude')),
        session_key TEXT NOT NULL,
        content_blob TEXT NOT NULL,
        original_cwd TEXT NOT NULL,
        original_hash TEXT DEFAULT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_quick_actions_project ON quick_actions(project_id);
      CREATE INDEX IF NOT EXISTS idx_tabs_project ON tabs(project_id);
      CREATE INDEX IF NOT EXISTS idx_gemini_history_project ON gemini_history(project_id);
      CREATE INDEX IF NOT EXISTS idx_gemini_history_timestamp ON gemini_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_project ON ai_sessions(project_id);
    `);

    // Research Conversations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT,
        type TEXT DEFAULT 'research',
        messages_json TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    
    // App state table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Bookmarks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        position INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Fork markers table - tracks where sessions were forked for Timeline visualization
    // entry_uuids_json stores JSON array of all entry UUIDs at fork time for robust positioning
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fork_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_session_id TEXT NOT NULL,
        forked_to_session_id TEXT NOT NULL,
        entry_uuids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(source_session_id, forked_to_session_id)
      )
    `);
    // Migration: add entry_uuids_json column if not exists
    try { this.db.exec(`ALTER TABLE fork_markers ADD COLUMN entry_uuids_json TEXT NOT NULL DEFAULT '[]'`); } catch (e) {}
  }

  // ========== APP STATE ========== 

  getAppState(key) {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  setAppState(key, value) {
    const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);
    this.db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, jsonValue);
  }

  // ========== PROJECTS ========== 

  // Legacy helper - should be avoided in favor of getProjectById
  getProject(projectPath) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT * FROM projects WHERE path = ? ORDER BY updated_at DESC LIMIT 1').get(normalizedPath);
    if (!project) return null;
    return this.getProjectById(project.id);
  }

  getProjectById(projectId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return null;

    const tabs = this.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(project.id);
    const globalCommands = this.getGlobalCommands();

    return {
      id: project.id,
      path: project.path,
      name: project.name,
      description: project.description || '',
      geminiPrompt: project.gemini_prompt,
      notesGlobal: project.notes_global || '',
      sidebarOpen: project.sidebar_open === 1,
      openFilePath: project.open_file_path || null,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      quickActions: globalCommands.map(gc => ({ name: gc.name, command: gc.command })),
      tabs: tabs.map(t => ({
        name: t.name,
        cwd: t.cwd,
        color: t.color || undefined,
        isUtility: t.is_utility === 1,
        claudeSessionId: t.claude_session_id || undefined,
        geminiSessionId: t.gemini_session_id || undefined,
        wasInterrupted: t.was_interrupted === 1,
        overlayDismissed: t.overlay_dismissed === 1,
        notes: t.notes || ''
      }))
    };
  }

  createProject(projectPath) {
    const normalizedPath = path.resolve(projectPath);
    const folderName = path.basename(normalizedPath);
    const projectId = Buffer.from(normalizedPath).toString('base64').substring(0, 20) + '_' + Date.now();

    this.db.prepare(`
      INSERT INTO projects (id, path, name, description, gemini_prompt, notes_global)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectId, normalizedPath, folderName, '', 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ', `<h1>${folderName}</h1>`);

    return this.getProjectById(projectId);
  }

  createProjectInstance(projectPath, customName = null) {
    const normalizedPath = path.resolve(projectPath);
    const folderName = path.basename(normalizedPath);
    const projectId = `${Buffer.from(normalizedPath).toString('base64').substring(0, 20)}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    let projectName = customName;
    if (!projectName) {
      const existingCount = this.db.prepare('SELECT COUNT(*) as count FROM projects WHERE path = ?').get(normalizedPath).count;
      projectName = existingCount > 0 ? `${folderName}-${existingCount + 1}` : folderName;
    }

    this.db.prepare(`
      INSERT INTO projects (id, path, name, description, gemini_prompt, notes_global)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectId, normalizedPath, projectName, '', 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ', `<h1>${projectName}</h1>`);

    return this.getProjectById(projectId);
  }

  createEmptyProject(name = 'Новый проект') {
    const projectId = `new_project_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const emptyPath = ''; // Path can be set later via Edit Modal

    this.db.prepare(`
      INSERT INTO projects (id, path, name, description, gemini_prompt, notes_global)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectId, emptyPath, name, '', 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ', `<h1>${name}</h1>`);

    return this.getProjectById(projectId);
  }

  getAllProjects() {
    const projects = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return projects.map(p => this.getProjectById(p.id));
  }

  updateProjectMetadata(projectId, metadata) {
    const { name, description, geminiPrompt, path: newPath } = metadata;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (geminiPrompt !== undefined) { updates.push('gemini_prompt = ?'); params.push(geminiPrompt); }
    if (newPath !== undefined) { updates.push('path = ?'); params.push(newPath); }

    if (updates.length > 0) {
      params.push(projectId);
      this.db.prepare(`UPDATE projects SET ${updates.join(', ')}, updated_at = strftime('%s', 'now') WHERE id = ?`).run(...params);
    }
    return { success: true };
  }

  updateProjectNotes(projectId, notes) {
    this.db.prepare('UPDATE projects SET notes_global = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(notes, projectId);
  }

  updateProjectSidebarState(projectId, sidebarOpen, openFilePath) {
    this.db.prepare('UPDATE projects SET sidebar_open = ?, open_file_path = ? WHERE id = ?').run(sidebarOpen ? 1 : 0, openFilePath || null, projectId);
  }

  deleteProject(projectId) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    return true;
  }

  // ========== TABS ========== 

  saveTabs(projectId, tabs) {
    this.db.prepare('DELETE FROM tabs WHERE project_id = ?').run(projectId);
    const insert = this.db.prepare(`
      INSERT INTO tabs (project_id, name, cwd, position, color, is_utility, claude_session_id, gemini_session_id, was_interrupted, overlay_dismissed, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((tabList) => {
      tabList.forEach((tab, index) => {
        insert.run(projectId, tab.name, tab.cwd, index, tab.color || null, tab.isUtility ? 1 : 0, tab.claudeSessionId || null, tab.geminiSessionId || null, tab.wasInterrupted ? 1 : 0, tab.overlayDismissed ? 1 : 0, tab.notes || '');
      });
    });
transaction(tabs);
    this.db.prepare('UPDATE projects SET updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(projectId);
  }

  // ========== GEMINI HISTORY ========== 

  saveGeminiHistory(projectId, selectedText, prompt, response) {
    const result = this.db.prepare(`
      INSERT INTO gemini_history (project_id, selected_text, prompt, response)
      VALUES (?, ?, ?, ?)
    `).run(projectId, selectedText, prompt, response);

    return { id: result.lastInsertRowid, project_id: projectId, selected_text: selectedText, prompt, response, timestamp: Math.floor(Date.now() / 1000) };
  }

  getGeminiHistory(projectId, limit = 50) {
    return this.db.prepare('SELECT * FROM gemini_history WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?').all(projectId, limit);
  }

  // ========== GLOBAL COMMANDS & PROMPTS ========== 

  getGlobalCommands() { return this.db.prepare('SELECT * FROM global_commands ORDER BY position').all(); }
  saveGlobalCommands(commands) {
    this.db.prepare('DELETE FROM global_commands').run();
    const insert = this.db.prepare('INSERT INTO global_commands (name, command, position) VALUES (?, ?, ?)');
    commands.forEach((cmd, index) => insert.run(cmd.name, cmd.command, index));
  }

  getPrompts() { return this.db.prepare('SELECT * FROM prompts ORDER BY position').all(); }
  savePrompts(prompts) {
    this.db.prepare('DELETE FROM prompts').run();
    const insert = this.db.prepare('INSERT INTO prompts (title, content, position) VALUES (?, ?, ?)');
    prompts.forEach((p, index) => insert.run(p.title, p.content, index));
  }

  createDefaultPrompts() {
    if (this.db.prepare('SELECT COUNT(*) as count FROM prompts').get().count > 0) return;
    this.savePrompts([{ title: 'Fix Error', content: 'Analyze this error:' }, { title: 'Explain', content: 'Explain this:' }, { title: 'Optimize', content: 'Optimize this:' }]);
  }

  // ========== AI SESSIONS ========== 

  saveAISession(projectId, toolType, sessionKey, contentBlob, originalCwd, originalHash = null) {
    const existing = this.db.prepare('SELECT id FROM ai_sessions WHERE project_id = ? AND tool_type = ? AND session_key = ?').get(projectId, toolType, sessionKey);
    if (existing) {
      this.db.prepare('UPDATE ai_sessions SET content_blob = ?, original_cwd = ?, original_hash = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(contentBlob, originalCwd, originalHash, existing.id);
      return existing.id;
    } else {
      return this.db.prepare('INSERT INTO ai_sessions (project_id, tool_type, session_key, content_blob, original_cwd, original_hash) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, toolType, sessionKey, contentBlob, originalCwd, originalHash).lastInsertRowid;
    }
  }

  getAISessions(projectId, toolType = null) {
    if (toolType) return this.db.prepare('SELECT * FROM ai_sessions WHERE project_id = ? AND tool_type = ? ORDER BY updated_at DESC').all(projectId, toolType);
    return this.db.prepare('SELECT * FROM ai_sessions WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
  }

  // ========== BOOKMARKS ========== 

  getAllBookmarks() { return this.db.prepare('SELECT * FROM bookmarks ORDER BY position').all(); }
  createBookmark(dirPath, name, description = '') {
    const normalized = path.resolve(dirPath);
    const existing = this.db.prepare('SELECT * FROM bookmarks WHERE path = ?').get(normalized);
    if (existing) return existing;
    const pos = (this.db.prepare('SELECT MAX(position) as max FROM bookmarks').get().max || 0) + 1;
    const res = this.db.prepare('INSERT INTO bookmarks (path, name, description, position) VALUES (?, ?, ?, ?)').run(normalized, name, description, pos);
    return this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(res.lastInsertRowid);
  }
  updateBookmark(id, updates) {
    const { name, description, position } = updates;
    if (name !== undefined) this.db.prepare('UPDATE bookmarks SET name = ? WHERE id = ?').run(name, id);
    if (description !== undefined) this.db.prepare('UPDATE bookmarks SET description = ? WHERE id = ?').run(description, id);
    if (position !== undefined) this.db.prepare('UPDATE bookmarks SET position = ? WHERE id = ?').run(position, id);
    return this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  }
  deleteBookmark(id) { this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id); }

  // ========== FORK MARKERS ==========

  /**
   * Save a fork marker when a session is forked
   * Also copies inherited markers from parent session (for cascading forks)
   * @param {string} sourceSessionId - Original session UUID
   * @param {string} forkedToSessionId - New session UUID
   * @param {string[]} entryUuids - Array of all entry UUIDs at fork time (snapshot)
   */
  saveForkMarker(sourceSessionId, forkedToSessionId, entryUuids) {
    try {
      // First, copy all inherited markers from parent session
      const parentMarkers = this.getForkMarkers(sourceSessionId);
      for (const marker of parentMarkers) {
        const inheritedJson = JSON.stringify(marker.entry_uuids || []);
        this.db.prepare(`
          INSERT OR IGNORE INTO fork_markers (source_session_id, forked_to_session_id, entry_uuids_json)
          VALUES (?, ?, ?)
        `).run(marker.source_session_id, forkedToSessionId, inheritedJson);
        console.log('[DB] Inherited fork marker copied:', marker.source_session_id, '->', forkedToSessionId);
      }

      // Then add the new fork marker
      const entryUuidsJson = JSON.stringify(entryUuids || []);
      this.db.prepare(`
        INSERT OR REPLACE INTO fork_markers (source_session_id, forked_to_session_id, entry_uuids_json)
        VALUES (?, ?, ?)
      `).run(sourceSessionId, forkedToSessionId, entryUuidsJson);
      console.log('[DB] Fork marker saved:', { sourceSessionId, forkedToSessionId, entryCount: entryUuids?.length || 0 });
    } catch (e) {
      console.error('[DB] Failed to save fork marker:', e);
    }
  }

  /**
   * Get fork origin for a session (to show blue line on Timeline where it was forked from)
   * @param {string} sessionId - Session UUID (the forked/child session)
   * @returns {Array<{source_session_id: string, entry_uuids: string[]}>}
   */
  getForkMarkers(sessionId) {
    // Search by forked_to_session_id - we want to show the fork point on the CHILD session
    const rows = this.db.prepare(`
      SELECT source_session_id, entry_uuids_json, created_at
      FROM fork_markers
      WHERE forked_to_session_id = ?
      ORDER BY created_at
    `).all(sessionId);

    return rows.map(row => ({
      source_session_id: row.source_session_id,
      entry_uuids: JSON.parse(row.entry_uuids_json || '[]'),
      created_at: row.created_at
    }));
  }

  /**
   * Get parent session (where this session was forked from)
   * @param {string} sessionId - Session UUID
   * @returns {{source_session_id: string, message_uuid: string} | null}
   */
  getParentSession(sessionId) {
    return this.db.prepare(`
      SELECT source_session_id, message_uuid
      FROM fork_markers
      WHERE forked_to_session_id = ?
    `).get(sessionId) || null;
  }

  close() { this.db.close(); }
}

module.exports = DatabaseManager;