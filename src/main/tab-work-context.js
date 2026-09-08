'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const {
  createSubagentStepProjectionState, claudeRecordToSteps, codexRecordToSteps,
} = require('./subagent-transcript');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OWNED_HEADS = 256;
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const clean = (text) => typeof text === 'string' ? text.trim() : '';
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]+/g, ' ');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function updateWrapper(update) {
  return '<saved_prompt name="' + escape(update.title) + '" context-update-id="'
    + escape(update.id) + '">\n'
    + update.text.split('</saved_prompt>').join('<\\/saved_prompt>') + '\n</saved_prompt>';
}

function refreshUpdateWrapper(prompt, update) {
  const source = String(prompt);
  const marker = 'context-update-id="' + update.id + '"';
  const replacement = updateWrapper(update);
  let cursor = 0;
  let output = '';
  let found = false;
  while (cursor < source.length) {
    const markerAt = source.indexOf(marker, cursor);
    if (markerAt < 0) break;
    const openAt = source.lastIndexOf('<saved_prompt', markerAt);
    const openEnd = source.indexOf('>', markerAt + marker.length);
    const closeAt = openEnd >= 0 ? source.indexOf('</saved_prompt>', openEnd + 1) : -1;
    if (openAt < cursor || openEnd < markerAt || closeAt < 0) {
      output += source.slice(cursor, markerAt + marker.length);
      cursor = markerAt + marker.length;
      continue;
    }
    output += source.slice(cursor, openAt);
    if (!found) output += replacement;
    found = true;
    cursor = closeAt + '</saved_prompt>'.length;
  }
  output += source.slice(cursor);
  return { prompt: output, found };
}

// A single bounded changed span preserves every changed byte, including
// deletions. Line numbers are a display hint; hashes identify the versions.
function changedSpan(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const removedLineCount = endA - start;
  const addedLineCount = endB - start;
  return {
    startLine: start + 1, endLine: Math.max(start + 1, endB),
    beforeEndLine: Math.max(start + 1, endA),
    changedLineCount: Math.max(removedLineCount, addedLineCount),
    text: 'Previous lines ' + (start + 1) + '-' + Math.max(start + 1, endA)
      + ':\n' + a.slice(start, endA).map((line) => '- ' + line).join('\n')
      + '\nCurrent lines ' + (start + 1) + '-' + Math.max(start + 1, endB)
      + ':\n' + b.slice(start, endB).map((line) => '+ ' + line).join('\n'),
  };
}

function splitFileLines(text) {
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body ? body.split('\n') : [], finalNewline };
}

// patch_apply_end already carries source line coordinates. Apply those
// coordinates to one exact file version instead of guessing which repeated
// old_string Codex changed.
function applyDiffHunks(before, hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  const source = splitFileLines(before);
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldStart = Number(hunk?.oldStart);
    const newStart = Number(hunk?.newStart);
    const entries = hunk?.entries;
    if (!Number.isInteger(oldStart) || oldStart < 0
      || !Number.isInteger(newStart) || newStart < 0
      || !Array.isArray(entries)) return null;
    const sourceIndex = oldStart === 0 ? 0 : oldStart - 1;
    const outputIndex = newStart === 0 ? 0 : newStart - 1;
    if (sourceIndex < cursor || sourceIndex > source.lines.length) return null;
    output.push(...source.lines.slice(cursor, sourceIndex));
    if (output.length !== outputIndex) return null;
    cursor = sourceIndex;
    for (const entry of entries) {
      const tag = entry?.tag;
      const line = typeof entry?.line === 'string' ? entry.line : null;
      if (!line && line !== '') return null;
      if (tag === 'add') {
        output.push(line);
        continue;
      }
      if ((tag !== 'eq' && tag !== 'del') || source.lines[cursor] !== line) return null;
      if (tag === 'eq') output.push(line);
      cursor += 1;
    }
  }
  output.push(...source.lines.slice(cursor));
  return output.join('\n') + (source.finalNewline ? '\n' : '');
}

function applyOwnedEdit(before, { args = {}, tool = '', diffHunks = null } = {}) {
  if (typeof before !== 'string') return null;
  if (/write/i.test(tool)) return typeof args.content === 'string' ? args.content : null;
  const positioned = applyDiffHunks(before, diffHunks);
  if (positioned !== null) return positioned;
  let expected = before;
  for (const edit of Array.isArray(args.edits) ? args.edits : [args]) {
    const old = edit?.old_string ?? edit?.oldText;
    const next = edit?.new_string ?? edit?.newText;
    if (typeof old !== 'string' || !old || typeof next !== 'string') return null;
    const at = expected.indexOf(old);
    if (at < 0) return null;
    if (edit.replace_all) expected = expected.split(old).join(next);
    else {
      // Without a line-aware patch, a repeated fragment has no exact owner.
      if (expected.indexOf(old, at + old.length) >= 0) return null;
      expected = expected.slice(0, at) + next + expected.slice(at + old.length);
    }
  }
  return expected;
}

function fileUpdatePresentation(filePath, before, after, beforeHash, afterHash) {
  const span = changedSpan(before, after);
  return {
    title: path.basename(filePath) + ':' + span.startLine + '-' + span.endLine,
    text: 'Working context changed in ' + filePath + '\nVersions: '
      + beforeHash + ' -> ' + afterHash + '\n' + span.text,
    span,
  };
}

function pluralRu(value, one, few, many) {
  const n = Math.abs(Number(value)) % 100;
  const tail = n % 10;
  if (n > 10 && n < 20) return many;
  if (tail === 1) return one;
  if (tail >= 2 && tail <= 4) return few;
  return many;
}

function normalizeFileChange(value) {
  if (!value || typeof value !== 'object' || !clean(value.path)) return null;
  const beforeText = typeof value.beforeText === 'string' ? value.beforeText : null;
  const afterText = typeof value.afterText === 'string' ? value.afterText : null;
  if (beforeText === null || afterText === null) return null;
  const beforeHash = clean(value.beforeHash) || hash(beforeText);
  const afterHash = clean(value.afterHash) || hash(afterText);
  return { path: path.resolve(value.path), beforeHash, afterHash, beforeText, afterText };
}

function fileChangesFromRow(row) {
  if (!row) return [];
  if (typeof row.file_changes_json === 'string' && row.file_changes_json) {
    try {
      const parsed = JSON.parse(row.file_changes_json);
      if (Array.isArray(parsed)) return parsed.map(normalizeFileChange).filter(Boolean);
    } catch {}
  }
  const legacy = normalizeFileChange({
    path: row.path,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    beforeText: row.before_text,
    afterText: row.after_text,
  });
  return legacy ? [legacy] : [];
}

function mergeFileChanges(changes, incoming) {
  const next = changes.map((item) => ({ ...item }));
  const normalized = normalizeFileChange(incoming);
  if (!normalized) return next;
  const index = next.findIndex((item) => item.path === normalized.path);
  if (index < 0) next.push(normalized);
  else {
    const previous = next[index];
    if (previous.afterHash === normalized.afterHash) return next;
    next[index] = {
      path: normalized.path,
      beforeHash: previous.beforeHash,
      beforeText: previous.beforeText,
      afterHash: normalized.afterHash,
      afterText: normalized.afterText,
    };
  }
  return next.filter((item) => item.beforeHash !== item.afterHash);
}

function fileBatchPresentation(changes) {
  const normalized = changes.map(normalizeFileChange).filter(Boolean);
  const spans = normalized.map((item) => ({
    item,
    presentation: fileUpdatePresentation(
      item.path, item.beforeText, item.afterText, item.beforeHash, item.afterHash,
    ),
  }));
  const lines = spans.reduce((sum, entry) => sum + entry.presentation.span.changedLineCount, 0);
  const lineLabel = lines + ' ' + pluralRu(lines, 'строка', 'строки', 'строк');
  const title = normalized.length === 1
    ? path.basename(normalized[0].path) + ' · ' + lineLabel
    : normalized.length + ' ' + pluralRu(normalized.length, 'файл', 'файла', 'файлов') + ' · ' + lineLabel;
  return {
    title,
    text: spans.map((entry) => entry.presentation.text).join('\n\n'),
    startLine: normalized.length === 1 ? spans[0].presentation.span.startLine : null,
    endLine: normalized.length === 1 ? spans[0].presentation.span.endLine : null,
  };
}

class TabWorkContext {
  constructor({ db, listTabs, archivedTab, onChanged }) {
    this.db = db;
    this.listTabs = listTabs;
    this.archivedTab = archivedTab;
    this.onChanged = onChanged;
    this.watchers = new Map();
    this.reads = new Map();
    this.projectors = new Map();
    this.pendingEdits = new Map();
    this.ownedHeads = new Map();
    this.subscriptions = new Map();
    this.subscriptionInflight = new Map();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tab_work_context (
        tab_id TEXT PRIMARY KEY, responsibility TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tab_context_files (
        tab_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', hash TEXT,
        error TEXT, PRIMARY KEY(tab_id, path)
      );
      CREATE TABLE IF NOT EXISTS tab_context_updates (
        id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, source_tab_id TEXT, request_key TEXT,
        title TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, path TEXT,
        before_hash TEXT, after_hash TEXT, before_text TEXT, after_text TEXT,
        start_line INTEGER, end_line INTEGER, file_changes_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, UNIQUE(tab_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS tab_context_updates_owner ON tab_context_updates(tab_id, status);
      CREATE TABLE IF NOT EXISTS tab_context_handoffs (
        tab_id TEXT NOT NULL, handoff_id TEXT NOT NULL, base_hash TEXT NOT NULL,
        prefix TEXT NOT NULL, prepared_prompt TEXT, payload_hash TEXT NOT NULL, update_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'preparing', created_at INTEGER NOT NULL,
        PRIMARY KEY(tab_id, handoff_id)
      );
    `);
    const updateColumns = new Set(
      this.db.prepare('PRAGMA table_info(tab_context_updates)').all().map((column) => column.name),
    );
    if (!updateColumns.has('file_changes_json')) {
      this.db.exec('ALTER TABLE tab_context_updates ADD COLUMN file_changes_json TEXT');
    }
    const handoffColumns = new Set(
      this.db.prepare('PRAGMA table_info(tab_context_handoffs)').all().map((column) => column.name),
    );
    if (!handoffColumns.has('prepared_prompt')) {
      this.db.exec('ALTER TABLE tab_context_handoffs ADD COLUMN prepared_prompt TEXT');
    }
    this.consolidatePendingFileBatches();
  }

  configure({ transcriptService, decodeCodexCall, decodeCodexPatch, readReceipts }) {
    this.transcriptService = transcriptService;
    this.decodeCodexCall = decodeCodexCall;
    this.decodeCodexPatch = decodeCodexPatch;
    this.readReceipts = readReceipts;
    // A staged UI send that never crossed the durable send boundary can be
    // restored. Unknown physical attempts keep their immutable attachment set.
    for (const row of this.db.prepare("SELECT * FROM tab_context_handoffs WHERE status='preparing'").all()) {
      const receipt = (readReceipts?.(row.tab_id) || []).find((r) => r.handoffId === row.handoff_id);
      if (receipt?.state === 'confirmed') this.confirm(row.tab_id, row.handoff_id, row.payload_hash);
      else if (!receipt || ['not-submitted', 'reserved', 'preparing'].includes(receipt.state)) {
        this.release(row.tab_id, row.handoff_id);
      }
    }
    void this.syncLinks().catch((error) => console.warn('[TabContext] startup:', error.message));
  }

  tab(tabId) {
    return this.listTabs().find((tab) => tab.tabId === tabId) || this.archivedTab?.(tabId) || null;
  }

  requireTab(tabId) {
    if (!clean(tabId) || !this.tab(tabId)) throw fail('tab not found', 404);
  }

  touch(tabId) {
    this.db.prepare(`INSERT INTO tab_work_context(tab_id, revision) VALUES (?, 1)
      ON CONFLICT(tab_id) DO UPDATE SET revision=revision+1`).run(tabId);
    this.onChanged?.(this.get(tabId));
  }

  get(tabId, tab = this.tab(tabId)) {
    const row = this.db.prepare('SELECT * FROM tab_work_context WHERE tab_id=?').get(tabId);
    const updates = this.db.prepare(`SELECT id, title, text, kind, path, source_tab_id AS sourceTabId,
      start_line AS startLine, end_line AS endLine, status, created_at AS createdAt
      FROM tab_context_updates WHERE tab_id=? AND status IN ('pending','sending') ORDER BY created_at, rowid`).all(tabId);
    const files = this.db.prepare('SELECT path, hash, error FROM tab_context_files WHERE tab_id=? ORDER BY path').all(tabId);
    return {
      tabId, name: tab?.name || null, projectId: tab?.projectId || null,
      responsibility: row?.responsibility || '', revision: row?.revision || 0,
      files, updates, pendingCount: updates.filter((item) => item.status === 'pending').length,
      sessionId: tab?.codexSessionId || tab?.claudeSessionId || null,
      cwd: tab?.cwd || null,
    };
  }

  list() {
    return this.listTabs().filter((tab) => tab.tabType !== 'file').map((tab) => {
      const state = this.get(tab.tabId, tab);
      return { ...state, updates: state.updates.map(({ text, ...item }) => item) };
    });
  }

  setResponsibility(tabId, description) {
    this.requireTab(tabId);
    if (typeof description !== 'string' || description.length > 12000) throw fail('description must be text up to 12000 characters');
    this.db.prepare(`INSERT INTO tab_work_context(tab_id, responsibility) VALUES (?, ?)
      ON CONFLICT(tab_id) DO UPDATE SET responsibility=excluded.responsibility`).run(tabId, description.trim());
    this.touch(tabId);
    return this.get(tabId);
  }

  publish(tabId, { title, text, sourceTabId = null, requestId = null }) {
    this.requireTab(tabId);
    if (!clean(text) || text.length > 100000) throw fail('update text must contain 1-100000 characters');
    const key = clean(requestId) || null;
    const existing = key && this.db.prepare('SELECT * FROM tab_context_updates WHERE tab_id=? AND request_key=?').get(tabId, key);
    if (existing) {
      if (existing.text !== text.trim() || existing.title !== (clean(title) || 'Обновление состояния')) throw fail('update requestId was reused with different content', 409);
      return { updateId: existing.id, deduplicated: true };
    }
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO tab_context_updates(id, tab_id, source_tab_id, request_key, title, text, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'message', ?)`).run(id, tabId, sourceTabId, key, clean(title) || 'Обновление состояния', text.trim(), Date.now());
    this.touch(tabId);
    void this.syncLinks().catch((e) => console.warn('[TabContext] update subscription:', e.message));
    return { updateId: id, deduplicated: false };
  }

  dismiss(tabId, id) {
    this.requireTab(tabId);
    const result = this.db.prepare("UPDATE tab_context_updates SET status='dismissed' WHERE id=? AND tab_id=? AND status='pending'").run(id, tabId);
    if (!result.changes) throw fail('update changed or is already being sent', 409);
    this.touch(tabId);
    return this.get(tabId);
  }

  async syncLinks() {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = this._syncLinks();
    try { await this.syncing; } finally {
      this.syncing = null;
      if (this.syncAgain) { this.syncAgain = false; void this.syncLinks().catch((e) => console.warn('[TabContext] sync:', e.message)); }
    }
  }

  async _syncLinks() {
    const tabs = this.listTabs();
    const owners = new Map(tabs.map((tab) => [tab.tabId, tab]));
    const links = new Set();
    const dirs = new Set();
    const subscriptionIds = new Set();
    const observedOwners = new Set(this.db.prepare("SELECT DISTINCT tab_id FROM tab_context_updates WHERE status IN ('pending','sending')").all().map((row) => row.tab_id));
    for (const child of tabs) {
      if (child.tabType !== 'file' || !/\.(md|markdown)$/i.test(child.filePath || '')) continue;
      const owner = owners.get(child.visualParentTabId);
      if (!owner) continue;
      const filePath = path.resolve(child.filePath);
      observedOwners.add(owner.tabId);
      links.add(owner.tabId + '\0' + filePath);
      dirs.add(path.dirname(filePath));
      const inserted = this.db.prepare('INSERT OR IGNORE INTO tab_context_files(tab_id,path) VALUES (?,?)').run(owner.tabId, filePath);
      if (inserted.changes || !this.watchers.has(path.dirname(filePath))) await this.readFile(filePath);
    }
    for (const ownerId of observedOwners) {
      const owner = owners.get(ownerId);
      if (!owner) continue;
      const sessionId = owner.commandType?.startsWith('codex') ? owner.codexSessionId : owner.claudeSessionId;
      const toolType = owner.commandType?.startsWith('codex') ? 'codex' : 'claude';
      if (sessionId && this.transcriptService) {
        const consumerId = 'tab-work-context:' + owner.tabId;
        subscriptionIds.add(consumerId);
        if (this.subscriptions.get(consumerId) !== sessionId && !this.subscriptionInflight.has(consumerId)) {
          const request = this.transcriptService.subscribe({ consumerId, tabId: owner.tabId, sessionId, toolType, cwd: owner.cwd })
            .then((subscribed) => { if (subscribed.success) this.subscriptions.set(consumerId, sessionId); })
            .catch((error) => console.warn('[TabContext] transcript unavailable:', owner.tabId, error.message))
            .finally(() => {
              this.subscriptionInflight.delete(consumerId);
              const current = this.listTabs().find((tab) => tab.tabId === owner.tabId);
              const desired = current?.commandType?.startsWith('codex') ? current.codexSessionId : current?.claudeSessionId;
              if (desired !== sessionId) void this.syncLinks().catch((error) => console.warn('[TabContext] rebind:', error.message));
            });
          this.subscriptionInflight.set(consumerId, request);
        }
      }
    }
    for (const row of this.db.prepare('SELECT tab_id,path FROM tab_context_files').all()) {
      // Closed owners retain their baseline; reopening can catch offline edits.
      if (owners.has(row.tab_id) && !links.has(row.tab_id + '\0' + row.path)) {
        this.db.prepare('DELETE FROM tab_context_files WHERE tab_id=? AND path=?').run(row.tab_id, row.path);
        this.touch(row.tab_id);
      } else if (!owners.has(row.tab_id)) dirs.add(path.dirname(row.path));
    }
    for (const [dir, watcher] of this.watchers) if (!dirs.has(dir)) { watcher.close(); this.watchers.delete(dir); }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, name) => {
          const paths = this.db.prepare('SELECT DISTINCT path FROM tab_context_files').all()
            .filter((row) => path.dirname(row.path) === dir && (!name || path.basename(row.path) === String(name)));
          for (const row of paths) void this.readFile(row.path).catch((e) => console.warn('[TabContext] watch:', e.message));
        });
        watcher.on('error', (e) => console.warn('[TabContext] watcher:', dir, e.message));
        watcher.unref();
        this.watchers.set(dir, watcher);
        for (const file of this.db.prepare('SELECT DISTINCT path FROM tab_context_files').all()) {
          if (path.dirname(file.path) === dir) await this.readFile(file.path);
        }
      } catch (e) { console.warn('[TabContext] watcher unavailable:', dir, e.message); }
    }
    for (const id of this.subscriptions.keys()) if (!subscriptionIds.has(id)) {
      await this.transcriptService?.unsubscribe({ consumerId: id });
      this.subscriptions.delete(id);
    }
  }

  async readFile(filePath) {
    const previous = this.reads.get(filePath) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      let content;
      let error = null;
      try {
        const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw fail('Markdown file is unavailable or exceeds 2 MB');
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (!chunk.bytesRead) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead > MAX_FILE_BYTES) throw fail('Markdown file exceeds 2 MB');
          content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
        } finally { await handle.close(); }
      } catch (e) { error = String(e.message || e); }
      for (const row of this.db.prepare('SELECT * FROM tab_context_files WHERE path=?').all(filePath)) {
        if (error) {
          if (row.error === error) continue;
          this.db.prepare('UPDATE tab_context_files SET error=? WHERE tab_id=? AND path=?').run(error, row.tab_id, filePath);
          this.publishFileUpdate(row, { error });
          this.touch(row.tab_id);
          continue;
        }
        const digest = hash(content);
        if (digest === row.hash && !row.error) continue;
        this.db.transaction(() => {
          if (row.error) this.db.prepare("UPDATE tab_context_updates SET status='superseded' WHERE tab_id=? AND path=? AND kind='file-error' AND status='pending'").run(row.tab_id, filePath);
          if (row.hash && row.hash !== digest) this.publishFileUpdate(row, { content, digest });
          this.db.prepare('UPDATE tab_context_files SET content=?, hash=?, error=NULL WHERE tab_id=? AND path=?')
            .run(content, digest, row.tab_id, filePath);
        })();
        this.touch(row.tab_id);
      }
    });
    this.reads.set(filePath, work);
    try { await work; } finally { if (this.reads.get(filePath) === work) this.reads.delete(filePath); }
  }

  reservedUpdateIds(tabId) {
    const ids = new Set();
    for (const row of this.db.prepare('SELECT update_ids FROM tab_context_handoffs WHERE tab_id=?').all(tabId)) {
      try {
        for (const id of JSON.parse(row.update_ids || '[]')) ids.add(String(id));
      } catch {}
    }
    return ids;
  }

  pendingFileRows(tabId, { mutableOnly = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM tab_context_updates
      WHERE tab_id=? AND status='pending' AND kind IN ('file','file-batch')
      ORDER BY created_at,rowid`).all(tabId);
    if (!mutableOnly) return rows;
    const reserved = this.reservedUpdateIds(tabId);
    return rows.filter((row) => !reserved.has(row.id));
  }

  saveFileBatch(rowId, tabId, changes, emptyStatus = 'superseded') {
    const normalized = changes.map(normalizeFileChange).filter(Boolean)
      .filter((item) => item.beforeHash !== item.afterHash);
    if (normalized.length === 0) {
      return this.db.prepare(`UPDATE tab_context_updates
        SET status=?,before_text=NULL,after_text=NULL,file_changes_json='[]'
        WHERE id=? AND tab_id=? AND status='pending'`).run(emptyStatus, rowId, tabId).changes > 0;
    }
    const presentation = fileBatchPresentation(normalized);
    const single = normalized.length === 1 ? normalized[0] : null;
    return this.db.prepare(`UPDATE tab_context_updates SET
      title=?,text=?,kind='file-batch',path=?,before_hash=?,after_hash=?,
      before_text=?,after_text=?,start_line=?,end_line=?,file_changes_json=?
      WHERE id=? AND tab_id=? AND status='pending'`).run(
      presentation.title,
      presentation.text,
      single?.path || null,
      single?.beforeHash || null,
      single?.afterHash || null,
      single?.beforeText || null,
      single?.afterText || null,
      presentation.startLine,
      presentation.endLine,
      JSON.stringify(normalized),
      rowId,
      tabId,
    ).changes > 0;
  }

  consolidatePendingFileBatches(tabId = null) {
    const ownerIds = tabId
      ? [tabId]
      : this.db.prepare(`SELECT DISTINCT tab_id FROM tab_context_updates
          WHERE status='pending' AND kind IN ('file','file-batch')`).all().map((row) => row.tab_id);
    for (const ownerId of ownerIds) {
      const rows = this.pendingFileRows(ownerId, { mutableOnly: true });
      if (rows.length === 0) continue;
      let changes = [];
      for (const row of rows) {
        for (const item of fileChangesFromRow(row)) changes = mergeFileChanges(changes, item);
      }
      this.saveFileBatch(rows[0].id, ownerId, changes);
      for (const row of rows.slice(1)) {
        this.db.prepare(`UPDATE tab_context_updates
          SET status='superseded',before_text=NULL,after_text=NULL,file_changes_json=NULL
          WHERE id=? AND tab_id=? AND status='pending'`).run(row.id, ownerId);
      }
    }
  }

  upsertPendingFileChange(tabId, incoming) {
    const rows = this.pendingFileRows(tabId, { mutableOnly: true });
    let changes = [];
    for (const row of rows) {
      for (const item of fileChangesFromRow(row)) changes = mergeFileChanges(changes, item);
    }
    changes = mergeFileChanges(changes, incoming);
    if (rows.length === 0) {
      if (changes.length === 0) return;
      const id = crypto.randomUUID();
      const first = changes[0];
      this.db.prepare(`INSERT INTO tab_context_updates(
        id,tab_id,title,text,kind,path,before_hash,after_hash,before_text,after_text,
        start_line,end_line,file_changes_json,created_at
      ) VALUES (?,?,'','', 'file-batch',?,?,?,?,?,NULL,NULL,?,?)`).run(
        id, tabId, first.path, first.beforeHash, first.afterHash,
        first.beforeText, first.afterText, JSON.stringify(changes), Date.now(),
      );
      this.saveFileBatch(id, tabId, changes);
      return;
    }
    this.saveFileBatch(rows[0].id, tabId, changes);
    for (const row of rows.slice(1)) {
      this.db.prepare(`UPDATE tab_context_updates
        SET status='superseded',before_text=NULL,after_text=NULL,file_changes_json=NULL
        WHERE id=? AND tab_id=? AND status='pending'`).run(row.id, tabId);
    }
  }

  latestPendingFileChange(tabId, filePath, afterHash) {
    const rows = this.pendingFileRows(tabId).reverse();
    for (const row of rows) {
      const match = fileChangesFromRow(row).find((item) => (
        item.path === filePath && item.afterHash === afterHash
      ));
      if (match) return match;
    }
    return null;
  }

  publishFileUpdate(row, { content, digest, error }) {
    if (!error) {
      this.upsertPendingFileChange(row.tab_id, {
        path: row.path,
        beforeHash: row.hash,
        afterHash: digest,
        beforeText: row.content,
        afterText: content,
      });
      return;
    }
    const presentation = error ? null
      : fileUpdatePresentation(row.path, row.content, content, row.hash, digest);
    const title = presentation?.title || path.basename(row.path) + ' · недоступен';
    const text = error
      ? 'Linked working file is unavailable: ' + row.path + '\n' + error
      : presentation.text;
    this.db.prepare(`INSERT INTO tab_context_updates(id,tab_id,title,text,kind,path,before_hash,after_hash,
      before_text,after_text,start_line,end_line,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), row.tab_id, title, text, error ? 'file-error' : 'file', row.path,
        row.hash, digest || null, error ? null : row.content, content ?? null,
        presentation?.span.startLine || null, presentation?.span.endLine || null, Date.now());
  }

  async prepare(tabId, handoffId, prompt) {
    if (!tabId || !handoffId || !String(prompt).trim() || String(prompt).trimStart().startsWith('/')) return { prompt, prefix: '' };
    const saved = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (saved) {
      if (promptAuditFingerprint(prompt) === saved.payload_hash) return { prompt, prefix: saved.prefix };
      if (hash(prompt) !== saved.base_hash) throw fail('context handoff reused for another prompt', 409);
      return { prompt: saved.prepared_prompt || saved.prefix + prompt, prefix: saved.prefix };
    }
    if ((this.readReceipts?.(tabId) || []).some((receipt) => receipt.handoffId === handoffId)) {
      return { prompt, prefix: '' };
    }
    await this.syncLinks();
    for (const file of this.db.prepare('SELECT path FROM tab_context_files WHERE tab_id=?').all(tabId)) await this.readFile(file.path);
    // Another caller may have reserved this same handoff while file IO yielded.
    if (this.db.prepare('SELECT 1 FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId)) {
      return this.prepare(tabId, handoffId, prompt);
    }
    const updates = this.db.prepare("SELECT * FROM tab_context_updates WHERE tab_id=? AND status='pending' ORDER BY created_at,rowid").all(tabId);
    let preparedBase = prompt;
    const missing = [];
    for (const update of updates) {
      const refreshed = refreshUpdateWrapper(preparedBase, update);
      preparedBase = refreshed.prompt;
      if (!refreshed.found) missing.push(update);
    }
    const prefix = missing.map(updateWrapper).join('\n\n');
    const separatorPrefix = prefix ? prefix + '\n\n' : '';
    const full = separatorPrefix + preparedBase;
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO tab_context_handoffs(
        tab_id,handoff_id,base_hash,prefix,prepared_prompt,payload_hash,update_ids,created_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        tabId, handoffId, hash(prompt), separatorPrefix, full,
        promptAuditFingerprint(full), JSON.stringify(updates.map((item) => item.id)), Date.now(),
      );
      for (const item of updates) this.db.prepare("UPDATE tab_context_updates SET status='sending' WHERE id=? AND status='pending'").run(item.id);
    })();
    if (updates.length) this.touch(tabId);
    return { prompt: full, prefix: separatorPrefix };
  }

  confirm(tabId, handoffId, expectedHash) {
    const sent = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (!sent || sent.payload_hash !== expectedHash || sent.status === 'delivered') return;
    this.db.transaction(() => {
      for (const id of JSON.parse(sent.update_ids)) {
        this.db.prepare("UPDATE tab_context_updates SET status='delivered',before_text=NULL,after_text=NULL WHERE id=? AND tab_id=? AND status='sending'").run(id, tabId);
      }
      this.db.prepare("UPDATE tab_context_handoffs SET status='delivered' WHERE tab_id=? AND handoff_id=?").run(tabId, handoffId);
    })();
    this.touch(tabId);
  }

  activate(tabId, handoffId) {
    const sent = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (!sent || sent.status === 'delivered') return;
    let changed = 0;
    this.db.transaction(() => {
      for (const id of JSON.parse(sent.update_ids)) changed += this.db.prepare("UPDATE tab_context_updates SET status='sending' WHERE id=? AND tab_id=? AND status='pending'").run(id, tabId).changes;
      this.db.prepare("UPDATE tab_context_handoffs SET status='preparing' WHERE tab_id=? AND handoff_id=?").run(tabId, handoffId);
    })();
    if (changed) this.touch(tabId);
  }

  hasHandoff(tabId, handoffId) {
    return !!this.db.prepare('SELECT 1 FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
  }

  release(tabId, handoffId) {
    const sent = this.db.prepare('SELECT * FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
    if (!sent || sent.status === 'delivered') return;
    this.db.transaction(() => {
      for (const id of JSON.parse(sent.update_ids)) this.db.prepare("UPDATE tab_context_updates SET status='pending' WHERE id=? AND tab_id=? AND status='sending'").run(id, tabId);
      this.db.prepare("UPDATE tab_context_handoffs SET status='failed' WHERE tab_id=? AND handoff_id=?").run(tabId, handoffId);
    })();
    this.touch(tabId);
  }

  settle(tabId, handoffId, result) {
    const receipt = classifyAgentSendReceipt(result);
    if (receipt.state === 'not-submitted' || receipt.state === 'provider-not-accepted' || result?.historyRecorded === true) {
      if (result?.historyRecorded === true) {
        const record = this.db.prepare('SELECT payload_hash FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?').get(tabId, handoffId);
        if (record) this.confirm(tabId, handoffId, record.payload_hash);
      } else this.release(tabId, handoffId);
    }
  }

  ownedHeadKey(tabId, sessionId, filePath) {
    return tabId + '\0' + (sessionId || '') + '\0' + filePath;
  }

  rememberOwnedHead(tabId, sessionId, filePath, before, after) {
    if (before === after) return;
    const key = this.ownedHeadKey(tabId, sessionId, filePath);
    const beforeHash = hash(before);
    const afterHash = hash(after);
    const previous = this.ownedHeads.get(key);
    this.ownedHeads.delete(key);
    this.ownedHeads.set(key, previous?.afterHash === beforeHash
      ? { beforeHash: previous.beforeHash, afterHash, afterText: after }
      : { beforeHash, afterHash, afterText: after });
    while (this.ownedHeads.size > MAX_OWNED_HEADS) {
      this.ownedHeads.delete(this.ownedHeads.keys().next().value);
    }
  }

  ownedEditBefore(tabId, sessionId, filePath, row) {
    const key = this.ownedHeadKey(tabId, sessionId, filePath);
    const head = this.ownedHeads.get(key);
    if (!head) return row.content;
    if (head.beforeHash === row.hash) return head.afterText;
    // The filesystem observer caught up or a different writer advanced the
    // file. Either way the durable row is now the newer starting point.
    this.ownedHeads.delete(key);
    return row.content;
  }

  reconcileOwnedTransition(tabId, filePath, before, after, current) {
    if (before === after) return null;
    const beforeHash = hash(before);
    const afterHash = hash(after);
    for (const row of this.pendingFileRows(tabId)) {
      const changes = fileChangesFromRow(row);
      const index = changes.findIndex((item) => item.path === filePath && item.beforeHash === beforeHash);
      if (index < 0) continue;
      const observed = changes[index];
      if (observed.afterHash === afterHash) {
        changes.splice(index, 1);
        this.saveFileBatch(row.id, tabId, changes, 'own-edit');
        return { changed: true, outcome: 'exact', beforeHash, afterHash };
      }
      // fs.watch may coalesce "own A->B" and a later external B->C into one
      // durable A->C row. Remove only the proven A->B prefix; C remains visible.
      if (!current?.hash || current.hash !== observed.afterHash) continue;
      changes[index] = {
        ...observed,
        beforeHash: afterHash,
        beforeText: after,
      };
      const netChanges = changes[index].beforeHash === changes[index].afterHash
        ? changes.filter((_, itemIndex) => itemIndex !== index)
        : changes;
      this.saveFileBatch(row.id, tabId, netChanges, 'own-edit');
      return { changed: true, outcome: 'external-residue', beforeHash, afterHash };
    }
    return null;
  }

  observeRecord(detail) {
    const { tabId, sessionId, toolType, message } = detail;
    let userText = null;
    if (toolType === 'codex' && message?.type === 'event_msg' && message.payload?.type === 'user_message') {
      userText = message.payload.message;
    } else if (toolType === 'claude' && message?.type === 'user' && message.uuid && message.isMeta !== true) {
      const blocks = message.message?.content;
      if (typeof blocks === 'string') userText = blocks;
      else if (Array.isArray(blocks) && !blocks.some((block) => block.type === 'tool_result')) {
        userText = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n');
      }
    }
    if (typeof userText === 'string') {
      const digest = promptAuditFingerprint(userText);
      for (const sent of this.db.prepare("SELECT handoff_id FROM tab_context_handoffs WHERE tab_id=? AND payload_hash=? AND status='preparing'").all(tabId, digest)) {
        this.confirm(tabId, sent.handoff_id, digest);
      }
    }
    if (!this.db.prepare('SELECT 1 FROM tab_context_files WHERE tab_id=? LIMIT 1').get(tabId)) return;
    if (toolType === 'codex' && message?.type === 'event_msg') {
      for (const action of this.decodeCodexPatch?.(message.payload) || []) {
        const filePath = path.resolve(this.tab(tabId)?.cwd || '/', action.args?.file_path || '');
        const row = this.db.prepare('SELECT * FROM tab_context_files WHERE tab_id=? AND path=?').get(tabId, filePath);
        if (row) void this.acceptOwnEdit(tabId, filePath, {
          before: this.ownedEditBefore(tabId, sessionId, filePath, row),
          args: action.args,
          tool: action.toolName,
          diffHunks: action.diffHunks,
          sessionId,
          operationId: String(message.payload?.call_id || message.payload?.id || 'patch'),
          beforeTrusted: false,
        }).catch((e) => console.warn('[TabContext] own patch:', e.message));
      }
    }
    const key = tabId + ':' + sessionId;
    let state = this.projectors.get(key);
    if (!state) {
      for (const candidate of this.projectors.keys()) if (candidate.startsWith(tabId + ':')) this.projectors.delete(candidate);
      state = createSubagentStepProjectionState({ codexSessionId: sessionId });
      this.projectors.set(key, state);
    }
    const steps = toolType === 'codex'
      ? codexRecordToSteps(message, state, this.decodeCodexCall)
      : claudeRecordToSteps(message, state);
    for (const step of steps) {
      if (step.kind !== 'tool' || !['Edit','MultiEdit','Write','edit_file','write_file'].includes(step.tool)) continue;
      const args = step.args || {};
      const filePath = path.resolve(this.tab(tabId)?.cwd || '/', args.file_path || args.path || '');
      const row = this.db.prepare('SELECT * FROM tab_context_files WHERE tab_id=? AND path=?').get(tabId, filePath);
      if (!row) continue;
      const opKey = key + ':' + step.id;
      if (step.result === undefined) {
        if (!this.pendingEdits.has(opKey)) this.pendingEdits.set(opKey, {
          before: this.ownedEditBefore(tabId, sessionId, filePath, row),
          args,
          tool: step.tool,
          diffHunks: step.diffHunks,
          sessionId,
          operationId: step.id,
          beforeTrusted: true,
        });
        if (this.pendingEdits.size > 512) this.pendingEdits.delete(this.pendingEdits.keys().next().value);
        continue;
      }
      const pending = this.pendingEdits.get(opKey);
      this.pendingEdits.delete(opKey);
      if (step.isError || !pending) continue;
      void this.acceptOwnEdit(tabId, filePath, {
        ...pending,
        diffHunks: step.diffHunks || pending.diffHunks,
      }).catch((e) => console.warn('[TabContext] own edit:', e.message));
    }
  }

  async acceptOwnEdit(tabId, filePath, {
    before, args, tool, diffHunks = null, sessionId = null, operationId = null,
    beforeTrusted = false,
  }) {
    const initialExpected = applyOwnedEdit(before, { args, tool, diffHunks });
    if (beforeTrusted && initialExpected !== null) {
      this.rememberOwnedHead(tabId, sessionId, filePath, before, initialExpected);
    }
    await this.readFile(filePath);
    const current = this.db.prepare('SELECT * FROM tab_context_files WHERE tab_id=? AND path=?').get(tabId, filePath);
    const latestTransition = current?.hash
      ? this.latestPendingFileChange(tabId, filePath, current.hash)
      : null;
    const candidates = new Set([before, latestTransition?.beforeText].filter((item) => typeof item === 'string'));
    let changed = false;
    let outcome = null;
    for (const candidate of candidates) {
      const expected = applyOwnedEdit(candidate, { args, tool, diffHunks });
      if (expected === null) continue;
      const reconciled = this.reconcileOwnedTransition(tabId, filePath, candidate, expected, current);
      if (reconciled?.changed) {
        this.rememberOwnedHead(tabId, sessionId, filePath, candidate, expected);
        changed = true;
        outcome = reconciled.outcome;
      }
    }
    const headKey = this.ownedHeadKey(tabId, sessionId, filePath);
    const head = this.ownedHeads.get(headKey);
    if (head && current?.hash === head.afterHash) this.ownedHeads.delete(headKey);
    if (changed) {
      console.log('[TabContext] own file change reconciled tab=' + String(tabId).slice(-12)
        + ' session=' + String(sessionId || '-').slice(0, 8)
        + ' operation=' + String(operationId || '-').slice(0, 24)
        + ' outcome=' + outcome + ' file=' + path.basename(filePath));
      this.touch(tabId);
    }
  }
}

module.exports = { TabWorkContext, updateWrapper, applyDiffHunks, applyOwnedEdit };
