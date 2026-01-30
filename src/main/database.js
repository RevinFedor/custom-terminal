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
        path TEXT UNIQUE NOT NULL,
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

    // Migration: add color and is_utility columns if they don't exist
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN color TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN is_utility INTEGER DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN claude_session_id TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN was_interrupted INTEGER DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN gemini_session_id TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN overlay_dismissed INTEGER DEFAULT 0`);
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

    // AI Sessions table (for session persistence)
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

    // Session deployments - tracks where sessions have been imported to
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        deployed_cwd TEXT NOT NULL,
        deployed_hash TEXT,
        deployed_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, deployed_cwd)
      )
    `);

    // Create indexes for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_quick_actions_project ON quick_actions(project_id);
      CREATE INDEX IF NOT EXISTS idx_tabs_project ON tabs(project_id);
      CREATE INDEX IF NOT EXISTS idx_gemini_history_project ON gemini_history(project_id);
      CREATE INDEX IF NOT EXISTS idx_gemini_history_timestamp ON gemini_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_project ON ai_sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_tool_type ON ai_sessions(tool_type);
      CREATE INDEX IF NOT EXISTS idx_session_deployments_session ON session_deployments(session_id);
    `);

    // Migration: Remove UNIQUE constraint from projects.path to allow multiple project instances
    this.migrateProjectsTableRemoveUniquePathConstraint();

    // Research Conversations table (JSON storage for full chat history)
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
    
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_research_conversations_project ON research_conversations(project_id);`);

    // App state table (for storing session, settings, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Bookmarks table (reserved directories for quick project creation)
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
  }

  // Migration: Remove UNIQUE constraint from projects.path
  migrateProjectsTableRemoveUniquePathConstraint() {
    // Check if migration is needed by trying to find the unique index
    const indexes = this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='projects'").all();
    const hasUniquePathIndex = indexes.some(idx => idx.name === 'sqlite_autoindex_projects_2');

    // Also check if path column has UNIQUE by looking at table info
    const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get();
    if (!tableInfo || !tableInfo.sql.includes('path TEXT UNIQUE')) {
      console.log('[Database] projects.path UNIQUE constraint already removed or never existed');
      return;
    }

    console.log('[Database] Migrating projects table: removing UNIQUE constraint from path');

    this.db.exec('BEGIN TRANSACTION');
    try {
      // 1. Create new table without UNIQUE on path
      this.db.exec(`
        CREATE TABLE projects_new (
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

      // 2. Copy data
      this.db.exec(`
        INSERT INTO projects_new (id, path, name, description, gemini_prompt, notes_global, created_at, updated_at)
        SELECT id, path, name, description, gemini_prompt, notes_global, created_at, updated_at FROM projects
      `);

      // 3. Drop old table
      this.db.exec('DROP TABLE projects');

      // 4. Rename new table
      this.db.exec('ALTER TABLE projects_new RENAME TO projects');

      // 5. Recreate index on path (non-unique)
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)');

      this.db.exec('COMMIT');
      console.log('[Database] Migration completed: projects.path is no longer UNIQUE');
    } catch (err) {
      this.db.exec('ROLLBACK');
      console.error('[Database] Migration failed:', err);
      throw err;
    }
  }

  // ========== APP STATE ==========

  getAppState(key) {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
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

  getProject(projectPath) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) {
      return null;
    }

    // Load related data
    const tabs = this.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(project.id);

    // Load global commands instead of project-specific quick actions
    const globalCommands = this.getGlobalCommands();

    return {
      id: project.id,
      path: project.path,
      name: project.name,
      description: project.description,
      geminiPrompt: project.gemini_prompt,
      notes: {
        global: project.notes_global,
        sessions: []
      },
      quickActions: globalCommands.map(gc => ({
        name: gc.name,
        command: gc.command
      })),
      tabs: tabs.map(t => ({
        name: t.name,
        cwd: t.cwd,
        color: t.color || undefined,
        isUtility: t.is_utility === 1,
        claudeSessionId: t.claude_session_id || undefined,
        geminiSessionId: t.gemini_session_id || undefined,
        wasInterrupted: t.was_interrupted === 1,
        overlayDismissed: t.overlay_dismissed === 1
      }))
    };
  }

  createProject(projectPath) {
    const normalizedPath = path.resolve(projectPath);
    const folderName = path.basename(normalizedPath);
    const projectId = Buffer.from(normalizedPath).toString('base64');

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO projects (id, path, name, description, gemini_prompt, notes_global)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      projectId,
      normalizedPath,
      folderName,
      '',
      'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
      `<h1>${folderName}</h1><p>Project notes go here...</p>`
    );

    // Ensure default global commands exist if this is the first project
    const globalCommandsCount = this.db.prepare('SELECT COUNT(*) as count FROM global_commands').get().count;

    if (globalCommandsCount === 0) {
      const defaultCommands = [
        {
          name: "gemini (прочитать docs)",
          command: "gemini 'Прочитай всю документацию в папке docs и в корне проекта, чтобы понять архитектуру. Не отвечай пока я не спрошу.'"
        },
        {
          name: "claude (прочитать docs)",
          command: "claude 'Прочитай всю документацию в папке docs и в корне проекта, чтобы понять архитектуру. Не отвечай пока я не спрошу.'"
        },
        {
          name: "📂 List Project Files",
          command: "ls -lah"
        }
      ];

      this.saveGlobalCommands(defaultCommands);
    }

    return this.getProject(normalizedPath);
  }

  // Create a new project instance (allows multiple projects with same path)
  createProjectInstance(projectPath, customName = null) {
    const normalizedPath = path.resolve(projectPath);
    const folderName = path.basename(normalizedPath);

    // Generate unique ID using timestamp + random
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const projectId = `${Buffer.from(normalizedPath).toString('base64').substring(0, 20)}_${timestamp}_${random}`;

    // Determine name: use customName or generate suffix
    let projectName = customName;
    if (!projectName) {
      // Count existing projects with this path to generate suffix
      const existingCount = this.db.prepare('SELECT COUNT(*) as count FROM projects WHERE path = ?').get(normalizedPath).count;
      projectName = existingCount > 0 ? `${folderName}-${existingCount + 1}` : folderName;
    }

    const insert = this.db.prepare(`
      INSERT INTO projects (id, path, name, description, gemini_prompt, notes_global)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      projectId,
      normalizedPath,
      projectName,
      '',
      'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
      `<h1>${projectName}</h1><p>Project notes go here...</p>`
    );

    return this.getProjectById(projectId);
  }

  // Get project by ID (not by path)
  getProjectById(projectId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    if (!project) {
      return null;
    }

    // Load related data
    const tabs = this.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(project.id);
    const globalCommands = this.getGlobalCommands();

    return {
      id: project.id,
      path: project.path,
      name: project.name,
      description: project.description || '',
      geminiPrompt: project.gemini_prompt,
      notesGlobal: project.notes_global || '',
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      quickActions: globalCommands.map(gc => ({
        name: gc.name,
        command: gc.command
      })),
      tabs: tabs.map(t => ({
        name: t.name,
        cwd: t.cwd,
        color: t.color || undefined,
        isUtility: t.is_utility === 1,
        claudeSessionId: t.claude_session_id || undefined,
        geminiSessionId: t.gemini_session_id || undefined,
        wasInterrupted: t.was_interrupted === 1,
        overlayDismissed: t.overlay_dismissed === 1
      }))
    };
  }

  getAllProjects() {
    const projects = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return projects.map(project => this.getProject(project.path));
  }

  updateProjectMetadata(projectPath, metadata) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return;

    const updates = [];
    const params = [];

    if (metadata.name !== undefined) {
      updates.push('name = ?');
      params.push(metadata.name);
    }
    if (metadata.description !== undefined) {
      updates.push('description = ?');
      params.push(metadata.description);
    }
    if (metadata.geminiPrompt !== undefined) {
      updates.push('gemini_prompt = ?');
      params.push(metadata.geminiPrompt);
    }

    if (updates.length > 0) {
      updates.push('updated_at = strftime(\'%s\', \'now\')');
      params.push(normalizedPath);

      const sql = `UPDATE projects SET ${updates.join(', ')} WHERE path = ?`;
      this.db.prepare(sql).run(...params);
    }
  }

  updateProjectNotes(projectPath, notes) {
    const normalizedPath = path.resolve(projectPath);
    this.db.prepare(`
      UPDATE projects
      SET notes_global = ?, updated_at = strftime('%s', 'now')
      WHERE path = ?
    `).run(notes, normalizedPath);
  }

  deleteProject(projectPath) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return false;

    // CASCADE will delete tabs, quick_actions, gemini_history, ai_sessions
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    return true;
  }

  // ========== QUICK ACTIONS (now redirects to global commands) ==========

  saveQuickActions(projectPath, actions) {
    // Now we save to global commands instead of project-specific
    this.saveGlobalCommands(actions);
  }

  // ========== TABS ==========

  saveTabs(projectPath, tabs) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return;

    // Delete existing tabs
    this.db.prepare('DELETE FROM tabs WHERE project_id = ?').run(project.id);

    // Insert new tabs with color, is_utility, claude_session_id, gemini_session_id, was_interrupted and overlay_dismissed
    const insert = this.db.prepare(`
      INSERT INTO tabs (project_id, name, cwd, position, color, is_utility, claude_session_id, gemini_session_id, was_interrupted, overlay_dismissed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    tabs.forEach((tab, index) => {
      insert.run(project.id, tab.name, tab.cwd, index, tab.color || null, tab.isUtility ? 1 : 0, tab.claudeSessionId || null, tab.geminiSessionId || null, tab.wasInterrupted ? 1 : 0, tab.overlayDismissed ? 1 : 0);
    });

    this.db.prepare(`
      UPDATE projects SET updated_at = strftime('%s', 'now') WHERE id = ?
    `).run(project.id);
  }

  // ========== GEMINI HISTORY ==========

  saveGeminiHistory(projectPath, selectedText, prompt, response) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return null;

    const insert = this.db.prepare(`
      INSERT INTO gemini_history (project_id, selected_text, prompt, response)
      VALUES (?, ?, ?, ?)
    `);

    const result = insert.run(project.id, selectedText, prompt, response);

    return {
      id: result.lastInsertRowid,
      project_id: project.id,
      selected_text: selectedText,
      prompt: prompt,
      response: response,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }

  getGeminiHistory(projectPath, limit = 50) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return [];

    return this.db.prepare(`
      SELECT * FROM gemini_history
      WHERE project_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(project.id, limit);
  }

  deleteGeminiHistoryItem(historyId) {
    this.db.prepare('DELETE FROM gemini_history WHERE id = ?').run(historyId);
  }

  // ========== GLOBAL COMMANDS ==========

  getGlobalCommands() {
    return this.db.prepare('SELECT * FROM global_commands ORDER BY position').all();
  }

  saveGlobalCommands(commands) {
    // Delete existing commands
    this.db.prepare('DELETE FROM global_commands').run();

    // Insert new commands
    const insert = this.db.prepare(`
      INSERT INTO global_commands (name, command, position)
      VALUES (?, ?, ?)
    `);

    commands.forEach((cmd, index) => {
      insert.run(cmd.name, cmd.command, index);
    });
  }

  // Migration: Copy unique quick_actions to global_commands
  migrateQuickActionsToGlobal() {
    const existingGlobal = this.db.prepare('SELECT COUNT(*) as count FROM global_commands').get().count;

    // Only migrate if global_commands is empty
    if (existingGlobal > 0) {
      return { migrated: false, message: 'Global commands already exist' };
    }

    // Get unique commands from all projects
    const uniqueCommands = new Map();

    const allActions = this.db.prepare('SELECT * FROM quick_actions ORDER BY position').all();

    allActions.forEach(action => {
      const key = `${action.name}::${action.command}`;
      if (!uniqueCommands.has(key)) {
        uniqueCommands.set(key, {
          name: action.name,
          command: action.command
        });
      }
    });

    // Insert unique commands as global
    const insert = this.db.prepare(`
      INSERT INTO global_commands (name, command, position)
      VALUES (?, ?, ?)
    `);

    let position = 0;
    for (const cmd of uniqueCommands.values()) {
      insert.run(cmd.name, cmd.command, position++);
    }

    return { migrated: true, count: uniqueCommands.size };
  }

  // ========== PROMPTS ==========

  getPrompts() {
    return this.db.prepare('SELECT * FROM prompts ORDER BY position').all();
  }

  savePrompts(prompts) {
    // Delete existing prompts
    this.db.prepare('DELETE FROM prompts').run();

    // Insert new prompts
    const insert = this.db.prepare(`
      INSERT INTO prompts (title, content, position)
      VALUES (?, ?, ?)
    `);

    prompts.forEach((prompt, index) => {
      insert.run(prompt.title, prompt.content, index);
    });
  }

  createDefaultPrompts() {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM prompts').get().count;
    if (count > 0) return;

    const defaultPrompts = [
      {
        title: 'Fix Error',
        content: 'Please analyze this error and provide a solution:'
      },
      {
        title: 'Explain Code',
        content: 'Explain what this code does:'
      },
      {
        title: 'Optimize',
        content: 'How can I optimize this code?'
      }
    ];

    this.savePrompts(defaultPrompts);
  }

  // ========== AI SESSIONS ==========

  saveAISession(projectPath, toolType, sessionKey, contentBlob, originalCwd, originalHash = null) {
    const normalizedPath = path.resolve(projectPath);
    let project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    // Auto-create project if it doesn't exist
    if (!project) {
      console.log('[Database] Auto-creating project for:', normalizedPath);
      this.createProject(normalizedPath);
      project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);
      if (!project) {
        console.error('[Database] Failed to create project for:', normalizedPath);
        return null;
      }
    }

    // Check if session already exists
    const existing = this.db.prepare(`
      SELECT id FROM ai_sessions
      WHERE project_id = ? AND tool_type = ? AND session_key = ?
    `).get(project.id, toolType, sessionKey);

    if (existing) {
      // Update existing session
      this.db.prepare(`
        UPDATE ai_sessions
        SET content_blob = ?, original_cwd = ?, original_hash = ?, updated_at = strftime('%s', 'now')
        WHERE id = ?
      `).run(contentBlob, originalCwd, originalHash, existing.id);

      return existing.id;
    } else {
      // Insert new session
      const result = this.db.prepare(`
        INSERT INTO ai_sessions (project_id, tool_type, session_key, content_blob, original_cwd, original_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(project.id, toolType, sessionKey, contentBlob, originalCwd, originalHash);

      return result.lastInsertRowid;
    }
  }

  // Get ALL sessions across all projects (with deployments)
  getAllAISessions(toolType = null) {
    let sessions;
    if (toolType) {
      sessions = this.db.prepare(`
        SELECT s.*, p.path as project_path
        FROM ai_sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.tool_type = ?
        ORDER BY s.updated_at DESC
      `).all(toolType);
    } else {
      sessions = this.db.prepare(`
        SELECT s.*, p.path as project_path
        FROM ai_sessions s
        JOIN projects p ON s.project_id = p.id
        ORDER BY s.updated_at DESC
      `).all();
    }

    // Add deployments to each session
    for (const session of sessions) {
      const deployments = this.getSessionDeployments(session.id);
      // Collect all locations: original_cwd + all deployed locations
      const locations = new Set([session.original_cwd]);
      for (const d of deployments) {
        locations.add(d.deployed_cwd);
      }
      session.locations = Array.from(locations);
    }

    return sessions;
  }

  getAISessions(projectPath, toolType = null) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return [];

    if (toolType) {
      return this.db.prepare(`
        SELECT * FROM ai_sessions
        WHERE project_id = ? AND tool_type = ?
        ORDER BY updated_at DESC
      `).all(project.id, toolType);
    } else {
      return this.db.prepare(`
        SELECT * FROM ai_sessions
        WHERE project_id = ?
        ORDER BY updated_at DESC
      `).all(project.id);
    }
  }

  getAISession(projectPath, toolType, sessionKey) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return null;

    return this.db.prepare(`
      SELECT * FROM ai_sessions
      WHERE project_id = ? AND tool_type = ? AND session_key = ?
    `).get(project.id, toolType, sessionKey);
  }

  deleteAISession(sessionId) {
    this.db.prepare('DELETE FROM ai_sessions WHERE id = ?').run(sessionId);
  }

  // ========== SESSION DEPLOYMENTS ==========

  addSessionDeployment(sessionId, deployedCwd, deployedHash = null) {
    const normalizedCwd = path.resolve(deployedCwd);
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO session_deployments (session_id, deployed_cwd, deployed_hash)
        VALUES (?, ?, ?)
      `).run(sessionId, normalizedCwd, deployedHash);
      return true;
    } catch (error) {
      console.error('[Database] Error adding deployment:', error);
      return false;
    }
  }

  getSessionDeployments(sessionId) {
    return this.db.prepare(`
      SELECT * FROM session_deployments
      WHERE session_id = ?
      ORDER BY deployed_at DESC
    `).all(sessionId);
  }

  removeSessionDeployment(sessionId, deployedCwd) {
    const normalizedCwd = path.resolve(deployedCwd);
    this.db.prepare(`
      DELETE FROM session_deployments
      WHERE session_id = ? AND deployed_cwd = ?
    `).run(sessionId, normalizedCwd);
  }

  // Get session by ID (for cross-project import)
  getAISessionById(sessionId) {
    return this.db.prepare('SELECT * FROM ai_sessions WHERE id = ?').get(sessionId);
  }

  // ========== VISUAL SNAPSHOTS ==========

  saveTabVisualSnapshot(projectPath, tabIndex, snapshot) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return;

    const tabs = this.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(project.id);

    if (tabIndex < 0 || tabIndex >= tabs.length) return;

    const tab = tabs[tabIndex];

    this.db.prepare(`
      UPDATE tabs
      SET visual_snapshot = ?
      WHERE id = ?
    `).run(snapshot, tab.id);
  }

  getTabVisualSnapshot(projectPath, tabIndex) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return null;

    const tabs = this.db.prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position').all(project.id);

    if (tabIndex < 0 || tabIndex >= tabs.length) return null;

    const tab = tabs[tabIndex];
    return tab.visual_snapshot;
  }

  // ========== RESEARCH CONVERSATIONS ==========

  saveResearchConversation(projectPath, conversation) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);
    if (!project) return;

    this.db.prepare(`
      INSERT INTO research_conversations (id, project_id, title, type, messages_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at
    `).run(
      conversation.id,
      project.id,
      conversation.title,
      conversation.type,
      JSON.stringify(conversation.messages),
      Math.floor(conversation.createdAt / 1000), // Store as seconds for consistency
      Math.floor(conversation.updatedAt / 1000)
    );
  }

  getResearchConversations(projectPath) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);
    if (!project) return [];

    const rows = this.db.prepare(`
      SELECT * FROM research_conversations
      WHERE project_id = ?
      ORDER BY updated_at DESC
    `).all(project.id);

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      type: row.type,
      messages: JSON.parse(row.messages_json),
      createdAt: row.created_at * 1000, // Convert back to ms
      updatedAt: row.updated_at * 1000
    }));
  }

  deleteResearchConversation(projectPath, conversationId) {
    const normalizedPath = path.resolve(projectPath);
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);
    if (!project) return;

    this.db.prepare('DELETE FROM research_conversations WHERE id = ? AND project_id = ?')
      .run(conversationId, project.id);
  }

  // ========== CLEANUP ==========

  // ========== BOOKMARKS ==========

  getAllBookmarks() {
    return this.db.prepare('SELECT * FROM bookmarks ORDER BY position').all();
  }

  getBookmark(id) {
    return this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  }

  createBookmark(dirPath, name, description = '') {
    const normalizedPath = path.resolve(dirPath);

    // Check if bookmark already exists
    const existing = this.db.prepare('SELECT * FROM bookmarks WHERE path = ?').get(normalizedPath);
    if (existing) {
      return existing;
    }

    // Get max position
    const maxPos = this.db.prepare('SELECT MAX(position) as max FROM bookmarks').get();
    const position = (maxPos.max || 0) + 1;

    const result = this.db.prepare(`
      INSERT INTO bookmarks (path, name, description, position)
      VALUES (?, ?, ?, ?)
    `).run(normalizedPath, name, description, position);

    return this.getBookmark(result.lastInsertRowid);
  }

  updateBookmark(id, updates) {
    const { name, description, position } = updates;

    if (name !== undefined) {
      this.db.prepare('UPDATE bookmarks SET name = ? WHERE id = ?').run(name, id);
    }
    if (description !== undefined) {
      this.db.prepare('UPDATE bookmarks SET description = ? WHERE id = ?').run(description, id);
    }
    if (position !== undefined) {
      this.db.prepare('UPDATE bookmarks SET position = ? WHERE id = ?').run(position, id);
    }

    return this.getBookmark(id);
  }

  deleteBookmark(id) {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }

  close() {
    this.db.close();
  }
}

module.exports = DatabaseManager;
