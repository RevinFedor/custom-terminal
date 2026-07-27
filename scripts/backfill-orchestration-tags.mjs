#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ORCHESTRATION_PREFIX = '[Оркестрация]';

export function promptTransportHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

export function parseOrchestrationMessage(text) {
  if (typeof text !== 'string' || !text.startsWith(ORCHESTRATION_PREFIX)) return null;
  const runId = text.match(/^runId:\s*([0-9a-z-]{8,80})\s*$/im)?.[1] || '';
  if (!runId) return null;
  const firstLine = text.split(/\r?\n/, 1)[0];
  return {
    runId,
    phase: /с ошибкой/i.test(firstLine) ? 'failure' : 'completion',
  };
}

function claudeText(record) {
  if (record?.type !== 'user' || record?.isMeta || record?.isCompactSummary) return null;
  const content = record?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const textBlocks = content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text);
  return textBlocks.length === 1 ? textBlocks[0] : null;
}

function filenameSessionId(filePath) {
  const basename = path.basename(filePath, '.jsonl');
  const matches = basename.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi);
  return matches?.at(-1) || basename;
}

export function candidateFromClaudeRecord(record, filePath) {
  const text = claudeText(record);
  const tag = parseOrchestrationMessage(text);
  const timestamp = typeof record?.timestamp === 'string' ? record.timestamp : '';
  const entryUuid = typeof record?.uuid === 'string' ? record.uuid : '';
  const sessionId = String(record?.sessionId || filenameSessionId(filePath)).trim();
  if (!tag || !timestamp || !entryUuid || !sessionId || !Number.isFinite(Date.parse(timestamp))) return null;
  return {
    toolType: 'claude',
    sessionId,
    auditTimestamp: timestamp,
    transportHash: promptTransportHash(text),
    entryUuid,
    tag: { id: `backfill-orchestration-${tag.runId}`, kind: 'orchestration', ...tag },
  };
}

export function candidateFromCodexRecord(record, filePath, lineIndex, sessionIdHint = '') {
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'user_message') return null;
  const text = typeof record.payload.message === 'string' ? record.payload.message : null;
  const tag = parseOrchestrationMessage(text);
  const timestamp = typeof record?.timestamp === 'string' ? record.timestamp : '';
  const sessionId = String(sessionIdHint || filenameSessionId(filePath)).trim();
  if (!tag || !timestamp || !sessionId || !Number.isInteger(lineIndex) || !Number.isFinite(Date.parse(timestamp))) return null;
  return {
    toolType: 'codex',
    sessionId,
    auditTimestamp: timestamp,
    transportHash: promptTransportHash(text),
    entryUuid: `codex-user-${sessionId}-${lineIndex}`,
    tag: { id: `backfill-orchestration-${tag.runId}`, kind: 'orchestration', ...tag },
  };
}

async function collectRecentFiles(root, cutoffMs, output = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectRecentFiles(fullPath, cutoffMs, output);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const stat = await fs.promises.stat(fullPath).catch(() => null);
    if (stat && stat.mtimeMs >= cutoffMs) output.push(fullPath);
  }
  return output;
}

async function scanJsonl(filePath, toolType, cutoffMs, candidates, stats) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineIndex = 0;
  let codexSessionId = filenameSessionId(filePath);
  for await (const line of lines) {
    if (!line.trim()) {
      lineIndex += 1;
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.invalidLines += 1;
      lineIndex += 1;
      continue;
    }
    if (toolType === 'codex' && record?.type === 'session_meta') {
      codexSessionId = String(record?.payload?.id || record?.payload?.session_id || codexSessionId);
    }
    const candidate = toolType === 'codex'
      ? candidateFromCodexRecord(record, filePath, lineIndex, codexSessionId)
      : candidateFromClaudeRecord(record, filePath);
    if (candidate && Date.parse(candidate.auditTimestamp) >= cutoffMs) {
      const key = [candidate.toolType, candidate.sessionId, candidate.auditTimestamp, candidate.transportHash].join('\u0000');
      candidates.set(key, candidate);
    }
    lineIndex += 1;
  }
  stats.filesScanned += 1;
}

function ensureSidecarSchema(db) {
  db.exec(`
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
    );
    CREATE INDEX IF NOT EXISTS idx_history_prompt_presentations_entry
    ON history_prompt_presentations(tool_type, session_id, entry_uuid);
  `);
}

function mergeCandidate(db, candidate, apply) {
  const existing = db.prepare(`
    SELECT entry_uuid, schema_version, chips_json
    FROM history_prompt_presentations
    WHERE tool_type = ? AND session_id = ? AND audit_timestamp = ? AND transport_hash = ?
  `).get(candidate.toolType, candidate.sessionId, candidate.auditTimestamp, candidate.transportHash);
  let items = [];
  try {
    items = existing ? JSON.parse(existing.chips_json || '[]') : [];
  } catch {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  const same = items.some(item => item?.kind === 'orchestration'
    && item.runId === candidate.tag.runId
    && item.phase === candidate.tag.phase);
  const entryMatches = !existing?.entry_uuid || existing.entry_uuid === candidate.entryUuid;
  if (same && entryMatches) return 'unchanged';
  const nextItems = [
    ...items.filter(item => item?.kind !== 'orchestration' || item.runId !== candidate.tag.runId),
    candidate.tag,
  ];
  if (!apply) return existing ? 'wouldUpdate' : 'wouldInsert';
  db.prepare(`
    INSERT INTO history_prompt_presentations (
      tool_type, session_id, audit_timestamp, transport_hash, entry_uuid,
      schema_version, chips_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 2, ?, strftime('%s', 'now'), strftime('%s', 'now'))
    ON CONFLICT(tool_type, session_id, audit_timestamp, transport_hash) DO UPDATE SET
      entry_uuid = COALESCE(history_prompt_presentations.entry_uuid, excluded.entry_uuid),
      schema_version = MAX(history_prompt_presentations.schema_version, 2),
      chips_json = excluded.chips_json,
      updated_at = strftime('%s', 'now')
  `).run(
    candidate.toolType,
    candidate.sessionId,
    candidate.auditTimestamp,
    candidate.transportHash,
    candidate.entryUuid,
    JSON.stringify(nextItems),
  );
  return existing ? 'updated' : 'inserted';
}

function parseArgs(argv) {
  const options = { apply: false, days: 3, json: false, dbPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--days') options.days = Math.max(1, Number(argv[++index]) || 3);
    else if (arg === '--db') options.dbPaths.push(path.resolve(argv[++index]));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const now = Date.now();
  const cutoffMs = now - options.days * 24 * 60 * 60 * 1000;
  const fileCutoffMs = cutoffMs - 24 * 60 * 60 * 1000;
  const candidates = new Map();
  const stats = { filesScanned: 0, invalidLines: 0 };
  const roots = [
    { toolType: 'claude', path: path.join(os.homedir(), '.claude', 'projects') },
    { toolType: 'codex', path: path.join(os.homedir(), '.codex', 'sessions') },
  ];
  for (const root of roots) {
    const files = await collectRecentFiles(root.path, fileCutoffMs);
    for (const filePath of files) await scanJsonl(filePath, root.toolType, cutoffMs, candidates, stats);
  }

  const dbPaths = options.dbPaths.length > 0 ? options.dbPaths : [
    path.join(os.homedir(), 'Library', 'Application Support', 'noted-terminal', 'noted-terminal.db'),
    path.join(os.homedir(), 'Library', 'Application Support', 'noted-terminal', 'noted-terminal-dev.db'),
  ].filter(filePath => fs.existsSync(filePath));
  const Database = require('better-sqlite3');
  const databases = [];
  for (const dbPath of dbPaths) {
    const db = new Database(dbPath, { readonly: !options.apply, fileMustExist: true });
    if (options.apply) ensureSidecarSchema(db);
    databases.push({ db, dbPath });
  }

  const result = {
    mode: options.apply ? 'apply' : 'dry-run',
    days: options.days,
    cutoff: new Date(cutoffMs).toISOString(),
    candidates: candidates.size,
    filesScanned: stats.filesScanned,
    invalidLines: stats.invalidLines,
    databases: [],
  };
  for (const { db, dbPath } of databases) {
    const counts = { inserted: 0, updated: 0, unchanged: 0, wouldInsert: 0, wouldUpdate: 0 };
    const applyAll = db.transaction(() => {
      for (const candidate of candidates.values()) counts[mergeCandidate(db, candidate, options.apply)] += 1;
    });
    applyAll();
    db.close();
    result.databases.push({ dbPath, ...counts });
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    console.log(`[orchestration-backfill] mode=${result.mode} candidates=${result.candidates} files=${result.filesScanned} invalidLines=${result.invalidLines}`);
    for (const row of result.databases) {
      console.log(`[orchestration-backfill] db=${row.dbPath} insert=${row.inserted || row.wouldInsert} update=${row.updated || row.wouldUpdate} unchanged=${row.unchanged}`);
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[orchestration-backfill] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
