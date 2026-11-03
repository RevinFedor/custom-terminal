'use strict';
// A message sent into a BUSY Claude tab is queued by Claude, and its
// UserPromptSubmit carries the ACTIVE turn's prompt_id. Main drops that event
// as `duplicate-prompt-start`, so the PasteAudit waiting for the next admitted
// UserPromptSubmit never saw it. The card stayed CONFIRMING for the whole
// running turn and then went delivery-unknown, while the user watched the
// prompt land in Claude Code:
//   01.11 05:37:31.642  PasteAudit staged … await=true
//   01.11 05:37:31.694  ClaudeHookScope ignored reason=duplicate-prompt-start
//   01.11 05:37:39.643  PasteAudit:TIMEOUT  (nothing else ever looked)
//   01.11 05:38:30.867  renderer receipt unavailable -> delivery-unknown
// The dropped hook still names the exact transcript, which is enough to
// CONFIRM an expectation even though it may not start a turn.
//
// Real function from main.js over a real JSONL fixture and the real audit
// selector (claude-prompt-audit.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const {
  readClaudeUserRecords, selectClaudePendingPromptAudit,
  selectUniqueClaudePromptSubmitAudit,
} = require('./claude-prompt-audit');

const mainSource = fs.readFileSync(process.env.QUEUED_AUDIT_MAIN_SOURCE
  || path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const declaration = (name) => {
  const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name + ' found in main.js');
  return node.getText(ast);
};

const TAB = 'tab-f6bc0c8c-7d73-49f5-8146-5b20bf267cca';
const PROMPT = '<pasted_content> План после подключения: 1. Через list_tabs найду открытое окно.';
const hash = (text) => require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

// The incident tab had a live session, so the staged expectation owns an exact
// pre-Enter byte boundary; only records written after it may be claimed.
function transcript(before, after) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-audit-')), 'session.jsonl');
  const text = (rows) => rows.map((l) => JSON.stringify(l)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(file, text(before));
  const boundary = { available: true, transcriptPath: file,
    fileSize: fs.statSync(file).size, endedWithNewline: true };
  fs.appendFileSync(file, text(after));
  return { file, boundary };
}

const userRecord = (text, uuid) => ({
  type: 'user', uuid, sessionId: '803036d9-71a4-427d-8641-7b57db16c1b4',
  timestamp: new Date().toISOString(), message: { role: 'user', content: text },
});

function harness({ pending = [] } = {}) {
  const confirmed = [];
  const logs = [];
  const ctx = vm.createContext({
    console: { log: (l) => logs.push(l), warn: (l) => logs.push(l) },
    setTimeout, Promise, Set, String, Number,
    getPendingClaudePasteAudits: () => pending,
    readClaudeUserRecords,
    selectClaudePendingPromptAudit,
    // The rescan also binds the text Claude accepted before scanning, so a
    // record Claude rewrote can still be identified. See
    // claude-queued-image-prompt-audit.actual.test.js for that rule itself.
    selectUniqueClaudePromptSubmitAudit,
    bridgePidCache: new Map(),
    getTerminalInputRevision: () => 0,
    pasteAuditHash: hash,
    confirmClaudePasteAuditFromTranscriptSelection: (tabId, audit, selection, reason) => {
      audit.finished = true;
      audit.result = { success: true };
      confirmed.push({ handoffId: audit.handoffId, reason, text: selection.candidate.text });
      return { success: true };
    },
  });
  vm.runInContext(declaration('confirmClaudePasteAuditsFromQueuedHook'), ctx);
  return { ctx, confirmed, logs, pending };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 2200));

test('a dropped queued-prompt hook confirms the waiting expectation', async () => {
  const { file, boundary } = transcript([userRecord('ранний ход', 'u-old')], [userRecord(PROMPT, 'u-new')]);
  const audit = { handoffId: 'mvxeergg-roqznl', finished: false,
    expectedText: PROMPT, expectedLen: PROMPT.length, expectedHash: hash(PROMPT),
    sentAt: Date.now(), preSubmitBoundary: boundary };
  const h = harness({ pending: [audit] });
  h.ctx.confirmClaudePasteAuditsFromQueuedHook(TAB, { transcript_path: file, prompt: PROMPT });
  await settle();
  assert.equal(h.confirmed.length, 1, 'pre-fix nothing looked at the transcript here');
  assert.equal(h.confirmed[0].handoffId, 'mvxeergg-roqznl');
  assert.equal(h.confirmed[0].reason, 'queued-prompt-hook-scan');
  assert.equal(h.confirmed[0].text, PROMPT);
  assert.ok(h.logs.some((l) => l.includes('audit-confirmed')));
});

test('a record that matches nothing leaves the expectation pending, not failed', async () => {
  const { file, boundary } = transcript([], [userRecord('совсем другое сообщение', 'u-other')]);
  const audit = { handoffId: 'other', finished: false,
    expectedText: PROMPT, expectedLen: PROMPT.length, expectedHash: hash(PROMPT),
    sentAt: Date.now(), preSubmitBoundary: boundary };
  const h = harness({ pending: [audit] });
  h.ctx.confirmClaudePasteAuditsFromQueuedHook(TAB, { transcript_path: file });
  await settle();
  assert.equal(h.confirmed.length, 0);
  assert.equal(audit.finished, false, 'still pending/unknown — never a proven failure');
});

test('no pending expectation, no transcript path and a finished audit are all no-ops', async () => {
  const { file, boundary } = transcript([], [userRecord(PROMPT, 'u-new')]);
  const empty = harness({ pending: [] });
  empty.ctx.confirmClaudePasteAuditsFromQueuedHook(TAB, { transcript_path: file });

  const done = { handoffId: 'done', finished: true, result: { success: true },
    expectedText: PROMPT, expectedLen: PROMPT.length, expectedHash: hash(PROMPT),
    sentAt: Date.now(), preSubmitBoundary: boundary };
  const settled = harness({ pending: [done] });
  settled.ctx.confirmClaudePasteAuditsFromQueuedHook(TAB, { transcript_path: file });

  const audit = { handoffId: 'x', finished: false, expectedText: PROMPT,
    expectedLen: PROMPT.length, expectedHash: hash(PROMPT),
    sentAt: Date.now(), preSubmitBoundary: boundary };
  const noPath = harness({ pending: [audit] });
  noPath.ctx.confirmClaudePasteAuditsFromQueuedHook(TAB, { prompt: PROMPT });

  await settle();
  assert.equal(empty.confirmed.length, 0);
  assert.equal(settled.confirmed.length, 0);
  assert.equal(noPath.confirmed.length, 0);
  assert.equal(audit.finished, false);
});

test('wired: only the dropped duplicate-prompt-start UserPromptSubmit triggers the scan', () => {
  assert.ok(mainSource.includes(
    "          if (event === 'UserPromptSubmit' && hookAdmission.reason === 'duplicate-prompt-start') {\n"
    + '            confirmClaudePasteAuditsFromQueuedHook(tabId, msg);\n'
    + '          }\n'
    + '          continue;'),
  'the scan runs inside the ignored-hook branch, before `continue`');
  // Admission itself is unchanged: the dropped event still may not start a turn.
  assert.ok(mainSource.includes('rememberClaudeQueuedPromptSubmit(tabId, msg, hookAdmission.reason);'));
});
