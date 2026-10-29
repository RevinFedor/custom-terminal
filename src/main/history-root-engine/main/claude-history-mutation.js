'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = code => { throw Object.assign(new Error(code), { code }); };
const statIdentity = stat => ({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev });
const sameStat = (a, b) => Object.keys(a).every(key => a[key] === b[key]);

async function readClaudeMutationFile(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const before = statIdentity(await fd.stat());
    const bytes = await fd.readFile();
    const after = statIdentity(await fd.stat());
    if (!sameStat(before, after) || bytes.length !== before.size) failure('stale_transcript_revision');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const records = content.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    return { filePath: path.resolve(filePath), ...after, hash: digest(bytes), content, records };
  } finally { await fd.close(); }
}

function claudeMutationRevision({ sessionId, cwd, sources }) {
  const value = { schema: 'claude-mutation-v1', sessionId, cwd: cwd || '', sources: sources.map(source => ({
    sessionId: source.sessionId, parentSessionId: source.parentSessionId || null, linkKind: source.linkKind || 'end',
    filePath: source.filePath, size: source.size, mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs,
    ino: source.ino, dev: source.dev, hash: source.hash,
  })) };
  return { ...value, token: digest(JSON.stringify(value)) };
}

function checkClaudeMutationRevision(loaded, expectedRevision) {
  if (!expectedRevision) return;
  const token = typeof expectedRevision === 'string' ? expectedRevision : expectedRevision.token;
  if (!token || token !== loaded.revision.token) failure('stale_transcript_revision');
}

function assertClaudeMutationCurrent(loaded, { findSessionFile, getSessionParent }) {
  for (const source of loaded.sources) {
    const found = findSessionFile(source.sessionId, loaded.cwd);
    if (!found || path.resolve(found.filePath) !== source.filePath) failure('stale_transcript_topology');
    const current = fs.statSync(source.filePath);
    if (!sameStat(statIdentity(source), statIdentity(current))
      || digest(fs.readFileSync(source.filePath)) !== source.hash) failure('stale_transcript_revision');
    const parent = getSessionParent?.(source.sessionId) || null;
    if (source.linkKind === 'sqlite' && parent !== source.parentSessionId) failure('stale_transcript_topology');
    if (source.linkKind === 'end' && parent && findSessionFile(parent, loaded.cwd)) failure('stale_transcript_topology');
  }
}

function callClaudeMutationGuard(guard, loaded) {
  if (typeof guard !== 'function') return;
  const result = guard(loaded);
  if (result?.then) {
    // A commit callback must not yield. Consume a possible rejection without
    // granting it any ability to write after this function has returned.
    Promise.resolve(result).catch(() => {});
    failure('claude_history_commit_guard_must_be_sync');
  }
  if (result === false || result?.allowed === false || result?.success === false) {
    failure(result?.reason || result?.error || 'claude_history_commit_guard_rejected');
  }
}

async function commitClaudeHistoryMutation({ loaded, output, beforeCommit, findSessionFile, getSessionParent }) {
  const filePath = loaded.filePath;
  const temporary = filePath + '.delete-' + crypto.randomUUID() + '.tmp';
  let staged = false;
  try {
    if (output !== null) {
      await fs.promises.writeFile(temporary, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      staged = true;
    }
    assertClaudeMutationCurrent(loaded, { findSessionFile, getSessionParent });
    callClaudeMutationGuard(beforeCommit, loaded);
    // No await between owner/revision proof and rename/unlink. A second
    // in-process mutation or input event cannot enter this commit interval.
    assertClaudeMutationCurrent(loaded, { findSessionFile, getSessionParent });
    if (output === null) fs.unlinkSync(filePath);
    else fs.renameSync(temporary, filePath);
    staged = false;
    return { committed: true, fileDeleted: output === null };
  } finally {
    if (staged) { try { fs.unlinkSync(temporary); } catch {} }
  }
}

module.exports = { readClaudeMutationFile, claudeMutationRevision, checkClaudeMutationRevision,
  assertClaudeMutationCurrent, callClaudeMutationGuard, commitClaudeHistoryMutation };
