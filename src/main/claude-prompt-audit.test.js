'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  captureClaudePromptAuditBoundary,
  classifyClaudeAuditRecordAfterBoundary,
  readLastClaudeUserRecord,
} = require('./claude-prompt-audit');

function userRecord(uuid, text, timestamp = '2026-07-24T10:00:00.000Z') {
  return {
    type: 'user',
    uuid,
    timestamp,
    message: { role: 'user', content: text },
  };
}

test('an identical pre-submit Claude record cannot satisfy the next audit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify(userRecord('old-uuid', 'same prompt')) + '\n',
  );

  const boundary = await captureClaudePromptAuditBoundary(transcriptPath);
  const stale = await readLastClaudeUserRecord(transcriptPath, boundary);
  assert.equal(stale, null, 'same-file audit reads only bytes after the boundary');

  fs.appendFileSync(
    transcriptPath,
    JSON.stringify(userRecord('new-uuid', 'same prompt')) + '\n',
  );
  const appended = await readLastClaudeUserRecord(transcriptPath, boundary);
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(appended, boundary), {
    causal: true,
    reason: 'record-after-byte-boundary',
  });
});

test('resume child rejects a copied identical tail and accepts only a new UUID', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'source.jsonl');
  const childPath = path.join(dir, 'child.jsonl');
  const copied = JSON.stringify(userRecord('source-tail-uuid', 'same prompt')) + '\n';
  fs.writeFileSync(sourcePath, copied);
  const boundary = await captureClaudePromptAuditBoundary(sourcePath);

  fs.writeFileSync(childPath, copied);
  const staleChild = await readLastClaudeUserRecord(childPath, boundary);
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(staleChild, boundary), {
    causal: false,
    reason: 'copied-source-tail',
  });

  fs.appendFileSync(
    childPath,
    JSON.stringify(userRecord('child-new-uuid', 'same prompt')) + '\n',
  );
  const newChild = await readLastClaudeUserRecord(childPath, boundary);
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(newChild, boundary), {
    causal: true,
    reason: 'new-child-record-uuid',
  });
});

test('large JSONL prefixes and partial appended lines use bounded tail/offset reads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-bounded-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcriptPath = path.join(dir, 'large-session.jsonl');
  const maxReadBytes = 4096;
  const largeAssistant = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: 'x'.repeat(maxReadBytes * 4),
    },
  });
  fs.writeFileSync(
    transcriptPath,
    largeAssistant + '\n' + JSON.stringify(userRecord('old-uuid', 'same prompt')) + '\n',
  );

  const boundary = await captureClaudePromptAuditBoundary(transcriptPath, {
    maxReadBytes,
  });
  assert.equal(boundary.lastUserUuid, 'old-uuid');
  assert.ok(
    boundary.bytesRead <= maxReadBytes + 1,
    `pre-boundary read ${boundary.bytesRead} bytes`,
  );

  const nextLine = JSON.stringify(userRecord('new-uuid', 'same prompt'));
  const splitAt = Math.floor(nextLine.length / 2);
  fs.appendFileSync(transcriptPath, nextLine.slice(0, splitAt));
  const partial = await readLastClaudeUserRecord(transcriptPath, boundary, {
    maxReadBytes,
  });
  assert.equal(partial, null, 'a partial post-boundary JSON line is not proof');

  fs.appendFileSync(transcriptPath, nextLine.slice(splitAt) + '\n');
  const complete = await readLastClaudeUserRecord(transcriptPath, boundary, {
    maxReadBytes,
  });
  assert.equal(complete.record.uuid, 'new-uuid');
  assert.equal(complete.readMode, 'post-boundary-offset');
  assert.ok(
    complete.bytesRead <= maxReadBytes,
    `post-boundary read ${complete.bytesRead} bytes`,
  );
  assert.deepEqual(classifyClaudeAuditRecordAfterBoundary(complete, boundary), {
    causal: true,
    reason: 'record-after-byte-boundary',
  });
});
