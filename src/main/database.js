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
    this.seedDefaultAIPrompts();
    this.ensureRewindPrompt();
    this.ensureAdoptPrompt();
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
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN command_type TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN tab_type TEXT DEFAULT 'terminal'`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN url TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN terminal_id TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN terminal_name TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN active_view TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN is_collapsed INTEGER DEFAULT 0`);
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

    // API Call Log table (adopt, update_docs, research — one-off API calls)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_call_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT,
        call_type TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        result_text TEXT,
        source_tab_id TEXT,
        source_session_id TEXT,
        target_tab_id TEXT,
        payload_size INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
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
      CREATE INDEX IF NOT EXISTS idx_api_call_log_project ON api_call_log(project_id);
      CREATE INDEX IF NOT EXISTS idx_api_call_log_type ON api_call_log(call_type);
    `);

    // Migration: add session_meta and input_payload to api_call_log
    try { this.db.exec('ALTER TABLE api_call_log ADD COLUMN session_meta TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE api_call_log ADD COLUMN input_payload TEXT'); } catch {}

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

    // Tab history table - closed tabs archive
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tab_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        color TEXT DEFAULT NULL,
        notes TEXT DEFAULT NULL,
        command_type TEXT DEFAULT NULL,
        tab_type TEXT DEFAULT 'terminal',
        url TEXT DEFAULT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        closed_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // Tab history indexes (must be after table creation)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tab_history_project ON tab_history(project_id);
      CREATE INDEX IF NOT EXISTS idx_tab_history_closed ON tab_history(closed_at DESC);
    `);

    // Migration: add created_at to tabs
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN created_at INTEGER DEFAULT NULL`); } catch (e) {}

    // Migration: add parent_tab_id for MCP sub-agent tabs
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN parent_tab_id TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: add tab_id to preserve tab identity across restarts
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN tab_id TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: add mcp_task_started_at for sub-agent timeout tracking
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN mcp_task_started_at INTEGER DEFAULT NULL`); } catch (e) {}

    // Migration: add mcp_task_id to persist MCP task IDs across restarts
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN mcp_task_id TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: add claude_task_count to persist iteration counter across restarts
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN claude_task_count INTEGER DEFAULT 0`); } catch (e) {}

    // Index on tab_id for faster lookups in saveTabs
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tabs_tab_id ON tabs(tab_id) WHERE tab_id IS NOT NULL`); } catch (e) {}

    // Migration: add session IDs to tab_history (for resume on restore)
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN claude_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN gemini_session_id TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: add message_count to tab_history
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN message_count INTEGER DEFAULT NULL`); } catch (e) {}

    // AI Prompts table (dynamic AI prompts for Research/Compact/Description/Custom)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'gemini-3-flash-preview',
        thinking_level TEXT NOT NULL DEFAULT 'HIGH',
        color TEXT NOT NULL DEFAULT '#0ea5e9',
        is_built_in INTEGER NOT NULL DEFAULT 0,
        show_in_context_menu INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Favorites table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT,
        cwd TEXT,
        color TEXT,
        notes TEXT,
        command_type TEXT,
        tab_type TEXT DEFAULT 'terminal',
        url TEXT,
        claude_session_id TEXT,
        gemini_session_id TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_project ON favorites(project_id)`);

    // Session links table - tracks parent→child session transitions (Clear Context without JSONL bridge)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_links (
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL PRIMARY KEY,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Timeline notes table - user annotations attached to timeline entries
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_uuid TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(entry_uuid, session_id)
      )
    `);

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
        commandType: t.command_type || undefined,
        claudeSessionId: t.claude_session_id || undefined,
        geminiSessionId: t.gemini_session_id || undefined,
        wasInterrupted: t.was_interrupted === 1,
        overlayDismissed: t.overlay_dismissed === 1,
        notes: t.notes || '',
        tabType: t.tab_type || 'terminal',
        url: t.url || undefined,
        terminalId: t.terminal_id || undefined,
        terminalName: t.terminal_name || undefined,
        activeView: t.active_view || undefined,
        createdAt: t.created_at || undefined,
        isCollapsed: t.is_collapsed === 1,
        parentTabId: t.parent_tab_id || undefined,
        tabId: t.tab_id || undefined,
        mcpTaskStartedAt: t.mcp_task_started_at || undefined,
        mcpTaskId: t.mcp_task_id || undefined,
        claudeTaskCount: t.claude_task_count || 0
      }))
    };
  }

  // Update mcp_task_started_at for a specific sub-agent tab (by tab_id)
  setMcpTaskStartedAt(tabId, startedAt) {
    try {
      this.db.prepare('UPDATE tabs SET mcp_task_started_at = ? WHERE tab_id = ?').run(startedAt, tabId);
    } catch (e) {
      console.error('[DB] setMcpTaskStartedAt error:', e.message);
    }
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
    // Unique placeholder path — legacy prod DBs have UNIQUE constraint on projects.path,
    // so empty string '' would collide on second empty project creation
    const emptyPath = `__unset__${projectId}`;

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

  saveTabs(projectId, tabs, forceCleanup = false) {
    // Check if project exists to avoid FOREIGN KEY constraint error
    const projectExists = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!projectExists) {
      console.warn('[DB] saveTabs: project not found, skipping:', projectId);
      return;
    }

    // Safety: count existing tabs to detect accidental mass deletion
    const existingCount = this.db.prepare('SELECT COUNT(*) as cnt FROM tabs WHERE project_id = ?').get(projectId)?.cnt || 0;
    const newCount = tabs.length;

    if (existingCount > 0 && newCount < existingCount - 2) {
      const subAgentCount = tabs.filter(t => t.parentTabId).length;
      const dbSubAgents = this.db.prepare('SELECT COUNT(*) as cnt FROM tabs WHERE project_id = ? AND parent_tab_id IS NOT NULL').get(projectId)?.cnt || 0;
      console.warn('[DB] saveTabs: WARNING — saving ' + newCount + ' tabs (sub-agents: ' + subAgentCount + ') but DB has ' + existingCount + ' (sub-agents: ' + dbSubAgents + '). Project: ' + projectId);
    }

    const newTabIds = tabs.map(t => t.tabId).filter(Boolean);

    const deleteByTabId = this.db.prepare('DELETE FROM tabs WHERE project_id = ? AND tab_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO tabs (project_id, name, cwd, position, color, is_utility, command_type, claude_session_id, gemini_session_id, was_interrupted, overlay_dismissed, notes, tab_type, url, terminal_id, terminal_name, active_view, created_at, is_collapsed, parent_tab_id, tab_id, mcp_task_started_at, mcp_task_id, claude_task_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((tabList) => {
      // Step 1: Delete old rows for tabs we're about to re-insert (by tab_id)
      tabList.forEach((tab) => {
        if (tab.tabId) {
          deleteByTabId.run(projectId, tab.tabId);
        }
      });
      // Step 2: Delete orphan rows without tab_id (legacy tabs)
      this.db.prepare('DELETE FROM tabs WHERE project_id = ? AND tab_id IS NULL').run(projectId);

      // Step 3: Insert all tabs fresh
      tabList.forEach((tab, index) => {
        insert.run(projectId, tab.name, tab.cwd, index, tab.color || null, tab.isUtility ? 1 : 0, tab.commandType || null, tab.claudeSessionId || null, tab.geminiSessionId || null, tab.wasInterrupted ? 1 : 0, tab.overlayDismissed ? 1 : 0, tab.notes || '', tab.tabType || 'terminal', tab.url || null, tab.terminalId || null, tab.terminalName || null, tab.activeView || null, tab.createdAt || null, tab.isCollapsed ? 1 : 0, tab.parentTabId || null, tab.tabId || null, tab.mcpTaskStartedAt || null, tab.mcpTaskId || null, tab.claudeTaskCount || 0);
      });

      // Step 4: Clean up tabs that exist in DB but NOT in the new set
      // Safety: only do this if tab count is stable (not losing more than 2 tabs)
      // forceCleanup bypasses the guard for intentional batch operations (moveTabsToProject, batch close)
      if (newTabIds.length > 0 && (forceCleanup || newCount >= existingCount - 2)) {
        const placeholders = newTabIds.map(() => '?').join(',');
        this.db.prepare('DELETE FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL AND tab_id NOT IN (' + placeholders + ')').run(projectId, ...newTabIds);
      } else if (newTabIds.length > 0 && newCount < existingCount - 2) {
        console.error('[DB] saveTabs: SKIPPING cleanup — new set (' + newCount + ') is much smaller than DB (' + existingCount + '). Orphan tabs preserved to prevent data loss.');
      }
    });
    transaction(tabs);
    this.db.prepare('UPDATE projects SET updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(projectId);
  }

  // ========== TAB HISTORY (CLOSED TABS ARCHIVE) ==========

  archiveTab(projectId, tab) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO tab_history (project_id, name, cwd, color, notes, command_type, tab_type, url, created_at, closed_at, claude_session_id, gemini_session_id, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      tab.name,
      tab.cwd,
      tab.color || null,
      tab.notes || null,
      tab.commandType || null,
      tab.tabType || 'terminal',
      tab.url || null,
      tab.createdAt || now,
      now,
      tab.claudeSessionId || null,
      tab.geminiSessionId || null,
      tab.messageCount ?? null
    );
  }

  getTabHistory(projectId, limit = 200) {
    return this.db.prepare(
      'SELECT * FROM tab_history WHERE project_id = ? ORDER BY closed_at DESC LIMIT ?'
    ).all(projectId, limit);
  }

  getTabHistoryCount(projectId) {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM tab_history WHERE project_id = ?'
    ).get(projectId);
    return row ? row.count : 0;
  }

  clearTabHistory(projectId) {
    this.db.prepare('DELETE FROM tab_history WHERE project_id = ?').run(projectId);
  }

  clearTabHistoryExceptNotes(projectId) {
    this.db.prepare("DELETE FROM tab_history WHERE project_id = ? AND (notes IS NULL OR notes = '')").run(projectId);
  }

  deleteTabHistoryEntry(id) {
    this.db.prepare('DELETE FROM tab_history WHERE id = ?').run(id);
  }

  // ========== FAVORITES ==========

  addFavorite(projectId, tab) {
    this.db.prepare(`
      INSERT INTO favorites (project_id, name, cwd, color, notes, command_type, tab_type, url, claude_session_id, gemini_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      tab.name || null,
      tab.cwd || null,
      tab.color || null,
      tab.notes || null,
      tab.commandType || null,
      tab.tabType || 'terminal',
      tab.url || null,
      tab.claudeSessionId || null,
      tab.geminiSessionId || null
    );
  }

  getFavorites(projectId) {
    return this.db.prepare(
      'SELECT * FROM favorites WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId);
  }

  deleteFavorite(id) {
    this.db.prepare('DELETE FROM favorites WHERE id = ?').run(id);
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
    if (!Array.isArray(commands)) return;
    const existingCount = this.db.prepare('SELECT COUNT(*) as cnt FROM global_commands').get()?.cnt || 0;
    if (commands.length === 0 && existingCount > 0) {
      console.warn('[DB] saveGlobalCommands: refusing to delete ' + existingCount + ' commands with empty array');
      return;
    }
    const transaction = this.db.transaction((cmds) => {
      this.db.prepare('DELETE FROM global_commands').run();
      const insert = this.db.prepare('INSERT INTO global_commands (name, command, position) VALUES (?, ?, ?)');
      cmds.forEach((cmd, index) => insert.run(cmd.name, cmd.command, index));
    });
    transaction(commands);
  }

  getPrompts() { return this.db.prepare('SELECT * FROM prompts ORDER BY position').all(); }
  savePrompts(prompts) {
    if (!Array.isArray(prompts)) return;
    const existingCount = this.db.prepare('SELECT COUNT(*) as cnt FROM prompts').get()?.cnt || 0;
    if (prompts.length === 0 && existingCount > 0) {
      console.warn('[DB] savePrompts: refusing to delete ' + existingCount + ' prompts with empty array');
      return;
    }
    const transaction = this.db.transaction((list) => {
      this.db.prepare('DELETE FROM prompts').run();
      const insert = this.db.prepare('INSERT INTO prompts (title, content, position) VALUES (?, ?, ?)');
      list.forEach((p, index) => insert.run(p.title, p.content, index));
    });
    transaction(prompts);
  }

  createDefaultPrompts() {
    if (this.db.prepare('SELECT COUNT(*) as count FROM prompts').get().count > 0) return;
    this.savePrompts([{ title: 'Fix Error', content: 'Analyze this error:' }, { title: 'Explain', content: 'Explain this:' }, { title: 'Optimize', content: 'Optimize this:' }]);
  }

  // ========== AI PROMPTS (Dynamic System Prompts) ==========

  getAIPrompts() {
    return this.db.prepare('SELECT * FROM ai_prompts ORDER BY position').all().map(row => ({
      id: row.id,
      name: row.name,
      content: row.content,
      model: row.model,
      thinkingLevel: row.thinking_level,
      color: row.color,
      isBuiltIn: row.is_built_in === 1,
      showInContextMenu: row.show_in_context_menu === 1,
      position: row.position
    }));
  }

  saveAIPrompt(prompt) {
    this.db.prepare(`
      INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        content = excluded.content,
        model = excluded.model,
        thinking_level = excluded.thinking_level,
        color = excluded.color,
        show_in_context_menu = excluded.show_in_context_menu,
        position = excluded.position
    `).run(
      prompt.id,
      prompt.name,
      prompt.content,
      prompt.model || 'gemini-3-flash-preview',
      prompt.thinkingLevel || 'HIGH',
      prompt.color || '#0ea5e9',
      prompt.isBuiltIn ? 1 : 0,
      prompt.showInContextMenu !== false ? 1 : 0,
      prompt.position ?? 0
    );
  }

  deleteAIPrompt(id) {
    // Only delete non-built-in prompts
    this.db.prepare('DELETE FROM ai_prompts WHERE id = ? AND is_built_in = 0').run(id);
  }

  seedDefaultAIPrompts() {
    if (this.db.prepare('SELECT COUNT(*) as count FROM ai_prompts').get().count > 0) return;

    const defaults = [
      {
        id: 'research',
        name: 'Research',
        content: 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
        model: 'gemini-3-flash-preview',
        thinking_level: 'HIGH',
        color: '#0ea5e9',
        is_built_in: 1,
        show_in_context_menu: 1,
        position: 0
      },
      {
        id: 'compact',
        name: 'Compact (Резюме)',
        content: 'Проанализируй всю нашу текущую сессию и составь структурированное резюме для переноса контекста в новый чат, включив в него: изначальную цель; список всех созданных файлов с пояснением, почему мы выбрали именно такую структуру и эти файлы; краткий отчет о том, что работает; детальный разбор того, что НЕ получилось, с указанием конкретных причин ошибок (почему выбранные решения не сработали); текущее состояние кода и пошаговый план дальнейших действий — оформи это всё одним компактным сообщением, которое я смогу скопировать и отправить тебе в новом чате для полного восстановления контекста.\n\nВот текст сессии:\n',
        model: 'gemini-3-flash-preview',
        thinking_level: 'HIGH',
        color: '#a855f7',
        is_built_in: 1,
        show_in_context_menu: 1,
        position: 1
      },
      {
        id: 'rewind',
        name: 'Rewind (Откат)',
        content: 'Ниже представлена сессия из нейронки (Claude Code). Составь краткую сводку:\n\n1. **Изначальная цель** — что делали\n2. **Изменённые файлы** — путь, какие функции/компоненты затронуты, зачем\n3. **Что работает** — кратко\n4. **Что НЕ работает и ПОЧЕМУ** — конкретные причины ошибок, какие решения пробовали и почему они не сработали\n5. **Текущее состояние** — на чём остановились\n\nВажно: только факты и анализ. Никакого плана, никаких рекомендаций, никаких \"следующих шагов\". Не добавляй своё мнение. Начни сразу со сводки.\n\nСессия:\n',
        model: 'gemini-3-flash-preview',
        thinking_level: 'HIGH',
        color: '#ec4899',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 3
      },
      {
        id: 'description',
        name: 'Description',
        content: '1-2 предложения: что сделано. Без маркдауна, без вступлений.\n\n',
        model: 'gemini-3-flash-preview',
        thinking_level: 'NONE',
        color: '#f59e0b',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 2
      },
      {
        id: 'adopt',
        name: 'Adopt Summary',
        content: 'Ниже — сессия разработки Claude Code. Опиши конкретно что агент делал и на чём остановился (3-7 предложений). Какие файлы менял, какие действия выполнил, что осталось незавершённым. Только факты — без оценок и рекомендаций.\n',
        model: 'gemini-3-flash-preview',
        thinking_level: 'NONE',
        color: '#6366f1',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 4
      }
    ];

    const insert = this.db.prepare(`
      INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const d of defaults) {
      insert.run(d.id, d.name, d.content, d.model, d.thinking_level, d.color, d.is_built_in, d.show_in_context_menu, d.position);
    }
  }

  // Ensure built-in 'rewind' prompt exists (migration for existing DBs)
  ensureRewindPrompt() {
    const exists = this.db.prepare('SELECT id FROM ai_prompts WHERE id = ?').get('rewind');
    if (!exists) {
      this.db.prepare(`
        INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'rewind',
        'Rewind (Откат)',
        'Ниже представлена сессия из нейронки (Claude Code). Составь краткую сводку:\n\n1. **Изначальная цель** — что делали\n2. **Изменённые файлы** — путь, какие функции/компоненты затронуты, зачем\n3. **Что работает** — кратко\n4. **Что НЕ работает и ПОЧЕМУ** — конкретные причины ошибок, какие решения пробовали и почему они не сработали\n5. **Текущее состояние** — на чём остановились\n\nВажно: только факты и анализ. Никакого плана, никаких рекомендаций, никаких \"следующих шагов\". Не добавляй своё мнение. Начни сразу со сводки.\n\nСессия:\n',
        'gemini-3-flash-preview',
        'HIGH',
        '#ec4899',
        1,
        0,
        3
      );
      console.log('[DB] Migrated: added rewind prompt');
    }
  }

  // Ensure built-in 'adopt' prompt exists and is up-to-date (migration for existing DBs)
  ensureAdoptPrompt() {
    const adoptContent = 'Ниже — сессия разработки Claude Code. Опиши конкретно что агент делал и на чём остановился (3-7 предложений). Какие файлы менял, какие действия выполнил, что осталось незавершённым. Только факты — без оценок и рекомендаций.\n';
    const exists = this.db.prepare('SELECT id, content FROM ai_prompts WHERE id = ?').get('adopt');
    if (!exists) {
      this.db.prepare(`
        INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('adopt', 'Adopt Summary', adoptContent, 'gemini-3-flash-preview', 'NONE', '#6366f1', 1, 0, 4);
      console.log('[DB] Migrated: added adopt prompt');
    } else if (exists.content !== adoptContent) {
      // Update content if it changed (built-in prompt evolution)
      this.db.prepare('UPDATE ai_prompts SET content = ? WHERE id = ? AND is_built_in = 1').run(adoptContent, 'adopt');
      console.log('[DB] Migrated: updated adopt prompt content');
    }
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

  // ========== API CALL LOG ==========

  saveApiCallLog({ projectId, callType, model, inputTokens, outputTokens, resultText, sourceTabId, sourceSessionId, targetTabId, payloadSize, sessionMeta, inputPayload }) {
    return this.db.prepare(`
      INSERT INTO api_call_log (project_id, call_type, model, input_tokens, output_tokens, result_text, source_tab_id, source_session_id, target_tab_id, payload_size, session_meta, input_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projectId || null, callType, model || null, inputTokens || 0, outputTokens || 0, resultText || null, sourceTabId || null, sourceSessionId || null, targetTabId || null, payloadSize || 0, sessionMeta ? JSON.stringify(sessionMeta) : null, inputPayload || null).lastInsertRowid;
  }

  getApiCallLog(projectId = null, limit = 50) {
    if (projectId) {
      return this.db.prepare('SELECT * FROM api_call_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit);
    }
    return this.db.prepare('SELECT * FROM api_call_log ORDER BY created_at DESC LIMIT ?').all(limit);
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

      // Debug: dump all fork_markers in DB
      const allMarkers = this.db.prepare('SELECT source_session_id, forked_to_session_id FROM fork_markers').all();
      console.log('[DB] ALL fork_markers after save:', JSON.stringify(allMarkers));
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

    console.log('[DB] getForkMarkers(' + sessionId?.slice(0, 8) + '...):', rows.length, 'rows');

    return rows.map(row => ({
      source_session_id: row.source_session_id,
      entry_uuids: JSON.parse(row.entry_uuids_json || '[]'),
      created_at: row.created_at
    }));
  }

  /**
   * Get parent session (where this session was forked from)
   * @param {string} sessionId - Session UUID
   * @returns {{source_session_id: string} | null}
   */
  getParentSession(sessionId) {
    return this.db.prepare(`
      SELECT source_session_id
      FROM fork_markers
      WHERE forked_to_session_id = ?
    `).get(sessionId) || null;
  }

  // ========== SESSION LINKS (Clear Context chain) ==========

  saveSessionLink(parentId, childId) {
    // Cycle guard: if reverse link (child→parent) already exists, skip to prevent circular chains
    const reverse = this.db.prepare(
      'SELECT 1 FROM session_links WHERE parent_session_id = ? AND child_session_id = ?'
    ).get(childId, parentId);
    if (reverse) {
      console.log('[DB] saveSessionLink: SKIPPING circular link', parentId.substring(0, 8), '→', childId.substring(0, 8), '(reverse exists)');
      return;
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO session_links (parent_session_id, child_session_id)
      VALUES (?, ?)
    `).run(parentId, childId);
  }

  getSessionParent(childId) {
    const row = this.db.prepare('SELECT parent_session_id FROM session_links WHERE child_session_id = ?').get(childId);
    return row ? row.parent_session_id : null;
  }

  getSessionChild(parentId) {
    const row = this.db.prepare('SELECT child_session_id FROM session_links WHERE parent_session_id = ?').get(parentId);
    return row ? row.child_session_id : null;
  }

  /**
   * Copy session_links chain for a given session from the other DB (prod↔dev).
   * Walks backwards from sessionId, copying all parent links found in the other DB
   * but missing in the current one.
   */
  importSessionLinksFromOtherDb(sessionId) {
    const userDataPath = app.getPath('userData');
    const otherDbName = app.isPackaged ? 'noted-terminal-dev.db' : 'noted-terminal.db';
    const otherDbPath = path.join(userDataPath, otherDbName);

    if (!require('fs').existsSync(otherDbPath)) return 0;

    let otherDb;
    try {
      otherDb = new Database(otherDbPath, { readonly: true });
    } catch (e) {
      console.error('[DB] Cannot open other DB:', e.message);
      return 0;
    }

    let imported = 0;
    try {
      // Collect all session IDs to check: walk fork_markers to find originals
      const idsToCheck = new Set();
      let walkId = sessionId;
      const walkVisited = new Set();
      while (walkId && !walkVisited.has(walkId)) {
        walkVisited.add(walkId);
        idsToCheck.add(walkId);
        const parent = this.getParentSession(walkId);
        walkId = parent ? parent.source_session_id : null;
      }

      for (const checkId of idsToCheck) {
        let currentId = checkId;
        const visited = new Set();
        while (currentId && !visited.has(currentId)) {
          visited.add(currentId);
          // Skip if link already exists in current DB
          if (this.getSessionParent(currentId)) {
            currentId = this.getSessionParent(currentId);
            continue;
          }
          // Check other DB
          const row = otherDb.prepare('SELECT parent_session_id FROM session_links WHERE child_session_id = ?').get(currentId);
          if (!row) break;
          this.saveSessionLink(row.parent_session_id, currentId);
          console.log('[DB] Imported session link from other DB:', row.parent_session_id.substring(0, 8), '→', currentId.substring(0, 8));
          imported++;
          currentId = row.parent_session_id;
        }
      }
    } catch (e) {
      console.error('[DB] importSessionLinks error:', e.message);
    } finally {
      try { otherDb.close(); } catch {}
    }
    return imported;
  }

  // ========== TIMELINE NOTES ==========

  getTimelineNotes(sessionId) {
    return this.db.prepare('SELECT entry_uuid, content FROM timeline_notes WHERE session_id = ?').all(sessionId);
  }

  saveTimelineNote(entryUuid, sessionId, tabId, content) {
    this.db.prepare(`
      INSERT INTO timeline_notes (entry_uuid, session_id, tab_id, content, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(entry_uuid, session_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(entryUuid, sessionId, tabId, content);
  }

  deleteTimelineNote(entryUuid, sessionId) {
    this.db.prepare('DELETE FROM timeline_notes WHERE entry_uuid = ? AND session_id = ?').run(entryUuid, sessionId);
  }

  close() { this.db.close(); }
}

module.exports = DatabaseManager;