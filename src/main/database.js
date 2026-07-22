const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const {
  emptyTaskPlan,
  normalizeTaskPlan,
  applyTaskPlanOperations,
  undoTaskPlan,
  redoTaskPlan,
  chooseNewestTaskPlan,
} = require('./tab-task-plan');
const INBOX_PROJECT_ID = '__noted_inbox__';
const INBOX_PROJECT_NAME = 'Inbox';
const INBOX_PROJECT_DESCRIPTION = 'System workspace for API-created and unassigned agent tabs.';
const getInboxProjectPath = () => process.env.NOTED_INBOX_CWD || process.env.HOME || os.homedir() || '/';

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
    this.ensureInboxProject();
    this.createDefaultPrompts();
    this.seedDefaultAIPrompts();
    this.ensureRewindPrompt();
    this.ensureAdoptPrompt();
    this.ensureTabTitlePrompt();
    this.ensureRunAfterTitlePrompt();
    this.ensurePromptSummaryPrompt();
    this.ensureTimelineGroupingPrompt();
    this.ensureGitCommitPrompt();
  }

  initTables() {
    // Projects table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        icon TEXT DEFAULT NULL,
        gemini_prompt TEXT DEFAULT 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
        notes_global TEXT DEFAULT '',
        tab_groups TEXT DEFAULT NULL,
        sidebar_open INTEGER DEFAULT 0,
        open_file_path TEXT DEFAULT NULL,
        sidebar_expanded_dirs TEXT DEFAULT NULL,
        sidebar_scroll_top REAL DEFAULT 0,
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

    // Prompt groups table (for grouping context menu prompts)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        position INTEGER DEFAULT 0
      )
    `);

    // Migrations: prompt_groups
    try { this.db.exec(`ALTER TABLE prompt_groups ADD COLUMN description TEXT DEFAULT ''`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE prompt_groups ADD COLUMN is_collapsed INTEGER DEFAULT 0`); } catch (e) {}

    // Migration: add group_id to prompts
    try { this.db.exec(`ALTER TABLE prompts ADD COLUMN group_id INTEGER DEFAULT NULL`); } catch (e) {}

    // Migration: add file_paths to prompts (JSON array of absolute file paths)
    try { this.db.exec(`ALTER TABLE prompts ADD COLUMN file_paths TEXT DEFAULT NULL`); } catch (e) {}

    // Durable identity is separate from the legacy AUTOINCREMENT row id because
    // savePrompts rewrites the table. DnD must keep following the same prompt
    // while array positions change during a preview.
    try { this.db.exec(`ALTER TABLE prompts ADD COLUMN stable_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`UPDATE prompts SET stable_id = 'prompt-' || id WHERE stable_id IS NULL OR stable_id = ''`); } catch (e) {}
    try { this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_stable_id ON prompts(stable_id) WHERE stable_id IS NOT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE prompts ADD COLUMN visual_parent_id TEXT DEFAULT NULL`); } catch (e) {}

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
        name_set_manually INTEGER DEFAULT 0,
        cwd TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        visual_snapshot TEXT DEFAULT NULL,
        color TEXT DEFAULT NULL,
        is_utility INTEGER DEFAULT 0,
        task_plan TEXT DEFAULT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // Migrations
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN color TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN is_utility INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN name_set_manually INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN claude_session_id TEXT DEFAULT NULL`); } catch (e) {}
    // Per-tab provider state (provider type + chosen model + effort + thinking).
    // JSON-serialized {type:'anthropic'|'deepseek'|'zen', model?, effort?, thinking?}.
    // Persisted because main's `providerStates` Map is in-memory only — without
    // this column every restart resets all tabs to default anthropic provider.
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN provider_state TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN was_interrupted INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN gemini_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_effort TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN external_run TEXT DEFAULT NULL`); } catch (e) {}
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN overlay_dismissed INTEGER DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN notes TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN task_plan TEXT DEFAULT NULL`);
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
      this.db.exec(`ALTER TABLE tabs ADD COLUMN file_path TEXT DEFAULT NULL`);
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
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN tab_group_id TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN visual_parent_tab_id TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }

    // Project sidebar state
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN sidebar_open INTEGER DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN open_file_path TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN sidebar_expanded_dirs TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN sidebar_scroll_top REAL DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN tab_groups TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN icon TEXT DEFAULT NULL`);
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

    // App state table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
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
    // Migration: add hidden column for soft-delete (keeps snapshot data for boundary suppression)
    try { this.db.exec(`ALTER TABLE fork_markers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`); } catch (e) {}

    // Tab history table - closed tabs archive
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tab_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_set_manually INTEGER DEFAULT 0,
        cwd TEXT NOT NULL,
        color TEXT DEFAULT NULL,
        notes TEXT DEFAULT NULL,
        task_plan TEXT DEFAULT NULL,
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
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN name_set_manually INTEGER DEFAULT 0`); } catch (e) {}

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

    // Migration: add session_status (user-chosen status marker id, vertical mode).
    // Stores id from useUIStore.sessionStatuses palette. Lookup в renderer'е,
    // если id больше нет в палитре — marker просто не рендерится, но данные не теряем.
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN session_status TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: persistent tab-completion notification mode. One-shot armed/fired
    // state is renderer-runtime only; this flag means "auto-arm on every new turn".
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN completion_notification_persistent INTEGER DEFAULT 0`); } catch (e) {}

    // Migration: restart-after AI trigger for terminal/dev tabs.
    // Target, one-shot armed state, and repeat mode all survive app restarts.
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN restart_after_tab_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN restart_after_tab_ids TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN restart_after_command TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN restart_after_paused INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN restart_after_armed INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN restart_after_persistent INTEGER DEFAULT 0`); } catch (e) {}

    // Migration: claude_session_history — JSON array (most-recent-first, cap 5)
    // of {sessionId, reason, at}. Lets the user revert when an automated writer
    // (bridge watcher, AutoResume, timeline chain) overwrites the wrong session.
    // See docs/knowledge/fix-bridge-stale-takeover.md.
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN claude_session_history TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: context_pct — last-known context-window fill % for this tab.
    // Persisted so the control-bar meter can show the value even when no Claude
    // process is running (CLI exited / not launched yet). Written point-wise via
    // updateTabContextPct (cheap single-column UPDATE, like provider_state) and
    // preserved across full-reinsert saveTabs by a snapshot (never wiped to NULL
    // just because the renderer's saveTabs payload doesn't carry it).
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN context_pct REAL DEFAULT NULL`); } catch (e) {}

    // Migration: cache_stats — last-known prompt-cache split for the control-bar
    // cooldown chip, stored as JSON {cacheRead,cacheCreate,input,ts}. ts is a
    // wall-clock anchor (server cache TTL is wall-clock), so a persisted value
    // still yields an accurate "cools down in N min" countdown after a tab switch
    // or app restart. Same point-wise write + snapshot-preserve pattern as
    // context_pct / provider_state.
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN cache_stats TEXT DEFAULT NULL`); } catch (e) {}

    // Index on tab_id for faster lookups in saveTabs
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tabs_tab_id ON tabs(tab_id) WHERE tab_id IS NOT NULL`); } catch (e) {}

    // Migration: add session IDs to tab_history (for resume on restore)
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN claude_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN gemini_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_effort TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: add message_count to tab_history
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN message_count INTEGER DEFAULT NULL`); } catch (e) {}

    // Migration: add position + process_was_running to tab_history.
    // - position: index inside TabBar at close time (excluding sub-agent / utility tabs),
    //   used as a hint by Shift+Cmd+T to put the restored tab back near where it was.
    // - process_was_running: 1 if the underlying CLI (claude/gemini/script) was alive
    //   when the tab was closed. Shift+Cmd+T uses this to auto-Continue Claude sessions
    //   that were killed only by virtue of the tab itself going away.
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN position INTEGER DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN process_was_running INTEGER DEFAULT 0`); } catch (e) {}

    // Migration: session_status survives close/restore (matches tabs.session_status).
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN session_status TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: group_id survives close/restore if the TabSidebar group still exists.
    // We intentionally store only the group id, not a serialized group snapshot:
    // closing a whole group deletes the container, and later restore must degrade
    // to a flat tab instead of resurrecting a removed folder.
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN group_id TEXT DEFAULT NULL`); } catch (e) {}
    // Migration: linked file tabs preserve the absolute path across restart and Shift+Cmd+T restore.
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN file_path TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN task_plan TEXT DEFAULT NULL`); } catch (e) {}

    // Migration: add position to timeline_notes
    try { this.db.exec(`ALTER TABLE timeline_notes ADD COLUMN position TEXT DEFAULT 'before'`); } catch (e) {}

    // Migration: add file_paths to ai_prompts (JSON array of absolute file paths)
    try { this.db.exec(`ALTER TABLE ai_prompts ADD COLUMN file_paths TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN project_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN project_name TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN project_path TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN tab_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN tab_name TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN tool_type TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN entry_uuid TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE ai_prompt_call_logs ADD COLUMN iteration_index INTEGER DEFAULT NULL`); } catch (e) {}

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
        position INTEGER NOT NULL DEFAULT 0,
        file_paths TEXT DEFAULT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_prompt_summaries (
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_uuid TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_hash TEXT DEFAULT NULL,
        model TEXT DEFAULT NULL,
        prompt_id TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        candidate_tokens INTEGER DEFAULT 0,
        thought_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (tool_type, session_id, entry_uuid)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timeline_prompt_summaries_session
      ON timeline_prompt_summaries(tool_type, session_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timeline_prompt_summaries_updated
      ON timeline_prompt_summaries(updated_at DESC)
    `);

    // Generated semantic projection for the expanded Timeline. The canonical
    // transcript remains JSONL; this row is disposable metadata keyed by the
    // owning tool/session and can be rebuilt explicitly from the toolbar.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_outlines (
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        source_hash TEXT NOT NULL,
        source_uuids_json TEXT NOT NULL DEFAULT '[]',
        source_entry_count INTEGER NOT NULL DEFAULT 0,
        source_last_uuid TEXT DEFAULT NULL,
        outline_json TEXT NOT NULL,
        model TEXT DEFAULT NULL,
        prompt_id TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        candidate_tokens INTEGER DEFAULT 0,
        thought_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        source_chars INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (tool_type, session_id)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timeline_outlines_updated
      ON timeline_outlines(updated_at DESC)
    `);

    // User-requested per-turn action labels. Kept outside generated outlines so
    // a manual correction survives regrouping and also covers singleton/new turns.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_turn_action_overrides (
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_uuid TEXT NOT NULL,
        action_label TEXT NOT NULL,
        source_hash TEXT DEFAULT NULL,
        model TEXT DEFAULT NULL,
        prompt_id TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (tool_type, session_id, entry_uuid)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timeline_turn_action_overrides_session
      ON timeline_turn_action_overrides(tool_type, session_id)
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_prompt_call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_id TEXT DEFAULT NULL,
        task_type TEXT DEFAULT NULL,
        model TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        candidate_tokens INTEGER DEFAULT 0,
        thought_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        status TEXT DEFAULT 'success',
        error TEXT DEFAULT NULL,
        source_chars INTEGER DEFAULT 0,
        output_chars INTEGER DEFAULT 0,
        project_id TEXT DEFAULT NULL,
        project_name TEXT DEFAULT NULL,
        project_path TEXT DEFAULT NULL,
        tab_id TEXT DEFAULT NULL,
        tab_name TEXT DEFAULT NULL,
        tool_type TEXT DEFAULT NULL,
        session_id TEXT DEFAULT NULL,
        entry_uuid TEXT DEFAULT NULL,
        iteration_index INTEGER DEFAULT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_prompt_call_logs_created
      ON ai_prompt_call_logs(created_at DESC)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_prompt_call_logs_prompt
      ON ai_prompt_call_logs(prompt_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_prompt_call_logs_model
      ON ai_prompt_call_logs(model)
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
        codex_session_id TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_project ON favorites(project_id)`);
    try { this.db.exec(`ALTER TABLE favorites ADD COLUMN codex_session_id TEXT DEFAULT NULL`); } catch (e) {}

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

    // Rewind markers — pink dots on Timeline for edit-range compact entries
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_rewind_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_uuid TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(entry_uuid, session_id)
      )
    `);

    // claude_usage_snapshots — sample of /oauth/usage every minute.
    // Storage: 1440 rows/day × ~50B ≈ 26 MB/year. Kept FOREVER (no prune) —
    // user wants unbounded history so the "By day" chart can look back over
    // arbitrary ranges, not just the last week.
    // `weekly_resets_at` is the ISO string from Anthropic — used to detect
    // weekly resets (when value drops because Anthropic rotated the bucket).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claude_usage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        weekly_pct REAL,
        five_hour_pct REAL,
        weekly_opus_pct REAL,
        weekly_sonnet_pct REAL,
        weekly_resets_at TEXT,
        five_hour_resets_at TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_snapshots_ts ON claude_usage_snapshots(ts DESC);
    `);

    // agent_activity_intervals — one row per "loader was on" span, i.e. an
    // agent (Claude PTY / Claude SDK / Gemini) actively working in a tab.
    // Boundaries come from the SAME busy-state signal that drives the tab
    // loader (see main.js recordActivity). Identity columns are DENORMALIZED
    // snapshots taken at interval-open time so a row survives the tab/project
    // being deleted later. Only CLOSED intervals are written (start+end known),
    // so there are never dangling NULL-end rows; a crash mid-interval simply
    // loses that one in-flight span. Timestamps are ms epoch.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_activity_intervals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tab_id TEXT,
        project_id TEXT,
        project_path TEXT,
        project_name TEXT,
        tab_name TEXT,
        engine TEXT,
        session_id TEXT,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_activity_start ON agent_activity_intervals(start_ts DESC);
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

  // Bulk-read all rows whose key starts with prefix (or every row when no prefix).
  // Values are returned verbatim — this is the raw mirror of localStorage strings,
  // so we DON'T re-parse JSON here (the renderer will use the result as plain strings).
  getAllAppStateRaw(prefix) {
    const rows = prefix
      ? this.db.prepare('SELECT key, value FROM app_state WHERE key LIKE ?').all(prefix + '%')
      : this.db.prepare('SELECT key, value FROM app_state').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  deleteAppState(key) {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key);
  }

  // ========== PROJECTS ========== 

  ensureInboxProject() {
    const inboxPath = getInboxProjectPath();
    const existing = this.db.prepare('SELECT id, path, name, description FROM projects WHERE id = ?').get(INBOX_PROJECT_ID);

    if (!existing) {
      this.db.prepare(`
        INSERT INTO projects (id, path, name, description, gemini_prompt, notes_global)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        INBOX_PROJECT_ID,
        inboxPath,
        INBOX_PROJECT_NAME,
        INBOX_PROJECT_DESCRIPTION,
        'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
        `<h1>${INBOX_PROJECT_NAME}</h1>`
      );
      return;
    }

    if (
      existing.path !== inboxPath ||
      existing.name !== INBOX_PROJECT_NAME ||
      existing.description !== INBOX_PROJECT_DESCRIPTION
    ) {
      this.db.prepare(`
        UPDATE projects
        SET path = ?, name = ?, description = ?
        WHERE id = ?
      `).run(inboxPath, INBOX_PROJECT_NAME, INBOX_PROJECT_DESCRIPTION, INBOX_PROJECT_ID);
    }
  }

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
      icon: project.icon || null,
      geminiPrompt: project.gemini_prompt,
      notesGlobal: project.notes_global || '',
      tabGroups: (() => {
        if (!project.tab_groups) return [];
        try {
          const parsed = JSON.parse(project.tab_groups);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      sidebarOpen: project.sidebar_open === 1,
      openFilePath: project.open_file_path || null,
      sidebarExpandedDirs: project.sidebar_expanded_dirs ? JSON.parse(project.sidebar_expanded_dirs) : null,
      sidebarScrollTop: Number.isFinite(Number(project.sidebar_scroll_top))
        ? Math.max(0, Number(project.sidebar_scroll_top))
        : 0,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      quickActions: globalCommands.map(gc => ({ name: gc.name, command: gc.command })),
      tabs: tabs.map(t => ({
        name: t.name,
        nameSetManually: t.name_set_manually === 1 || undefined,
        cwd: t.cwd,
        color: t.color || undefined,
        isUtility: t.is_utility === 1,
        commandType: t.command_type || undefined,
        claudeSessionId: t.claude_session_id || undefined,
        claudeSessionHistory: (() => {
          if (!t.claude_session_history) return undefined;
          try { return JSON.parse(t.claude_session_history); }
          catch { return undefined; }
        })(),
        geminiSessionId: t.gemini_session_id || undefined,
        codexSessionId: t.codex_session_id || undefined,
        codexModel: t.codex_model || undefined,
        codexEffort: t.codex_effort || undefined,
        externalRun: (() => {
          if (!t.external_run) return undefined;
          try { return JSON.parse(t.external_run); }
          catch { return undefined; }
        })(),
        wasInterrupted: t.was_interrupted === 1,
        overlayDismissed: t.overlay_dismissed === 1,
        notes: t.notes || '',
        taskPlan: normalizeTaskPlan(t.task_plan),
        tabType: t.tab_type || 'terminal',
        url: t.url || undefined,
        filePath: t.file_path || undefined,
        terminalId: t.terminal_id || undefined,
        terminalName: t.terminal_name || undefined,
        activeView: t.active_view || undefined,
        createdAt: t.created_at || undefined,
        isCollapsed: t.is_collapsed === 1,
        groupId: t.tab_group_id || undefined,
        visualParentTabId: t.visual_parent_tab_id || undefined,
        tabId: t.tab_id || undefined,
        sessionStatus: t.session_status || undefined,
        completionNotificationPersistent: t.completion_notification_persistent === 1 || undefined,
        restartAfterTabId: t.restart_after_tab_id || undefined,
        restartAfterTabIds: (() => {
          if (!t.restart_after_tab_ids) return undefined;
          try {
            const parsed = JSON.parse(t.restart_after_tab_ids);
            return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.trim()) : undefined;
          } catch {
            return undefined;
          }
        })(),
        restartAfterCommand: t.restart_after_command || undefined,
        restartAfterPaused: t.restart_after_paused === 1 || undefined,
        restartAfterArmed: t.restart_after_armed === 1 || undefined,
        restartAfterPersistent: t.restart_after_persistent === 1 || undefined,
        contextPct: (t.context_pct ?? undefined),
        cacheStats: (() => {
          if (!t.cache_stats) return undefined;
          try { return JSON.parse(t.cache_stats); }
          catch { return undefined; }
        })(),
        providerState: (() => {
          if (!t.provider_state) return undefined;
          try { return JSON.parse(t.provider_state); }
          catch { return undefined; }
        })()
      }))
    };
  }

  // OSC 7 proof is resolved in main, so persist the accepted value point-wise
  // before acknowledging it to renderer. A full renderer save still follows,
  // but this closes the crash window between live-process proof and SQLite.
  updateTabCwd(tabId, cwd) {
    if (!tabId || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
    const info = this.db.prepare('UPDATE tabs SET cwd = ? WHERE tab_id = ?').run(cwd, tabId);
    return info.changes > 0;
  }

  // Point-wise context% write (no renderer round-trip, no full-reinsert).
  // Called many times across a session as the bridge / SDK reports new fill;
  // single-column UPDATE keeps it cheap. NULL-guard: only writes a real number.
  updateTabContextPct(tabId, pct) {
    if (!tabId || typeof pct !== 'number' || !isFinite(pct)) return;
    try {
      this.db.prepare('UPDATE tabs SET context_pct = ? WHERE tab_id = ?').run(pct, tabId);
    } catch (e) {
      console.error('[DB] updateTabContextPct error:', e.message);
    }
  }

  // Read one tab's last-known context%. Used by the control-bar to seed the
  // meter on mount, so a tab with no live process still shows its last fill.
  getTabContextPct(tabId) {
    if (!tabId) return null;
    try {
      const row = this.db.prepare('SELECT context_pct FROM tabs WHERE tab_id = ?').get(tabId);
      return row && row.context_pct != null ? row.context_pct : null;
    } catch (e) {
      console.error('[DB] getTabContextPct error:', e.message);
      return null;
    }
  }

  // Point-wise cache-stats write for the control-bar cooldown chip. Stores the
  // {cacheRead,cacheCreate,input,ts} JSON for one tab. Called once per turn
  // (message_start), so a single-row UPDATE is cheap. NULL-guard: skip non-objects.
  updateTabCacheStats(tabId, stats) {
    if (!tabId || !stats || typeof stats !== 'object') return;
    try {
      this.db.prepare('UPDATE tabs SET cache_stats = ? WHERE tab_id = ?').run(JSON.stringify(stats), tabId);
    } catch (e) {
      console.error('[DB] updateTabCacheStats error:', e.message);
    }
  }

  // Read one tab's last-known cache split. Used by the control-bar to seed the
  // cooldown chip on mount so it survives tab switches / restart.
  getTabCacheStats(tabId) {
    if (!tabId) return null;
    try {
      const row = this.db.prepare('SELECT cache_stats FROM tabs WHERE tab_id = ?').get(tabId);
      if (!row || row.cache_stats == null) return null;
      try { return JSON.parse(row.cache_stats); } catch { return null; }
    } catch (e) {
      console.error('[DB] getTabCacheStats error:', e.message);
      return null;
    }
  }

  getTabTaskPlan(tabId) {
    if (!tabId) return emptyTaskPlan();
    const row = this.db.prepare('SELECT task_plan FROM tabs WHERE tab_id = ? LIMIT 1').get(tabId);
    return normalizeTaskPlan(row?.task_plan);
  }

  setTabTaskPlan(tabId, rawDocument) {
    if (!tabId) throw new Error('tab_id_required');
    const document = normalizeTaskPlan(rawDocument);
    const info = this.db.prepare('UPDATE tabs SET task_plan = ? WHERE tab_id = ?')
      .run(JSON.stringify(document), tabId);
    if (info.changes === 0) throw new Error('tab_not_found');
    return document;
  }

  applyTabTaskPlanOperations(tabId, operations, source = 'unknown') {
    const current = this.getTabTaskPlan(tabId);
    const result = applyTaskPlanOperations(current, operations, source);
    if (result.changed) this.setTabTaskPlan(tabId, result.document);
    return result;
  }

  undoTabTaskPlan(tabId, source = 'user') {
    const result = undoTaskPlan(this.getTabTaskPlan(tabId), source);
    if (result.changed) this.setTabTaskPlan(tabId, result.document);
    return result;
  }

  redoTabTaskPlan(tabId, source = 'user') {
    const result = redoTaskPlan(this.getTabTaskPlan(tabId), source);
    if (result.changed) this.setTabTaskPlan(tabId, result.document);
    return result;
  }

  // Direct one-tab update used by main.js's provider:switch / provider:set-options
  // handlers — avoids renderer round-trip (renderer would have to receive
  // broadcast → mutate tab → saveTabs ALL tabs of the project). state==null
  // resets to default; pass `null` to clear.
  updateTabProviderState(tabId, state) {
    if (!tabId) return;
    try {
      const json = state ? JSON.stringify(state) : null;
      this.db.prepare('UPDATE tabs SET provider_state = ? WHERE tab_id = ?').run(json, tabId);
    } catch (e) {
      console.error('[DB] updateTabProviderState error:', e.message);
    }
  }

  // Read every tab's persisted providerState across all projects. Called once
  // at app startup so main can hydrate `providerStates` Map before any Claude
  // process spawns and asks proxy what provider to route to.
  getAllTabProviderStates() {
    try {
      return this.db.prepare(
        `SELECT tab_id, provider_state FROM tabs WHERE provider_state IS NOT NULL AND tab_id IS NOT NULL`
      ).all();
    } catch (e) {
      console.error('[DB] getAllTabProviderStates error:', e.message);
      return [];
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
    const { name, description, geminiPrompt, path: newPath, icon } = metadata;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (geminiPrompt !== undefined) { updates.push('gemini_prompt = ?'); params.push(geminiPrompt); }
    if (newPath !== undefined) { updates.push('path = ?'); params.push(newPath); }
    if (icon !== undefined) { updates.push('icon = ?'); params.push(icon || null); }

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

  updateProjectSidebarExpandedDirs(projectId, expandedDirs) {
    const json = expandedDirs ? JSON.stringify(expandedDirs) : null;
    this.db.prepare('UPDATE projects SET sidebar_expanded_dirs = ? WHERE id = ?').run(json, projectId);
  }

  updateProjectSidebarScrollTop(projectId, scrollTop) {
    const normalized = Number.isFinite(Number(scrollTop)) ? Math.max(0, Number(scrollTop)) : 0;
    this.db.prepare('UPDATE projects SET sidebar_scroll_top = ? WHERE id = ?').run(normalized, projectId);
  }

  updateProjectTabGroups(projectId, groups) {
    const json = Array.isArray(groups) && groups.length > 0 ? JSON.stringify(groups) : null;
    this.db.prepare('UPDATE projects SET tab_groups = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(json, projectId);
  }

  deleteProject(projectId) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    return true;
  }

  // ========== TABS ========== 

  saveTabs(projectId, tabs, forceCleanup = false, preserveInterrupted = false) {
    // Check if project exists to avoid FOREIGN KEY constraint error
    const projectExists = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!projectExists) {
      console.warn('[DB] saveTabs: project not found, skipping:', projectId);
      return;
    }

    // Safety: count existing tabs to detect accidental mass deletion
    const existingCount = this.db.prepare('SELECT COUNT(*) as cnt FROM tabs WHERE project_id = ?').get(projectId)?.cnt || 0;
    const newCount = tabs.length;
    const newTabIds = tabs.map(t => t.tabId).filter(Boolean);

    if (existingCount > 0 && newCount < existingCount - 2) {
      const existingRows = this.db.prepare('SELECT tab_id, name, command_type, tab_type FROM tabs WHERE project_id = ? ORDER BY position, tab_id').all(projectId);
      const incomingSet = new Set(newTabIds);
      const summarizeRows = (rows) => rows.slice(0, 20).map((row) => {
        const id = String(row.tab_id || row.tabId || '').slice(-12);
        const name = String(row.name || '').replace(/\s+/g, ' ').slice(0, 24);
        const type = row.tab_type || row.tabType || 'terminal';
        const command = row.command_type || row.commandType || 'generic';
        return id + ':' + name + ':' + type + ':' + command;
      }).join(',') + (rows.length > 20 ? ',+' + (rows.length - 20) : '');
      const dbOnlyRows = existingRows.filter((row) => row.tab_id && !incomingSet.has(row.tab_id));
      console.warn(
        '[DB] saveTabs: WARNING — saving ' + newCount +
        ' tabs but DB has ' + existingCount +
        '. Project: ' + projectId +
        ' forceCleanup=' + forceCleanup +
        ' incoming=' + summarizeRows(tabs) +
        ' dbOnly=' + summarizeRows(dbOnlyRows)
      );
    }

    // Shutdown guard (never-downgrade): saveTabs does a full delete+reinsert,
    // writing was_interrupted from the renderer's in-memory tab, which is always
    // `false` during normal operation. During app shutdown the before-quit
    // handler marks was_interrupted=1 FIRST (so a stalled proxy-drain / pkill
    // can't lose it), but the renderer stays alive through the up-to-20s drain
    // and any background saveTabs (e.g. a bridge session-detected firing
    // setClaudeSessionId on cwd-drift) would reinsert every row with
    // was_interrupted=0 → clobber the mark → AutoResume "No interrupted tabs"
    // on next launch. With preserveInterrupted we snapshot the on-disk flag
    // BEFORE the delete and OR it into the reinsert: a 1 never drops to 0,
    // every other field saves normally. See fix-interrupted-session-lifecycle.md.
    let interruptedSnapshot = null;
    if (preserveInterrupted) {
      interruptedSnapshot = new Map();
      const rows = this.db.prepare('SELECT tab_id, was_interrupted FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) interruptedSnapshot.set(r.tab_id, r.was_interrupted === 1);
    }

    // Snapshot context_pct BEFORE the delete+reinsert. The renderer's saveTabs
    // payload does NOT carry contextPct (it's written point-wise via
    // updateTabContextPct), so a full reinsert triggered by an unrelated change
    // (rename, colour, notes) would otherwise reset the column to NULL and wipe
    // the last-known meter value. We re-apply the snapshot when the incoming tab
    // carries no contextPct of its own. Same never-downgrade idea as interrupted.
    const contextPctSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, context_pct FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) contextPctSnapshot.set(r.tab_id, r.context_pct);
    }

    // Same snapshot-preserve as context_pct: the renderer's saveTabs payload does
    // not carry cacheStats (written point-wise via updateTabCacheStats), so a full
    // reinsert from an unrelated change must not wipe the cooldown chip's data.
    const cacheStatsSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, cache_stats FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) cacheStatsSnapshot.set(r.tab_id, r.cache_stats);
    }

    // Task-plan writes can arrive directly from Terminal MCP while the renderer
    // still holds an older tab snapshot. Keep the document with the highest
    // revision so an unrelated rename/save cannot roll an MCP edit back.
    const taskPlanSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, task_plan FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) taskPlanSnapshot.set(r.tab_id, r.task_plan);
    }

    const deleteByTabId = this.db.prepare('DELETE FROM tabs WHERE project_id = ? AND tab_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO tabs (project_id, name, name_set_manually, cwd, position, color, is_utility, command_type, claude_session_id, gemini_session_id, codex_session_id, codex_model, codex_effort, external_run, was_interrupted, overlay_dismissed, notes, task_plan, tab_type, url, file_path, terminal_id, terminal_name, active_view, created_at, is_collapsed, tab_group_id, visual_parent_tab_id, tab_id, session_status, completion_notification_persistent, restart_after_tab_id, restart_after_tab_ids, restart_after_command, restart_after_paused, restart_after_armed, restart_after_persistent, claude_session_history, provider_state, context_pct, cache_stats)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        const historyJson = (tab.claudeSessionHistory && tab.claudeSessionHistory.length > 0)
          ? JSON.stringify(tab.claudeSessionHistory)
          : null;
        // providerState: serialize only if non-default (anthropic, no model/effort/thinking).
        // Default state == NULL — saves space and aligns with "fresh tab" semantics.
        const providerStateJson = tab.providerState && (
          tab.providerState.type !== 'anthropic' ||
          tab.providerState.model ||
          tab.providerState.effort ||
          tab.providerState.thinking
        ) ? JSON.stringify(tab.providerState) : null;
        const externalRunJson = tab.externalRun && typeof tab.externalRun === 'object'
          ? JSON.stringify(tab.externalRun)
          : null;
        // never-downgrade: if shutdown already marked this tab interrupted on
        // disk, keep it 1 even though the in-memory tab carries false.
        const interruptedFlag = (interruptedSnapshot && interruptedSnapshot.get(tab.tabId))
          ? 1
          : (tab.wasInterrupted ? 1 : 0);
        // context_pct: prefer an incoming value (rare — payload usually omits it),
        // else re-apply the pre-delete snapshot so a full-reinsert never wipes it.
        const ctxPct = (typeof tab.contextPct === 'number' && isFinite(tab.contextPct))
          ? tab.contextPct
          : (contextPctSnapshot.has(tab.tabId) ? contextPctSnapshot.get(tab.tabId) : null);
        // cache_stats: prefer an incoming object (rare — payload omits it), else
        // re-apply the pre-delete snapshot (already a JSON string or null) so a
        // full reinsert never wipes the cooldown chip's last-known split.
        const cacheStatsJson = (tab.cacheStats && typeof tab.cacheStats === 'object')
          ? JSON.stringify(tab.cacheStats)
          : (cacheStatsSnapshot.has(tab.tabId) ? cacheStatsSnapshot.get(tab.tabId) : null);
        const restartAfterIds = Array.isArray(tab.restartAfterTabIds)
          ? Array.from(new Set(tab.restartAfterTabIds.filter((id) => typeof id === 'string' && id.trim())))
          : (tab.restartAfterTabId ? [tab.restartAfterTabId] : []);
        const restartAfterIdsJson = restartAfterIds.length > 0 ? JSON.stringify(restartAfterIds) : null;
        const taskPlanDocument = chooseNewestTaskPlan(tab.taskPlan, taskPlanSnapshot.get(tab.tabId));
        const taskPlanJson = taskPlanDocument.revision > 0
          || taskPlanDocument.items.length > 0
          || taskPlanDocument.history.past.length > 0
          || taskPlanDocument.history.future.length > 0
          ? JSON.stringify(taskPlanDocument)
          : null;
        insert.run(projectId, tab.name, tab.nameSetManually ? 1 : 0, tab.cwd, index, tab.color || null, tab.isUtility ? 1 : 0, tab.commandType || null, tab.claudeSessionId || null, tab.geminiSessionId || null, tab.codexSessionId || null, tab.codexModel || null, tab.codexEffort || null, externalRunJson, interruptedFlag, tab.overlayDismissed ? 1 : 0, tab.notes || '', taskPlanJson, tab.tabType || 'terminal', tab.url || null, tab.filePath || null, tab.terminalId || null, tab.terminalName || null, tab.activeView || null, tab.createdAt || null, tab.isCollapsed ? 1 : 0, tab.groupId || null, tab.visualParentTabId || null, tab.tabId || null, tab.sessionStatus || null, tab.completionNotificationPersistent ? 1 : 0, restartAfterIds[0] || null, restartAfterIdsJson, tab.restartAfterCommand || null, tab.restartAfterPaused ? 1 : 0, tab.restartAfterArmed ? 1 : 0, tab.restartAfterPersistent ? 1 : 0, historyJson, providerStateJson, ctxPct, cacheStatsJson);
      });

      // Step 4: Clean up tabs that exist in DB but NOT in the new set
      // Safety: only do this if tab count is stable (not losing more than 2 tabs)
      // forceCleanup bypasses the guard for intentional batch operations (moveTabsToProject, batch close)
      if (newTabIds.length === 0) {
        if (newCount === 0 && forceCleanup) {
          this.db.prepare('DELETE FROM tabs WHERE project_id = ?').run(projectId);
        } else if (existingCount > 0) {
          console.error('[DB] saveTabs: SKIPPING empty cleanup — empty tab set without forceCleanup for project ' + projectId);
        }
      } else if (forceCleanup || newCount >= existingCount - 2) {
        const placeholders = newTabIds.map(() => '?').join(',');
        this.db.prepare('DELETE FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL AND tab_id NOT IN (' + placeholders + ')').run(projectId, ...newTabIds);
      } else if (newCount < existingCount - 2) {
        console.error('[DB] saveTabs: SKIPPING cleanup — new set (' + newCount + ') is much smaller than DB (' + existingCount + '). Orphan tabs preserved to prevent data loss.');
      }
    });
    transaction(tabs);
    this.db.prepare('UPDATE projects SET updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(projectId);
  }

  // ========== TAB HISTORY (CLOSED TABS ARCHIVE) ==========

  archiveTab(projectId, tab) {
    const tabType = tab?.tabType || tab?.tab_type || 'terminal';
    if (tabType === 'file') {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const info = this.db.prepare(`
      INSERT INTO tab_history (project_id, name, name_set_manually, cwd, color, notes, task_plan, command_type, tab_type, url, file_path, created_at, closed_at, claude_session_id, gemini_session_id, codex_session_id, codex_model, codex_effort, message_count, position, process_was_running, session_status, group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      tab.name,
      tab.nameSetManually ? 1 : 0,
      tab.cwd,
      tab.color || null,
      tab.notes || null,
      tab.taskPlan ? JSON.stringify(normalizeTaskPlan(tab.taskPlan)) : null,
      tab.commandType || null,
      tabType,
      tab.url || null,
      tab.filePath || null,
      tab.createdAt || now,
      now,
      tab.claudeSessionId || null,
      tab.geminiSessionId || null,
      tab.codexSessionId || null,
      tab.codexModel || null,
      tab.codexEffort || null,
      tab.messageCount ?? null,
      tab.position ?? null,
      tab.processWasRunning ? 1 : 0,
      tab.sessionStatus || null,
      tab.groupId || null
    );
    return info.lastInsertRowid;
  }

  // Read the most recent restorable history entry without consuming it.
  // Restore is a two-phase operation: the caller must create the replacement
  // tab first and delete this row only after creation succeeds.
  getLatestTabHistory(projectId) {
    return this.db.prepare(
      "SELECT * FROM tab_history WHERE project_id = ? AND (tab_type IS NULL OR tab_type != 'file') ORDER BY closed_at DESC, id DESC LIMIT 1"
    ).get(projectId);
  }

  getTabHistoryEntry(id, projectId) {
    return this.db.prepare(
      "SELECT * FROM tab_history WHERE id = ? AND project_id = ? AND (tab_type IS NULL OR tab_type != 'file') LIMIT 1"
    ).get(id, projectId);
  }

  getTabHistory(projectId, limit = 0) {
    if (limit && limit > 0) {
      return this.db.prepare(
        "SELECT * FROM tab_history WHERE project_id = ? AND (tab_type IS NULL OR tab_type != 'file') ORDER BY closed_at DESC, id DESC LIMIT ?"
      ).all(projectId, limit);
    }
    return this.db.prepare(
      "SELECT * FROM tab_history WHERE project_id = ? AND (tab_type IS NULL OR tab_type != 'file') ORDER BY closed_at DESC, id DESC"
    ).all(projectId);
  }

  getTabHistoryCount(projectId) {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM tab_history WHERE project_id = ? AND (tab_type IS NULL OR tab_type != 'file')"
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
    const info = this.db.prepare('DELETE FROM tab_history WHERE id = ?').run(id);
    return info.changes > 0;
  }

  updateTabHistoryTitle(id, name, nameSetManually = true) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return false;
    const info = this.db.prepare(
      'UPDATE tab_history SET name = ?, name_set_manually = ? WHERE id = ?'
    ).run(cleanName, nameSetManually ? 1 : 0, id);

    // Title embeddings are keyed to the old name. Invalidate this row so the
    // ProjectHome index button can rebuild a matching embedding later.
    try {
      this.db.prepare('DELETE FROM tab_history_title_index WHERE history_id = ?').run(id);
    } catch (_) {}

    return info.changes > 0;
  }

  // ========== FAVORITES ==========

  addFavorite(projectId, tab) {
    this.db.prepare(`
      INSERT INTO favorites (project_id, name, cwd, color, notes, command_type, tab_type, url, claude_session_id, gemini_session_id, codex_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      tab.geminiSessionId || null,
      tab.codexSessionId || null
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

  getPrompts() {
    return this.db.prepare('SELECT * FROM prompts ORDER BY group_id NULLS LAST, position').all().map(row => ({
      ...row,
      id: row.stable_id || `prompt-${row.id}`,
      file_paths: row.file_paths ? JSON.parse(row.file_paths) : []
    }));
  }
  savePrompts(prompts) {
    if (!Array.isArray(prompts)) return;
    const existingCount = this.db.prepare('SELECT COUNT(*) as cnt FROM prompts').get()?.cnt || 0;
    if (prompts.length === 0 && existingCount > 0) {
      console.warn('[DB] savePrompts: refusing to delete ' + existingCount + ' prompts with empty array');
      return;
    }
    const transaction = this.db.transaction((list) => {
      this.db.prepare('DELETE FROM prompts').run();
      const stableIds = new Set(list.map(p => String(p.id || '')).filter(Boolean));
      const byStableId = new Map(list.map(p => [String(p.id || ''), p]));
      const insert = this.db.prepare('INSERT INTO prompts (stable_id, title, content, position, group_id, file_paths, visual_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      list.forEach((p, index) => insert.run(
        p.id || `prompt-${Date.now().toString(36)}-${index}`,
        p.title,
        p.content,
        p.position != null ? p.position : index,
        p.group_id ?? null,
        p.file_paths && p.file_paths.length > 0 ? JSON.stringify(p.file_paths) : null,
        p.visual_parent_id && stableIds.has(String(p.visual_parent_id))
          && (byStableId.get(String(p.visual_parent_id))?.group_id ?? null) === (p.group_id ?? null)
          ? String(p.visual_parent_id)
          : null
      ));
    });
    transaction(prompts);
  }

  createDefaultPrompts() {
    if (this.db.prepare('SELECT COUNT(*) as count FROM prompts').get().count > 0) return;
    this.savePrompts([{ title: 'Fix Error', content: 'Analyze this error:' }, { title: 'Explain', content: 'Explain this:' }, { title: 'Optimize', content: 'Optimize this:' }]);
  }

  // ========== PROMPT GROUPS ==========

  getPromptGroups() {
    return this.db.prepare('SELECT * FROM prompt_groups ORDER BY position').all().map(row => ({
      id: row.id, name: row.name, position: row.position,
      description: row.description || '',
      is_collapsed: row.is_collapsed === 1
    }));
  }
  savePromptGroups(groups) {
    if (!Array.isArray(groups)) return;
    const transaction = this.db.transaction((list) => {
      this.db.prepare('DELETE FROM prompt_groups').run();
      const insert = this.db.prepare('INSERT INTO prompt_groups (id, name, position, description, is_collapsed) VALUES (?, ?, ?, ?, ?)');
      list.forEach((g, index) => insert.run(g.id, g.name, g.position != null ? g.position : index, g.description || '', g.is_collapsed ? 1 : 0));
    });
    transaction(groups);
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
      position: row.position,
      filePaths: row.file_paths ? JSON.parse(row.file_paths) : []
    }));
  }

  saveAIPrompt(prompt) {
    this.db.prepare(`
      INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position, file_paths)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        content = excluded.content,
        model = excluded.model,
        thinking_level = excluded.thinking_level,
        color = excluded.color,
        show_in_context_menu = excluded.show_in_context_menu,
        position = excluded.position,
        file_paths = excluded.file_paths
    `).run(
      prompt.id,
      prompt.name,
      prompt.content,
      prompt.model || 'gemini-3-flash-preview',
      prompt.thinkingLevel || 'HIGH',
      prompt.color || '#0ea5e9',
      prompt.isBuiltIn ? 1 : 0,
      prompt.showInContextMenu !== false ? 1 : 0,
      prompt.position ?? 0,
      prompt.filePaths && prompt.filePaths.length > 0 ? JSON.stringify(prompt.filePaths) : null
    );
  }

  deleteAIPrompt(id) {
    // Only delete non-built-in prompts
    this.db.prepare('DELETE FROM ai_prompts WHERE id = ? AND is_built_in = 0').run(id);
  }

  getTimelinePromptSummaries(toolType, sessionId) {
    if (!toolType || !sessionId) return [];
    return this.db.prepare(`
      SELECT * FROM timeline_prompt_summaries
      WHERE tool_type = ? AND session_id = ?
      ORDER BY updated_at DESC
    `).all(toolType, sessionId).map(row => ({
      toolType: row.tool_type,
      sessionId: row.session_id,
      entryUuid: row.entry_uuid,
      summary: row.summary,
      sourceHash: row.source_hash,
      model: row.model,
      promptId: row.prompt_id,
      thinkingLevel: row.thinking_level,
      promptTokens: row.prompt_tokens || 0,
      candidateTokens: row.candidate_tokens || 0,
      thoughtTokens: row.thought_tokens || 0,
      totalTokens: row.total_tokens || 0,
      updatedAt: row.updated_at || 0,
    }));
  }

  saveTimelinePromptSummary(summary) {
    if (!summary || !summary.toolType || !summary.sessionId || !summary.entryUuid || !summary.summary) {
      return false;
    }
    this.db.prepare(`
      INSERT INTO timeline_prompt_summaries (
        tool_type, session_id, entry_uuid, summary, source_hash, model, prompt_id, thinking_level,
        prompt_tokens, candidate_tokens, thought_tokens, total_tokens, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(tool_type, session_id, entry_uuid) DO UPDATE SET
        summary = excluded.summary,
        source_hash = excluded.source_hash,
        model = excluded.model,
        prompt_id = excluded.prompt_id,
        thinking_level = excluded.thinking_level,
        prompt_tokens = excluded.prompt_tokens,
        candidate_tokens = excluded.candidate_tokens,
        thought_tokens = excluded.thought_tokens,
        total_tokens = excluded.total_tokens,
        updated_at = strftime('%s', 'now')
    `).run(
      summary.toolType,
      summary.sessionId,
      summary.entryUuid,
      summary.summary,
      summary.sourceHash || null,
      summary.model || null,
      summary.promptId || null,
      summary.thinkingLevel || null,
      Number(summary.promptTokens || 0),
      Number(summary.candidateTokens || 0),
      Number(summary.thoughtTokens || 0),
      Number(summary.totalTokens || 0)
    );
    return true;
  }

  getTimelineOutline(toolType, sessionId) {
    if (!toolType || !sessionId) return null;
    const row = this.db.prepare(`
      SELECT * FROM timeline_outlines
      WHERE tool_type = ? AND session_id = ?
      LIMIT 1
    `).get(toolType, sessionId);
    if (!row) return null;
    try {
      return {
        toolType: row.tool_type,
        sessionId: row.session_id,
        schemaVersion: Number(row.schema_version || 1),
        sourceHash: row.source_hash,
        sourceUuids: JSON.parse(row.source_uuids_json || '[]'),
        sourceEntryCount: Number(row.source_entry_count || 0),
        sourceLastUuid: row.source_last_uuid || null,
        outline: JSON.parse(row.outline_json),
        model: row.model || null,
        promptId: row.prompt_id || null,
        thinkingLevel: row.thinking_level || null,
        promptTokens: Number(row.prompt_tokens || 0),
        candidateTokens: Number(row.candidate_tokens || 0),
        thoughtTokens: Number(row.thought_tokens || 0),
        totalTokens: Number(row.total_tokens || 0),
        sourceChars: Number(row.source_chars || 0),
        updatedAt: Number(row.updated_at || 0),
      };
    } catch (error) {
      console.warn('[DB] Ignoring malformed Timeline outline:', error?.message || String(error));
      return null;
    }
  }

  saveTimelineOutline(row) {
    if (!row?.toolType || !row?.sessionId || !row?.sourceHash || !row?.outline) return false;
    const sourceUuids = Array.isArray(row.sourceUuids) ? row.sourceUuids.map(String) : [];
    this.db.prepare(`
      INSERT INTO timeline_outlines (
        tool_type, session_id, schema_version, source_hash, source_uuids_json,
        source_entry_count, source_last_uuid, outline_json, model, prompt_id,
        thinking_level, prompt_tokens, candidate_tokens, thought_tokens,
        total_tokens, source_chars, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(tool_type, session_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        source_hash = excluded.source_hash,
        source_uuids_json = excluded.source_uuids_json,
        source_entry_count = excluded.source_entry_count,
        source_last_uuid = excluded.source_last_uuid,
        outline_json = excluded.outline_json,
        model = excluded.model,
        prompt_id = excluded.prompt_id,
        thinking_level = excluded.thinking_level,
        prompt_tokens = excluded.prompt_tokens,
        candidate_tokens = excluded.candidate_tokens,
        thought_tokens = excluded.thought_tokens,
        total_tokens = excluded.total_tokens,
        source_chars = excluded.source_chars,
        updated_at = strftime('%s', 'now')
    `).run(
      row.toolType,
      row.sessionId,
      Number(row.schemaVersion || 1),
      row.sourceHash,
      JSON.stringify(sourceUuids),
      Number(row.sourceEntryCount ?? sourceUuids.length),
      row.sourceLastUuid || sourceUuids[sourceUuids.length - 1] || null,
      JSON.stringify(row.outline),
      row.model || null,
      row.promptId || null,
      row.thinkingLevel || null,
      Number(row.promptTokens || row.countedInputTokens || 0),
      Number(row.candidateTokens || 0),
      Number(row.thoughtTokens || 0),
      Number(row.totalTokens || 0),
      Number(row.sourceChars || 0)
    );
    return true;
  }

  getTimelineTurnActionOverrides(toolType, sessionId) {
    if (!toolType || !sessionId) return [];
    return this.db.prepare(`
      SELECT * FROM timeline_turn_action_overrides
      WHERE tool_type = ? AND session_id = ?
      ORDER BY updated_at DESC
    `).all(toolType, sessionId).map(row => ({
      toolType: row.tool_type,
      sessionId: row.session_id,
      entryUuid: row.entry_uuid,
      actionLabel: row.action_label,
      sourceHash: row.source_hash || null,
      model: row.model || null,
      promptId: row.prompt_id || null,
      thinkingLevel: row.thinking_level || null,
      updatedAt: Number(row.updated_at || 0),
    }));
  }

  saveTimelineTurnActionOverride(override) {
    if (!override?.toolType || !override?.sessionId || !override?.entryUuid || !override?.actionLabel) {
      return false;
    }
    this.db.prepare(`
      INSERT INTO timeline_turn_action_overrides (
        tool_type, session_id, entry_uuid, action_label, source_hash,
        model, prompt_id, thinking_level, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(tool_type, session_id, entry_uuid) DO UPDATE SET
        action_label = excluded.action_label,
        source_hash = excluded.source_hash,
        model = excluded.model,
        prompt_id = excluded.prompt_id,
        thinking_level = excluded.thinking_level,
        updated_at = strftime('%s', 'now')
    `).run(
      override.toolType,
      override.sessionId,
      override.entryUuid,
      override.actionLabel,
      override.sourceHash || null,
      override.model || null,
      override.promptId || null,
      override.thinkingLevel || null
    );
    return true;
  }

  logAIPromptCall(call) {
    if (!call) return false;
    this.db.prepare(`
      INSERT INTO ai_prompt_call_logs (
        prompt_id, task_type, model, thinking_level, prompt_tokens, candidate_tokens,
        thought_tokens, total_tokens, status, error, source_chars, output_chars,
        project_id, project_name, project_path, tab_id, tab_name, tool_type,
        session_id, entry_uuid, iteration_index
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.promptId || null,
      call.taskType || null,
      call.model || null,
      call.thinkingLevel || null,
      Number(call.promptTokens || 0),
      Number(call.candidateTokens || 0),
      Number(call.thoughtTokens || 0),
      Number(call.totalTokens || 0),
      call.status || 'success',
      call.error || null,
      Number(call.sourceChars || 0),
      Number(call.outputChars || 0),
      call.projectId || null,
      call.projectName || null,
      call.projectPath || null,
      call.tabId || null,
      call.tabName || null,
      call.toolType || null,
      call.sessionId || null,
      call.entryUuid || null,
      Number.isFinite(Number(call.iterationIndex)) ? Number(call.iterationIndex) : null
    );
    return true;
  }

  getAIPromptUsageStats(range = 'week') {
    const now = Math.floor(Date.now() / 1000);
    const since = range === 'all' ? 0 : now - (range === 'month' ? 30 : 7) * 24 * 60 * 60;
    const rows = this.db.prepare(`
      SELECT l.*, p.name AS prompt_name
      FROM ai_prompt_call_logs l
      LEFT JOIN ai_prompts p ON p.id = l.prompt_id
      WHERE (? = 0 OR l.created_at >= ?)
      ORDER BY l.created_at DESC
    `).all(since, since);

    const totals = {
      calls: rows.length,
      promptTokens: 0,
      candidateTokens: 0,
      thoughtTokens: 0,
      totalTokens: 0,
      errors: 0,
    };
    const byModel = new Map();
    const byPrompt = new Map();
    const bump = (map, key, row) => {
      const id = key || 'unknown';
      const cur = map.get(id) || {
        id,
        calls: 0,
        promptTokens: 0,
        candidateTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
        errors: 0,
      };
      cur.calls += 1;
      cur.promptTokens += row.prompt_tokens || 0;
      cur.candidateTokens += row.candidate_tokens || 0;
      cur.thoughtTokens += row.thought_tokens || 0;
      cur.totalTokens += row.total_tokens || 0;
      if (row.status === 'error') cur.errors += 1;
      map.set(id, cur);
    };

    for (const row of rows) {
      totals.promptTokens += row.prompt_tokens || 0;
      totals.candidateTokens += row.candidate_tokens || 0;
      totals.thoughtTokens += row.thought_tokens || 0;
      totals.totalTokens += row.total_tokens || 0;
      if (row.status === 'error') totals.errors += 1;
      bump(byModel, row.model, row);
      if (row.prompt_id) {
        const promptKey = row.prompt_id;
        const before = byPrompt.get(promptKey);
        bump(byPrompt, promptKey, row);
        const after = byPrompt.get(promptKey);
        if (!before && after) after.name = row.prompt_name || promptKey;
      }
    }

    return {
      range,
      since,
      totals,
      byModel: Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens),
      byPrompt: Array.from(byPrompt.values()).sort((a, b) => b.totalTokens - a.totalTokens),
      history: rows.slice(0, 500).map(row => ({
        id: row.id,
        promptId: row.prompt_id,
        promptName: row.prompt_name,
        taskType: row.task_type,
        model: row.model,
        thinkingLevel: row.thinking_level,
        promptTokens: row.prompt_tokens || 0,
        candidateTokens: row.candidate_tokens || 0,
        thoughtTokens: row.thought_tokens || 0,
        totalTokens: row.total_tokens || 0,
        status: row.status || 'success',
        error: row.error,
        sourceChars: row.source_chars || 0,
        outputChars: row.output_chars || 0,
        projectId: row.project_id || null,
        projectName: row.project_name || null,
        projectPath: row.project_path || null,
        tabId: row.tab_id || null,
        tabName: row.tab_name || null,
        toolType: row.tool_type || null,
        sessionId: row.session_id || null,
        entryUuid: row.entry_uuid || null,
        iterationIndex: row.iteration_index || null,
        createdAt: row.created_at || 0,
      })),
    };
  }

  seedDefaultAIPrompts() {
    if (this.db.prepare('SELECT COUNT(*) as count FROM ai_prompts').get().count > 0) return;

    const defaults = [
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
      },
      {
        id: 'tab-title',
        name: 'Tab Title',
        content: 'На основе первого пользовательского сообщения придумай короткое название вкладки. Верни только название: 2-6 слов, без кавычек, без точки, без markdown, без пояснений.',
        model: 'gemini-3-flash-preview',
        thinking_level: 'NONE',
        color: '#22c55e',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 5
      },
      {
        id: 'run-after-title',
        name: 'Run After Title',
        content: 'На основе текста задачи Run after придумай короткое название задачи. Верни только название: 2-7 слов, без кавычек, без точки, без markdown, без пояснений. Если текст на русском — название тоже на русском; если на английском — на английском.',
        model: 'gemini-3.1-flash-lite',
        thinking_level: 'NONE',
        color: '#DA7756',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 6
      },
      {
        id: 'prompt-summary',
        name: 'Prompt Summary',
        content: 'Кратко передай смысл пользовательского сообщения для таймлайна, до 70 символов. Верни только пересказ: без кавычек, точки в конце и пояснений. Сохрани язык исходного сообщения. Формулируй действие или вопрос прямо; не добавляй слова «запрос», «просьба» или «диалог», если без них смысл ясен. Ровно один непрерывный смысловой акцент оберни одной парой одинарных звездочек; внутри может быть одно или несколько соседних слов. Вторую пару звездочек не используй. Примеры: проверить *конфликт инструментов с WebODM*; что такое *мультиселектор*. Не выделяй всю строку и не используй другой markdown.',
        model: 'gemini-3.1-flash-lite',
        thinking_level: 'NONE',
        color: '#38bdf8',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 7
      },
      {
        id: 'timeline-grouping',
        name: 'Timeline Grouping',
        content: 'Group a chronological list of user turns into a compact semantic outline.\nA group is one concrete work phase with at least two contiguous turns.\nKeep the hierarchy flat, preserve chronological order, and leave uncertain or isolated turns ungrouped.\nNever cross an item marked boundaryBefore.\nUse short titles and descriptions in the predominant language of the supplied turns.\nMeta-prompt markers describe workflow actions; do not infer their omitted template body.',
        model: 'gemini-3.1-flash-lite',
        thinking_level: 'LOW',
        color: '#c084fc',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 8
      },
      {
        id: 'git-commit',
        name: 'Git Commit',
        content: 'You write concise Git commit messages for local commits.\nReturn only JSON with keys "summary" and "description".\n\nRules:\n- The summary must be one line, imperative mood when possible, no trailing period, under 72 characters.\n- The description may be empty. If non-empty, use 1-4 short lines with concrete facts.\n- Do not mention files that are not present in the provided changes.\n- If docs/ changed, base the commit message on changed docs files only when the prompt data says docs-only context was applied.\n- If docs/ did not change, use all included changes.',
        model: 'gemini-3.1-flash-lite',
        thinking_level: 'NONE',
        color: '#facc15',
        is_built_in: 1,
        show_in_context_menu: 0,
        position: 9
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

  // Ensure built-in prompt for automatic tab naming exists (migration for existing DBs).
  // Content is intentionally user-editable in Settings → AI, so unlike adopt we do not
  // overwrite an existing row.
  ensureTabTitlePrompt() {
    const exists = this.db.prepare('SELECT id FROM ai_prompts WHERE id = ?').get('tab-title');
    if (!exists) {
      this.db.prepare(`
        INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'tab-title',
        'Tab Title',
        'На основе первого пользовательского сообщения придумай короткое название вкладки. Верни только название: 2-6 слов, без кавычек, без точки, без markdown, без пояснений.',
        'gemini-3-flash-preview',
        'NONE',
        '#22c55e',
        1,
        0,
        5
      );
      console.log('[DB] Migrated: added tab-title prompt');
    }
  }

  // Ensure built-in prompt for Run-after task naming exists (migration for existing DBs).
  // User edits in Settings → AI are preserved; only missing row is inserted.
  ensureRunAfterTitlePrompt() {
    const exists = this.db.prepare('SELECT id FROM ai_prompts WHERE id = ?').get('run-after-title');
    if (!exists) {
      this.db.prepare(`
        INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'run-after-title',
        'Run After Title',
        'На основе текста задачи Run after придумай короткое название задачи. Верни только название: 2-7 слов, без кавычек, без точки, без markdown, без пояснений. Если текст на русском — название тоже на русском; если на английском — на английском.',
        'gemini-3.1-flash-lite',
        'NONE',
        '#DA7756',
        1,
        0,
        6
      );
      console.log('[DB] Migrated: added run-after-title prompt');
    }
  }

  // Ensure built-in prompt for Timeline user-message summaries exists.
  // Names/content/model stay user-editable; only missing row is inserted.
  ensurePromptSummaryPrompt() {
    const oldDefaults = [
      'Перескажи пользовательское сообщение для строки таймлайна. Верни только краткий пересказ до 70 символов: без кавычек, без markdown, без точки в конце, без пояснений. Сохрани язык исходного сообщения.',
      'Перескажи пользовательское сообщение для строки таймлайна. Верни только краткий пересказ до 70 символов: без кавычек, без точки в конце, без пояснений. Сохрани язык исходного сообщения. Одно главное ключевое слово или короткую ключевую фразу оберни одинарными звездочками, например *fork*.',
      'Перескажи пользовательское сообщение для строки таймлайна. Верни только краткий пересказ до 70 символов: без кавычек, без точки в конце, без пояснений. Сохрани язык исходного сообщения. Оберни одинарными звездочками 1-2 главных смысловых акцента, за которые цепляется взгляд: объект или тему действия, например смена *названий системных промптов* или *обновление документации*. Не выделяй всю строку и не используй другой markdown.'
    ];
    const nextDefault = 'Кратко передай смысл пользовательского сообщения для таймлайна, до 70 символов. Верни только пересказ: без кавычек, точки в конце и пояснений. Сохрани язык исходного сообщения. Формулируй действие или вопрос прямо; не добавляй слова «запрос», «просьба» или «диалог», если без них смысл ясен. Ровно один непрерывный смысловой акцент оберни одной парой одинарных звездочек; внутри может быть одно или несколько соседних слов. Вторую пару звездочек не используй. Примеры: проверить *конфликт инструментов с WebODM*; что такое *мультиселектор*. Не выделяй всю строку и не используй другой markdown.';
    const exists = this.db.prepare('SELECT id, content FROM ai_prompts WHERE id = ?').get('prompt-summary');
    if (!exists) {
      this.db.prepare(`
        INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'prompt-summary',
        'Prompt Summary',
        nextDefault,
        'gemini-3.1-flash-lite',
        'NONE',
        '#38bdf8',
        1,
        0,
        7
      );
      console.log('[DB] Migrated: added prompt-summary prompt');
    } else if (oldDefaults.includes(exists.content)) {
      this.db.prepare('UPDATE ai_prompts SET content = ? WHERE id = ? AND is_built_in = 1').run(nextDefault, 'prompt-summary');
      console.log('[DB] Migrated: updated prompt-summary prompt content');
    }
  }

  // Ensure the user-owned AI configuration used by manual Timeline grouping.
  // Only a missing row is inserted; Settings edits are never overwritten.
  ensureTimelineGroupingPrompt() {
    const exists = this.db.prepare('SELECT id FROM ai_prompts WHERE id = ?').get('timeline-grouping');
    if (exists) return;
    const nextPosition = Math.max(
      8,
      Number(this.db.prepare('SELECT MAX(position) AS max_position FROM ai_prompts').get()?.max_position ?? -1) + 1
    );
    const content = [
      'Group a chronological list of user turns into a compact semantic outline.',
      'A group is one concrete work phase with at least two contiguous turns.',
      'Keep the hierarchy flat, preserve chronological order, and leave uncertain or isolated turns ungrouped.',
      'Never cross an item marked boundaryBefore.',
      'Use short titles and descriptions in the predominant language of the supplied turns.',
      'Meta-prompt markers describe workflow actions; do not infer their omitted template body.',
    ].join('\n');
    this.db.prepare(`
      INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'timeline-grouping',
      'Timeline Grouping',
      content,
      'gemini-3.1-flash-lite',
      'LOW',
      '#c084fc',
      1,
      0,
      nextPosition
    );
    console.log('[DB] Migrated: added timeline-grouping prompt');
  }

  // Ensure built-in prompt for Git commit summary generation exists.
  // User edits are preserved; only missing row is inserted.
  ensureGitCommitPrompt() {
    const content = 'You write concise Git commit messages for local commits.\nReturn only JSON with keys "summary" and "description".\n\nRules:\n- The summary must be one line, imperative mood when possible, no trailing period, under 72 characters.\n- The description may be empty. If non-empty, use 1-4 short lines with concrete facts.\n- Do not mention files that are not present in the provided changes.\n- If docs/ changed, base the commit message on changed docs files only when the prompt data says docs-only context was applied.\n- If docs/ did not change, use all included changes.';
    const exists = this.db.prepare('SELECT id FROM ai_prompts WHERE id = ?').get('git-commit');
    if (!exists) {
      this.db.prepare(`
        INSERT INTO ai_prompts (id, name, content, model, thinking_level, color, is_built_in, show_in_context_menu, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'git-commit',
        'Git Commit',
        content,
        'gemini-3.1-flash-lite',
        'NONE',
        '#facc15',
        1,
        0,
        9
      );
      console.log('[DB] Migrated: added git-commit prompt');
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

  // ========== FORK MARKERS ==========

  /**
   * Save a fork marker when a session is forked
   * @param {string} sourceSessionId - Original session UUID
   * @param {string} forkedToSessionId - New session UUID
   * @param {string[]} entryUuids - Array of all entry UUIDs at fork time (snapshot)
   */
  saveForkMarker(sourceSessionId, forkedToSessionId, entryUuids) {
    try {
      // No inheritance needed: fork now rewrites all sessionIds in the copied JSONL,
      // eliminating false boundaries. Inherited markers would only cause wrong blue stripes.

      // Add the new fork marker
      const entryUuidsJson = JSON.stringify(entryUuids || []);
      this.db.prepare(`
        INSERT OR REPLACE INTO fork_markers (source_session_id, forked_to_session_id, entry_uuids_json)
        VALUES (?, ?, ?)
      `).run(sourceSessionId, forkedToSessionId, entryUuidsJson);
      console.log('[DB] Fork marker saved:', { sourceSessionId, forkedToSessionId, entryCount: entryUuids?.length || 0 });

      // Invalidate cache for both endpoints so the next Timeline read sees the new marker.
      this.invalidateForkMarkerCache(sourceSessionId);
      this.invalidateForkMarkerCache(forkedToSessionId);
    } catch (e) {
      console.error('[DB] Failed to save fork marker:', e);
    }
  }

  /**
   * In-memory cache for getForkMarkers. Fork markers change infrequently (only when
   * the user forks or hides a marker), so Timeline's 2s poll previously issued ~137K
   * redundant SQLite reads per session (see 2026-04-19 audit).
   *
   * Cache shape: Map<sessionId, { markers, ts }>. TTL is effectively infinite —
   * entries are invalidated explicitly by saveForkMarker / timeline:delete-fork-marker.
   * Regression signal: [DB:ForkCache] MISS firing > once per real fork operation
   * for the same session means invalidation is too aggressive or cache never populates.
   */
  _forkMarkerCache = new Map();
  _forkMarkerCacheStats = { hit: 0, miss: 0, invalidate: 0 };

  invalidateForkMarkerCache(sessionId) {
    if (!sessionId) return;
    if (this._forkMarkerCache.has(sessionId)) {
      this._forkMarkerCache.delete(sessionId);
      this._forkMarkerCacheStats.invalidate++;
      console.log('[DB:ForkCache] INVALIDATE ' + sessionId.slice(0, 8));
    }
    // Also invalidate any cached entry whose markers reference this session as the
    // opposite endpoint (both source and destination look up the same marker).
    for (const [key, val] of this._forkMarkerCache) {
      if (val.markers.some(m => m.source_session_id === sessionId || m.fork_session_id === sessionId)) {
        this._forkMarkerCache.delete(key);
        this._forkMarkerCacheStats.invalidate++;
      }
    }
  }

  /**
   * Get fork origin for a session (to show blue line on Timeline where it was forked from)
   * @param {string} sessionId - Session UUID (the forked/child session)
   * @returns {Array<{source_session_id: string, entry_uuids: string[]}>}
   */
  getForkMarkers(sessionId) {
    if (!sessionId) return [];

    const cached = this._forkMarkerCache.get(sessionId);
    if (cached) {
      this._forkMarkerCacheStats.hit++;
      // Log every 1000 hits to keep file size sane but still prove cache works.
      if (this._forkMarkerCacheStats.hit % 1000 === 0) {
        console.log('[DB:ForkCache] stats hit=' + this._forkMarkerCacheStats.hit +
                    ' miss=' + this._forkMarkerCacheStats.miss +
                    ' invalidate=' + this._forkMarkerCacheStats.invalidate +
                    ' size=' + this._forkMarkerCache.size);
      }
      return cached.markers;
    }

    // Search by both source and destination to show markers in both sessions
    const rows = this.db.prepare(`
      SELECT source_session_id, forked_to_session_id, entry_uuids_json, created_at, hidden
      FROM fork_markers
      WHERE source_session_id = ? OR forked_to_session_id = ?
      ORDER BY created_at
    `).all(sessionId, sessionId);

    this._forkMarkerCacheStats.miss++;
    console.log('[DB] getForkMarkers(' + sessionId?.slice(0, 8) + '...):', rows.length, 'rows [MISS]');

    const markers = rows.map(row => ({
      source_session_id: row.source_session_id,
      fork_session_id: row.forked_to_session_id,
      entry_uuids: JSON.parse(row.entry_uuids_json || '[]'),
      created_at: row.created_at,
      hidden: !!row.hidden
    }));

    this._forkMarkerCache.set(sessionId, { markers, ts: Date.now() });
    return markers;
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
    // Liveness guard: subagent fork-flow creates a directory named `<uuid>/subagents/`
    // inside the project dir, which Bridge can transiently surface as `session_id`.
    // Persisting such UUIDs into session_links corrupts the chain — Timeline forward-
    // resolves to the dead child, overwrites the store, and renders empty.
    // See fix-dead-session-link-overwrite.md.
    if (!_sessionUuidHasJsonlFile(childId)) {
      console.warn('[DB] saveSessionLink: SKIPPING dead child', childId.substring(0, 8), '(no JSONL file — likely subagent directory)');
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
    return this.db.prepare('SELECT entry_uuid, content, position FROM timeline_notes WHERE session_id = ?').all(sessionId);
  }

  saveTimelineNote(entryUuid, sessionId, tabId, content, position) {
    this.db.prepare(`
      INSERT INTO timeline_notes (entry_uuid, session_id, tab_id, content, position, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(entry_uuid, session_id) DO UPDATE SET content = excluded.content, position = excluded.position, updated_at = excluded.updated_at
    `).run(entryUuid, sessionId, tabId, content, position || 'before');
  }

  deleteTimelineNote(entryUuid, sessionId) {
    this.db.prepare('DELETE FROM timeline_notes WHERE entry_uuid = ? AND session_id = ?').run(entryUuid, sessionId);
  }

  // Rewind markers
  getRewindMarkers(sessionId) {
    return this.db.prepare('SELECT entry_uuid FROM timeline_rewind_markers WHERE session_id = ?').all(sessionId);
  }

  saveRewindMarker(entryUuid, sessionId) {
    this.db.prepare(`
      INSERT OR IGNORE INTO timeline_rewind_markers (entry_uuid, session_id)
      VALUES (?, ?)
    `).run(entryUuid, sessionId);
  }

  /**
   * Copy timeline_notes and timeline_rewind_markers from source rows to a new sessionId.
   * Used by fork: the JSONL file is duplicated and sessionIds rewritten to the new fork
   * id, but notes/rewind rows still carry the old sessionId — without this copy they
   * disappear from the fork's Timeline.
   *
   * Match by UUID set (entries that exist in the forked JSONL) instead of by old
   * sessionId, because a single forked file can contain entries from several sessionIds
   * (Plan Mode / Clear Context within the parent chain). Any matching note attaches to
   * the new fork sessionId — duplicate UUIDs across sessions just collapse to one row.
   *
   * @param {string} newSessionId - Fork's sessionId
   * @param {string[]} entryUuids - All UUIDs present in the forked JSONL
   * @param {string|null} forkTabId - Tab id for the new fork (notes need a tab_id)
   * @returns {{notes: number, rewindMarkers: number}}
   */
  copyTimelineMetadataForFork(newSessionId, entryUuids, forkTabId) {
    if (!Array.isArray(entryUuids) || entryUuids.length === 0) {
      return { notes: 0, rewindMarkers: 0 };
    }

    // SQLite has a default param limit of 999; chunk to be safe.
    const CHUNK = 800;
    let notesCopied = 0;
    let rewindCopied = 0;

    const insertNote = this.db.prepare(`
      INSERT OR IGNORE INTO timeline_notes (entry_uuid, session_id, tab_id, content, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
    `);
    const insertRewind = this.db.prepare(`
      INSERT OR IGNORE INTO timeline_rewind_markers (entry_uuid, session_id)
      VALUES (?, ?)
    `);

    const tx = this.db.transaction((uuids) => {
      // Notes — pick the most recently updated row per uuid (in case the same UUID
      // appears in several sessionIds in the parent chain).
      const notesQuery = `
        SELECT entry_uuid, content, position, MAX(updated_at) AS u
        FROM timeline_notes
        WHERE entry_uuid IN (${uuids.map(() => '?').join(',')})
          AND session_id != ?
        GROUP BY entry_uuid
      `;
      const noteRows = this.db.prepare(notesQuery).all(...uuids, newSessionId);
      for (const r of noteRows) {
        const result = insertNote.run(
          r.entry_uuid,
          newSessionId,
          forkTabId || '',
          r.content || '',
          r.position || 'before'
        );
        if (result.changes > 0) notesCopied++;
      }

      // Rewind markers — same idea, dedupe by uuid.
      const rewindQuery = `
        SELECT DISTINCT entry_uuid
        FROM timeline_rewind_markers
        WHERE entry_uuid IN (${uuids.map(() => '?').join(',')})
          AND session_id != ?
      `;
      const rewindRows = this.db.prepare(rewindQuery).all(...uuids, newSessionId);
      for (const r of rewindRows) {
        const result = insertRewind.run(r.entry_uuid, newSessionId);
        if (result.changes > 0) rewindCopied++;
      }
    });

    for (let i = 0; i < entryUuids.length; i += CHUNK) {
      tx(entryUuids.slice(i, i + CHUNK));
    }

    return { notes: notesCopied, rewindMarkers: rewindCopied };
  }

  // ========== CLAUDE USAGE SNAPSHOTS ==========

  // Append one snapshot from /oauth/usage. NO pruning — history is retained
  // indefinitely (user opted out of the 60-day window so long-range "By day"
  // charts have real data to draw).
  saveClaudeUsageSnapshot(snapshot) {
    if (!snapshot) return;
    const ts = snapshot.ts || Math.floor(Date.now() / 1000);
    try {
      this.db.prepare(`
        INSERT INTO claude_usage_snapshots
          (ts, weekly_pct, five_hour_pct, weekly_opus_pct, weekly_sonnet_pct,
           weekly_resets_at, five_hour_resets_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        ts,
        snapshot.weekly_pct ?? null,
        snapshot.five_hour_pct ?? null,
        snapshot.weekly_opus_pct ?? null,
        snapshot.weekly_sonnet_pct ?? null,
        snapshot.weekly_resets_at ?? null,
        snapshot.five_hour_resets_at ?? null
      );
    } catch (e) {
      console.error('[DB] saveClaudeUsageSnapshot failed:', e.message);
    }
  }

  // Last persisted snapshot — used as fallback usage data when live /oauth/usage
  // is rate-limited and the in-memory cache is empty (e.g. fresh app start
  // hits 429 before any successful fetch). Lets the chip show real numbers
  // instead of a dash even when API is temporarily unavailable.
  getLatestClaudeUsageSnapshot() {
    return this.db.prepare(`
      SELECT ts, weekly_pct, five_hour_pct, weekly_opus_pct, weekly_sonnet_pct,
             weekly_resets_at, five_hour_resets_at
      FROM claude_usage_snapshots
      ORDER BY ts DESC
      LIMIT 1
    `).get();
  }

  // Return raw snapshots between two unix timestamps, ascending order.
  getClaudeUsageSnapshots(fromTs, toTs) {
    return this.db.prepare(`
      SELECT ts, weekly_pct, five_hour_pct, weekly_opus_pct, weekly_sonnet_pct,
             weekly_resets_at, five_hour_resets_at
      FROM claude_usage_snapshots
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts ASC
    `).all(fromTs, toTs);
  }

  // ========== AGENT ACTIVITY INTERVALS ==========

  // Persist one CLOSED activity interval. `iv` carries the denormalized
  // identity snapshot captured at open-time plus start/end ms timestamps.
  // Zero / negative spans are dropped (idempotent recorder may emit a
  // false→false with no real interval).
  saveActivityInterval(iv) {
    if (!iv || !iv.startTs || !iv.endTs) return;
    const duration = iv.endTs - iv.startTs;
    if (duration <= 0) return;
    try {
      this.db.prepare(`
        INSERT INTO agent_activity_intervals
          (tab_id, project_id, project_path, project_name, tab_name, engine,
           session_id, start_ts, end_ts, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        iv.tabId ?? null,
        iv.projectId ?? null,
        iv.projectPath ?? null,
        iv.projectName ?? null,
        iv.tabName ?? null,
        iv.engine ?? null,
        iv.sessionId ?? null,
        iv.startTs,
        iv.endTs,
        duration
      );
    } catch (e) {
      console.error('[DB] saveActivityInterval failed:', e.message);
    }
  }

  // Raw closed intervals overlapping [fromTs, toTs] (ms). Ascending by start.
  // Aggregation (by day / project / tab / engine) is done by the IPC layer,
  // mirroring how computeDailyHistory consumes raw usage snapshots.
  getActivityIntervals(fromTs, toTs) {
    return this.db.prepare(`
      SELECT tab_id, project_id, project_path, project_name, tab_name, engine,
             session_id, start_ts, end_ts, duration_ms
      FROM agent_activity_intervals
      WHERE end_ts >= ? AND start_ts <= ?
      ORDER BY start_ts ASC
    `).all(fromTs, toTs);
  }

  close() { this.db.close(); }
}

// Module-level helper for saveSessionLink liveness guard. Avoids requiring
// claude-data.js (circular dep: claude-data.js → DatabaseManager). Scans
// ~/.claude/projects/* for a JSONL file named `<uuid>.jsonl`. A bare directory
// of the same name (subagent fork-flow artifact) does NOT count.
function _sessionUuidHasJsonlFile(uuid) {
  if (!uuid || typeof uuid !== 'string') return false;
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return false;
  try {
    const projects = fs.readdirSync(projectsRoot);
    for (const proj of projects) {
      const candidate = path.join(projectsRoot, proj, uuid + '.jsonl');
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return true;
      } catch {}
    }
  } catch {}
  return false;
}

module.exports = DatabaseManager;
