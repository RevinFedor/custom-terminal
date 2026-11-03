'use strict';
// A prompt sent into a BUSY Claude tab hung on CONFIRMING for 37 minutes and
// then went delivery-unknown — although Claude had accepted it and answered.
// Production 01.11.2026, tab 1ccc61c912ae, handoff mvxsfc3q-j2xsy3:
//   12:09:53.370  Enter sent, waiting for UserPromptSubmit audit (8000ms)
//   12:09:53.416  [ClaudeHookScope] ignored reason=duplicate-prompt-start
//   12:09:53.416  [ClaudeQueueContinuation] remembered chars=1152
//   12:10:01.371  [PasteAudit] failed claude_user_message_audit_timeout
//   12:47:14      delivery-unknown, audit evicted by age
//
// Two facts combine. (1) A prompt queued mid-turn gets its UserPromptSubmit
// under the RUNNING turn's prompt_id, so Main drops it as a duplicate start
// and the ordinary confirmation never runs; the queued-hook rescan exists
// exactly for that. (2) Claude rewrote the payload before storing it: our
// 1095 pasted chars became a 1152-char record, and the 1095 are NOT a
// contiguous substring of it (verified by scanning every window). So the
// rescan's raw len+hash comparison could not identify the record, and only
// the untransformed neighbours were confirmed.
//
// The dropped hook reports exactly what Claude accepted — the log recorded
// chars=1152, the same size as the stored record. Binding that text as the
// audit's provider-accepted form, through the SAME owner selector the
// admitted hook already uses, is the whole repair. These tests exercise the
// REAL audit primitives and the REAL main.js wiring.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const auditApi = require('./claude-prompt-audit');
const {
  claudeAuditTextMatches,
  readClaudeUserRecords,
  selectUniqueClaudePromptSubmitAudit,
} = auditApi;

const hashText = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

// What we pasted, and the different text Claude actually stored AND reported
// through the dropped hook. The rewrite is deliberately not derivable from the
// payload — that is the production situation.
const PASTED = '[imagePath: /tmp/shot.png] so the card spun while Claude answered.';
const ACCEPTED = '<pasted_content id="102c">\n[Image #1] so the card spun while Claude answered.\n</pasted_content id="102c">';

async function recordOnDisk(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-queued-prompt-'));
  const file = path.join(dir, 'session.jsonl');
  // A preceding record so the boundary is a real byte offset, as in production.
  const head = JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: [] } }) + '\n';
  const carrier = JSON.stringify({
    type: 'attachment', uuid: 'u1', timestamp: '2026-11-01T12:09:53.371Z',
    attachment: { type: 'queued_command', prompt: text },
  }) + '\n';
  fs.writeFileSync(file, head + carrier);
  return { file, boundary: { available: true, transcriptPath: file,
    fileSize: Buffer.byteLength(head), endedWithNewline: true } };
}

// The audit exactly as it exists once Enter has been written: it knows only
// the payload WE sent, never Claude's rewritten form.
const pendingAudit = () => ({
  handoffId: 'mvxsfc3q-j2xsy3', tabId: 'T', finished: false, submitWritten: true,
  expectedLen: PASTED.length, expectedHash: hashText(PASTED),
  enterInputRevision: 5,
  pasteReadyProof: { ready: true, form: 'collapsed-paste', expectedImageCount: 1 },
});

// The REAL main.js function, executed against these audits. Nothing about the
// binding rule is reimplemented here.
const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const confirmFromQueuedHook = (audits, hookPrompt, transcriptPath = null) => {
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    getPendingClaudePasteAudits: () => audits,
    selectUniqueClaudePromptSubmitAudit, pasteAuditHash: hashText,
    readClaudeUserRecords, selectClaudePendingPromptAudit: () => null,
    confirmClaudePasteAuditFromTranscriptSelection: () => ({ success: true }),
    bridgePidCache: new Map([[1, 'T']]),
    getTerminalInputRevision: () => 5,
    setTimeout, Promise, Set, Number, String, JSON,
  });
  vm.runInContext(mainAst.statements
    .find((node) => ts.isFunctionDeclaration(node)
      && node.name?.text === 'confirmClaudePasteAuditsFromQueuedHook').getText(mainAst), context);
  context.confirmClaudePasteAuditsFromQueuedHook('T', {
    prompt: hookPrompt, ppid: 1,
    transcript_path: transcriptPath || path.join(os.tmpdir(), 'absent-' + Date.now() + '.jsonl'),
  });
  return audits;
};

test('a rewritten prompt queued mid-turn is confirmed from the dropped hook', async () => {
  const { file, boundary } = await recordOnDisk(ACCEPTED);
  const audit = pendingAudit();
  const [candidate] = await readClaudeUserRecords(file, boundary);
  assert.equal(candidate.text, ACCEPTED, 'the scanner reads Claude\'s stored record');

  // Pre-fix: our pasted payload never identified the rewritten record, so the
  // card stayed CONFIRMING until it expired.
  assert.equal(claudeAuditTextMatches(audit, candidate.text, hashText), false);

  confirmFromQueuedHook([audit], ACCEPTED);
  assert.equal(audit.providerAcceptedLen, ACCEPTED.length, 'the hook text is bound');
  assert.equal(claudeAuditTextMatches(audit, candidate.text, hashText), true,
    'the hook-accepted text now identifies this record');
});

test('a prompt Claude did not rewrite needs no binding and is unaffected', async () => {
  const { file, boundary } = await recordOnDisk(PASTED);
  const audit = { ...pendingAudit(),
    pasteReadyProof: { ready: true, form: 'plain', expectedImageCount: 0 } };
  const [candidate] = await readClaudeUserRecords(file, boundary);
  assert.equal(claudeAuditTextMatches(audit, candidate.text, hashText), true,
    'exact len+hash already matched before any fix');
});

test('a foreign record is still not accepted after binding', async () => {
  const { file, boundary } = await recordOnDisk(
    '<pasted_content id="102c">\n[Image #1] somebody else entirely\n</pasted_content id="102c">');
  const audit = pendingAudit();
  confirmFromQueuedHook([audit], ACCEPTED);
  const [candidate] = await readClaudeUserRecords(file, boundary);
  assert.equal(claudeAuditTextMatches(audit, candidate.text, hashText), false,
    'binding an accepted text is identity, not a same-shape heuristic');
});

test('an already bound provider text is never overwritten', () => {
  const audit = { ...pendingAudit(), providerAcceptedHash: hashText('earlier'),
    providerAcceptedLen: 7, providerAcceptedText: 'earlier' };
  confirmFromQueuedHook([audit], ACCEPTED);
  assert.equal(audit.providerAcceptedText, 'earlier',
    'a confirmed provider transform owns its audit');
});

test('two identical pending prompts bind nothing', () => {
  const a = pendingAudit(), b = pendingAudit();
  confirmFromQueuedHook([a, b], ACCEPTED);
  assert.equal(a.providerAcceptedHash, undefined, 'an ambiguous owner must not be guessed');
  assert.equal(b.providerAcceptedHash, undefined);
});

test('a finished, unwritten or unready audit is not a candidate', () => {
  for (const patch of [{ finished: true }, { submitWritten: false },
    { pasteReadyProof: { ready: false, form: 'collapsed-paste', expectedImageCount: 1 } }]) {
    const audit = { ...pendingAudit(), ...patch };
    confirmFromQueuedHook([audit], ACCEPTED);
    assert.equal(audit.providerAcceptedHash, undefined);
  }
});

test('an audit from a different input generation is not a candidate', () => {
  const audit = { ...pendingAudit(), enterInputRevision: 99 };
  confirmFromQueuedHook([audit], ACCEPTED);
  assert.equal(audit.providerAcceptedHash, undefined,
    'the hook must belong to this exact input generation');
});

test('wired: the dropped-hook rescan binds the accepted text before scanning', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('function confirmClaudePasteAuditsFromQueuedHook(');
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('\nfunction ', start + 10));
  const bind = body.indexOf('selectUniqueClaudePromptSubmitAudit(audits, msg.prompt');
  const scan = body.indexOf('readClaudeUserRecords(');
  assert.ok(bind > 0, 'the rescan binds the hook-accepted text');
  assert.ok(bind < scan, 'it binds before reading the transcript');
  assert.match(body, /providerAcceptedHash == null/, 'an existing binding is preserved');
  assert.match(body, /unique-owned-provider-transform/, 'ambiguous owners bind nothing');
  assert.match(body, /hookInputRevision: getTerminalInputRevision\(tabId\)/,
    'the same input-generation guard as the admitted hook');
});
