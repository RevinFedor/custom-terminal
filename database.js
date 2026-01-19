const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

class DatabaseManager {
  constructor() {
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'noted-terminal.db');

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
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

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

    // Create indexes for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_quick_actions_project ON quick_actions(project_id);
      CREATE INDEX IF NOT EXISTS idx_tabs_project ON tabs(project_id);
      CREATE INDEX IF NOT EXISTS idx_gemini_history_project ON gemini_history(project_id);
      CREATE INDEX IF NOT EXISTS idx_gemini_history_timestamp ON gemini_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_project ON ai_sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_tool_type ON ai_sessions(tool_type);
    `);
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
        cwd: t.cwd
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

    // Insert new tabs
    const insert = this.db.prepare(`
      INSERT INTO tabs (project_id, name, cwd, position)
      VALUES (?, ?, ?, ?)
    `);

    tabs.forEach((tab, index) => {
      insert.run(project.id, tab.name, tab.cwd, index);
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
    const project = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(normalizedPath);

    if (!project) return null;

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

  // ========== CLEANUP ==========

  close() {
    this.db.close();
  }
}

module.exports = DatabaseManager;
