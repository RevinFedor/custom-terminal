const Database = require('better-sqlite3');
const crypto = require('crypto');
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
const {
  normalizeForkMarkerEntryUuids,
  parseForkMarkerEntryUuidsJson,
} = require('./fork-marker-snapshot');
const {
  cleanString: cleanSessionHistoryEventString,
  forkEventKey,
  normalizeEventType: normalizeSessionHistoryEventType,
  normalizeProvider: normalizeSessionHistoryProvider,
  toEpochSeconds: sessionHistoryEventEpochSeconds,
} = require('./session-history-events');
const INBOX_PROJECT_ID = '__noted_inbox__';
const INBOX_PROJECT_NAME = 'Inbox';
const INBOX_PROJECT_DESCRIPTION = 'System workspace for API-created and unassigned agent tabs.';
const getInboxProjectPath = () => process.env.NOTED_INBOX_CWD || process.env.HOME || os.homedir() || '/';
const CODEX_PENDING_WRITER_HANDOFF_KEY_PREFIX = 'codex.pending-writer-handoff.v1:';
const CODEX_REWIND_COMMIT_RECEIPT_KEY_PREFIX = 'codex.rewind-commit-receipt.v1:';

function inspectCodexWriterHandoffValue(journalKey, rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return { status: 'absent', journalKey, journal: null };
  }
  let journal;
  try {
    journal = JSON.parse(rawValue);
  } catch (error) {
    return {
      status: 'invalid',
      journalKey,
      journal: null,
      error: 'codex_handoff_journal_corrupt',
      reason: error?.message || 'invalid_json',
      rawValue,
    };
  }
  const baseValid = journal
    && typeof journal === 'object'
    && !Array.isArray(journal)
    && typeof journal.projectId === 'string'
    && journal.projectId.trim()
    && typeof journal.tabId === 'string'
    && journal.tabId.trim()
    && typeof journal.cwd === 'string'
    && journal.cwd.trim()
    && typeof journal.sourceSessionId === 'string'
    && journal.sourceSessionId.trim()
    && typeof journal.actionGeneration === 'string'
    && journal.actionGeneration.trim()
    && Number.isFinite(Number(journal.actionStartedAtMs));
  const versionValid = journal?.version === 1 || (
    journal?.version === 2
    && typeof journal.targetUuid === 'string'
    && journal.targetUuid.trim()
    && Number.isInteger(Number(journal.targetSourceLine))
    && Number(journal.targetSourceLine) >= 1
    && typeof journal.targetTextHash === 'string'
    && /^[a-f0-9]{64}$/i.test(journal.targetTextHash)
    && Number.isInteger(Number(journal.rollbackTurns))
    && Number(journal.rollbackTurns) >= 1
  );
  const optionalBindingValid = journal?.expectedBindingSessionId === undefined
    || (
      typeof journal.expectedBindingSessionId === 'string'
      && journal.expectedBindingSessionId.trim()
    );
  const optionalRuntimeGenerationValid = (
    journal?.sourceLifecycleGeneration === undefined
    || (
      typeof journal.sourceLifecycleGeneration === 'string'
      && journal.sourceLifecycleGeneration.trim()
    )
  ) && (
    journal?.sourceRunSeq === undefined
    || (
      Number.isInteger(Number(journal.sourceRunSeq))
      && Number(journal.sourceRunSeq) > 0
    )
  );
  const optionalOperationIdentityValid = (
    journal?.operationId === undefined
    || (typeof journal.operationId === 'string' && journal.operationId.trim())
  ) && (
    journal?.requestId === undefined
    || (typeof journal.requestId === 'string' && journal.requestId.trim())
  );
  const optionalOriginProjectValid = journal?.originProjectId === undefined
    || (typeof journal.originProjectId === 'string' && journal.originProjectId.trim());
  const hasSeparatedBinding = typeof journal?.expectedBindingSessionId === 'string'
    && journal.expectedBindingSessionId.trim()
    && journal.expectedBindingSessionId.trim() !== String(journal?.sourceSessionId || '').trim();
  const separatedBindingValid = !hasSeparatedBinding || (
    journal.version === 2
    && journal.sourceBindingMode === 'quarantined-manual-writer'
    && typeof journal.sourceLifecycleGeneration === 'string'
    && journal.sourceLifecycleGeneration.trim()
    && Number.isInteger(Number(journal.sourceRunSeq))
      && Number(journal.sourceRunSeq) > 0
  );
  const replacementCandidateProof = journal?.replacementCandidateProof;
  const optionalReplacementCandidateValid = replacementCandidateProof === undefined || (
    replacementCandidateProof
    && replacementCandidateProof.version === 1
    && replacementCandidateProof.kind === 'rewind-replacement'
    && typeof replacementCandidateProof.sessionId === 'string'
    && replacementCandidateProof.sessionId.trim()
    && replacementCandidateProof.sessionId.trim() !== String(journal?.sourceSessionId || '').trim()
    && replacementCandidateProof.sourceSessionId === journal.sourceSessionId
    && replacementCandidateProof.actionGeneration === journal.actionGeneration
    && Number.isFinite(Number(replacementCandidateProof.candidateCreatedAtMs))
    && Number(replacementCandidateProof.candidateCreatedAtMs) >= Number(journal.actionStartedAtMs)
    && Number.isFinite(Number(replacementCandidateProof.observedAtMs))
    && Number(replacementCandidateProof.observedAtMs)
      >= Number(replacementCandidateProof.candidateCreatedAtMs)
    && replacementCandidateProof.targetUuid === journal.targetUuid
    && Number(replacementCandidateProof.targetSourceLine) === Number(journal.targetSourceLine)
    && replacementCandidateProof.targetTextHash === journal.targetTextHash
    && Number(replacementCandidateProof.rollbackTurns) === Number(journal.rollbackTurns)
    && replacementCandidateProof.retainedPrefixExact === true
    && replacementCandidateProof.suffixAfterAction === true
  );
  const valid = baseValid
    && versionValid
    && optionalBindingValid
    && optionalRuntimeGenerationValid
    && optionalOperationIdentityValid
    && optionalOriginProjectValid
    && separatedBindingValid
    && optionalReplacementCandidateValid;
  if (!valid) {
    return {
      status: 'invalid',
      journalKey,
      journal: null,
      error: 'codex_handoff_journal_invalid',
      reason: 'invalid_shape',
      rawValue,
    };
  }
  return { status: 'present', journalKey, journal, rawValue };
}

function inspectCodexNativeRewindCommitReceiptValue(receiptKey, rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return { status: 'absent', receiptKey, receipt: null };
  }
  let receipt;
  try {
    receipt = JSON.parse(rawValue);
  } catch (error) {
    return {
      status: 'invalid',
      receiptKey,
      receipt: null,
      error: 'codex_rewind_commit_receipt_corrupt',
      reason: error?.message || 'invalid_json',
      rawValue,
    };
  }
  const valid = receipt
    && typeof receipt === 'object'
    && !Array.isArray(receipt)
    && receipt.version === 1
    && receipt.kind === 'codex-native-rewind-commit'
    && (receipt.phase === 'committed' || receipt.phase === 'finalized')
    && typeof receipt.receiptId === 'string'
    && receipt.receiptId.trim()
    && typeof receipt.projectId === 'string'
    && receipt.projectId.trim()
    && typeof receipt.originProjectId === 'string'
    && receipt.originProjectId.trim()
    && typeof receipt.tabId === 'string'
    && receipt.tabId.trim()
    && receiptKey === CODEX_REWIND_COMMIT_RECEIPT_KEY_PREFIX + receipt.tabId
    && typeof receipt.operationId === 'string'
    && receipt.operationId.trim()
    && typeof receipt.requestId === 'string'
    && receipt.requestId.trim()
    && typeof receipt.actionGeneration === 'string'
    && receipt.actionGeneration.trim()
    && typeof receipt.sourceSessionId === 'string'
    && receipt.sourceSessionId.trim()
    && typeof receipt.childSessionId === 'string'
    && receipt.childSessionId.trim()
    && receipt.childSessionId !== receipt.sourceSessionId
    && typeof receipt.sourceLifecycleGeneration === 'string'
    && receipt.sourceLifecycleGeneration.trim()
    && Number.isInteger(Number(receipt.sourceRunSeq))
    && Number(receipt.sourceRunSeq) > 0
    && typeof receipt.targetUuid === 'string'
    && receipt.targetUuid.trim()
    && Number.isInteger(Number(receipt.targetSourceLine))
    && Number(receipt.targetSourceLine) >= 1
    && typeof receipt.targetTextHash === 'string'
    && /^[a-f0-9]{64}$/i.test(receipt.targetTextHash)
    && Number.isInteger(Number(receipt.rollbackTurns))
    && Number(receipt.rollbackTurns) >= 1
    && Number.isFinite(Number(receipt.committedAtMs))
    && Number(receipt.committedAtMs) > 0
    && Number.isFinite(Number(receipt.actionStartedAtMs))
    && Number(receipt.actionStartedAtMs) > 0;
  if (!valid) {
    return {
      status: 'invalid',
      receiptKey,
      receipt: null,
      error: 'codex_rewind_commit_receipt_invalid',
      reason: 'invalid_shape',
      rawValue,
    };
  }
  return { status: 'present', receiptKey, receipt, rawValue };
}

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
        tab_list_scroll_top REAL DEFAULT 0,
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

    // Project prompt sources are disk-owned roots. Prompt files themselves are
    // deliberately not copied into `prompts`: the catalog is derived from
    // `<root>/docs/**/*.prompt.md` and stays current when files move or change.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_prompt_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(project_id, root_path),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_project_prompt_sources_project
      ON project_prompt_sources(project_id, position, id)
    `);

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
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_settings_proof_at INTEGER DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_settings_proof_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_pending INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_restore_default_model INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_restore_default_effort INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_source_model TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_source_effort TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_target_model TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_config_path TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_config_fingerprint TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tabs ADD COLUMN codex_model_migration_config_already_target INTEGER DEFAULT 0`); } catch (e) {}
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
    // When this tab was last ACTIVATED (ms epoch). Recency of tab visits must be
    // a durable property of the tab itself, not an array in the session blob:
    // Ctrl+Tab / Cmd+P order is global across projects, and the per-project
    // visit list was rebuilt empty on every restart, so after a restart the
    // switcher could only rank tabs of whatever project happened to be saved.
    // NULL = never activated in a build that records this.
    try {
      this.db.exec(`ALTER TABLE tabs ADD COLUMN last_activated_at INTEGER DEFAULT NULL`);
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
      this.db.exec(`ALTER TABLE projects ADD COLUMN tab_list_scroll_top REAL DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN tab_groups TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN icon TEXT DEFAULT NULL`);
    } catch (e) { /* column already exists */ }
    // «Показывать только значок»: у проекта со значком можно спрятать подпись,
    // чтобы карточка в шапке занимала меньше места.
    try {
      this.db.exec(`ALTER TABLE projects ADD COLUMN hide_name INTEGER DEFAULT 0`);
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

    // App-owned normalized history facts. Provider transcripts remain recovery
    // evidence, but UI/MCP consumers read this projection so Claude and Codex
    // expose the same fork/compact contract.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_history_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_session_id TEXT DEFAULT NULL,
        child_session_id TEXT DEFAULT NULL,
        source_tab_id TEXT DEFAULT NULL,
        child_tab_id TEXT DEFAULT NULL,
        visual_parent_tab_id TEXT DEFAULT NULL,
        orchestration_run_id TEXT DEFAULT NULL,
        orchestration_parent_run_id TEXT DEFAULT NULL,
        fork_mode TEXT DEFAULT NULL,
        entry_uuids_json TEXT NOT NULL DEFAULT '[]',
        snapshot_complete INTEGER NOT NULL DEFAULT 1,
        boundary_entry_uuid TEXT DEFAULT NULL,
        summary_entry_uuid TEXT DEFAULT NULL,
        occurred_at INTEGER DEFAULT NULL,
        turn_index INTEGER DEFAULT NULL,
        after_iteration_index INTEGER DEFAULT NULL,
        next_iteration_index INTEGER DEFAULT NULL,
        trigger TEXT DEFAULT NULL,
        pre_tokens INTEGER DEFAULT NULL,
        post_tokens INTEGER DEFAULT NULL,
        origin TEXT NOT NULL DEFAULT 'app',
        inherited INTEGER NOT NULL DEFAULT 0,
        is_direct INTEGER NOT NULL DEFAULT 0,
        metadata_copied INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    try { this.db.exec(`ALTER TABLE session_history_events ADD COLUMN snapshot_complete INTEGER NOT NULL DEFAULT 1`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE session_history_events ADD COLUMN orchestration_parent_run_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE session_history_events ADD COLUMN metadata_copied INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_history_events_session
      ON session_history_events(session_id, event_type, occurred_at, id);
      CREATE INDEX IF NOT EXISTS idx_session_history_events_source
      ON session_history_events(source_session_id, event_type, occurred_at, id);
    `);

    // Legacy Claude rows already drive the blue Timeline stripe. Import them
    // once without guessing away cascade ancestry; the newest row for a child
    // is marked direct, while all snapshots remain available for compatibility.
    try {
      const legacyRows = this.db.prepare(`
        SELECT id, source_session_id, forked_to_session_id, entry_uuids_json,
               created_at, hidden
        FROM fork_markers
        ORDER BY id
      `).all();
      const newestIdByChild = new Map();
      for (const row of legacyRows) newestIdByChild.set(row.forked_to_session_id, row.id);
      const insertLegacy = this.db.prepare(`
        INSERT OR IGNORE INTO session_history_events (
          event_key, event_type, provider, session_id,
          source_session_id, child_session_id, entry_uuids_json,
          occurred_at, origin, is_direct, hidden, created_at, updated_at
        ) VALUES (?, 'fork', 'claude', ?, ?, ?, ?, ?, 'legacy-fork-marker', ?, ?, ?, ?)
      `);
      const migrateLegacy = this.db.transaction(() => {
        for (const row of legacyRows) {
          const key = forkEventKey('claude', row.source_session_id, row.forked_to_session_id);
          if (!key) continue;
          insertLegacy.run(
            key,
            row.forked_to_session_id,
            row.source_session_id,
            row.forked_to_session_id,
            row.entry_uuids_json || '[]',
            row.created_at || null,
            newestIdByChild.get(row.forked_to_session_id) === row.id ? 1 : 0,
            row.hidden ? 1 : 0,
            row.created_at || null,
            row.created_at || null,
          );
        }
      });
      migrateLegacy();
    } catch (e) {
      console.warn('[DB] session_history_events legacy migration failed:', e.message);
    }

    // Tab history table - closed tabs archive
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tab_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        tab_id TEXT DEFAULT NULL,
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
    // Exact closed-tab identity is required for an explicit Project API send
    // to restore the requested tab instead of guessing from name/session.
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN tab_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tab_history_tab_id ON tab_history(tab_id) WHERE tab_id IS NOT NULL`); } catch (e) {}

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
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_settings_proof_at INTEGER DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_settings_proof_session_id TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_pending INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_restore_default_model INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_restore_default_effort INTEGER DEFAULT 0`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_source_model TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_source_effort TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_target_model TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_config_path TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_config_fingerprint TEXT DEFAULT NULL`); } catch (e) {}
    try { this.db.exec(`ALTER TABLE tab_history ADD COLUMN codex_model_migration_config_already_target INTEGER DEFAULT 0`); } catch (e) {}

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

    // Presentation-only metadata for reversible composer chips and semantic
    // user-turn tags. The canonical prompt remains in Claude/Codex JSONL
    // byte-for-byte; metadata is attached only after a post-Enter audit has
    // identified the durable user record. `chips_json` is the legacy column
    // name; schema v2 may contain both prompt and orchestration items.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_prompt_presentations (
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        audit_timestamp TEXT NOT NULL,
        transport_hash TEXT NOT NULL,
        entry_uuid TEXT DEFAULT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        chips_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (tool_type, session_id, audit_timestamp, transport_hash)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_prompt_presentations_entry
      ON history_prompt_presentations(tool_type, session_id, entry_uuid)
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
        position TEXT DEFAULT 'before',
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

    // claude_usage_snapshots — accepted Claude quota snapshots from the
    // official status-line payload or the authenticated usage endpoint.
    // Storage: 1440 rows/day × ~50B ≈ 26 MB/year. Kept FOREVER (no prune) —
    // user wants unbounded history so the "By day" chart can look back over
    // arbitrary ranges, not just the last week.
    // `weekly_resets_at` is the ISO string from Anthropic — used to detect
    // weekly resets (when value drops because Anthropic rotated the bucket).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claude_usage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_key TEXT,
        ts INTEGER NOT NULL,
        weekly_pct REAL,
        five_hour_pct REAL,
        weekly_opus_pct REAL,
        weekly_sonnet_pct REAL,
        weekly_resets_at TEXT,
        five_hour_resets_at TEXT
      )
    `);
    // Existing rows predate multi-account identity and remain NULL on purpose:
    // attributing them to whichever account happens to be current would mix
    // histories. New snapshots are always scoped.
    try { this.db.exec(`ALTER TABLE claude_usage_snapshots ADD COLUMN account_key TEXT DEFAULT NULL`); } catch (e) {}
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_snapshots_ts ON claude_usage_snapshots(ts DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_snapshots_account_ts
      ON claude_usage_snapshots(account_key, ts DESC);
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
    // Presentation-only binding between an app-owned activity interval and the
    // exact durable assistant row that completed inside it. JSONL stays
    // untouched; duration is read from agent_activity_intervals through JOIN.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_response_timings (
        interval_id INTEGER PRIMARY KEY,
        tool_type TEXT NOT NULL,
        tab_id TEXT,
        session_id TEXT,
        entry_uuid TEXT,
        source_identity TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_response_timings_entry
      ON history_response_timings(tool_type, entry_uuid)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_response_timings_pending
      ON history_response_timings(tool_type, tab_id, session_id)
      WHERE entry_uuid IS NULL
    `);
    // A Codex source rollout can be projected into a proven child after
    // resume/rewind. Keep the original binding and add child aliases instead
    // of moving the single interval row away from its source transcript.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_response_timing_aliases (
        interval_id INTEGER NOT NULL,
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_uuid TEXT NOT NULL,
        source_identity TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (interval_id, tool_type, session_id),
        UNIQUE (tool_type, session_id, entry_uuid)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_history_response_timing_aliases_entry
      ON history_response_timing_aliases(tool_type, entry_uuid)
    `);

    // Runtime state in main is keyed by tab_id alone. Repair legacy collisions
    // before enforcing the same identity contract in SQLite; otherwise a PTY,
    // loader or Codex writer can be silently attached to a row from another
    // project after restart.
    this.ensureGlobalTabIdInvariant();
  }

  _tableColumns(tableName) {
    try {
      return new Set(this.db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
    } catch {
      return new Set();
    }
  }

  _allocateGlobalTabId(projectId, usedTabIds, nextByProject) {
    const prefix = `${projectId}-tab-`;
    let next = nextByProject.get(projectId);
    if (!Number.isFinite(next)) {
      next = 0;
      for (const id of usedTabIds) {
        if (!id.startsWith(prefix)) continue;
        const suffix = id.slice(prefix.length);
        if (/^\d+$/.test(suffix)) next = Math.max(next, Number(suffix) + 1);
      }
    }
    let candidate = `${prefix}${next}`;
    while (usedTabIds.has(candidate)) {
      next += 1;
      candidate = `${prefix}${next}`;
    }
    nextByProject.set(projectId, next + 1);
    usedTabIds.add(candidate);
    return candidate;
  }

  _rewriteProjectScopedTabReferences(projectId, oldTabId, newTabId, tabRow) {
    const updateTabsColumn = (column) => {
      if (!this._tableColumns('tabs').has(column)) return;
      this.db.prepare(`UPDATE tabs SET ${column} = ? WHERE project_id = ? AND ${column} = ?`)
        .run(newTabId, projectId, oldTabId);
    };
    updateTabsColumn('parent_tab_id');
    updateTabsColumn('visual_parent_tab_id');
    updateTabsColumn('restart_after_tab_id');

    if (this._tableColumns('tabs').has('restart_after_tab_ids')) {
      const rows = this.db.prepare(
        'SELECT id, restart_after_tab_ids FROM tabs WHERE project_id = ? AND restart_after_tab_ids IS NOT NULL'
      ).all(projectId);
      const update = this.db.prepare('UPDATE tabs SET restart_after_tab_ids = ? WHERE id = ?');
      for (const row of rows) {
        try {
          const ids = JSON.parse(row.restart_after_tab_ids);
          if (!Array.isArray(ids) || !ids.includes(oldTabId)) continue;
          update.run(JSON.stringify(ids.map((id) => id === oldTabId ? newTabId : id)), row.id);
        } catch { /* preserve malformed legacy JSON */ }
      }
    }

    const projectRow = this.db.prepare('SELECT tab_groups FROM projects WHERE id = ?').get(projectId);
    if (projectRow?.tab_groups) {
      try {
        const groups = JSON.parse(projectRow.tab_groups);
        if (Array.isArray(groups)) {
          let changed = false;
          const next = groups.map((group) => {
            if (!group || group.anchorTabId !== oldTabId) return group;
            changed = true;
            return { ...group, anchorTabId: newTabId };
          });
          if (changed) {
            this.db.prepare('UPDATE projects SET tab_groups = ? WHERE id = ?')
              .run(JSON.stringify(next), projectId);
          }
        }
      } catch { /* preserve malformed legacy JSON */ }
    }

    const scopedTables = [
      ['ai_prompt_call_logs', 'tab_id'],
      ['agent_activity_intervals', 'tab_id'],
    ];
    for (const [table, column] of scopedTables) {
      const columns = this._tableColumns(table);
      if (!columns.has('project_id') || !columns.has(column)) continue;
      this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE project_id = ? AND ${column} = ?`)
        .run(newTabId, projectId, oldTabId);
    }

    // api_call_log is created by the API subsystem, not by this manager, so it
    // is optional in older databases.
    const apiColumns = this._tableColumns('api_call_log');
    if (apiColumns.has('project_id')) {
      for (const column of ['source_tab_id', 'target_tab_id']) {
        if (!apiColumns.has(column)) continue;
        this.db.prepare(`UPDATE api_call_log SET ${column} = ? WHERE project_id = ? AND ${column} = ?`)
          .run(newTabId, projectId, oldTabId);
      }
    }

    // timeline_notes predates project_id. Session identity is the only safe
    // discriminator; never rewrite notes merely because the ambiguous tab ID
    // matches.
    const sessionIds = [
      tabRow?.claude_session_id,
      tabRow?.gemini_session_id,
      tabRow?.codex_session_id,
    ].filter((id) => typeof id === 'string' && id.trim());
    if (sessionIds.length > 0 && this._tableColumns('timeline_notes').has('tab_id')) {
      const placeholders = sessionIds.map(() => '?').join(',');
      this.db.prepare(
        `UPDATE timeline_notes SET tab_id = ? WHERE tab_id = ? AND session_id IN (${placeholders})`
      ).run(newTabId, oldTabId, ...sessionIds);
    }

    // Command history rows carry projectId even though the outer map is keyed
    // only by tabId, so the colliding project's entries can be split without
    // guessing. Other unscoped tab-keyed app_state values intentionally remain
    // on the canonical ID: cloning queued actions could execute them twice.
    const historyKey = 'terminal:command-run-history';
    const history = this.getAppState(historyKey);
    if (history && typeof history === 'object' && !Array.isArray(history)) {
      const oldRows = Array.isArray(history[oldTabId]) ? history[oldTabId] : [];
      const moving = oldRows.filter((row) => row?.projectId === projectId);
      if (moving.length > 0) {
        const staying = oldRows.filter((row) => row?.projectId !== projectId);
        const existingNew = Array.isArray(history[newTabId]) ? history[newTabId] : [];
        const rewritten = moving.map((row) => ({
          ...row,
          id: `${row?.at || 0}:${newTabId}`,
          tabId: newTabId,
        }));
        if (staying.length > 0) history[oldTabId] = staying;
        else delete history[oldTabId];
        history[newTabId] = [...rewritten, ...existingNew];
        this.setAppState(historyKey, history);
      }
    }

    const lastByCwdKey = 'terminal:last-command-by-cwd';
    const lastByCwd = this.getAppState(lastByCwdKey);
    if (lastByCwd && typeof lastByCwd === 'object' && !Array.isArray(lastByCwd)) {
      let changed = false;
      for (const [cwd, row] of Object.entries(lastByCwd)) {
        if (!row || row.projectId !== projectId || row.tabId !== oldTabId) continue;
        lastByCwd[cwd] = { ...row, tabId: newTabId };
        changed = true;
      }
      if (changed) this.setAppState(lastByCwdKey, lastByCwd);
    }

    for (const key of [
      'promptQueueByTab',
      'timelineSummaryAutoTabs',
      'timelineSummaryAutoSinceTabs',
      'noted-terminal-timeline-summary-auto-tabs',
      'noted-terminal-timeline-summary-auto-since-tabs',
      'noted-terminal-task-plan-expanded-tabs',
    ]) {
      const value = this.getAppState(key);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Object.prototype.hasOwnProperty.call(value, oldTabId)) continue;
      console.warn('[DB:TabIdInvariant] unscoped app-state kept on canonical tab'
        + ' key=' + key
        + ' old=' + oldTabId
        + ' renamedProject=' + projectId
        + ' new=' + newTabId);
    }
  }

  ensureGlobalTabIdInvariant() {
    const usedTabIds = new Set(
      this.db.prepare("SELECT tab_id FROM tabs WHERE tab_id IS NOT NULL AND trim(tab_id) != ''")
        .all()
        .map((row) => row.tab_id)
    );
    const nextByProject = new Map();
    const repairs = [];

    const repair = this.db.transaction(() => {
      // First materialize every legacy NULL/empty identity. These rows cannot
      // own any reliable tab-keyed references, so only the row itself changes.
      const missing = this.db.prepare(
        "SELECT * FROM tabs WHERE tab_id IS NULL OR trim(tab_id) = '' ORDER BY id"
      ).all();
      for (const row of missing) {
        const newTabId = this._allocateGlobalTabId(row.project_id, usedTabIds, nextByProject);
        this.db.prepare('UPDATE tabs SET tab_id = ? WHERE id = ?').run(newTabId, row.id);
        repairs.push({ rowId: row.id, projectId: row.project_id, oldTabId: null, newTabId, reason: 'missing' });
      }

      const duplicateIds = this.db.prepare(`
        SELECT tab_id
        FROM tabs
        WHERE tab_id IS NOT NULL AND trim(tab_id) != ''
        GROUP BY tab_id
        HAVING COUNT(*) > 1
        ORDER BY tab_id
      `).all();
      for (const duplicate of duplicateIds) {
        const oldTabId = duplicate.tab_id;
        const rows = this.db.prepare('SELECT * FROM tabs WHERE tab_id = ? ORDER BY id').all(oldTabId);
        const canonical = rows
          .slice()
          .sort((a, b) => {
            const aOwn = oldTabId.startsWith(`${a.project_id}-tab-`) ? 1 : 0;
            const bOwn = oldTabId.startsWith(`${b.project_id}-tab-`) ? 1 : 0;
            return bOwn - aOwn || a.id - b.id;
          })[0];
        const countByProject = new Map();
        for (const row of rows) countByProject.set(row.project_id, (countByProject.get(row.project_id) || 0) + 1);

        for (const row of rows) {
          if (row.id === canonical.id) continue;
          const newTabId = this._allocateGlobalTabId(row.project_id, usedTabIds, nextByProject);
          this.db.prepare('UPDATE tabs SET tab_id = ? WHERE id = ?').run(newTabId, row.id);
          // References are safely attributable only when this project had one
          // row with the collided ID. Duplicate rows inside one project are
          // already ambiguous, so keep their references on the canonical row.
          if (countByProject.get(row.project_id) === 1) {
            this._rewriteProjectScopedTabReferences(row.project_id, oldTabId, newTabId, row);
          }
          repairs.push({
            rowId: row.id,
            projectId: row.project_id,
            oldTabId,
            newTabId,
            canonicalRowId: canonical.id,
            referencesRewritten: countByProject.get(row.project_id) === 1,
            reason: 'duplicate',
          });
        }
      }

      // The old non-unique lookup index remains useful, while this partial
      // unique index makes every future nonempty runtime identity global.
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_tab_id_unique
        ON tabs(tab_id)
        WHERE tab_id IS NOT NULL AND trim(tab_id) != ''
      `);
    });
    repair();

    for (const item of repairs) {
      console.warn('[DB:TabIdInvariant] repaired project=' + item.projectId
        + ' old=' + (item.oldTabId || '<missing>')
        + ' new=' + item.newTabId
        + ' reason=' + item.reason
        + ' refs=' + (item.referencesRewritten === true ? 'rewritten' : 'none'));
    }
    return repairs;
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

  compareAndSetAppState(key, expectedValue, nextValue) {
    if (!key) return false;
    const expectedJson = typeof expectedValue === 'string'
      ? expectedValue
      : JSON.stringify(expectedValue);
    const nextJson = typeof nextValue === 'string'
      ? nextValue
      : JSON.stringify(nextValue);
    const info = this.db.prepare(`
      UPDATE app_state
      SET value = ?, updated_at = strftime('%s', 'now')
      WHERE key = ? AND value = ?
    `).run(nextJson, key, expectedJson);
    return info.changes === 1;
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

  inspectPendingCodexWriterHandoff(journalKey) {
    if (typeof journalKey !== 'string' || !journalKey.trim()) {
      return {
        status: 'invalid',
        journalKey: journalKey || null,
        journal: null,
        error: 'codex_handoff_journal_key_invalid',
        reason: 'journal_key_required',
      };
    }
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(journalKey);
    return inspectCodexWriterHandoffValue(journalKey, row?.value);
  }

  inspectCodexNativeRewindCommitReceipt(receiptKey) {
    if (typeof receiptKey !== 'string' || !receiptKey.trim()) {
      return {
        status: 'invalid',
        receiptKey: receiptKey || null,
        receipt: null,
        error: 'codex_rewind_commit_receipt_key_invalid',
        reason: 'receipt_key_required',
      };
    }
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(receiptKey);
    return inspectCodexNativeRewindCommitReceiptValue(receiptKey, row?.value);
  }

  verifyCodexNativeRewindCommitReceipt({
    receiptKey,
    projectId,
    originProjectId = projectId,
    tabId,
    operationId,
    requestId,
    actionGeneration,
    sourceSessionId,
    sourceLifecycleGeneration,
    sourceRunSeq,
    targetUuid,
    targetSourceLine,
    targetTextHash,
    rollbackTurns,
    expectedChildSessionId = null,
    receiptId = null,
  } = {}) {
    const inspection = this.inspectCodexNativeRewindCommitReceipt(receiptKey);
    if (inspection.status !== 'present') {
      return {
        success: false,
        error: inspection.error || 'codex_rewind_commit_receipt_missing',
        reason: inspection.reason || inspection.status,
        retryable: inspection.status === 'absent',
      };
    }
    const receipt = inspection.receipt;
    const expected = {
      projectId,
      tabId,
      operationId,
      requestId,
      actionGeneration,
      sourceSessionId,
      sourceLifecycleGeneration,
      targetUuid,
      targetTextHash,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (!value || String(receipt[field] || '') !== String(value)) {
        return {
          success: false,
          error: 'codex_rewind_commit_receipt_stale',
          mismatch: field,
          retryable: false,
        };
      }
    }
    if (!originProjectId || receipt.originProjectId !== originProjectId) {
      return {
        success: false,
        error: 'codex_rewind_commit_receipt_stale',
        mismatch: 'originProjectId',
        retryable: false,
      };
    }
    if (!Number.isInteger(Number(sourceRunSeq))
      || Number(receipt.sourceRunSeq) !== Number(sourceRunSeq)
      || !Number.isInteger(Number(targetSourceLine))
      || Number(receipt.targetSourceLine) !== Number(targetSourceLine)
      || !Number.isInteger(Number(rollbackTurns))
      || Number(receipt.rollbackTurns) !== Number(rollbackTurns)
      || (expectedChildSessionId
        && String(receipt.childSessionId) !== String(expectedChildSessionId))
      || (receiptId && String(receipt.receiptId) !== String(receiptId))) {
      return {
        success: false,
        error: 'codex_rewind_commit_receipt_stale',
        mismatch: Number(receipt.sourceRunSeq) !== Number(sourceRunSeq)
          ? 'sourceRunSeq'
          : Number(receipt.targetSourceLine) !== Number(targetSourceLine)
            ? 'targetSourceLine'
            : Number(receipt.rollbackTurns) !== Number(rollbackTurns)
              ? 'rollbackTurns'
              : expectedChildSessionId && String(receipt.childSessionId) !== String(expectedChildSessionId)
                ? 'childSessionId'
                : 'receiptId',
        retryable: false,
      };
    }
    const tabRow = this.db.prepare(
      'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
    ).get(projectId, tabId);
    if (!tabRow) {
      return { success: false, error: 'codex_tab_row_missing', retryable: true };
    }
    const currentSessionId = tabRow.codex_session_id || null;
    if (currentSessionId !== receipt.childSessionId) {
      return {
        success: false,
        error: 'codex_rewind_commit_receipt_binding_changed',
        currentSessionId,
        receiptChildSessionId: receipt.childSessionId,
        retryable: false,
      };
    }
    return {
      success: true,
      receipt,
      rawValue: inspection.rawValue,
      childSessionId: receipt.childSessionId,
      currentSessionId,
      alreadyFinalized: receipt.phase === 'finalized',
    };
  }

  finalizeCodexNativeRewindCommitReceipt(expectation = {}) {
    const transaction = this.db.transaction(() => {
      const verified = this.verifyCodexNativeRewindCommitReceipt(expectation);
      if (verified.success !== true) return verified;
      if (verified.receipt.phase === 'finalized') {
        return { ...verified, updated: false };
      }
      const nextReceipt = {
        ...verified.receipt,
        phase: 'finalized',
        finalizedAtMs: Date.now(),
      };
      const updated = this.db.prepare(`
        UPDATE app_state
        SET value = ?, updated_at = strftime('%s', 'now')
        WHERE key = ? AND value = ?
      `).run(
        JSON.stringify(nextReceipt),
        expectation.receiptKey,
        verified.rawValue,
      );
      return updated.changes === 1
        ? {
            success: true,
            updated: true,
            receipt: nextReceipt,
            childSessionId: nextReceipt.childSessionId,
            currentSessionId: nextReceipt.childSessionId,
          }
        : {
            success: false,
            error: 'codex_rewind_commit_receipt_finalize_compare_and_set_failed',
            retryable: true,
          };
    });
    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
  }

  _migratePendingCodexWriterHandoffsInTransaction({
    sourceProjectId,
    targetProjectId,
    tabIds,
  } = {}) {
    const plans = [];
    for (const tabId of tabIds) {
      const journalKey = CODEX_PENDING_WRITER_HANDOFF_KEY_PREFIX + tabId;
      const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(journalKey);
      const inspection = inspectCodexWriterHandoffValue(journalKey, row?.value);
      if (inspection.status === 'invalid') {
        return {
          success: false,
          error: inspection.error,
          tabId,
          journalKey,
          reason: inspection.reason,
        };
      }
      if (inspection.status === 'present') {
        const journal = inspection.journal;
        if (journal.tabId !== tabId || journal.projectId !== sourceProjectId) {
          return {
            success: false,
            error: 'codex_handoff_journal_owner_mismatch',
            tabId,
            journalKey,
            journalTabId: journal.tabId,
            journalProjectId: journal.projectId,
            expectedProjectId: sourceProjectId,
          };
        }
        plans.push({
          tabId,
          key: journalKey,
          previousRaw: inspection.rawValue,
          nextRaw: JSON.stringify({ ...journal, projectId: targetProjectId }),
        });
      }

      const receiptKey = CODEX_REWIND_COMMIT_RECEIPT_KEY_PREFIX + tabId;
      const receiptRow = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(receiptKey);
      const receiptInspection = inspectCodexNativeRewindCommitReceiptValue(
        receiptKey,
        receiptRow?.value,
      );
      if (receiptInspection.status === 'invalid') {
        return {
          success: false,
          error: receiptInspection.error,
          tabId,
          receiptKey,
          reason: receiptInspection.reason,
        };
      }
      if (receiptInspection.status === 'present') {
        const receipt = receiptInspection.receipt;
        if (receipt.tabId !== tabId || receipt.projectId !== sourceProjectId) {
          return {
            success: false,
            error: 'codex_rewind_commit_receipt_owner_mismatch',
            tabId,
            receiptKey,
            receiptProjectId: receipt.projectId,
            expectedProjectId: sourceProjectId,
          };
        }
        plans.push({
          tabId,
          key: receiptKey,
          previousRaw: receiptInspection.rawValue,
          nextRaw: JSON.stringify({ ...receipt, projectId: targetProjectId }),
        });
      }
    }

    for (const plan of plans) {
      const updated = this.db.prepare(`
        UPDATE app_state
        SET value = ?, updated_at = strftime('%s', 'now')
        WHERE key = ? AND value = ?
      `).run(plan.nextRaw, plan.key, plan.previousRaw);
      if (updated.changes !== 1) {
        const error = new Error('codex_handoff_journal_compare_and_set_failed');
        error.tabId = plan.tabId;
        error.journalKey = plan.key;
        throw error;
      }
    }
    return { success: true, migrated: [...new Set(plans.map((plan) => plan.tabId))] };
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

    // The removed Utils surface had its own position namespace. During the
    // one-way migration, preserve the old visible order: main tabs first,
    // then utility tabs, with a deterministic row-id tie-break.
    const tabs = this.db.prepare(`
      SELECT * FROM tabs
      WHERE project_id = ?
      ORDER BY is_utility ASC, position ASC, id ASC
    `).all(project.id);
    const globalCommands = this.getGlobalCommands();

    return {
      id: project.id,
      path: project.path,
      name: project.name,
      description: project.description || '',
      icon: project.icon || null,
      // Прятать подпись можно только при живом значке: иначе карточка стала бы
      // пустой. Правило применяется ЗДЕСЬ, на чтении, а не только в интерфейсе —
      // значок можно убрать, и сохранённое «спрятать» пережило бы его.
      hideName: project.hide_name === 1 && !!project.icon,
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
      tabListScrollTop: Number.isFinite(Number(project.tab_list_scroll_top))
        ? Math.max(0, Number(project.tab_list_scroll_top))
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
        codexSettingsProofAt: Number(t.codex_settings_proof_at) || undefined,
        codexSettingsProofSessionId: t.codex_settings_proof_session_id || undefined,
        codexModelMigrationPending: t.codex_model_migration_pending === 1 || undefined,
        codexModelMigrationRestoreDefaultModel: t.codex_model_migration_restore_default_model === 1 || undefined,
        codexModelMigrationRestoreDefaultEffort: t.codex_model_migration_restore_default_effort === 1 || undefined,
        codexModelMigrationSourceModel: t.codex_model_migration_source_model || undefined,
        codexModelMigrationSourceEffort: t.codex_model_migration_source_effort || undefined,
        codexModelMigrationTargetModel: t.codex_model_migration_target_model || undefined,
        codexModelMigrationConfigPath: t.codex_model_migration_config_path || undefined,
        codexModelMigrationConfigFingerprint: t.codex_model_migration_config_fingerprint || undefined,
        codexModelMigrationConfigAlreadyTarget: t.codex_model_migration_config_already_target === 1 || undefined,
        externalRun: (() => {
          if (!t.external_run) return undefined;
          try { return JSON.parse(t.external_run); }
          catch { return undefined; }
        })(),
        wasInterrupted: t.was_interrupted === 1,
        overlayDismissed: t.overlay_dismissed === 1,
        notes: t.notes || '',
        taskPlan: normalizeTaskPlan(t.task_plan),
        // Встроенная browser-вкладка удалена 2026-08-17. У кого-то в базе такие
        // строки ещё лежат, и рендерер про этот тип уже не знает — поэтому здесь
        // они становятся обычным терминалом, а не «вкладкой, которую никто не
        // умеет показать». Колонки url/terminal_id/terminal_name/active_view
        // остаются в схеме пустыми: удалять колонку в SQLite дороже, чем
        // перестать её читать.
        tabType: (!t.tab_type || t.tab_type === 'browser') ? 'terminal' : t.tab_type,
        filePath: t.file_path || undefined,
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
        // Durable tab-visit time — the switcher orders ALL tabs of ALL projects
        // by this, so the order survives a restart even for projects whose
        // per-session visit list is gone.
        lastActivatedAt: Number(t.last_activated_at) || undefined,
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

  // Codex writer identity is committed point-wise by main after runtime proof.
  // tab_id is globally unique after ensureGlobalTabIdInvariant, while the
  // project scope is still mandatory here: it proves that a row has not moved
  // to another workspace between async process inspection and this write. A
  // renderer workspace snapshot is only a cache and may still carry the resume
  // source (or a previously active writer), so it must not own this column for
  // an existing row. New rows are seeded by saveTabs below.
  getTabClaudeSessionId(projectId, tabId) {
    if (arguments.length < 2 || !projectId || !tabId) return undefined;
    const row = this.db.prepare(
      'SELECT claude_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
    ).get(projectId, tabId);
    if (!row) return undefined;
    return row.claude_session_id || null;
  }

  getTabCodexSessionId(projectId, tabId) {
    if (arguments.length < 2 || !projectId || !tabId) return undefined;
    const row = this.db.prepare(
      'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
    ).get(projectId, tabId);
    if (!row) return undefined;
    return row.codex_session_id || null;
  }

  getTabCodexSettingsState(projectId, tabId) {
    if (arguments.length < 2 || !projectId || !tabId) return undefined;
    const row = this.db.prepare(`
      SELECT codex_model,
             codex_effort,
             codex_settings_proof_at,
             codex_settings_proof_session_id,
             codex_model_migration_pending,
             codex_model_migration_restore_default_model,
             codex_model_migration_restore_default_effort,
             codex_model_migration_source_model,
             codex_model_migration_source_effort,
             codex_model_migration_target_model,
             codex_model_migration_config_path,
             codex_model_migration_config_fingerprint,
             codex_model_migration_config_already_target
      FROM tabs
      WHERE project_id = ? AND tab_id = ?
      LIMIT 1
    `).get(projectId, tabId);
    if (!row) return undefined;
    return {
      model: row.codex_model || null,
      effort: row.codex_effort || null,
      proofAt: Number(row.codex_settings_proof_at) || null,
      proofSessionId: row.codex_settings_proof_session_id || null,
      modelMigrationPending: row.codex_model_migration_pending === 1,
      restoreDefaultModel: row.codex_model_migration_restore_default_model === 1,
      restoreDefaultEffort: row.codex_model_migration_restore_default_effort === 1,
      sourceModel: row.codex_model_migration_source_model || null,
      sourceEffort: row.codex_model_migration_source_effort || null,
      targetModel: row.codex_model_migration_target_model || null,
      configPath: row.codex_model_migration_config_path || null,
      configBaselineFingerprint: row.codex_model_migration_config_fingerprint || null,
      configAlreadyTargetAtArm: row.codex_model_migration_config_already_target === 1,
    };
  }

  updateTabCodexSessionId(projectId, tabId, sessionId) {
    // The arity guard deliberately rejects the legacy (tabId, sessionId) call:
    // reinterpreting those two strings could target an unrelated compound row.
    if (arguments.length < 3 || !projectId || !tabId) return false;
    const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : null;
    const info = this.db.prepare(
      'UPDATE tabs SET codex_session_id = ? WHERE project_id = ? AND tab_id = ?'
    ).run(normalizedSessionId, projectId, tabId);
    return info.changes > 0;
  }

  // A proven Resume/Fork writer and its non-conversation settings are one
  // durable fact. Persist them in one statement so a crash cannot leave writer
  // B paired with writer A's model/effort proof. Ultra is intentionally
  // rejected here because it belongs only to the live conversation overlay.
  updateTabCodexSessionAndSettings(projectId, tabId, {
    sessionId,
    model,
    effort,
    proofAt,
  } = {}) {
    if (arguments.length < 3 || !projectId || !tabId) return false;
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    const normalizedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    const normalizedProofAt = Number(proofAt);
    const persistentEfforts = new Set([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    if (!normalizedSessionId
      || !normalizedModel
      || !persistentEfforts.has(normalizedEffort)
      || !Number.isFinite(normalizedProofAt)
      || normalizedProofAt <= 0) {
      return false;
    }
    const info = this.db.prepare(`
      UPDATE tabs
      SET codex_session_id = ?,
          codex_model = ?,
          codex_effort = ?,
          codex_settings_proof_at = ?,
          codex_settings_proof_session_id = ?,
          codex_model_migration_pending = 0,
          codex_model_migration_restore_default_model = 0,
          codex_model_migration_restore_default_effort = 0,
          codex_model_migration_source_model = NULL,
          codex_model_migration_source_effort = NULL,
          codex_model_migration_target_model = NULL,
          codex_model_migration_config_path = NULL,
          codex_model_migration_config_fingerprint = NULL,
          codex_model_migration_config_already_target = 0
      WHERE project_id = ? AND tab_id = ?
    `).run(
      normalizedSessionId,
      normalizedModel,
      normalizedEffort,
      normalizedProofAt,
      normalizedSessionId,
      projectId,
      tabId,
    );
    return info.changes === 1;
  }

  // Claude session identity had no point-write path at all: the renderer
  // mutated its tab object and fired a full `saveTabs`, which wrote
  // `claude_session_id` verbatim from an array that may have been assembled
  // BEFORE a neighbouring tab received its new id from the bridge. The
  // neighbour's id was then rolled back, and after a restart that tab opened
  // on a stale (or foreign) session while its JSONL was intact. Same contract
  // as the Codex CAS above: write only if the row still holds what the caller
  // saw.
  compareAndSetTabClaudeSessionId(projectId, tabId, expectedSessionId, nextSessionId) {
    if (arguments.length < 4 || !projectId || !tabId) return false;
    const expected = typeof expectedSessionId === 'string' && expectedSessionId.trim()
      ? expectedSessionId.trim()
      : null;
    const next = typeof nextSessionId === 'string' && nextSessionId.trim()
      ? nextSessionId.trim()
      : null;
    const info = this.db.prepare(
      'UPDATE tabs SET claude_session_id = ? WHERE project_id = ? AND tab_id = ? AND claude_session_id IS ?'
    ).run(next, projectId, tabId, expected);
    return info.changes === 1;
  }

  compareAndSetTabCodexSessionId(projectId, tabId, expectedSessionId, nextSessionId) {
    if (arguments.length < 4 || !projectId || !tabId) return false;
    const expected = typeof expectedSessionId === 'string' && expectedSessionId.trim()
      ? expectedSessionId.trim()
      : null;
    const next = typeof nextSessionId === 'string' && nextSessionId.trim()
      ? nextSessionId.trim()
      : null;
    const info = this.db.prepare(
      'UPDATE tabs SET codex_session_id = ? WHERE project_id = ? AND tab_id = ? AND codex_session_id IS ?'
    ).run(next, projectId, tabId, expected);
    return info.changes === 1;
  }

  // Model migration is proven by main from the exact post-Enter Codex
  // acknowledgement, before a rollout/writer necessarily exists. Commit that
  // pair point-wise so a renderer reload or app crash cannot relaunch the stale
  // CLI override that triggered the migration prompt.
  updateTabCodexSettings(projectId, tabId, {
    model,
    effort,
    proofAt,
    proofSessionId = null,
  } = {}) {
    if (arguments.length < 3 || !projectId || !tabId) return false;
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    const normalizedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    const normalizedProofAt = Number(proofAt);
    const normalizedProofSessionId = typeof proofSessionId === 'string' && proofSessionId.trim()
      ? proofSessionId.trim()
      : null;
    if (!normalizedModel || !normalizedEffort || !Number.isFinite(normalizedProofAt) || normalizedProofAt <= 0) {
      return false;
    }
    const info = this.db.prepare(`
      UPDATE tabs
      SET codex_model = ?,
          codex_effort = ?,
          codex_settings_proof_at = ?,
          codex_settings_proof_session_id = ?,
          codex_model_migration_pending = 0,
          codex_model_migration_restore_default_model = 0,
          codex_model_migration_restore_default_effort = 0,
          codex_model_migration_source_model = NULL,
          codex_model_migration_source_effort = NULL,
          codex_model_migration_target_model = NULL,
          codex_model_migration_config_path = NULL,
          codex_model_migration_config_fingerprint = NULL,
          codex_model_migration_config_already_target = 0
      WHERE project_id = ? AND tab_id = ?
    `).run(
      normalizedModel,
      normalizedEffort,
      normalizedProofAt,
      normalizedProofSessionId,
      projectId,
      tabId,
    );
    return info.changes === 1;
  }

  beginTabCodexModelMigration(projectId, tabId, {
    proofAt,
    clearDefaultModel = false,
    expectedDefaultModel = null,
    clearDefaultEffort = false,
    expectedDefaultEffort = null,
    sourceModel,
    sourceEffort = null,
    targetModel,
    configPath,
    configBaselineFingerprint,
    configAlreadyTargetAtArm = false,
  } = {}) {
    if (arguments.length < 3 || !projectId || !tabId) {
      return { success: false, error: 'codex_model_migration_invalid' };
    }
    const normalizedProofAt = Number(proofAt);
    const normalizedSourceModel = typeof sourceModel === 'string' ? sourceModel.trim() : '';
    const normalizedSourceEffort = typeof sourceEffort === 'string'
      ? sourceEffort.trim().toLowerCase()
      : '';
    const normalizedTargetModel = typeof targetModel === 'string' ? targetModel.trim() : '';
    const normalizedConfigPath = typeof configPath === 'string' ? configPath.trim() : '';
    const normalizedConfigBaselineFingerprint = typeof configBaselineFingerprint === 'string'
      ? configBaselineFingerprint.trim().toLowerCase()
      : '';
    if (!Number.isFinite(normalizedProofAt)
      || normalizedProofAt <= 0
      || !normalizedSourceModel
      || !normalizedTargetModel
      || !normalizedConfigPath
      || !path.isAbsolute(normalizedConfigPath)
      || !/^[a-f0-9]{64}$/.test(normalizedConfigBaselineFingerprint)) {
      return { success: false, error: 'codex_model_migration_proof_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const previousPending = this.db.prepare(`
        SELECT codex_model_migration_restore_default_model,
               codex_model_migration_restore_default_effort,
               codex_model_migration_pending,
               codex_settings_proof_at,
               codex_model_migration_source_model,
               codex_model_migration_source_effort,
               codex_model_migration_target_model,
               codex_model_migration_config_path,
               codex_model_migration_config_fingerprint,
               codex_model_migration_config_already_target
        FROM tabs
        WHERE project_id = ? AND tab_id = ?
        LIMIT 1
      `).get(projectId, tabId);
      if (!previousPending) {
        return { success: false, error: 'codex_model_migration_tab_missing' };
      }
      if (previousPending.codex_model_migration_pending === 1) {
        const sameJournal = previousPending.codex_model_migration_source_model === normalizedSourceModel
          && (previousPending.codex_model_migration_source_effort || '') === (normalizedSourceEffort || '')
          && previousPending.codex_model_migration_target_model === normalizedTargetModel
          && previousPending.codex_model_migration_config_path === normalizedConfigPath
          && previousPending.codex_model_migration_config_fingerprint === normalizedConfigBaselineFingerprint
          && (previousPending.codex_model_migration_config_already_target === 1)
            === (configAlreadyTargetAtArm === true);
        if (!sameJournal) {
          return { success: false, error: 'codex_model_migration_already_pending' };
        }
        return {
          success: true,
          idempotent: true,
          pendingProofAt: Number(previousPending.codex_settings_proof_at),
          defaultModelInvalidated: previousPending.codex_model_migration_restore_default_model === 1,
          defaultEffortInvalidated: previousPending.codex_model_migration_restore_default_effort === 1,
        };
      }
      const tabUpdate = this.db.prepare(`
        UPDATE tabs
        SET codex_model = NULL,
            codex_effort = NULL,
            codex_settings_proof_at = ?,
            codex_settings_proof_session_id = NULL,
            codex_model_migration_pending = 1,
            codex_model_migration_source_model = ?,
            codex_model_migration_source_effort = ?,
            codex_model_migration_target_model = ?,
            codex_model_migration_config_path = ?,
            codex_model_migration_config_fingerprint = ?,
            codex_model_migration_config_already_target = ?
        WHERE project_id = ? AND tab_id = ? AND codex_model_migration_pending = 0
      `).run(
        normalizedProofAt,
        normalizedSourceModel,
        normalizedSourceEffort || null,
        normalizedTargetModel,
        normalizedConfigPath,
        normalizedConfigBaselineFingerprint,
        configAlreadyTargetAtArm === true ? 1 : 0,
        projectId,
        tabId,
      );
      if (tabUpdate.changes !== 1) {
        return { success: false, error: 'codex_model_migration_tab_missing' };
      }

      const clearDefault = (key, enabled, expectedValue) => {
        const expected = typeof expectedValue === 'string' ? expectedValue.trim() : '';
        if (!enabled || !expected) return false;
        const info = this.db.prepare(`
          UPDATE app_state
          SET value = 'none', updated_at = strftime('%s', 'now')
          WHERE key = ? AND value = ?
        `).run(key, expected);
        return info.changes === 1;
      };
      const defaultModelInvalidatedNow = clearDefault(
        'defaultCodexModel',
        clearDefaultModel,
        expectedDefaultModel,
      );
      const defaultEffortInvalidatedNow = clearDefault(
        'defaultCodexEffort',
        clearDefaultEffort,
        expectedDefaultEffort,
      );
      const defaultModelInvalidated = previousPending.codex_model_migration_restore_default_model === 1
        || defaultModelInvalidatedNow;
      const defaultEffortInvalidated = previousPending.codex_model_migration_restore_default_effort === 1
        || defaultEffortInvalidatedNow;
      this.db.prepare(`
        UPDATE tabs
        SET codex_model_migration_restore_default_model = ?,
            codex_model_migration_restore_default_effort = ?
        WHERE project_id = ? AND tab_id = ?
      `).run(
        defaultModelInvalidated ? 1 : 0,
        defaultEffortInvalidated ? 1 : 0,
        projectId,
        tabId,
      );
      return {
        success: true,
        defaultModelInvalidated,
        defaultEffortInvalidated,
      };
    });
    return transaction();
  }

  commitTabCodexModelMigration(projectId, tabId, {
    model,
    effort,
    proofAt,
    proofSessionId = null,
    expectedPendingProofAt,
  } = {}) {
    if (arguments.length < 3 || !projectId || !tabId) {
      return { success: false, error: 'codex_model_migration_invalid' };
    }
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    const normalizedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    const normalizedProofAt = Number(proofAt);
    const normalizedPendingProofAt = Number(expectedPendingProofAt);
    const normalizedProofSessionId = typeof proofSessionId === 'string' && proofSessionId.trim()
      ? proofSessionId.trim()
      : null;
    if (!normalizedModel
      || !normalizedEffort
      || !Number.isFinite(normalizedProofAt)
      || normalizedProofAt <= 0
      || !Number.isFinite(normalizedPendingProofAt)
      || normalizedPendingProofAt <= 0) {
      return { success: false, error: 'codex_model_migration_proof_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const pendingState = this.db.prepare(`
        SELECT codex_model_migration_restore_default_model,
               codex_model_migration_restore_default_effort,
               codex_model_migration_pending,
               codex_settings_proof_at
        FROM tabs
        WHERE project_id = ? AND tab_id = ?
        LIMIT 1
      `).get(projectId, tabId);
      if (!pendingState) {
        return { success: false, error: 'codex_model_migration_tab_missing' };
      }
      if (pendingState.codex_model_migration_pending !== 1
        || Number(pendingState.codex_settings_proof_at) !== normalizedPendingProofAt) {
        return { success: false, error: 'codex_model_migration_generation_changed' };
      }
      const tabUpdate = this.db.prepare(`
        UPDATE tabs
        SET codex_model = ?,
            codex_effort = ?,
            codex_settings_proof_at = ?,
            codex_settings_proof_session_id = ?,
            codex_model_migration_pending = 0,
            codex_model_migration_restore_default_model = 0,
            codex_model_migration_restore_default_effort = 0,
            codex_model_migration_source_model = NULL,
            codex_model_migration_source_effort = NULL,
            codex_model_migration_target_model = NULL,
            codex_model_migration_config_path = NULL,
            codex_model_migration_config_fingerprint = NULL,
            codex_model_migration_config_already_target = 0
        WHERE project_id = ? AND tab_id = ?
          AND codex_model_migration_pending = 1
          AND codex_settings_proof_at = ?
      `).run(
        normalizedModel,
        normalizedEffort,
        normalizedProofAt,
        normalizedProofSessionId,
        projectId,
        tabId,
        normalizedPendingProofAt,
      );
      if (tabUpdate.changes !== 1) {
        return { success: false, error: 'codex_model_migration_generation_changed' };
      }

      const restoreDefault = (key, enabled, value) => {
        if (!enabled) return false;
        const info = this.db.prepare(`
          UPDATE app_state
          SET value = ?, updated_at = strftime('%s', 'now')
          WHERE key = ? AND value = 'none'
        `).run(value, key);
        return info.changes === 1;
      };
      return {
        success: true,
        defaultModelUpdated: restoreDefault(
          'defaultCodexModel',
          pendingState.codex_model_migration_restore_default_model === 1,
          normalizedModel,
        ),
        defaultEffortUpdated: restoreDefault(
          'defaultCodexEffort',
          pendingState.codex_model_migration_restore_default_effort === 1,
          normalizedEffort,
        ),
      };
    });
    return transaction();
  }

  rollbackTabCodexModelMigration(projectId, tabId, {
    proofAt,
    expectedPendingProofAt,
  } = {}) {
    if (arguments.length < 3 || !projectId || !tabId) {
      return { success: false, error: 'codex_model_migration_invalid' };
    }
    const normalizedProofAt = Number(proofAt);
    const normalizedPendingProofAt = Number(expectedPendingProofAt);
    if (!Number.isFinite(normalizedProofAt)
      || normalizedProofAt <= 0
      || !Number.isFinite(normalizedPendingProofAt)
      || normalizedPendingProofAt <= 0) {
      return { success: false, error: 'codex_model_migration_proof_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const pendingState = this.db.prepare(`
        SELECT codex_model_migration_pending,
               codex_settings_proof_at,
               codex_model_migration_restore_default_model,
               codex_model_migration_restore_default_effort,
               codex_model_migration_source_model,
               codex_model_migration_source_effort
        FROM tabs
        WHERE project_id = ? AND tab_id = ?
        LIMIT 1
      `).get(projectId, tabId);
      if (!pendingState) {
        return { success: false, error: 'codex_model_migration_tab_missing' };
      }
      if (pendingState.codex_model_migration_pending !== 1
        || Number(pendingState.codex_settings_proof_at) !== normalizedPendingProofAt) {
        return { success: false, error: 'codex_model_migration_generation_changed' };
      }
      const sourceModel = typeof pendingState.codex_model_migration_source_model === 'string'
        ? pendingState.codex_model_migration_source_model.trim()
        : '';
      const sourceEffort = typeof pendingState.codex_model_migration_source_effort === 'string'
        ? pendingState.codex_model_migration_source_effort.trim().toLowerCase()
        : '';
      if (!sourceModel
        || (pendingState.codex_model_migration_restore_default_effort === 1 && !sourceEffort)) {
        return { success: false, error: 'codex_model_migration_rollback_source_missing' };
      }

      const tabUpdate = this.db.prepare(`
        UPDATE tabs
        SET codex_model = ?,
            codex_effort = ?,
            codex_settings_proof_at = ?,
            codex_settings_proof_session_id = NULL,
            codex_model_migration_pending = 0,
            codex_model_migration_restore_default_model = 0,
            codex_model_migration_restore_default_effort = 0,
            codex_model_migration_source_model = NULL,
            codex_model_migration_source_effort = NULL,
            codex_model_migration_target_model = NULL,
            codex_model_migration_config_path = NULL,
            codex_model_migration_config_fingerprint = NULL,
            codex_model_migration_config_already_target = 0
        WHERE project_id = ? AND tab_id = ?
          AND codex_model_migration_pending = 1
          AND codex_settings_proof_at = ?
      `).run(
        sourceModel,
        sourceEffort || null,
        normalizedProofAt,
        projectId,
        tabId,
        normalizedPendingProofAt,
      );
      if (tabUpdate.changes !== 1) {
        return { success: false, error: 'codex_model_migration_generation_changed' };
      }

      const restoreDefault = (key, enabled, value) => {
        if (!enabled || !value) return false;
        const info = this.db.prepare(`
          UPDATE app_state
          SET value = ?, updated_at = strftime('%s', 'now')
          WHERE key = ? AND value = 'none'
        `).run(value, key);
        return info.changes === 1;
      };
      return {
        success: true,
        model: sourceModel,
        effort: sourceEffort || null,
        defaultModelUpdated: restoreDefault(
          'defaultCodexModel',
          pendingState.codex_model_migration_restore_default_model === 1,
          sourceModel,
        ),
        defaultEffortUpdated: restoreDefault(
          'defaultCodexEffort',
          pendingState.codex_model_migration_restore_default_effort === 1,
          sourceEffort,
        ),
      };
    });
    return transaction();
  }

  settlePendingCodexStableSourceHandoff({
    journalKey,
    projectId,
    tabId,
    sourceSessionId,
    actionGeneration,
    settledAtMs,
  } = {}) {
    const normalizedSettledAtMs = Number(settledAtMs);
    if (!journalKey
      || !projectId
      || !tabId
      || !sourceSessionId
      || !actionGeneration
      || !Number.isFinite(normalizedSettledAtMs)
      || normalizedSettledAtMs <= 0) {
      return { success: false, error: 'codex_stable_source_settlement_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const inspection = this.inspectPendingCodexWriterHandoff(journalKey);
      if (inspection.status === 'absent') {
        return { success: false, error: 'codex_handoff_journal_missing', retryable: true };
      }
      if (inspection.status === 'invalid') {
        return {
          success: false,
          error: inspection.error,
          reason: inspection.reason,
          retryable: false,
        };
      }
      const journal = inspection.journal;
      if (journal.version !== 2
        || journal.projectId !== projectId
        || journal.tabId !== tabId
        || journal.sourceSessionId !== sourceSessionId
        || journal.actionGeneration !== actionGeneration) {
        return { success: false, error: 'codex_handoff_journal_stale', retryable: false };
      }
      const rollbackProofValid = (
        (journal.phase === 'rollback-applied'
          || journal.phase === 'stable-source-settled')
        && Number.isFinite(Number(journal.appliedAtMs))
        && Number(journal.appliedAtMs) >= Number(journal.actionStartedAtMs)
        && journal.restoredTextHash === journal.targetTextHash
      );
      if (!rollbackProofValid) {
        return {
          success: false,
          error: 'codex_stable_source_rollback_proof_missing',
          retryable: false,
        };
      }
      const tabRow = this.db.prepare(
        'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
      ).get(projectId, tabId);
      if (!tabRow) {
        return { success: false, error: 'codex_tab_row_missing', retryable: true };
      }
      if ((tabRow.codex_session_id || null) !== sourceSessionId) {
        return {
          success: false,
          error: 'codex_handoff_binding_changed',
          retryable: false,
          currentSessionId: tabRow.codex_session_id || null,
        };
      }
      if (journal.phase === 'stable-source-settled') {
        return {
          success: true,
          updated: false,
          currentSessionId: sourceSessionId,
          journalRetained: true,
          journal,
        };
      }
      const nextJournal = {
        ...journal,
        phase: 'stable-source-settled',
        stableSourceSettledAtMs: normalizedSettledAtMs,
      };
      const updated = this.db.prepare(`
        UPDATE app_state
        SET value = ?, updated_at = strftime('%s', 'now')
        WHERE key = ? AND value = ?
      `).run(JSON.stringify(nextJournal), journalKey, inspection.rawValue);
      if (updated.changes !== 1) {
        return {
          success: false,
          error: 'codex_stable_source_settlement_compare_and_set_failed',
          retryable: true,
        };
      }
      return {
        success: true,
        updated: true,
        currentSessionId: sourceSessionId,
        journalRetained: true,
        journal: nextJournal,
      };
    });
    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
  }

  armPendingCodexStableSourceSubmit({
    journalKey,
    projectId,
    tabId,
    sourceSessionId,
    actionGeneration,
    submitId,
    expectedLen,
    expectedHash,
    sentAtMs,
    sourceFilePath,
    sourceFileSize,
    runSeq,
  } = {}) {
    const normalizedExpectedLen = Number(expectedLen);
    const normalizedSentAtMs = Number(sentAtMs);
    const normalizedSourceFileSize = sourceFileSize === null
      || sourceFileSize === undefined
      ? null
      : Number(sourceFileSize);
    const normalizedRunSeq = Number(runSeq);
    if (!journalKey
      || !projectId
      || !tabId
      || !sourceSessionId
      || !actionGeneration
      || !submitId
      || !Number.isSafeInteger(normalizedExpectedLen)
      || normalizedExpectedLen < 0
      || !/^[a-f0-9]{16}$/i.test(String(expectedHash || ''))
      || !Number.isFinite(normalizedSentAtMs)
      || normalizedSentAtMs <= 0
      || !path.isAbsolute(String(sourceFilePath || ''))
      || (normalizedSourceFileSize !== null
        && (!Number.isSafeInteger(normalizedSourceFileSize) || normalizedSourceFileSize < 0))
      || !Number.isInteger(normalizedRunSeq)
      || normalizedRunSeq <= 0) {
      return { success: false, error: 'codex_stable_source_submit_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const inspection = this.inspectPendingCodexWriterHandoff(journalKey);
      if (inspection.status !== 'present') {
        return {
          success: false,
          error: inspection.error || 'codex_handoff_journal_missing',
          reason: inspection.reason || null,
          retryable: inspection.status === 'absent',
        };
      }
      const journal = inspection.journal;
      if (journal.version !== 2
        || journal.projectId !== projectId
        || journal.tabId !== tabId
        || journal.sourceSessionId !== sourceSessionId
        || journal.actionGeneration !== actionGeneration) {
        return { success: false, error: 'codex_handoff_journal_stale', retryable: false };
      }
      if (journal.phase === 'stable-source-submit-armed'
        || journal.phase === 'stable-source-submit-written') {
        const existing = journal.submitProof || null;
        const sameSubmit = existing?.submitId === submitId
          && Number(existing.expectedLen) === normalizedExpectedLen
          && existing.expectedHash === expectedHash
          && Number(existing.sentAtMs) === normalizedSentAtMs;
        return sameSubmit
          ? {
              success: true,
              updated: false,
              journal,
              alreadyWritten: journal.phase === 'stable-source-submit-written',
            }
          : {
              success: false,
              error: 'codex_stable_source_submit_already_armed',
              retryable: false,
            };
      }
      if (journal.phase !== 'stable-source-settled'
        || !Number.isFinite(Number(journal.stableSourceSettledAtMs))
        || normalizedSentAtMs < Number(journal.stableSourceSettledAtMs)) {
        return {
          success: false,
          error: 'codex_stable_source_settlement_missing',
          retryable: false,
        };
      }
      const tabRow = this.db.prepare(
        'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
      ).get(projectId, tabId);
      if (!tabRow) return { success: false, error: 'codex_tab_row_missing', retryable: true };
      if ((tabRow.codex_session_id || null) !== sourceSessionId) {
        return {
          success: false,
          error: 'codex_handoff_binding_changed',
          retryable: false,
          currentSessionId: tabRow.codex_session_id || null,
        };
      }
      const nextJournal = {
        ...journal,
        phase: 'stable-source-submit-armed',
        submitProof: {
          version: 1,
          submitId,
          sourceSessionId,
          actionGeneration,
          expectedLen: normalizedExpectedLen,
          expectedHash: String(expectedHash),
          sentAtMs: normalizedSentAtMs,
          sourceFilePath: path.resolve(sourceFilePath),
          sourceFileSize: normalizedSourceFileSize,
          runSeq: normalizedRunSeq,
        },
      };
      const updated = this.db.prepare(`
        UPDATE app_state
        SET value = ?, updated_at = strftime('%s', 'now')
        WHERE key = ? AND value = ?
      `).run(JSON.stringify(nextJournal), journalKey, inspection.rawValue);
      return updated.changes === 1
        ? { success: true, updated: true, journal: nextJournal, alreadyWritten: false }
        : {
            success: false,
            error: 'codex_stable_source_submit_compare_and_set_failed',
            retryable: true,
          };
    });
    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
  }

  markPendingCodexStableSourceSubmitWritten({
    journalKey,
    projectId,
    tabId,
    sourceSessionId,
    actionGeneration,
    submitId,
    submitWrittenAtMs,
  } = {}) {
    const normalizedWrittenAtMs = Number(submitWrittenAtMs);
    if (!journalKey
      || !projectId
      || !tabId
      || !sourceSessionId
      || !actionGeneration
      || !submitId
      || !Number.isFinite(normalizedWrittenAtMs)
      || normalizedWrittenAtMs <= 0) {
      return { success: false, error: 'codex_stable_source_submit_write_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const inspection = this.inspectPendingCodexWriterHandoff(journalKey);
      if (inspection.status !== 'present') {
        return {
          success: false,
          error: inspection.error || 'codex_handoff_journal_missing',
          reason: inspection.reason || null,
          retryable: inspection.status === 'absent',
        };
      }
      const journal = inspection.journal;
      const submitProof = journal.submitProof || null;
      if (journal.version !== 2
        || journal.projectId !== projectId
        || journal.tabId !== tabId
        || journal.sourceSessionId !== sourceSessionId
        || journal.actionGeneration !== actionGeneration
        || submitProof?.submitId !== submitId
        || submitProof?.sourceSessionId !== sourceSessionId
        || submitProof?.actionGeneration !== actionGeneration) {
        return { success: false, error: 'codex_stable_source_submit_stale', retryable: false };
      }
      if (journal.phase === 'stable-source-submit-written') {
        return {
          success: true,
          updated: false,
          journal,
        };
      }
      if (journal.phase !== 'stable-source-submit-armed'
        || normalizedWrittenAtMs < Number(submitProof.sentAtMs)) {
        return {
          success: false,
          error: 'codex_stable_source_submit_not_armed',
          retryable: false,
        };
      }
      const tabRow = this.db.prepare(
        'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
      ).get(projectId, tabId);
      if (!tabRow) return { success: false, error: 'codex_tab_row_missing', retryable: true };
      if ((tabRow.codex_session_id || null) !== sourceSessionId) {
        return {
          success: false,
          error: 'codex_handoff_binding_changed',
          retryable: false,
          currentSessionId: tabRow.codex_session_id || null,
        };
      }
      const nextJournal = {
        ...journal,
        phase: 'stable-source-submit-written',
        submitProof: {
          ...submitProof,
          submitWrittenAtMs: normalizedWrittenAtMs,
        },
      };
      const updated = this.db.prepare(`
        UPDATE app_state
        SET value = ?, updated_at = strftime('%s', 'now')
        WHERE key = ? AND value = ?
      `).run(JSON.stringify(nextJournal), journalKey, inspection.rawValue);
      return updated.changes === 1
        ? { success: true, updated: true, journal: nextJournal }
        : {
            success: false,
            error: 'codex_stable_source_submit_write_compare_and_set_failed',
            retryable: true,
          };
    });
    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
  }

  resolvePendingCodexStableSourceFromTranscript({
    journalKey,
    projectId,
    tabId,
    sourceSessionId,
    actionGeneration,
    targetSourceLine,
    targetTextHash,
    taskStartedSourceLine,
    taskStartedAtMs,
    userMessageSourceLine,
    userMessageTimestampMs,
  } = {}) {
    const targetLine = Number(targetSourceLine);
    const taskLine = Number(taskStartedSourceLine);
    const taskAt = Number(taskStartedAtMs);
    const messageLine = Number(userMessageSourceLine);
    const messageAt = Number(userMessageTimestampMs);
    if (!journalKey
      || !projectId
      || !tabId
      || !sourceSessionId
      || !actionGeneration
      || !Number.isInteger(targetLine)
      || !targetTextHash
      || !Number.isInteger(taskLine)
      || !Number.isFinite(taskAt)
      || !Number.isInteger(messageLine)
      || !Number.isFinite(messageAt)
      || !(targetLine < taskLine && taskLine < messageLine)
      || taskAt > messageAt) {
      return { success: false, error: 'codex_stable_source_transcript_proof_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const inspection = this.inspectPendingCodexWriterHandoff(journalKey);
      if (inspection.status !== 'present') {
        return {
          success: false,
          error: inspection.error || 'codex_handoff_journal_missing',
          retryable: inspection.status === 'absent',
        };
      }
      const journal = inspection.journal;
      const expectedBinding = journal.expectedBindingSessionId || journal.sourceSessionId;
      if (journal.version !== 2
        || journal.phase !== 'confirm-enter-boundary'
        || journal.projectId !== projectId
        || journal.tabId !== tabId
        || journal.sourceSessionId !== sourceSessionId
        || expectedBinding !== sourceSessionId
        || journal.actionGeneration !== actionGeneration
        || Number(journal.targetSourceLine) !== targetLine
        || journal.targetTextHash !== targetTextHash
        || taskAt < Number(journal.actionStartedAtMs)
        || messageAt < Number(journal.actionStartedAtMs)) {
        return { success: false, error: 'codex_handoff_journal_stale', retryable: false };
      }
      const tabRow = this.db.prepare(
        'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
      ).get(projectId, tabId);
      if (!tabRow) {
        return { success: false, error: 'codex_tab_row_missing', retryable: true };
      }
      if ((tabRow.codex_session_id || null) !== sourceSessionId) {
        return {
          success: false,
          error: 'codex_handoff_binding_changed',
          retryable: false,
          currentSessionId: tabRow.codex_session_id || null,
        };
      }
      const removed = this.db.prepare(
        'DELETE FROM app_state WHERE key = ? AND value = ?'
      ).run(journalKey, inspection.rawValue);
      if (removed.changes !== 1) {
        return {
          success: false,
          error: 'codex_stable_source_transcript_compare_and_delete_failed',
          retryable: true,
        };
      }
      return {
        success: true,
        updated: false,
        currentSessionId: sourceSessionId,
        journalCleared: true,
      };
    });
    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
  }

  releasePendingCodexStableSourceSubmit({
    journalKey,
    projectId,
    tabId,
    sourceSessionId,
    actionGeneration,
    submitId,
  } = {}) {
    if (!journalKey
      || !projectId
      || !tabId
      || !sourceSessionId
      || !actionGeneration
      || !submitId) {
      return { success: false, error: 'codex_stable_source_submit_release_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const inspection = this.inspectPendingCodexWriterHandoff(journalKey);
      if (inspection.status !== 'present') {
        return {
          success: false,
          error: inspection.error || 'codex_handoff_journal_missing',
          retryable: inspection.status === 'absent',
        };
      }
      const journal = inspection.journal;
      if (journal.projectId !== projectId
        || journal.tabId !== tabId
        || journal.sourceSessionId !== sourceSessionId
        || journal.actionGeneration !== actionGeneration
        || journal.submitProof?.submitId !== submitId) {
        return { success: false, error: 'codex_stable_source_submit_stale', retryable: false };
      }
      if (journal.phase === 'stable-source-submit-written') {
        return {
          success: false,
          error: 'codex_stable_source_submit_may_have_been_written',
          retryable: false,
        };
      }
      if (journal.phase !== 'stable-source-submit-armed') {
        return { success: false, error: 'codex_stable_source_submit_not_armed', retryable: false };
      }
      const nextJournal = { ...journal, phase: 'stable-source-settled' };
      delete nextJournal.submitProof;
      const updated = this.db.prepare(`
        UPDATE app_state
        SET value = ?, updated_at = strftime('%s', 'now')
        WHERE key = ? AND value = ?
      `).run(JSON.stringify(nextJournal), journalKey, inspection.rawValue);
      return updated.changes === 1
        ? { success: true, updated: true, journal: nextJournal }
        : {
            success: false,
            error: 'codex_stable_source_submit_release_compare_and_set_failed',
            retryable: true,
          };
    });
    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
  }

  commitPendingCodexWriterHandoff({
    journalKey,
    receiptKey = null,
    projectId,
    tabId,
    sourceSessionId,
    nextSessionId,
    actionGeneration,
  } = {}) {
    if (!journalKey || !projectId || !tabId || !sourceSessionId || !nextSessionId || !actionGeneration) {
      return { success: false, error: 'codex_handoff_commit_invalid' };
    }
    if (sourceSessionId === nextSessionId) {
      return {
        success: false,
        error: 'codex_handoff_stable_source_requires_settlement',
        retryable: false,
      };
    }
    if (receiptKey && receiptKey !== CODEX_REWIND_COMMIT_RECEIPT_KEY_PREFIX + tabId) {
      return { success: false, error: 'codex_rewind_commit_receipt_key_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const journalInspection = this.inspectPendingCodexWriterHandoff(journalKey);
      if (journalInspection.status === 'absent') {
        return { success: false, error: 'codex_handoff_journal_missing', retryable: true };
      }
      if (journalInspection.status === 'invalid') {
        return {
          success: false,
          error: journalInspection.error,
          reason: journalInspection.reason,
          retryable: false,
        };
      }
      const journal = journalInspection.journal;
      if (journal?.projectId !== projectId
        || journal?.tabId !== tabId
        || journal?.sourceSessionId !== sourceSessionId
        || journal?.actionGeneration !== actionGeneration) {
        return { success: false, error: 'codex_handoff_journal_stale', retryable: false };
      }

      // `sourceSessionId` is the rollout on which native Rewind actually ran.
      // For a quarantined manual writer that source is intentionally different
      // from the durable tab binding. The journal captures both identities at
      // the pre-Enter boundary; only the durable expectation participates in
      // the SQLite CAS.
      const expectedBindingSessionId = journal.expectedBindingSessionId || sourceSessionId;
      const replacementCandidateSessionId = journal.replacementCandidateProof?.sessionId || null;
      if (replacementCandidateSessionId && replacementCandidateSessionId !== nextSessionId) {
        return {
          success: false,
          error: 'codex_handoff_replacement_candidate_changed',
          retryable: false,
          replacementCandidateSessionId,
        };
      }
      let receiptContext = null;
      if (receiptKey) {
        const operationId = String(journal.operationId || actionGeneration || '').trim();
        const requestId = String(journal.requestId || actionGeneration || '').trim();
        const sourceLifecycleGeneration = String(journal.sourceLifecycleGeneration || '').trim();
        const sourceRunSeq = Number(journal.sourceRunSeq);
        if (!operationId
          || !requestId
          || !sourceLifecycleGeneration
          || !Number.isInteger(sourceRunSeq)
          || sourceRunSeq <= 0
          || journal.version !== 2
          || !journal.targetUuid
          || !Number.isInteger(Number(journal.targetSourceLine))
          || !journal.targetTextHash
          || !Number.isInteger(Number(journal.rollbackTurns))) {
          return {
            success: false,
            error: 'codex_rewind_commit_receipt_context_invalid',
            retryable: false,
          };
        }
        receiptContext = {
          operationId,
          requestId,
          sourceLifecycleGeneration,
          sourceRunSeq,
        };
      }

      const tabRow = this.db.prepare(
        'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
      ).get(projectId, tabId);
      if (!tabRow) {
        return { success: false, error: 'codex_tab_row_missing', retryable: true };
      }
      const currentSessionId = tabRow.codex_session_id || null;
      if (currentSessionId !== expectedBindingSessionId && currentSessionId !== nextSessionId) {
        return {
          success: false,
          error: 'codex_handoff_binding_changed',
          retryable: false,
          currentSessionId,
        };
      }
      if (currentSessionId === expectedBindingSessionId) {
        const updated = this.db.prepare(
          'UPDATE tabs SET codex_session_id = ? WHERE project_id = ? AND tab_id = ? AND codex_session_id IS ?'
        ).run(nextSessionId, projectId, tabId, expectedBindingSessionId);
        if (updated.changes !== 1) {
          return { success: false, error: 'codex_handoff_compare_and_set_failed', retryable: true };
        }
      }
      let commitReceipt = null;
      if (receiptKey && receiptContext) {
        const committedAtMs = Date.now();
        commitReceipt = {
          version: 1,
          kind: 'codex-native-rewind-commit',
          phase: 'committed',
          receiptId: crypto.randomUUID(),
          projectId,
          originProjectId: journal.originProjectId || projectId,
          tabId,
          operationId: receiptContext.operationId,
          requestId: receiptContext.requestId,
          actionGeneration,
          sourceSessionId,
          childSessionId: nextSessionId,
          expectedBindingSessionId,
          sourceLifecycleGeneration: receiptContext.sourceLifecycleGeneration,
          sourceRunSeq: receiptContext.sourceRunSeq,
          targetUuid: journal.targetUuid,
          targetSourceLine: Number(journal.targetSourceLine),
          targetTextHash: journal.targetTextHash,
          rollbackTurns: Number(journal.rollbackTurns),
          actionStartedAtMs: Number(journal.actionStartedAtMs),
          committedAtMs,
        };
        this.db.prepare(`
          INSERT INTO app_state (key, value, updated_at)
          VALUES (?, ?, strftime('%s', 'now'))
          ON CONFLICT(key) DO UPDATE
          SET value = excluded.value, updated_at = excluded.updated_at
        `).run(receiptKey, JSON.stringify(commitReceipt));
      }
      this.db.prepare('DELETE FROM app_state WHERE key = ?').run(journalKey);
      return {
        success: true,
        updated: currentSessionId === expectedBindingSessionId,
        currentSessionId,
        expectedBindingSessionId,
        journalCleared: true,
        receiptWritten: !!commitReceipt,
        commitReceipt,
      };
    });

    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
  }

  recordPendingCodexRewindReplacementCandidate({
    journalKey,
    projectId,
    tabId,
    sourceSessionId,
    candidateSessionId,
    actionGeneration,
    candidateCreatedAtMs,
    observedAtMs,
    retainedPrefixLength,
    postActionMessageCount,
  } = {}) {
    const createdAt = Number(candidateCreatedAtMs);
    const observedAt = Number(observedAtMs);
    const retainedCount = Number(retainedPrefixLength);
    const postActionCount = Number(postActionMessageCount);
    if (!journalKey
      || !projectId
      || !tabId
      || !sourceSessionId
      || !candidateSessionId
      || candidateSessionId === sourceSessionId
      || !actionGeneration
      || !Number.isFinite(createdAt)
      || !Number.isFinite(observedAt)
      || observedAt < createdAt
      || !Number.isInteger(retainedCount)
      || retainedCount < 0
      || !Number.isInteger(postActionCount)
      || postActionCount < 0) {
      return { success: false, error: 'codex_rewind_replacement_candidate_invalid' };
    }
    const transaction = this.db.transaction(() => {
      const inspection = this.inspectPendingCodexWriterHandoff(journalKey);
      if (inspection.status !== 'present') {
        return {
          success: false,
          error: inspection.error || 'codex_handoff_journal_missing',
          reason: inspection.reason || null,
          retryable: inspection.status === 'absent',
        };
      }
      const journal = inspection.journal;
      if (journal.version !== 2
        || journal.projectId !== projectId
        || journal.tabId !== tabId
        || journal.sourceSessionId !== sourceSessionId
        || journal.actionGeneration !== actionGeneration
        || createdAt < Number(journal.actionStartedAtMs)) {
        return { success: false, error: 'codex_handoff_journal_stale', retryable: false };
      }
      const expectedBindingSessionId = journal.expectedBindingSessionId || sourceSessionId;
      const tabRow = this.db.prepare(
        'SELECT codex_session_id FROM tabs WHERE project_id = ? AND tab_id = ? LIMIT 1'
      ).get(projectId, tabId);
      if (!tabRow) return { success: false, error: 'codex_tab_row_missing', retryable: true };
      const currentSessionId = tabRow.codex_session_id || null;
      if (currentSessionId !== expectedBindingSessionId
        && currentSessionId !== candidateSessionId) {
        return {
          success: false,
          error: 'codex_handoff_binding_changed',
          retryable: false,
          currentSessionId,
        };
      }

      const existing = journal.replacementCandidateProof || null;
      if (existing) {
        return existing.sessionId === candidateSessionId
          ? { success: true, updated: false, journal, proof: existing }
          : {
              success: false,
              error: 'codex_rewind_replacement_candidate_ambiguous',
              retryable: false,
              existingSessionId: existing.sessionId,
            };
      }
      const proof = {
        version: 1,
        kind: 'rewind-replacement',
        sessionId: candidateSessionId,
        sourceSessionId,
        actionGeneration,
        candidateCreatedAtMs: createdAt,
        observedAtMs: observedAt,
        targetUuid: journal.targetUuid,
        targetSourceLine: Number(journal.targetSourceLine),
        targetTextHash: journal.targetTextHash,
        rollbackTurns: Number(journal.rollbackTurns),
        retainedPrefixLength: retainedCount,
        postActionMessageCount: postActionCount,
        retainedPrefixExact: true,
        suffixAfterAction: true,
      };
      const nextJournal = { ...journal, replacementCandidateProof: proof };
      const updated = this.db.prepare(`
        UPDATE app_state
        SET value = ?, updated_at = strftime('%s', 'now')
        WHERE key = ? AND value = ?
      `).run(JSON.stringify(nextJournal), journalKey, inspection.rawValue);
      return updated.changes === 1
        ? { success: true, updated: true, journal: nextJournal, proof }
        : {
            success: false,
            error: 'codex_rewind_replacement_candidate_compare_and_set_failed',
            retryable: true,
          };
    });
    try {
      return transaction();
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        retryable: true,
      };
    }
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
    const { name, description, geminiPrompt, path: newPath, icon, hideName } = metadata;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (geminiPrompt !== undefined) { updates.push('gemini_prompt = ?'); params.push(geminiPrompt); }
    if (newPath !== undefined) { updates.push('path = ?'); params.push(newPath); }
    if (icon !== undefined) { updates.push('icon = ?'); params.push(icon || null); }
    if (hideName !== undefined) { updates.push('hide_name = ?'); params.push(hideName ? 1 : 0); }

    if (updates.length > 0) {
      params.push(projectId);
      this.db.prepare(`UPDATE projects SET ${updates.join(', ')}, updated_at = strftime('%s', 'now') WHERE id = ?`).run(...params);
    }
    return { success: true };
  }

  getProjectPromptSources(projectId) {
    if (!projectId) return [];
    return this.db.prepare(`
      SELECT id, project_id, root_path, position, created_at, updated_at
      FROM project_prompt_sources
      WHERE project_id = ?
      ORDER BY position ASC, id ASC
    `).all(projectId).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      rootPath: row.root_path,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getProjectsWithPromptSources() {
    return this.db.prepare(`
      SELECT DISTINCT p.id, p.name, p.path, p.icon, p.updated_at
      FROM projects p
      INNER JOIN project_prompt_sources s ON s.project_id = p.id
      ORDER BY p.updated_at DESC, p.id ASC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      icon: row.icon || null,
      updatedAt: row.updated_at,
    }));
  }

  saveProjectPromptSources(projectId, roots) {
    if (!projectId || !Array.isArray(roots)) return [];
    const projectExists = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!projectExists) throw new Error('project_not_found');

    const normalized = [];
    const seen = new Set();
    for (const value of roots) {
      const raw = typeof value === 'string' ? value : value?.rootPath;
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const rootPath = path.resolve(raw.trim());
      if (seen.has(rootPath)) continue;
      seen.add(rootPath);
      normalized.push(rootPath);
    }

    const save = this.db.transaction(() => {
      this.db.prepare('DELETE FROM project_prompt_sources WHERE project_id = ?').run(projectId);
      const insert = this.db.prepare(`
        INSERT INTO project_prompt_sources (project_id, root_path, position)
        VALUES (?, ?, ?)
      `);
      normalized.forEach((rootPath, position) => insert.run(projectId, rootPath, position));
    });
    save();
    return this.getProjectPromptSources(projectId);
  }

  rewriteFilePathReferences(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return { changed: 0 };
    const rewrite = (value) => {
      if (typeof value !== 'string') return value;
      if (value === oldPath) return newPath;
      return value.startsWith(oldPath + path.sep)
        ? newPath + value.slice(oldPath.length)
        : value;
    };
    let changed = 0;
    const run = this.db.transaction(() => {
      for (const table of ['tabs', 'tab_history']) {
        if (!this._tableColumns(table).has('file_path')) continue;
        changed += this.db.prepare(`UPDATE ${table} SET file_path = ? WHERE file_path = ?`)
          .run(newPath, oldPath).changes;
      }
      changed += this.db.prepare('UPDATE projects SET open_file_path = ? WHERE open_file_path = ?')
        .run(newPath, oldPath).changes;

      const rewriteJsonPaths = (table, idColumn = 'id') => {
        if (!this._tableColumns(table).has('file_paths')) return;
        const rows = this.db.prepare(`SELECT ${idColumn} AS row_id, file_paths FROM ${table} WHERE file_paths IS NOT NULL`).all();
        const update = this.db.prepare(`UPDATE ${table} SET file_paths = ? WHERE ${idColumn} = ?`);
        for (const row of rows) {
          try {
            const values = JSON.parse(row.file_paths);
            if (!Array.isArray(values)) continue;
            const next = values.map(rewrite);
            if (JSON.stringify(values) === JSON.stringify(next)) continue;
            update.run(JSON.stringify(next), row.row_id);
            changed += 1;
          } catch { /* preserve malformed legacy JSON */ }
        }
      };
      rewriteJsonPaths('prompts');
      rewriteJsonPaths('ai_prompts');
    });
    run();
    return { changed };
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

  updateProjectTabListScrollTop(projectId, scrollTop) {
    const normalized = Number.isFinite(Number(scrollTop)) ? Math.max(0, Number(scrollTop)) : 0;
    this.db.prepare('UPDATE projects SET tab_list_scroll_top = ? WHERE id = ?').run(normalized, projectId);
  }

  updateProjectTabGroups(projectId, groups) {
    const json = Array.isArray(groups) && groups.length > 0 ? JSON.stringify(groups) : null;
    this.db.prepare('UPDATE projects SET tab_groups = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(json, projectId);
  }

  deleteProject(projectId) {
    this.db.prepare('DELETE FROM project_prompt_sources WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    return true;
  }

  // ========== TABS ========== 

  saveTabs(projectId, tabs, forceCleanup = false, preserveInterrupted = false) {
    // Check if project exists to avoid FOREIGN KEY constraint error
    const projectExists = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!projectExists) {
      console.warn('[DB] saveTabs: project not found, skipping:', projectId);
      return { success: false, error: 'project_not_found' };
    }
    if (!Array.isArray(tabs)) {
      return { success: false, error: 'tabs_payload_invalid' };
    }
    const rawIncomingTabIds = tabs.map((tab) => typeof tab?.tabId === 'string' ? tab.tabId : '');
    const incomingTabIds = rawIncomingTabIds.map((tabId) => tabId.trim());
    if (incomingTabIds.some((tabId) => !tabId)
      || rawIncomingTabIds.some((tabId, index) => tabId !== incomingTabIds[index])) {
      return { success: false, error: 'tab_id_required' };
    }
    if (new Set(incomingTabIds).size !== incomingTabIds.length) {
      return { success: false, error: 'duplicate_tab_id_in_project_snapshot' };
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

    // Same snapshot-preserve idea, for the tab-visit timestamp. The renderer
    // sends `lastActivatedAt` on activation, but every OTHER saveTabs call
    // (rename, colour, notes, reorder) omits it — without this snapshot a full
    // reinsert would erase the visit order the switcher depends on.
    // NEVER-DOWNGRADE: only a strictly newer timestamp may replace the stored
    // one, so a stale payload cannot move a tab backwards in the MRU.
    const lastActivatedSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, last_activated_at FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) lastActivatedSnapshot.set(r.tab_id, r.last_activated_at);
    }

    // Same snapshot-preserve as context_pct: the renderer's saveTabs payload does
    // not carry cacheStats (written point-wise via updateTabCacheStats), so a full
    // reinsert from an unrelated change must not wipe the cooldown chip's data.
    const cacheStatsSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, cache_stats FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) cacheStatsSnapshot.set(r.tab_id, r.cache_stats);
    }

    // Provider state is main-owned and point-written before the IPC call that
    // changed it resolves. A subsequent renderer action (for example Start,
    // which sets command_type) can immediately trigger a full save carrying
    // the older tab projection. Preserve the row value for existing tabs so
    // that unrelated saves cannot erase a just-selected next-launch pair or
    // resurrect one that main already consumed after a proven startup.
    const providerStateSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, provider_state FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) providerStateSnapshot.set(r.tab_id, r.provider_state);
    }

    // Task-plan writes can arrive directly from Terminal MCP while the renderer
    // still holds an older tab snapshot. Keep the document with the highest
    // revision so an unrelated rename/save cannot roll an MCP edit back.
    const taskPlanSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, task_plan FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) taskPlanSnapshot.set(r.tab_id, r.task_plan);
    }

    // Codex session identity has a main-owned point-write path. Preserve the
    // current value for every existing row so a delayed full renderer save
    // cannot replace a proven writer with its stale resume/source snapshot.
    // A tab absent from this snapshot is new and may seed its incoming ID.
    const codexSessionSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, codex_session_id FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) codexSessionSnapshot.set(r.tab_id, r.codex_session_id);
    }

    // Same protection for Claude. A renderer save carries whatever the tab
    // array held when it was built; if the bridge assigned a new session id to
    // another tab in between, that id must not be rolled back by this write.
    // A new tab (absent here) may still seed its incoming id.
    const claudeSessionSnapshot = new Map();
    {
      const rows = this.db.prepare('SELECT tab_id, claude_session_id FROM tabs WHERE project_id = ? AND tab_id IS NOT NULL').all(projectId);
      for (const r of rows) claudeSessionSnapshot.set(r.tab_id, r.claude_session_id);
    }

    // Main can point-write an exact model/effort proof before renderer receives
    // the matching IPC event. Preserve whichever side has the newer proof
    // timestamp so an unrelated stale full save cannot resurrect old launch
    // arguments. Equal timestamps intentionally allow renderer to attach the
    // later-proven writer owner without changing the already-proven pair.
    const codexSettingsSnapshot = new Map();
    {
      const rows = this.db.prepare(`
        SELECT tab_id,
               codex_model,
               codex_effort,
               codex_settings_proof_at,
               codex_settings_proof_session_id,
               codex_model_migration_pending,
               codex_model_migration_restore_default_model,
               codex_model_migration_restore_default_effort,
               codex_model_migration_source_model,
               codex_model_migration_source_effort,
               codex_model_migration_target_model,
               codex_model_migration_config_path,
               codex_model_migration_config_fingerprint,
               codex_model_migration_config_already_target
        FROM tabs
        WHERE project_id = ? AND tab_id IS NOT NULL
      `).all(projectId);
      for (const r of rows) {
        codexSettingsSnapshot.set(r.tab_id, {
          model: r.codex_model,
          effort: r.codex_effort,
          proofAt: Number(r.codex_settings_proof_at) || null,
          proofSessionId: r.codex_settings_proof_session_id || null,
          modelMigrationPending: r.codex_model_migration_pending === 1,
          restoreDefaultModel: r.codex_model_migration_restore_default_model === 1,
          restoreDefaultEffort: r.codex_model_migration_restore_default_effort === 1,
          sourceModel: r.codex_model_migration_source_model || null,
          sourceEffort: r.codex_model_migration_source_effort || null,
          targetModel: r.codex_model_migration_target_model || null,
          configPath: r.codex_model_migration_config_path || null,
          configFingerprint: r.codex_model_migration_config_fingerprint || null,
          configAlreadyTarget: r.codex_model_migration_config_already_target === 1,
        });
      }
    }

    const deleteByTabId = this.db.prepare('DELETE FROM tabs WHERE project_id = ? AND tab_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO tabs (project_id, name, name_set_manually, cwd, position, color, is_utility, command_type, claude_session_id, gemini_session_id, codex_session_id, codex_model, codex_effort, codex_settings_proof_at, codex_settings_proof_session_id, codex_model_migration_pending, codex_model_migration_restore_default_model, codex_model_migration_restore_default_effort, codex_model_migration_source_model, codex_model_migration_source_effort, codex_model_migration_target_model, codex_model_migration_config_path, codex_model_migration_config_fingerprint, codex_model_migration_config_already_target, external_run, was_interrupted, overlay_dismissed, notes, task_plan, tab_type, url, file_path, terminal_id, terminal_name, active_view, created_at, is_collapsed, tab_group_id, visual_parent_tab_id, tab_id, session_status, completion_notification_persistent, restart_after_tab_id, restart_after_tab_ids, restart_after_command, restart_after_paused, restart_after_armed, restart_after_persistent, claude_session_history, provider_state, context_pct, cache_stats, last_activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        const incomingProviderStateJson = tab.providerState && (
          tab.providerState.type !== 'anthropic' ||
          tab.providerState.model ||
          tab.providerState.effort ||
          tab.providerState.thinking ||
          tab.providerState.startupModel ||
          tab.providerState.startupEffort
        ) ? JSON.stringify(tab.providerState) : null;
        const providerStateJson = providerStateSnapshot.has(tab.tabId)
          ? providerStateSnapshot.get(tab.tabId)
          : incomingProviderStateJson;
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
        const codexSessionId = codexSessionSnapshot.has(tab.tabId)
          ? codexSessionSnapshot.get(tab.tabId)
          : (tab.codexSessionId || null);
        const claudeSessionId = claudeSessionSnapshot.has(tab.tabId)
          ? claudeSessionSnapshot.get(tab.tabId)
          : (tab.claudeSessionId || null);
        const incomingCodexSettings = {
          model: tab.codexModel || null,
          effort: tab.codexEffort || null,
          proofAt: Number(tab.codexSettingsProofAt) || null,
          proofSessionId: tab.codexSettingsProofSessionId || null,
          modelMigrationPending: tab.codexModelMigrationPending === true,
          restoreDefaultModel: tab.codexModelMigrationRestoreDefaultModel === true,
          restoreDefaultEffort: tab.codexModelMigrationRestoreDefaultEffort === true,
          sourceModel: tab.codexModelMigrationSourceModel || null,
          sourceEffort: tab.codexModelMigrationSourceEffort || null,
          targetModel: tab.codexModelMigrationTargetModel || null,
          configPath: tab.codexModelMigrationConfigPath || null,
          configFingerprint: tab.codexModelMigrationConfigFingerprint || null,
          configAlreadyTarget: tab.codexModelMigrationConfigAlreadyTarget === true,
        };
        // Never-downgrade tab-visit time: keep whichever is newer. A payload
        // without lastActivatedAt (rename/colour/reorder) keeps the stored one.
        const incomingActivatedAt = Number(tab.lastActivatedAt);
        const storedActivatedAt = Number(lastActivatedSnapshot.get(tab.tabId));
        const lastActivatedAt = Math.max(
          Number.isFinite(incomingActivatedAt) ? incomingActivatedAt : 0,
          Number.isFinite(storedActivatedAt) ? storedActivatedAt : 0,
        ) || null;
        const persistedCodexSettings = codexSettingsSnapshot.get(tab.tabId) || null;
        let codexSettings = persistedCodexSettings
          && (
            // A renderer snapshot never owns a pending migration journal.
            // Only the main-process ACK/recovery paths may settle it.
            persistedCodexSettings.modelMigrationPending === true
            || Number(persistedCodexSettings.proofAt || 0) > Number(incomingCodexSettings.proofAt || 0)
          )
          ? persistedCodexSettings
          : incomingCodexSettings;
        insert.run(projectId, tab.name, tab.nameSetManually ? 1 : 0, tab.cwd, index, tab.color || null, tab.isUtility ? 1 : 0, tab.commandType || null, claudeSessionId, tab.geminiSessionId || null, codexSessionId, codexSettings.model, codexSettings.effort, codexSettings.proofAt, codexSettings.proofSessionId, codexSettings.modelMigrationPending ? 1 : 0, codexSettings.restoreDefaultModel ? 1 : 0, codexSettings.restoreDefaultEffort ? 1 : 0, codexSettings.sourceModel, codexSettings.sourceEffort, codexSettings.targetModel, codexSettings.configPath, codexSettings.configFingerprint, codexSettings.configAlreadyTarget ? 1 : 0, externalRunJson, interruptedFlag, tab.overlayDismissed ? 1 : 0, tab.notes || '', taskPlanJson, tab.tabType || 'terminal', tab.url || null, tab.filePath || null, tab.terminalId || null, tab.terminalName || null, tab.activeView || null, tab.createdAt || null, tab.isCollapsed ? 1 : 0, tab.groupId || null, tab.visualParentTabId || null, tab.tabId || null, tab.sessionStatus || null, tab.completionNotificationPersistent ? 1 : 0, restartAfterIds[0] || null, restartAfterIdsJson, tab.restartAfterCommand || null, tab.restartAfterPaused ? 1 : 0, tab.restartAfterArmed ? 1 : 0, tab.restartAfterPersistent ? 1 : 0, historyJson, providerStateJson, ctxPct, cacheStatsJson, lastActivatedAt);
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
    return { success: true };
  }

  transferTabsToProject(sourceProjectId, targetProjectId, tabIds) {
    const ids = Array.from(new Set(
      (Array.isArray(tabIds) ? tabIds : [])
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim())
    ));
    if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId || ids.length === 0) {
      return { success: false, error: 'invalid_tab_project_transfer' };
    }

    const transfer = this.db.transaction(() => {
      const sourceExists = this.db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(sourceProjectId);
      const targetExists = this.db.prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(targetProjectId);
      if (!sourceExists?.ok || !targetExists?.ok) {
        return { success: false, error: 'tab_project_not_found' };
      }

      const placeholders = ids.map(() => '?').join(',');
      const sourceRows = this.db.prepare(
        `SELECT id, tab_id, visual_parent_tab_id
         FROM tabs
         WHERE project_id = ? AND tab_id IN (${placeholders})
         ORDER BY position, id`
      ).all(sourceProjectId, ...ids);
      const foundIds = new Set(sourceRows.map((row) => row.tab_id));
      const missing = ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0 || sourceRows.length !== ids.length) {
        return { success: false, error: 'tab_project_source_rows_missing', missing };
      }

      const collisions = this.db.prepare(
        `SELECT tab_id FROM tabs WHERE project_id = ? AND tab_id IN (${placeholders})`
      ).all(targetProjectId, ...ids);
      if (collisions.length > 0) {
        return {
          success: false,
          error: 'tab_project_target_collision',
          collisions: collisions.map((row) => row.tab_id),
        };
      }

      const journalMigration = this._migratePendingCodexWriterHandoffsInTransaction({
        sourceProjectId,
        targetProjectId,
        tabIds: ids,
      });
      if (!journalMigration.success) return journalMigration;

      const targetMax = Number(this.db.prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_position FROM tabs WHERE project_id = ?'
      ).get(targetProjectId)?.max_position ?? -1);
      const update = this.db.prepare(`
        UPDATE tabs
        SET project_id = ?, position = ?, is_utility = 0,
            tab_group_id = NULL, visual_parent_tab_id = ?
        WHERE project_id = ? AND tab_id = ?
      `);
      const movedSet = new Set(ids);
      sourceRows.forEach((row, index) => {
        const retainedParent = row.visual_parent_tab_id && movedSet.has(row.visual_parent_tab_id)
          ? row.visual_parent_tab_id
          : null;
        const info = update.run(
          targetProjectId,
          targetMax + index + 1,
          retainedParent,
          sourceProjectId,
          row.tab_id
        );
        if (info.changes !== 1) throw new Error('tab_project_transfer_lost_source_row:' + row.tab_id);
      });

      // Tabs left behind cannot keep a visual-parent pointer to a tab that now
      // belongs to another workspace. The renderer performs the same repair in
      // memory after this durable commit.
      this.db.prepare(
        `UPDATE tabs SET visual_parent_tab_id = NULL
         WHERE project_id = ? AND visual_parent_tab_id IN (${placeholders})`
      ).run(sourceProjectId, ...ids);
      const sourceProject = this.db.prepare('SELECT tab_groups FROM projects WHERE id = ?').get(sourceProjectId);
      if (sourceProject?.tab_groups) {
        try {
          const groups = JSON.parse(sourceProject.tab_groups);
          if (Array.isArray(groups)) {
            let changed = false;
            const nextGroups = groups.map((group) => {
              if (!group?.anchorTabId || !movedSet.has(group.anchorTabId)) return group;
              changed = true;
              const { anchorTabId, ...rest } = group;
              return rest;
            });
            if (changed) {
              this.db.prepare('UPDATE projects SET tab_groups = ? WHERE id = ?')
                .run(JSON.stringify(nextGroups), sourceProjectId);
            }
          }
        } catch { /* preserve malformed legacy JSON */ }
      }
      this.db.prepare("UPDATE projects SET updated_at = strftime('%s', 'now') WHERE id IN (?, ?)")
        .run(sourceProjectId, targetProjectId);
      return { success: true, transferred: ids };
    });

    try {
      return transfer();
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  transferTabGroupToProject(
    sourceProjectId,
    targetProjectId,
    groupId,
    targetGroupId,
    expectedTabIds = null
  ) {
    const normalizeIds = (values) => Array.from(new Set(
      (Array.isArray(values) ? values : [])
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim())
    ));
    if (
      !sourceProjectId
      || !targetProjectId
      || sourceProjectId === targetProjectId
      || typeof groupId !== 'string'
      || !groupId.trim()
      || typeof targetGroupId !== 'string'
      || !targetGroupId.trim()
    ) {
      return { success: false, error: 'invalid_tab_group_project_transfer' };
    }

    const transfer = this.db.transaction(() => {
      const sourceProject = this.db.prepare('SELECT tab_groups FROM projects WHERE id = ?').get(sourceProjectId);
      const targetProject = this.db.prepare('SELECT tab_groups FROM projects WHERE id = ?').get(targetProjectId);
      if (!sourceProject || !targetProject) {
        return { success: false, error: 'tab_group_project_not_found' };
      }

      const parseGroups = (raw) => {
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('tab_group_state_invalid');
        return parsed;
      };
      let sourceGroups;
      let targetGroups;
      try {
        sourceGroups = parseGroups(sourceProject.tab_groups);
        targetGroups = parseGroups(targetProject.tab_groups);
      } catch (error) {
        return { success: false, error: error?.message || 'tab_group_state_invalid' };
      }

      const sourceGroupIndex = sourceGroups.findIndex((group) => group?.id === groupId);
      if (sourceGroupIndex < 0) {
        return { success: false, error: 'tab_group_source_missing' };
      }
      if (targetGroups.some((group) => group?.id === targetGroupId)) {
        return { success: false, error: 'tab_group_target_collision' };
      }

      const sourceRows = this.db.prepare(`
        SELECT id, tab_id, visual_parent_tab_id
        FROM tabs
        WHERE project_id = ? AND tab_group_id = ?
        ORDER BY position, id
      `).all(sourceProjectId, groupId);
      const rowTabIds = sourceRows.map((row) => row.tab_id).filter(Boolean);
      if (rowTabIds.length !== sourceRows.length) {
        return { success: false, error: 'tab_group_tab_identity_missing' };
      }

      if (Array.isArray(expectedTabIds)) {
        const expectedIds = normalizeIds(expectedTabIds);
        const found = new Set(rowTabIds);
        const expected = new Set(expectedIds);
        if (
          expectedIds.length !== rowTabIds.length
          || expectedIds.some((id) => !found.has(id))
          || rowTabIds.some((id) => !expected.has(id))
        ) {
          return {
            success: false,
            error: 'tab_group_source_rows_changed',
            expected: expectedIds,
            found: rowTabIds,
          };
        }
      }

      if (rowTabIds.length > 0) {
        const placeholders = rowTabIds.map(() => '?').join(',');
        const collisions = this.db.prepare(
          `SELECT tab_id FROM tabs WHERE project_id = ? AND tab_id IN (${placeholders})`
        ).all(targetProjectId, ...rowTabIds);
        if (collisions.length > 0) {
          return {
            success: false,
            error: 'tab_group_target_tab_collision',
            collisions: collisions.map((row) => row.tab_id),
          };
        }

        const journalMigration = this._migratePendingCodexWriterHandoffsInTransaction({
          sourceProjectId,
          targetProjectId,
          tabIds: rowTabIds,
        });
        if (!journalMigration.success) return journalMigration;

        const targetMax = Number(this.db.prepare(
          'SELECT COALESCE(MAX(position), -1) AS max_position FROM tabs WHERE project_id = ?'
        ).get(targetProjectId)?.max_position ?? -1);
        const movedSet = new Set(rowTabIds);
        const update = this.db.prepare(`
          UPDATE tabs
          SET project_id = ?, position = ?, is_utility = 0,
              tab_group_id = ?, visual_parent_tab_id = ?
          WHERE project_id = ? AND tab_id = ?
        `);
        sourceRows.forEach((row, index) => {
          const retainedParent = row.visual_parent_tab_id && movedSet.has(row.visual_parent_tab_id)
            ? row.visual_parent_tab_id
            : null;
          const info = update.run(
            targetProjectId,
            targetMax + index + 1,
            targetGroupId,
            retainedParent,
            sourceProjectId,
            row.tab_id
          );
          if (info.changes !== 1) {
            throw new Error('tab_group_project_transfer_lost_source_row:' + row.tab_id);
          }
        });

        this.db.prepare(
          `UPDATE tabs SET visual_parent_tab_id = NULL
           WHERE project_id = ? AND visual_parent_tab_id IN (${placeholders})`
        ).run(sourceProjectId, ...rowTabIds);
      }

      const sourceGroup = sourceGroups[sourceGroupIndex];
      const { anchorTabId: _sourceAnchor, ...groupWithoutAnchor } = sourceGroup;
      const targetGroup = { ...groupWithoutAnchor, id: targetGroupId };
      const nextSourceGroups = sourceGroups.filter((_, index) => index !== sourceGroupIndex);
      const nextTargetGroups = [...targetGroups, targetGroup];
      this.db.prepare('UPDATE projects SET tab_groups = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?')
        .run(nextSourceGroups.length > 0 ? JSON.stringify(nextSourceGroups) : null, sourceProjectId);
      this.db.prepare('UPDATE projects SET tab_groups = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?')
        .run(JSON.stringify(nextTargetGroups), targetProjectId);

      return {
        success: true,
        transferred: rowTabIds,
        sourceGroupId: groupId,
        targetGroupId,
      };
    });

    try {
      return transfer();
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  // ========== TAB HISTORY (CLOSED TABS ARCHIVE) ==========

  archiveTab(projectId, tab, {
    sourceTabId = null,
    codexWriterSessionId = null,
  } = {}) {
    const tabType = tab?.tabType || tab?.tab_type || 'terminal';
    if (tabType === 'file') {
      return null;
    }
    let archivedTab = tab;
    if (tab?.commandType === 'codex' && sourceTabId) {
      // Close/restore is a durable identity boundary. Resolve the binding from
      // main-owned state while the original row still exists; an incoming
      // renderer snapshot may still carry the resume source after main has
      // already point-written a linked writer or a model migration. A real
      // NULL session is authoritative too and must not fall back to that stale
      // renderer value.
      const persisted = this.db.prepare(`
        SELECT codex_session_id,
               codex_model,
               codex_effort,
               codex_settings_proof_at,
               codex_settings_proof_session_id,
               codex_model_migration_pending,
               codex_model_migration_restore_default_model,
               codex_model_migration_restore_default_effort,
               codex_model_migration_source_model,
               codex_model_migration_source_effort,
               codex_model_migration_target_model,
               codex_model_migration_config_path,
               codex_model_migration_config_fingerprint,
               codex_model_migration_config_already_target
        FROM tabs
        WHERE project_id = ? AND tab_id = ?
        LIMIT 1
      `).get(projectId, sourceTabId);
      if (!persisted) {
        return null;
      }
      const provenWriter = typeof codexWriterSessionId === 'string' && codexWriterSessionId.trim()
        ? codexWriterSessionId.trim()
        : null;
      const incomingSettingsProofAt = Number(tab.codexSettingsProofAt) || null;
      const persistedSettingsProofAt = Number(persisted.codex_settings_proof_at) || null;
      const persistedSettingsAreNewer = Number(persistedSettingsProofAt || 0)
        > Number(incomingSettingsProofAt || 0);
      archivedTab = {
        ...tab,
        codexSessionId: provenWriter || persisted.codex_session_id || null,
        ...(persisted.codex_model_migration_pending === 1 || persistedSettingsAreNewer ? {
          codexModel: persisted.codex_model || null,
          codexEffort: persisted.codex_effort || null,
          codexSettingsProofAt: persistedSettingsProofAt,
          codexSettingsProofSessionId: persisted.codex_settings_proof_session_id || null,
          codexModelMigrationPending: persisted.codex_model_migration_pending === 1,
          codexModelMigrationRestoreDefaultModel: persisted.codex_model_migration_restore_default_model === 1,
          codexModelMigrationRestoreDefaultEffort: persisted.codex_model_migration_restore_default_effort === 1,
          codexModelMigrationSourceModel: persisted.codex_model_migration_source_model || null,
          codexModelMigrationSourceEffort: persisted.codex_model_migration_source_effort || null,
          codexModelMigrationTargetModel: persisted.codex_model_migration_target_model || null,
          codexModelMigrationConfigPath: persisted.codex_model_migration_config_path || null,
          codexModelMigrationConfigFingerprint: persisted.codex_model_migration_config_fingerprint || null,
          codexModelMigrationConfigAlreadyTarget: persisted.codex_model_migration_config_already_target === 1,
        } : {}),
      };
    }
    const now = Math.floor(Date.now() / 1000);
    const archivedTabId = typeof (sourceTabId || archivedTab?.tabId || archivedTab?.id) === 'string'
      ? String(sourceTabId || archivedTab.tabId || archivedTab.id).trim() || null
      : null;
    const insert = this.db.prepare(`
      INSERT INTO tab_history (project_id, tab_id, name, name_set_manually, cwd, color, notes, task_plan, command_type, tab_type, url, file_path, created_at, closed_at, claude_session_id, gemini_session_id, codex_session_id, codex_model, codex_effort, codex_settings_proof_at, codex_settings_proof_session_id, codex_model_migration_pending, codex_model_migration_restore_default_model, codex_model_migration_restore_default_effort, codex_model_migration_source_model, codex_model_migration_source_effort, codex_model_migration_target_model, codex_model_migration_config_path, codex_model_migration_config_fingerprint, codex_model_migration_config_already_target, message_count, position, process_was_running, session_status, group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const archive = this.db.transaction(() => {
      const info = insert.run(
        projectId,
        archivedTabId,
        archivedTab.name,
        archivedTab.nameSetManually ? 1 : 0,
        archivedTab.cwd,
        archivedTab.color || null,
        archivedTab.notes || null,
        archivedTab.taskPlan ? JSON.stringify(normalizeTaskPlan(archivedTab.taskPlan)) : null,
        archivedTab.commandType || null,
        tabType,
        archivedTab.url || null,
        archivedTab.filePath || null,
        archivedTab.createdAt || now,
        now,
        archivedTab.claudeSessionId || null,
        archivedTab.geminiSessionId || null,
        archivedTab.codexSessionId || null,
        archivedTab.codexModel || null,
        archivedTab.codexEffort || null,
        Number(archivedTab.codexSettingsProofAt) || null,
        archivedTab.codexSettingsProofSessionId || null,
        archivedTab.codexModelMigrationPending ? 1 : 0,
        archivedTab.codexModelMigrationRestoreDefaultModel ? 1 : 0,
        archivedTab.codexModelMigrationRestoreDefaultEffort ? 1 : 0,
        archivedTab.codexModelMigrationSourceModel || null,
        archivedTab.codexModelMigrationSourceEffort || null,
        archivedTab.codexModelMigrationTargetModel || null,
        archivedTab.codexModelMigrationConfigPath || null,
        archivedTab.codexModelMigrationConfigFingerprint || null,
        archivedTab.codexModelMigrationConfigAlreadyTarget ? 1 : 0,
        archivedTab.messageCount ?? null,
        archivedTab.position ?? null,
        archivedTab.processWasRunning ? 1 : 0,
        archivedTab.sessionStatus || null,
        archivedTab.groupId || null
      );
      return info.lastInsertRowid;
    });
    return archive();
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

  getTabHistoryEntriesByTabId(tabId, limit = 2) {
    const cleanTabId = typeof tabId === 'string' ? tabId.trim() : '';
    if (!cleanTabId) return [];
    const safeLimit = Math.max(1, Math.min(10, Number(limit) || 2));
    return this.db.prepare(
      "SELECT * FROM tab_history WHERE tab_id = ? AND (tab_type IS NULL OR tab_type != 'file') ORDER BY closed_at DESC, id DESC LIMIT ?"
    ).all(cleanTabId, safeLimit);
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

  // One-time compatibility bridge for databases created before quick commands
  // became global. Existing global state always wins: legacy project rows must
  // never overwrite commands the user has edited in Settings.
  migrateQuickActionsToGlobal() {
    const migrate = this.db.transaction(() => {
      const existingGlobal = Number(
        this.db.prepare('SELECT COUNT(*) AS count FROM global_commands').get()?.count || 0
      );
      if (existingGlobal > 0) {
        return {
          migrated: false,
          count: 0,
          message: 'Global commands already exist',
        };
      }

      const legacyActions = this.db.prepare(`
        SELECT name, command
        FROM quick_actions
        ORDER BY position, id
      `).all();
      if (legacyActions.length === 0) {
        return {
          migrated: false,
          count: 0,
          message: 'No legacy quick actions',
        };
      }

      const uniqueCommands = new Map();
      for (const action of legacyActions) {
        const identity = JSON.stringify([action.name, action.command]);
        if (!uniqueCommands.has(identity)) {
          uniqueCommands.set(identity, {
            name: action.name,
            command: action.command,
          });
        }
      }

      const insert = this.db.prepare(`
        INSERT INTO global_commands (name, command, position)
        VALUES (?, ?, ?)
      `);
      let position = 0;
      for (const command of uniqueCommands.values()) {
        insert.run(command.name, command.command, position);
        position += 1;
      }

      return {
        migrated: true,
        count: uniqueCommands.size,
      };
    });

    return migrate();
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

  getHistoryPromptPresentations(toolType, sessionId) {
    if (!toolType || !sessionId) return [];
    return this.db.prepare(`
      SELECT *
      FROM history_prompt_presentations
      WHERE tool_type = ? AND session_id = ?
      ORDER BY updated_at ASC
    `).all(toolType, sessionId).flatMap(row => {
      try {
        const chips = JSON.parse(row.chips_json || '[]');
        if (!Array.isArray(chips) || chips.length === 0) return [];
        return [{
          toolType: row.tool_type,
          sessionId: row.session_id,
          auditTimestamp: row.audit_timestamp,
          transportHash: row.transport_hash,
          entryUuid: row.entry_uuid || null,
          schemaVersion: Number(row.schema_version || 1),
          chips,
          createdAt: Number(row.created_at || 0),
          updatedAt: Number(row.updated_at || 0),
        }];
      } catch {
        return [];
      }
    });
  }

  getHistoryPromptPresentationsForEntries(toolType, entryUuids) {
    const uuids = Array.from(new Set(
      (Array.isArray(entryUuids) ? entryUuids : [])
        .map(value => String(value || '').trim())
        .filter(Boolean)
    ));
    if (!toolType || uuids.length === 0) return [];
    const rows = [];
    const chunkSize = 800;
    for (let start = 0; start < uuids.length; start += chunkSize) {
      const chunk = uuids.slice(start, start + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      rows.push(...this.db.prepare(`
        SELECT *
        FROM history_prompt_presentations
        WHERE tool_type = ? AND entry_uuid IN (${placeholders})
      `).all(toolType, ...chunk));
    }
    return rows.flatMap(row => {
      try {
        const chips = JSON.parse(row.chips_json || '[]');
        if (!Array.isArray(chips) || chips.length === 0) return [];
        return [{
          toolType: row.tool_type,
          sessionId: row.session_id,
          auditTimestamp: row.audit_timestamp,
          transportHash: row.transport_hash,
          entryUuid: row.entry_uuid || null,
          schemaVersion: Number(row.schema_version || 1),
          chips,
          createdAt: Number(row.created_at || 0),
          updatedAt: Number(row.updated_at || 0),
        }];
      } catch {
        return [];
      }
    });
  }

  getHistoryPromptPresentationRevision(toolType, _sessionId) {
    if (!toolType) return 'none';
    // Exact UUID decoration intentionally follows preserved entries across
    // resume/fork session boundaries. Until sidecars are copied into every
    // child, the revision must cover all rows for this provider; a token scoped
    // only to the requested session could declare History unchanged while an
    // ancestor row gained presentation metadata.
    const rows = this.db.prepare(`
      SELECT session_id, audit_timestamp, transport_hash, entry_uuid, schema_version, chips_json
      FROM history_prompt_presentations
      WHERE tool_type = ?
      ORDER BY session_id ASC, audit_timestamp ASC, transport_hash ASC
    `).all(toolType);
    if (rows.length === 0) return 'none';
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')
      .slice(0, 24);
  }

  getHistoryPromptPresentationAssetIds() {
    const assetIdPattern = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
    const assetIds = new Set();
    const rows = this.db.prepare(`
      SELECT chips_json
      FROM history_prompt_presentations
      WHERE schema_version >= 3
    `).all();
    for (const row of rows) {
      let items;
      try {
        items = JSON.parse(row.chips_json || '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item?.kind !== 'image-ref') continue;
        const explicit = typeof item.assetId === 'string'
          ? path.basename(item.assetId.trim())
          : '';
        const fromPath = typeof item.path === 'string'
          ? path.basename(item.path.trim())
          : '';
        const assetId = assetIdPattern.test(explicit)
          ? explicit.toLowerCase()
          : assetIdPattern.test(fromPath)
            ? fromPath.toLowerCase()
            : '';
        if (assetId) assetIds.add(assetId);
      }
    }
    return [...assetIds];
  }

  saveHistoryPromptPresentation(presentation) {
    const toolType = String(presentation?.toolType || '').trim();
    const sessionId = String(presentation?.sessionId || '').trim();
    const auditTimestamp = String(presentation?.auditTimestamp || '').trim();
    const transportHash = String(presentation?.transportHash || '').trim();
    const chips = Array.isArray(presentation?.chips) ? presentation.chips : [];
    if (!toolType || !sessionId || !auditTimestamp || !transportHash || chips.length === 0) {
      return false;
    }
    this.db.prepare(`
      INSERT INTO history_prompt_presentations (
        tool_type, session_id, audit_timestamp, transport_hash, entry_uuid,
        schema_version, chips_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
      ON CONFLICT(tool_type, session_id, audit_timestamp, transport_hash) DO UPDATE SET
        entry_uuid = COALESCE(excluded.entry_uuid, history_prompt_presentations.entry_uuid),
        schema_version = excluded.schema_version,
        chips_json = excluded.chips_json,
        updated_at = strftime('%s', 'now')
    `).run(
      toolType,
      sessionId,
      auditTimestamp,
      transportHash,
      presentation.entryUuid || null,
      Number(presentation.schemaVersion || 1),
      JSON.stringify(chips)
    );
    return true;
  }

  bindHistoryPromptPresentationEntry({
    toolType,
    sessionId,
    auditTimestamp,
    transportHash,
    entryUuid,
  } = {}) {
    if (!toolType || !sessionId || !auditTimestamp || !transportHash || !entryUuid) return false;
    const result = this.db.prepare(`
      UPDATE history_prompt_presentations
      SET entry_uuid = ?, updated_at = strftime('%s', 'now')
      WHERE tool_type = ?
        AND session_id = ?
        AND audit_timestamp = ?
        AND transport_hash = ?
        AND (entry_uuid IS NULL OR entry_uuid = ?)
    `).run(entryUuid, toolType, sessionId, auditTimestamp, transportHash, entryUuid);
    return result.changes > 0;
  }

  cloneCodexHistoryPromptPresentations({
    sourceSessionId,
    childSessionId,
    entryMappings,
  } = {}) {
    const source = String(sourceSessionId || '').trim();
    const child = String(childSessionId || '').trim();
    const mappings = Array.isArray(entryMappings) ? entryMappings : [];
    if (!source || !child || source === child || mappings.length === 0) {
      return { inserted: 0, updated: 0, unchanged: 0, skipped: mappings.length };
    }

    const sourceByUuid = this.db.prepare(`
      SELECT *
      FROM history_prompt_presentations
      WHERE tool_type = 'codex' AND session_id = ? AND entry_uuid = ?
    `);
    const sourceByAudit = this.db.prepare(`
      SELECT *
      FROM history_prompt_presentations
      WHERE tool_type = 'codex'
        AND session_id = ?
        AND audit_timestamp = ?
        AND transport_hash = ?
    `);
    const childByPrimaryKey = this.db.prepare(`
      SELECT *
      FROM history_prompt_presentations
      WHERE tool_type = 'codex'
        AND session_id = ?
        AND audit_timestamp = ?
        AND transport_hash = ?
    `);
    const childByEntryUuid = this.db.prepare(`
      SELECT *
      FROM history_prompt_presentations
      WHERE tool_type = 'codex' AND session_id = ? AND entry_uuid = ?
    `);
    const insertChild = this.db.prepare(`
      INSERT INTO history_prompt_presentations (
        tool_type, session_id, audit_timestamp, transport_hash, entry_uuid,
        schema_version, chips_json, created_at, updated_at
      ) VALUES (
        'codex', ?, ?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now')
      )
    `);
    const bindCompatibleChild = this.db.prepare(`
      UPDATE history_prompt_presentations
      SET entry_uuid = ?, updated_at = strftime('%s', 'now')
      WHERE tool_type = 'codex'
        AND session_id = ?
        AND audit_timestamp = ?
        AND transport_hash = ?
        AND entry_uuid IS NULL
        AND schema_version = ?
        AND chips_json = ?
    `);

    const clone = this.db.transaction(() => {
      const result = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
      const seenTargets = new Set();
      for (const mapping of mappings) {
        const sourceEntryUuid = String(mapping?.sourceEntryUuid || '').trim();
        const childEntryUuid = String(mapping?.childEntryUuid || '').trim();
        const sourceAuditTimestamp = String(mapping?.sourceAuditTimestamp || '').trim();
        const sourceTransportHash = String(mapping?.sourceTransportHash || '').trim();
        const childAuditTimestamp = String(mapping?.childAuditTimestamp || '').trim();
        const childTransportHash = String(mapping?.childTransportHash || '').trim();
        const targetKey = `${childEntryUuid}\u0000${childAuditTimestamp}\u0000${childTransportHash}`;
        if (
          !sourceEntryUuid
          || !childEntryUuid
          || !sourceAuditTimestamp
          || !sourceTransportHash
          || !childAuditTimestamp
          || !childTransportHash
          || seenTargets.has(targetKey)
        ) {
          result.skipped += 1;
          continue;
        }
        seenTargets.add(targetKey);

        const candidates = new Map();
        for (const row of sourceByUuid.all(source, sourceEntryUuid)) {
          candidates.set(`${row.audit_timestamp}\u0000${row.transport_hash}`, row);
        }
        for (const row of sourceByAudit.all(
          source,
          sourceAuditTimestamp,
          sourceTransportHash,
        )) {
          candidates.set(`${row.audit_timestamp}\u0000${row.transport_hash}`, row);
        }
        if (candidates.size !== 1) {
          result.skipped += 1;
          continue;
        }
        const [sourceRow] = candidates.values();
        let chips;
        try {
          chips = JSON.parse(sourceRow.chips_json || '[]');
        } catch {
          chips = null;
        }
        if (
          !Array.isArray(chips)
          || chips.length === 0
          || chips.some(chip => (
            chip?.kind !== 'prompt'
            || typeof chip.text !== 'string'
            || !chip.text
          ))
        ) {
          result.skipped += 1;
          continue;
        }

        const primaryRow = childByPrimaryKey.get(
          child,
          childAuditTimestamp,
          childTransportHash,
        );
        const uuidRows = childByEntryUuid.all(child, childEntryUuid);
        if (primaryRow) {
          const compatible = Number(primaryRow.schema_version || 1) === Number(sourceRow.schema_version || 1)
            && primaryRow.chips_json === sourceRow.chips_json
            && (!primaryRow.entry_uuid || primaryRow.entry_uuid === childEntryUuid)
            && uuidRows.every(row => (
              row.audit_timestamp === primaryRow.audit_timestamp
              && row.transport_hash === primaryRow.transport_hash
            ));
          if (!compatible) {
            result.skipped += 1;
            continue;
          }
          if (primaryRow.entry_uuid === childEntryUuid) {
            result.unchanged += 1;
            continue;
          }
          const update = bindCompatibleChild.run(
            childEntryUuid,
            child,
            childAuditTimestamp,
            childTransportHash,
            Number(sourceRow.schema_version || 1),
            sourceRow.chips_json,
          );
          if (update.changes === 1) result.updated += 1;
          else result.skipped += 1;
          continue;
        }
        if (uuidRows.length > 0) {
          result.skipped += 1;
          continue;
        }
        insertChild.run(
          child,
          childAuditTimestamp,
          childTransportHash,
          childEntryUuid,
          Number(sourceRow.schema_version || 1),
          sourceRow.chips_json,
        );
        result.inserted += 1;
      }
      return result;
    });
    return clone();
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

  _mapSessionHistoryEvent(row) {
    if (!row) return null;
    return {
      eventKey: row.event_key,
      eventType: row.event_type,
      provider: row.provider,
      sessionId: row.session_id,
      sourceSessionId: row.source_session_id || null,
      childSessionId: row.child_session_id || null,
      sourceTabId: row.source_tab_id || null,
      childTabId: row.child_tab_id || null,
      visualParentTabId: row.visual_parent_tab_id || null,
      orchestrationRunId: row.orchestration_run_id || null,
      orchestrationParentRunId: row.orchestration_parent_run_id || null,
      forkMode: row.fork_mode || null,
      entryUuids: parseForkMarkerEntryUuidsJson(row.entry_uuids_json),
      snapshotComplete: row.snapshot_complete !== 0,
      boundaryEntryUuid: row.boundary_entry_uuid || null,
      summaryEntryUuid: row.summary_entry_uuid || null,
      occurredAt: row.occurred_at ?? null,
      turnIndex: row.turn_index ?? null,
      afterIterationIndex: row.after_iteration_index ?? null,
      nextIterationIndex: row.next_iteration_index ?? null,
      trigger: row.trigger || null,
      preTokens: row.pre_tokens ?? null,
      postTokens: row.post_tokens ?? null,
      origin: row.origin || null,
      inherited: row.inherited === 1,
      isDirect: row.is_direct === 1,
      metadataCopied: row.metadata_copied === 1,
      hidden: row.hidden === 1,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  saveSessionHistoryEvent(event) {
    const eventType = normalizeSessionHistoryEventType(event?.eventType);
    const provider = normalizeSessionHistoryProvider(event?.provider);
    const sessionId = cleanSessionHistoryEventString(event?.sessionId);
    const eventKey = cleanSessionHistoryEventString(event?.eventKey);
    if (!eventType || !provider || !sessionId || !eventKey) {
      throw new Error('invalid_session_history_event_identity');
    }

    const entryUuids = normalizeForkMarkerEntryUuids(event?.entryUuids);
    const now = Math.floor(Date.now() / 1000);
    const optionalInteger = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const numeric = Number(value);
      return Number.isInteger(numeric) ? numeric : null;
    };
    const optionalNumber = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const params = {
      eventKey,
      eventType,
      provider,
      sessionId,
      sourceSessionId: cleanSessionHistoryEventString(event?.sourceSessionId) || null,
      childSessionId: cleanSessionHistoryEventString(event?.childSessionId) || null,
      sourceTabId: cleanSessionHistoryEventString(event?.sourceTabId) || null,
      childTabId: cleanSessionHistoryEventString(event?.childTabId) || null,
      visualParentTabId: cleanSessionHistoryEventString(event?.visualParentTabId) || null,
      orchestrationRunId: cleanSessionHistoryEventString(event?.orchestrationRunId) || null,
      orchestrationParentRunId: cleanSessionHistoryEventString(event?.orchestrationParentRunId) || null,
      forkMode: cleanSessionHistoryEventString(event?.forkMode) || null,
      entryUuidsJson: JSON.stringify(entryUuids),
      snapshotComplete: event?.snapshotComplete === false ? 0 : 1,
      boundaryEntryUuid: cleanSessionHistoryEventString(event?.boundaryEntryUuid) || null,
      summaryEntryUuid: cleanSessionHistoryEventString(event?.summaryEntryUuid) || null,
      occurredAt: sessionHistoryEventEpochSeconds(event?.occurredAt),
      turnIndex: optionalInteger(event?.turnIndex),
      afterIterationIndex: optionalInteger(event?.afterIterationIndex),
      nextIterationIndex: optionalInteger(event?.nextIterationIndex),
      trigger: cleanSessionHistoryEventString(event?.trigger) || null,
      preTokens: optionalNumber(event?.preTokens),
      postTokens: optionalNumber(event?.postTokens),
      origin: cleanSessionHistoryEventString(event?.origin) || 'app',
      inherited: event?.inherited === true ? 1 : 0,
      isDirect: event?.isDirect === true ? 1 : 0,
      metadataCopied: event?.metadataCopied === true ? 1 : 0,
      createdAt: sessionHistoryEventEpochSeconds(event?.createdAt) || now,
      updatedAt: now,
    };

    const writeResult = this.db.prepare(`
      INSERT INTO session_history_events (
        event_key, event_type, provider, session_id,
        source_session_id, child_session_id,
        source_tab_id, child_tab_id, visual_parent_tab_id, orchestration_run_id,
        orchestration_parent_run_id,
        fork_mode, entry_uuids_json, snapshot_complete, boundary_entry_uuid, summary_entry_uuid,
        occurred_at, turn_index, after_iteration_index, next_iteration_index,
        trigger, pre_tokens, post_tokens, origin, inherited, is_direct, metadata_copied,
        created_at, updated_at
      ) VALUES (
        @eventKey, @eventType, @provider, @sessionId,
        @sourceSessionId, @childSessionId,
        @sourceTabId, @childTabId, @visualParentTabId, @orchestrationRunId,
        @orchestrationParentRunId,
        @forkMode, @entryUuidsJson, @snapshotComplete, @boundaryEntryUuid, @summaryEntryUuid,
        @occurredAt, @turnIndex, @afterIterationIndex, @nextIterationIndex,
        @trigger, @preTokens, @postTokens, @origin, @inherited, @isDirect, @metadataCopied,
        @createdAt, @updatedAt
      )
      ON CONFLICT(event_key) DO UPDATE SET
        source_session_id = COALESCE(excluded.source_session_id, session_history_events.source_session_id),
        child_session_id = COALESCE(excluded.child_session_id, session_history_events.child_session_id),
        source_tab_id = COALESCE(excluded.source_tab_id, session_history_events.source_tab_id),
        child_tab_id = COALESCE(excluded.child_tab_id, session_history_events.child_tab_id),
        visual_parent_tab_id = COALESCE(excluded.visual_parent_tab_id, session_history_events.visual_parent_tab_id),
        orchestration_run_id = COALESCE(excluded.orchestration_run_id, session_history_events.orchestration_run_id),
        orchestration_parent_run_id = COALESCE(excluded.orchestration_parent_run_id, session_history_events.orchestration_parent_run_id),
        fork_mode = CASE
          WHEN excluded.fork_mode IS NOT NULL AND excluded.fork_mode != 'unknown' THEN excluded.fork_mode
          ELSE session_history_events.fork_mode
        END,
        entry_uuids_json = CASE
          WHEN session_history_events.snapshot_complete = 0 AND excluded.snapshot_complete = 1
            THEN excluded.entry_uuids_json
          WHEN session_history_events.entry_uuids_json = '[]' AND excluded.entry_uuids_json != '[]'
            THEN excluded.entry_uuids_json
          ELSE session_history_events.entry_uuids_json
        END,
        snapshot_complete = MAX(session_history_events.snapshot_complete, excluded.snapshot_complete),
        boundary_entry_uuid = COALESCE(session_history_events.boundary_entry_uuid, excluded.boundary_entry_uuid),
        summary_entry_uuid = COALESCE(session_history_events.summary_entry_uuid, excluded.summary_entry_uuid),
        occurred_at = COALESCE(session_history_events.occurred_at, excluded.occurred_at),
        turn_index = COALESCE(session_history_events.turn_index, excluded.turn_index),
        after_iteration_index = COALESCE(session_history_events.after_iteration_index, excluded.after_iteration_index),
        next_iteration_index = COALESCE(session_history_events.next_iteration_index, excluded.next_iteration_index),
        trigger = COALESCE(session_history_events.trigger, excluded.trigger),
        pre_tokens = COALESCE(session_history_events.pre_tokens, excluded.pre_tokens),
        post_tokens = COALESCE(session_history_events.post_tokens, excluded.post_tokens),
        origin = CASE
          WHEN session_history_events.origin IN ('app', 'terminal-mcp', 'orchestration')
            THEN session_history_events.origin
          ELSE excluded.origin
        END,
        inherited = MAX(session_history_events.inherited, excluded.inherited),
        is_direct = MAX(session_history_events.is_direct, excluded.is_direct),
        metadata_copied = MAX(session_history_events.metadata_copied, excluded.metadata_copied),
        updated_at = excluded.updated_at
      WHERE
        (session_history_events.source_session_id IS NULL AND excluded.source_session_id IS NOT NULL)
        OR (session_history_events.child_session_id IS NULL AND excluded.child_session_id IS NOT NULL)
        OR (session_history_events.source_tab_id IS NULL AND excluded.source_tab_id IS NOT NULL)
        OR (session_history_events.child_tab_id IS NULL AND excluded.child_tab_id IS NOT NULL)
        OR (session_history_events.visual_parent_tab_id IS NULL AND excluded.visual_parent_tab_id IS NOT NULL)
        OR (session_history_events.orchestration_run_id IS NULL AND excluded.orchestration_run_id IS NOT NULL)
        OR (session_history_events.orchestration_parent_run_id IS NULL AND excluded.orchestration_parent_run_id IS NOT NULL)
        OR ((session_history_events.fork_mode IS NULL OR session_history_events.fork_mode = 'unknown')
            AND excluded.fork_mode IS NOT NULL AND excluded.fork_mode != 'unknown')
        OR (session_history_events.snapshot_complete = 0 AND excluded.snapshot_complete = 1)
        OR (session_history_events.entry_uuids_json = '[]' AND excluded.entry_uuids_json != '[]')
        OR (session_history_events.boundary_entry_uuid IS NULL AND excluded.boundary_entry_uuid IS NOT NULL)
        OR (session_history_events.summary_entry_uuid IS NULL AND excluded.summary_entry_uuid IS NOT NULL)
        OR (session_history_events.occurred_at IS NULL AND excluded.occurred_at IS NOT NULL)
        OR (session_history_events.turn_index IS NULL AND excluded.turn_index IS NOT NULL)
        OR (session_history_events.after_iteration_index IS NULL AND excluded.after_iteration_index IS NOT NULL)
        OR (session_history_events.next_iteration_index IS NULL AND excluded.next_iteration_index IS NOT NULL)
        OR (session_history_events.trigger IS NULL AND excluded.trigger IS NOT NULL)
        OR (session_history_events.pre_tokens IS NULL AND excluded.pre_tokens IS NOT NULL)
        OR (session_history_events.post_tokens IS NULL AND excluded.post_tokens IS NOT NULL)
        OR (session_history_events.origin NOT IN ('app', 'terminal-mcp', 'orchestration')
            AND excluded.origin != session_history_events.origin)
        OR session_history_events.inherited < excluded.inherited
        OR session_history_events.is_direct < excluded.is_direct
        OR session_history_events.metadata_copied < excluded.metadata_copied
    `).run(params);

    const saved = this._mapSessionHistoryEvent(
      this.db.prepare('SELECT * FROM session_history_events WHERE event_key = ?').get(eventKey),
    );
    Object.defineProperty(saved, '_writeChanged', {
      configurable: false,
      enumerable: false,
      value: writeResult.changes > 0,
      writable: false,
    });
    return saved;
  }

  saveSessionForkEvent({
    provider,
    sourceSessionId,
    childSessionId,
    entryUuids,
    ...metadata
  }) {
    const normalizedProvider = normalizeSessionHistoryProvider(provider);
    const source = cleanSessionHistoryEventString(sourceSessionId);
    const child = cleanSessionHistoryEventString(childSessionId);
    const eventKey = forkEventKey(normalizedProvider, source, child);
    if (!eventKey) throw new Error('invalid_session_fork_identity');
    const snapshot = normalizeForkMarkerEntryUuids(entryUuids);
    const event = this.saveSessionHistoryEvent({
      eventKey,
      eventType: 'fork',
      provider: normalizedProvider,
      sessionId: child,
      sourceSessionId: source,
      childSessionId: child,
      entryUuids: snapshot,
      ...metadata,
      boundaryEntryUuid: metadata.boundaryEntryUuid || snapshot.at(-1) || null,
      snapshotComplete: metadata.snapshotComplete !== false,
      occurredAt: metadata.occurredAt || Date.now(),
      isDirect: metadata.isDirect !== false,
    });

    // Keep old Claude readers functional during rollout. Codex must not enter
    // this provider-less legacy table: the next startup would migrate it back
    // as a false Claude lineage event.
    let legacyChanged = false;
    if (normalizedProvider === 'claude') {
      const legacyResult = this.db.prepare(`
        INSERT INTO fork_markers (
          source_session_id, forked_to_session_id, entry_uuids_json, created_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(source_session_id, forked_to_session_id) DO UPDATE SET
          entry_uuids_json = CASE
            WHEN fork_markers.entry_uuids_json = '[]' AND excluded.entry_uuids_json != '[]'
            THEN excluded.entry_uuids_json
            ELSE fork_markers.entry_uuids_json
          END
        WHERE fork_markers.entry_uuids_json = '[]' AND excluded.entry_uuids_json != '[]'
      `).run(source, child, JSON.stringify(snapshot), event.occurredAt || event.createdAt || null);
      legacyChanged = legacyResult.changes > 0;
    }

    if (event._writeChanged || legacyChanged) {
      this.invalidateForkMarkerCache(source);
      this.invalidateForkMarkerCache(child);
    }
    return event;
  }

  /**
   * Save a fork marker when a session is forked
   * @param {string} sourceSessionId - Original session UUID
   * @param {string} forkedToSessionId - New session UUID
   * @param {string[]} entryUuids - Array of all entry UUIDs at fork time (snapshot)
   */
  saveForkMarker(sourceSessionId, forkedToSessionId, entryUuids, metadata = {}) {
    try {
      const normalizedEntryUuids = normalizeForkMarkerEntryUuids(entryUuids);
      if (!Array.isArray(entryUuids)) {
        console.warn('[DB] Fork marker snapshot rejected non-array value; saving empty boundary');
      }
      const saved = this.saveSessionForkEvent({
        provider: metadata.provider || 'claude',
        sourceSessionId,
        childSessionId: forkedToSessionId,
        entryUuids: normalizedEntryUuids,
        origin: metadata.origin || 'app',
        forkMode: metadata.forkMode || null,
        sourceTabId: metadata.sourceTabId || null,
        childTabId: metadata.childTabId || null,
        visualParentTabId: metadata.visualParentTabId || null,
        orchestrationRunId: metadata.orchestrationRunId || null,
        occurredAt: metadata.occurredAt || null,
        isDirect: metadata.isDirect !== false,
      });
      console.log('[DB] Fork marker saved:', {
        provider: saved.provider,
        sourceSessionId,
        forkedToSessionId,
        entryCount: normalizedEntryUuids.length,
      });
      return saved;
    } catch (e) {
      console.error('[DB] Failed to save fork marker:', e);
      return null;
    }
  }

  saveCompactHistoryEvents(events) {
    const source = Array.isArray(events) ? events : [];
    const saved = [];
    const write = this.db.transaction(() => {
      for (const event of source) saved.push(this.saveSessionHistoryEvent(event));
    });
    write();
    return saved;
  }

  getSessionHistoryEvents(sessionId) {
    if (!sessionId) return [];
    return this.db.prepare(`
      SELECT *
      FROM session_history_events
      WHERE session_id = ? OR source_session_id = ?
      ORDER BY COALESCE(occurred_at, created_at), id
    `).all(sessionId, sessionId).map((row) => this._mapSessionHistoryEvent(row));
  }

  getSessionHistoryContext(sessionId) {
    const events = this.getSessionHistoryEvents(sessionId);
    const directFork = events
      .filter((event) => event.eventType === 'fork' && event.sessionId === sessionId)
      .sort((left, right) => (
        Number(right.isDirect) - Number(left.isDirect)
        || Number(right.occurredAt || right.createdAt || 0) - Number(left.occurredAt || left.createdAt || 0)
      ))[0] || null;
    return {
      fork: directFork,
      children: events.filter((event) => (
        event.eventType === 'fork' && event.sourceSessionId === sessionId
      )),
      compacts: events.filter((event) => (
        event.eventType === 'compact' && event.sessionId === sessionId
      )),
    };
  }

  markSessionForkMetadataCopied(eventKey) {
    const key = cleanSessionHistoryEventString(eventKey);
    if (!key) return false;
    return this.db.prepare(`
      UPDATE session_history_events
      SET metadata_copied = 1, updated_at = strftime('%s', 'now')
      WHERE event_key = ? AND event_type = 'fork' AND metadata_copied = 0
    `).run(key).changes > 0;
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
      SELECT *
      FROM session_history_events
      WHERE event_type = 'fork'
        AND (source_session_id = ? OR session_id = ?)
      ORDER BY COALESCE(occurred_at, created_at), id
    `).all(sessionId, sessionId);

    this._forkMarkerCacheStats.miss++;
    console.log('[DB] getForkMarkers(' + sessionId?.slice(0, 8) + '...):', rows.length, 'rows [MISS]');

    const markers = rows.map(row => ({
      source_session_id: row.source_session_id,
      fork_session_id: row.child_session_id || row.session_id,
      entry_uuids: parseForkMarkerEntryUuidsJson(row.entry_uuids_json),
      created_at: row.occurred_at || row.created_at,
      hidden: !!row.hidden,
      provider: row.provider,
      event_key: row.event_key,
      is_direct: !!row.is_direct,
      metadata_copied: !!row.metadata_copied,
      fork_mode: row.fork_mode || null,
      source_tab_id: row.source_tab_id || null,
      child_tab_id: row.child_tab_id || null,
      visual_parent_tab_id: row.visual_parent_tab_id || null,
      orchestration_run_id: row.orchestration_run_id || null,
      orchestration_parent_run_id: row.orchestration_parent_run_id || null,
      boundary_entry_uuid: row.boundary_entry_uuid || null,
      snapshot_complete: row.snapshot_complete !== 0,
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
      FROM session_history_events
      WHERE event_type = 'fork' AND session_id = ?
      ORDER BY is_direct DESC, COALESCE(occurred_at, created_at) DESC, id DESC
      LIMIT 1
    `).get(sessionId) || null;
  }

  hideForkMarker(sourceSessionId, forkSessionId) {
    const source = cleanSessionHistoryEventString(sourceSessionId);
    const child = cleanSessionHistoryEventString(forkSessionId);
    if (!source || !child) return 0;
    const changed = this.db.transaction(() => {
      const canonical = this.db.prepare(`
        UPDATE session_history_events
        SET hidden = 1, updated_at = strftime('%s', 'now')
        WHERE event_type = 'fork' AND source_session_id = ? AND session_id = ?
      `).run(source, child).changes;
      this.db.prepare(`
        UPDATE fork_markers SET hidden = 1
        WHERE source_session_id = ? AND forked_to_session_id = ?
      `).run(source, child);
      return canonical;
    })();
    this.invalidateForkMarkerCache(source);
    this.invalidateForkMarkerCache(child);
    return changed;
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

  copyTimelineMetadataForMappedFork(newSessionId, mappings, forkTabId) {
    const normalized = [];
    const seenChildren = new Set();
    for (const mapping of Array.isArray(mappings) ? mappings : []) {
      const sourceUuid = cleanSessionHistoryEventString(mapping?.sourceUuid);
      const childUuid = cleanSessionHistoryEventString(mapping?.childUuid);
      if (!sourceUuid || !childUuid || seenChildren.has(childUuid)) continue;
      seenChildren.add(childUuid);
      normalized.push({ sourceUuid, childUuid });
    }
    if (normalized.length === 0) return { notes: 0, rewindMarkers: 0 };

    const insertNote = this.db.prepare(`
      INSERT OR IGNORE INTO timeline_notes (
        entry_uuid, session_id, tab_id, content, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
    `);
    const insertRewind = this.db.prepare(`
      INSERT OR IGNORE INTO timeline_rewind_markers (entry_uuid, session_id)
      VALUES (?, ?)
    `);
    let notesCopied = 0;
    let rewindCopied = 0;
    const CHUNK = 500;

    for (let offset = 0; offset < normalized.length; offset += CHUNK) {
      const chunk = normalized.slice(offset, offset + CHUNK);
      const childBySource = new Map(chunk.map((mapping) => [mapping.sourceUuid, mapping.childUuid]));
      const sourceUuids = [...childBySource.keys()];
      const placeholders = sourceUuids.map(() => '?').join(',');
      const copy = this.db.transaction(() => {
        const noteRows = this.db.prepare(`
          SELECT entry_uuid, content, position, MAX(updated_at) AS updated_at
          FROM timeline_notes
          WHERE entry_uuid IN (${placeholders})
          GROUP BY entry_uuid
        `).all(...sourceUuids);
        for (const row of noteRows) {
          const childUuid = childBySource.get(row.entry_uuid);
          if (!childUuid) continue;
          const result = insertNote.run(
            childUuid,
            newSessionId,
            forkTabId || '',
            row.content || '',
            row.position || 'before',
          );
          if (result.changes > 0) notesCopied += 1;
        }

        const rewindRows = this.db.prepare(`
          SELECT DISTINCT entry_uuid
          FROM timeline_rewind_markers
          WHERE entry_uuid IN (${placeholders})
        `).all(...sourceUuids);
        for (const row of rewindRows) {
          const childUuid = childBySource.get(row.entry_uuid);
          if (!childUuid) continue;
          const result = insertRewind.run(childUuid, newSessionId);
          if (result.changes > 0) rewindCopied += 1;
        }
      });
      copy();
    }

    return { notes: notesCopied, rewindMarkers: rewindCopied };
  }

  // ========== CLAUDE USAGE SNAPSHOTS ==========

  // Append one accepted, account-scoped quota snapshot. NO pruning — history
  // is retained indefinitely so long-range "By day" charts have real data.
  saveClaudeUsageSnapshot(snapshot) {
    if (!snapshot) return;
    const ts = snapshot.ts || Math.floor(Date.now() / 1000);
    try {
      this.db.prepare(`
        INSERT INTO claude_usage_snapshots
          (account_key, ts, weekly_pct, five_hour_pct, weekly_opus_pct, weekly_sonnet_pct,
           weekly_resets_at, five_hour_resets_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.account_key ?? null,
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

  // Last account-scoped snapshot. Legacy rows without an account key are
  // intentionally excluded so a login switch cannot inherit another
  // account's quota.
  getLatestClaudeUsageSnapshot(accountKey) {
    if (!accountKey) return undefined;
    return this.db.prepare(`
      SELECT account_key, ts, weekly_pct, five_hour_pct, weekly_opus_pct, weekly_sonnet_pct,
             weekly_resets_at, five_hour_resets_at
      FROM claude_usage_snapshots
      WHERE account_key = ?
      ORDER BY ts DESC
      LIMIT 1
    `).get(accountKey);
  }

  // Return raw snapshots between two unix timestamps, ascending order.
  getClaudeUsageSnapshots(fromTs, toTs, accountKey) {
    if (!accountKey) return [];
    return this.db.prepare(`
      SELECT account_key, ts, weekly_pct, five_hour_pct, weekly_opus_pct, weekly_sonnet_pct,
             weekly_resets_at, five_hour_resets_at
      FROM claude_usage_snapshots
      WHERE account_key = ? AND ts >= ? AND ts <= ?
      ORDER BY ts ASC
    `).all(accountKey, fromTs, toTs);
  }

  // ========== AGENT ACTIVITY INTERVALS ==========

  // Persist one CLOSED activity interval. `iv` carries the denormalized
  // identity snapshot captured at open-time plus start/end ms timestamps.
  // Zero / negative spans are dropped (idempotent recorder may emit a
  // false→false with no real interval).
  saveActivityInterval(iv) {
    if (!iv || !iv.startTs || !iv.endTs) return null;
    const duration = iv.endTs - iv.startTs;
    if (duration <= 0) return null;
    try {
      const result = this.db.prepare(`
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
      return {
        id: Number(result.lastInsertRowid),
        startTs: iv.startTs,
        endTs: iv.endTs,
        durationMs: duration,
      };
    } catch (e) {
      console.error('[DB] saveActivityInterval failed:', e.message);
      return null;
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

  savePendingHistoryResponseTiming({
    intervalId,
    toolType,
    tabId = null,
    sessionId = null,
  } = {}) {
    const id = Number(intervalId);
    if (!Number.isInteger(id) || id <= 0 || !toolType) return false;
    const interval = this.db.prepare(`
      SELECT id FROM agent_activity_intervals WHERE id = ? LIMIT 1
    `).get(id);
    if (!interval) return false;
    this.db.prepare(`
      INSERT INTO history_response_timings (
        interval_id, tool_type, tab_id, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
      ON CONFLICT(interval_id) DO UPDATE SET
        tool_type = excluded.tool_type,
        tab_id = COALESCE(excluded.tab_id, history_response_timings.tab_id),
        session_id = COALESCE(excluded.session_id, history_response_timings.session_id),
        updated_at = strftime('%s', 'now')
    `).run(id, toolType, tabId, sessionId);
    return true;
  }

  bindHistoryResponseTimingEntry({
    intervalId,
    toolType,
    sessionId = null,
    entryUuid,
    sourceIdentity = null,
  } = {}) {
    const id = Number(intervalId);
    if (!Number.isInteger(id) || id <= 0 || !toolType || !entryUuid) return false;
    const alreadyOwned = this.db.prepare(`
      SELECT interval_id
      FROM history_response_timings
      WHERE tool_type = ?
        AND session_id IS ?
        AND entry_uuid = ?
        AND interval_id <> ?
      UNION ALL
      SELECT interval_id
      FROM history_response_timing_aliases
      WHERE tool_type = ?
        AND session_id IS ?
        AND entry_uuid = ?
        AND interval_id <> ?
      LIMIT 1
    `).get(
      toolType, sessionId, entryUuid, id,
      toolType, sessionId, entryUuid, id,
    );
    if (alreadyOwned) return false;
    const result = this.db.prepare(`
      UPDATE history_response_timings
      SET session_id = COALESCE(?, session_id),
          entry_uuid = ?,
          source_identity = ?,
          updated_at = strftime('%s', 'now')
      WHERE interval_id = ?
        AND tool_type = ?
        AND (entry_uuid IS NULL OR entry_uuid = ?)
    `).run(sessionId, entryUuid, sourceIdentity, id, toolType, entryUuid);
    return result.changes > 0;
  }

  getPendingHistoryResponseTimings({
    toolType,
    sessionIds = [],
    tabId = null,
  } = {}) {
    if (!toolType) return [];
    const normalizedSessions = Array.from(new Set(
      (Array.isArray(sessionIds) ? sessionIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    const identityClauses = [];
    const params = [toolType];
    if (tabId) {
      identityClauses.push('t.tab_id = ?');
      params.push(tabId);
    }
    if (normalizedSessions.length > 0) {
      identityClauses.push(`t.session_id IN (${normalizedSessions.map(() => '?').join(',')})`);
      params.push(...normalizedSessions);
    }
    if (identityClauses.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT t.*, a.start_ts, a.end_ts, a.duration_ms
      FROM history_response_timings t
      JOIN agent_activity_intervals a ON a.id = t.interval_id
      WHERE t.tool_type = ?
        AND t.entry_uuid IS NULL
        AND (${identityClauses.join(' OR ')})
      ORDER BY a.end_ts DESC
      LIMIT 100
    `).all(...params);
    return rows.map(row => ({
      intervalId: Number(row.interval_id),
      toolType: row.tool_type,
      tabId: row.tab_id || null,
      sessionId: row.session_id || null,
      entryUuid: null,
      sourceIdentity: null,
      startTs: Number(row.start_ts),
      endTs: Number(row.end_ts),
      durationMs: Number(row.duration_ms),
      updatedAt: Number(row.updated_at || 0),
    }));
  }

  getHistoryResponseTimingsForEntries(toolType, entryUuids) {
    const uuids = Array.from(new Set(
      (Array.isArray(entryUuids) ? entryUuids : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    if (!toolType || uuids.length === 0) return [];
    const rows = [];
    const chunkSize = 800;
    for (let start = 0; start < uuids.length; start += chunkSize) {
      const chunk = uuids.slice(start, start + chunkSize);
      rows.push(...this.db.prepare(`
        SELECT t.interval_id, t.tool_type, t.tab_id, t.session_id,
               t.entry_uuid, t.source_identity, t.updated_at,
               a.start_ts, a.end_ts, a.duration_ms
        FROM history_response_timings t
        JOIN agent_activity_intervals a ON a.id = t.interval_id
        WHERE t.tool_type = ?
          AND t.entry_uuid IN (${chunk.map(() => '?').join(',')})
        UNION ALL
        SELECT x.interval_id, x.tool_type, t.tab_id, x.session_id,
               x.entry_uuid, x.source_identity, x.updated_at,
               a.start_ts, a.end_ts, a.duration_ms
        FROM history_response_timing_aliases x
        JOIN history_response_timings t ON t.interval_id = x.interval_id
        JOIN agent_activity_intervals a ON a.id = x.interval_id
        WHERE x.tool_type = ?
          AND x.entry_uuid IN (${chunk.map(() => '?').join(',')})
        ORDER BY end_ts ASC
      `).all(toolType, ...chunk, toolType, ...chunk));
    }
    return rows.map(row => ({
      intervalId: Number(row.interval_id),
      toolType: row.tool_type,
      tabId: row.tab_id || null,
      sessionId: row.session_id || null,
      entryUuid: row.entry_uuid || null,
      sourceIdentity: row.source_identity || null,
      startTs: Number(row.start_ts),
      endTs: Number(row.end_ts),
      durationMs: Number(row.duration_ms),
      updatedAt: Number(row.updated_at || 0),
    }));
  }

  getLatestPendingHistoryResponseTimingForTab(tabId, toolType = null) {
    if (!tabId) return null;
    const params = [tabId];
    const toolFilter = toolType ? 'AND t.tool_type = ?' : '';
    if (toolType) params.push(toolType);
    const row = this.db.prepare(`
      SELECT t.*, a.start_ts, a.end_ts, a.duration_ms
      FROM history_response_timings t
      JOIN agent_activity_intervals a ON a.id = t.interval_id
      WHERE t.tab_id = ?
        ${toolFilter}
        AND t.entry_uuid IS NULL
      ORDER BY a.end_ts DESC
      LIMIT 1
    `).get(...params);
    if (!row) return null;
    return {
      intervalId: Number(row.interval_id),
      toolType: row.tool_type,
      tabId: row.tab_id || null,
      sessionId: row.session_id || null,
      entryUuid: null,
      startTs: Number(row.start_ts),
      endTs: Number(row.end_ts),
      durationMs: Number(row.duration_ms),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  cloneHistoryResponseTimingsForSession({
    toolType,
    sourceSessionId,
    childSessionId,
    tabId = null,
    entryMappings = [],
  } = {}) {
    const source = String(sourceSessionId || '').trim();
    const child = String(childSessionId || '').trim();
    const mappings = Array.isArray(entryMappings) ? entryMappings : [];
    if (!toolType || !source || !child || source === child) {
      return { cloned: 0, unchanged: 0, skipped: mappings.length, pendingReassigned: 0 };
    }
    const normalizedTabId = String(tabId || '').trim();
    const findSource = this.db.prepare(`
      SELECT interval_id
      FROM history_response_timings
      WHERE tool_type = ? AND session_id = ? AND entry_uuid = ?
      UNION ALL
      SELECT interval_id
      FROM history_response_timing_aliases
      WHERE tool_type = ? AND session_id = ? AND entry_uuid = ?
      LIMIT 1
    `);
    const findChild = this.db.prepare(`
      SELECT entry_uuid, source_identity
      FROM history_response_timing_aliases
      WHERE interval_id = ? AND tool_type = ? AND session_id = ?
      LIMIT 1
    `);
    const insertChild = this.db.prepare(`
      INSERT OR IGNORE INTO history_response_timing_aliases (
        interval_id, tool_type, session_id, entry_uuid, source_identity,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
    `);
    let cloned = 0;
    let unchanged = 0;
    let skipped = 0;
    let pendingReassigned = 0;
    const run = this.db.transaction(() => {
      const pendingResult = normalizedTabId
        ? this.db.prepare(`
            UPDATE history_response_timings
            SET session_id = ?, updated_at = strftime('%s', 'now')
            WHERE tool_type = ?
              AND session_id = ?
              AND tab_id = ?
              AND entry_uuid IS NULL
          `).run(child, toolType, source, normalizedTabId)
        : this.db.prepare(`
            UPDATE history_response_timings
            SET session_id = ?, updated_at = strftime('%s', 'now')
            WHERE tool_type = ?
              AND session_id = ?
              AND entry_uuid IS NULL
          `).run(child, toolType, source);
      pendingReassigned = Number(pendingResult.changes || 0);
      for (const mapping of mappings) {
        const sourceEntryUuid = String(mapping?.sourceEntryUuid || '').trim();
        const childEntryUuid = String(mapping?.childEntryUuid || '').trim();
        if (!sourceEntryUuid || !childEntryUuid) {
          skipped += 1;
          continue;
        }
        const sourceRow = findSource.get(
          toolType, source, sourceEntryUuid,
          toolType, source, sourceEntryUuid,
        );
        if (!sourceRow) {
          skipped += 1;
          continue;
        }
        const intervalId = Number(sourceRow.interval_id);
        const existing = findChild.get(intervalId, toolType, child);
        if (existing) {
          if (existing.entry_uuid === childEntryUuid) unchanged += 1;
          else skipped += 1;
          continue;
        }
        const result = insertChild.run(
          intervalId,
          toolType,
          child,
          childEntryUuid,
          mapping?.childSourceIdentity || null,
        );
        if (result.changes > 0) cloned += 1;
        else skipped += 1;
      }
    });
    run();
    return { cloned, unchanged, skipped, pendingReassigned };
  }

  getHistoryResponseTimingRevision(toolType, sessionId = null, tabId = null) {
    if (!toolType) return 'none';
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedTabId = String(tabId || '').trim();
    const identityClauses = [];
    const params = [toolType];
    if (normalizedSessionId) {
      identityClauses.push('t.session_id = ?');
      params.push(normalizedSessionId);
    }
    if (normalizedTabId) {
      identityClauses.push('t.tab_id = ?');
      params.push(normalizedTabId);
    }
    const identityFilter = identityClauses.length > 0
      ? `AND (${identityClauses.join(' OR ')})`
      : '';
    const aliasIdentityClauses = [];
    const aliasParams = [toolType];
    if (normalizedSessionId) {
      aliasIdentityClauses.push('x.session_id = ?');
      aliasParams.push(normalizedSessionId);
    }
    if (normalizedTabId) {
      aliasIdentityClauses.push('t.tab_id = ?');
      aliasParams.push(normalizedTabId);
    }
    const aliasIdentityFilter = aliasIdentityClauses.length > 0
      ? `AND (${aliasIdentityClauses.join(' OR ')})`
      : '';
    const rows = this.db.prepare(`
      SELECT 'primary' AS projection, t.interval_id, t.session_id,
             t.entry_uuid, t.source_identity, t.updated_at
      FROM history_response_timings t
      WHERE t.tool_type = ?
        ${identityFilter}
      UNION ALL
      SELECT 'alias' AS projection, x.interval_id, x.session_id,
             x.entry_uuid, x.source_identity, x.updated_at
      FROM history_response_timing_aliases x
      JOIN history_response_timings t ON t.interval_id = x.interval_id
      WHERE x.tool_type = ?
        ${aliasIdentityFilter}
      ORDER BY interval_id ASC, projection ASC
    `).all(...params, ...aliasParams);
    if (rows.length === 0) return 'none';
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')
      .slice(0, 24);
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
