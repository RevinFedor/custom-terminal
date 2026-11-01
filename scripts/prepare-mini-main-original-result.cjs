'use strict';
// Explicit one-shot offline historical archive. No app, API History reader,
// provider process, auth copy, source write, or full-original read.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { _api } = require('../src/main/ipc/codex-data');
const audit = require('../src/main/codex-prompt-audit');
const replay = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay');
const out = path.join(replay, 'main-original-result-20261031');
const sourceId = 'dcb48f49-d127-49d7-82f4-a97370d3d114';
const targetTurn = '01a18cdc-2d72-7140-a1f6-a6ebef8bdc8c';
const sourceCap = 26 * 1024 * 1024, ownCap = 32 * 1024 * 1024;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const text = r => (r.payload?.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('');
const statView = s => ({ size: s.size, ino: s.ino, dev: s.dev, mtimeMs: s.mtimeMs });
async function save(file, value) {
  const h = await fs.open(file, 'wx', 0o600);
  try { await h.writeFile(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)); await h.sync(); }
  finally { await h.close(); }
}
async function readExact(handle, start, length) {
  const bytes = Buffer.alloc(length); let read = 0;
  while (read < length) {
    const result = await handle.read(bytes, read, Math.min(1024 * 1024, length - read), start + read);
    if (!result.bytesRead) throw Error('short_exact_source_read'); read += result.bytesRead;
  }
  return bytes;
}
function parseExactLines(bytes, firstRawLine) {
  const rows = []; let pos = 0;
  if (bytes.at(-1) !== 10) throw Error('range_not_line_aligned');
  for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, pos)) {
    const raw = bytes.subarray(pos, end);
    if (raw.length > 10 * 1024 * 1024) throw Error('bounded_record_cap');
    rows.push({ rawLine: firstRawLine + rows.length, relativeStart: pos, relativeEnd: end + 1,
      rawRecordSha256: sha(raw), record: JSON.parse(raw.toString('utf8')) });
    pos = end + 1;
  }
  return rows;
}
function instructionFingerprints(records) {
  const values = [];
  function visit(item, location) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'message' && item.role === 'user') {
      const t = (item.content || []).map(c => c.text || '').join('');
      if (audit.isCodexProjectInstructionsUserText(t)) values.push({ location, kind: 'instruction_carrier', chars: t.length, sha256: sha(t) });
    }
    if (item.type === 'world_state' && typeof item.payload?.state?.agents_md?.text === 'string') {
      const t = item.payload.state.agents_md.text; values.push({ location, kind: 'world_state', chars: t.length, sha256: sha(t) });
    }
    if (Array.isArray(item)) item.forEach((v, i) => visit(v, location + '[' + i + ']'));
    else for (const [key, value] of Object.entries(item)) if (value && typeof value === 'object') visit(value, location + '.' + key);
  }
  records.forEach((r, i) => visit(r, 'records[' + i + ']'));
  return values;
}
async function main() {
  const caseFile = path.join(out, 'CASE.json');
  const existing = await fs.readFile(caseFile, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (existing) {
    const st = await fs.lstat(existing.sessionFile);
    if (!st.isFile() || st.size > ownCap || sha(await fs.readFile(existing.sessionFile)) !== existing.copyProof.sha256) throw Error('existing_own_archive_changed');
    console.log(JSON.stringify({ caseFile, status: 'existing_exact_original_archive', originalReadPerformed: false, providerRuns: 0 })); return;
  }
  const boundary = JSON.parse(await fs.readFile(path.join(replay, 'main/RAW-BOUNDARY.json'), 'utf8'));
  const canonical = JSON.parse(await fs.readFile(path.join(replay, 'main/SOURCE-EVIDENCE.json'), 'utf8')).canonical;
  const continuation = JSON.parse(await fs.readFile(path.join(replay, 'failure-example-20261031/MAIN570-CONTINUATION-EVIDENCE.json'), 'utf8'));
  const headerPin = boundary.results.find(r => r.line === 0), compactPin = boundary.results.find(r => r.line === 67663);
  const userPin = boundary.results.find(r => r.line === 69060), nativeUserPin = boundary.results.find(r => r.line === 69059);
  const finalPin = continuation.selected.find(r => r.rawLine === 69265), completePin = continuation.selected.find(r => r.rawLine === 69268);
  const start = compactPin?.start, end = completePin?.end, source = boundary.source.file;
  if (headerPin?.end !== 18707 || headerPin.sha256 !== '04f36c35cff435a72c2b633e1348a41c5cbb1eda3413db29b449b3e3d94e69a7'
    || start !== 642387127 || end !== 667198638 || end - start + headerPin.end > sourceCap
    || compactPin.sha256 !== 'e6fe4112527a040e289bf1ef7587fff59687d448834e4ee1866be344f0abf6bc'
    || userPin.sha256 !== '1218f6cbab1c9e41fd858c9f489804e35fe7155e540a0b88a985835e85e510a2'
    || finalPin?.sha256 !== 'bbaf88382ee6dde0c582c0e198522b691dd6a7006874a3e4c7767fa0e795332a'
    || completePin?.sha256 !== 'c4edf4f3520a38c4ba94581cbf8c7752daf65c8e581deae8a192010b6db5b840') throw Error('pin_contract_mismatch');
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  await save(path.join(out, 'SOURCE-READ-ATTEMPT.json'), { at: new Date().toISOString(), source, sourceId, header: [0, headerPin.end], range: [start, end], cap: sourceCap,
    singleOpenedHandle: true, automaticRetry: false, scope: 'header plus selected compact through exact first task_complete only' });
  const before = await fs.lstat(source);
  if (!before.isFile() || before.ino !== 99415911 || before.dev !== 16777232 || before.size < end) throw Error('source_identity_or_size');
  const h = await fs.open(source, 'r'); let headerBytes, range, handleBefore, handleAfter;
  try {
    handleBefore = await h.stat();
    if (handleBefore.ino !== before.ino || handleBefore.dev !== before.dev) throw Error('opened_source_identity');
    headerBytes = await readExact(h, 0, headerPin.end);
    if (sha(headerBytes.subarray(0, -1)) !== headerPin.sha256) throw Error('pinned_header_changed');
    range = await readExact(h, start, end - start);
    handleAfter = await h.stat();
  } finally { await h.close(); }
  const after = await fs.lstat(source);
  if (after.ino !== before.ino || after.dev !== before.dev || after.size < before.size
    || handleAfter.ino !== before.ino || handleAfter.dev !== before.dev || handleAfter.size < end) throw Error('source_replaced_or_shrunk');
  const header = JSON.parse(headerBytes.toString('utf8')), suffix = parseExactLines(range, 67663), byLine = new Map(suffix.map(r => [r.rawLine, r]));
  if (header.type !== 'session_meta' || header.payload.id !== sourceId || suffix.length !== 69268 - 67663 + 1) throw Error('range_identity_or_count');
  for (const pin of [compactPin, userPin, nativeUserPin, finalPin, completePin]) {
    const rawLine = pin.line ?? pin.rawLine, r = byLine.get(rawLine);
    if (!r || r.rawRecordSha256 !== pin.sha256 || start + r.relativeStart !== pin.start || start + r.relativeEnd !== pin.end) throw Error('exact_record_pin:' + rawLine);
  }
  const user = byLine.get(69060), nativeUser = byLine.get(69059), final = byLine.get(69265), complete = byLine.get(69268), context = byLine.get(69058);
  const question = user.record.payload?.message, answer = text(final.record);
  if (user.record.payload?.type !== 'user_message' || sha(question || '') !== '359bc824b2b749369c5d9ab45f1b75bb045b98d79cd1bae45007eb71c8cbf27e'
    || question !== canonical.text || nativeUser.record.payload?.role !== 'user'
    || final.record.payload?.id !== 'msg_0e0b0497d063498a016ae496ef045081919c26c5a9379231b4'
    || final.record.payload.phase !== 'final_answer' || final.record.payload.status !== 'completed'
    || complete.record.payload?.type !== 'task_complete' || complete.record.payload.turn_id !== targetTurn || complete.record.payload.last_agent_message !== answer
    || context.record.payload?.turn_id !== targetTurn || context.record.payload.model !== 'gpt-6.1-sol' || context.record.payload.effort !== 'max') throw Error('exact_original_completed_pair');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mini-main-original-result-')));
  const cwd = path.join(root, 'fixture'), home = path.join(root, 'codex'); await fs.mkdir(cwd, { mode: 0o700 }); await fs.mkdir(home, { mode: 0o700 });
  const records = [header, ...suffix.map(r => r.record)], retained = structuredClone(records), bodyProof = instructionFingerprints(records);
  const latestWorld = records.findLast(r => r.type === 'world_state' && typeof r.payload?.state?.agents_md?.text === 'string');
  const policy = latestWorld?.payload.state.agents_md.text; if (!policy) throw Error('actual_frozen_AGENTS_missing');
  const sessionId = crypto.randomUUID(), at = new Date().toISOString();
  _api.rewriteCodexEditedForkMetadata(records, sourceId, cwd, retained, sessionId, at);
  if (retained.length !== records.length) throw Error('unexpected_meta_removal');
  for (const r of retained) if (r.type === 'world_state' && r.payload?.state?.agents_md) r.payload.state.agents_md.directory = cwd;
  if (sha(json(instructionFingerprints(retained))) !== sha(json(bodyProof))) throw Error('AGENTS_body_changed');
  for (let i = 1; i < records.length; i++) {
    const expected = structuredClone(records[i]);
    if (expected.type === 'world_state' && expected.payload?.state?.agents_md) expected.payload.state.agents_md.directory = cwd;
    if (sha(JSON.stringify(expected)) !== sha(JSON.stringify(retained[i]))) throw Error('nonmetadata_record_changed:' + i);
  }
  if (sha(JSON.stringify(header.payload.base_instructions)) !== sha(JSON.stringify(retained[0].payload.base_instructions))) throw Error('base_instructions_changed');
  const serialized = Buffer.from(retained.map(r => JSON.stringify(r)).join('\n') + '\n'); if (serialized.length > ownCap) throw Error('own_fixture_cap');
  const dir = path.join(home, 'sessions', ...at.slice(0, 10).split('-')); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dir, `rollout-${at.slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`);
  await save(sessionFile, serialized); await save(path.join(cwd, 'AGENTS.md'), policy);
  const requestTextFile = path.join(out, 'REQUEST.txt'), answerTextFile = path.join(out, 'ANSWER.txt'); await save(requestTextFile, question); await save(answerTextFile, answer);
  const ownIndex = r => 1 + r.rawLine - 67663;
  const ref = r => ({ originalRawLine: r.rawLine, ownRawLine: ownIndex(r), originalByteStart: start + r.relativeStart, originalByteEnd: start + r.relativeEnd,
    rawOriginalRecordSha256: r.rawRecordSha256, timestamp: r.record.timestamp, nativeResponseItemId: r.record.payload?.id || null });
  const nativeImageParts = (nativeUser.record.payload.content || []).filter(x => /image/i.test(x.type || ''));
  const receipt = { source, sourceSessionId: sourceId, headerBytes: headerBytes.length, headerSha256: sha(headerBytes), headerRawSha256: headerPin.sha256,
    rangeStart: start, rangeEnd: end, rangeBytes: range.length, rangeSha256: sha(range), combinedReadBytes: headerBytes.length + range.length,
    singleOpenedHandle: true, sourceReadCap: sourceCap, originalWriteOperations: 0, before: statView(before), openedBefore: statView(handleBefore),
    openedAfter: statView(handleAfter), after: statView(after), appendAllowed: true, inodeAndDevStable: true, pinnedRecordHashesVerified: true };
  await save(path.join(out, 'SOURCE-READ-RECEIPT.json'), receipt);
  const c = { version: 1, case: 'exact-original-Main570-historical-result', root, cwd, codexHome: home, sessionId, sessionFile,
    tabId: 'mini-original-main-' + sessionId.slice(0, 8), createdAt: at, requestTextFile, answerTextFile, completed: true,
    historicalCopiedCompleted: true, newProviderRun: false, providerRuns: 0, viewOnly: true, authCopied: false,
    turnId: targetTurn, model: context.record.payload.model, effort: context.record.payload.effort, historicalModelAndEffort: true,
    sourceProof: { ...receipt, sessionId: sourceId, user: { ...ref(user), canonicalUserUuid: canonical.ref.userUuid,
      ownCanonicalUserUuid: `codex-user-${sessionId}-${ownIndex(user)}`, textHash: sha(question), nativeUser: ref(nativeUser) },
      final: { ...ref(final), ownCanonicalAssistantUuid: `codex-assistant-${sessionId}-${ownIndex(final)}`, textHash: sha(answer) },
      complete: ref(complete), nativeContext: ref(context), selectedCompact: ref(byLine.get(67663)),
      originalToOwnMapping: { header: [0, 0], suffixFirst: [67663, 1], suffixLast: [69268, retained.length - 1], formula: 'ownLine = originalRawLine - 67663 + 1 for suffix' },
      noFutureAfterRaw69268: true },
    copyProof: { bytes: serialized.length, sha256: sha(serialized), recordCount: retained.length, standaloneHistoryMode: 'legacy',
      originalNativeTurnAndMessageIdsPreserved: true, headerAliasesOwn: retained[0].payload.id === sessionId && retained[0].payload.session_id === sessionId,
      onlyHeaderAndWorldStateDirectoryRewritten: true },
    frozenInstructions: { path: path.join(cwd, 'AGENTS.md'), sha256: sha(policy), chars: policy.length, bodiesPreserved: true, carriers: bodyProof },
    imageTransport: { sourceNativeUserRawLine: 69059, ownNativeUserRawLine: ownIndex(nativeUser), inlinePartCount: nativeImageParts.length,
      allNativeContentRetainedUnchanged: true, nativeContentSha256: sha(JSON.stringify(nativeUser.record.payload.content)),
      ownContentSha256: sha(JSON.stringify(retained[ownIndex(nativeUser)].payload.content)), imagePartsSha256: sha(JSON.stringify(nativeImageParts)),
      nativeImageBytesNotExportedOrReinterpreted: true, eventImagesSha256: sha(JSON.stringify(user.record.payload.images || [])),
      imagePathsNotResolvedOrRetargeted: true },
    limitations: ['Exact historical completed answer, not a v4 regeneration or new model run.', 'No new safety/critique/developer carrier was appended.',
      'View-only independent legacy rollout; no authentication or live source writer authority copied.', 'Only pinned historical source range read, never full original or History API.'] };
  if (sha(await fs.readFile(sessionFile)) !== c.copyProof.sha256) throw Error('own_written_copy_hash');
  await save(caseFile, c); await save(path.join(out, 'PROFILE.json'), { root, cwd, sessionId, sessionFile, caseFile, viewOnly: true, newProviderRun: false });
  console.log(JSON.stringify({ caseFile, sessionId, bytes: serialized.length, recordCount: retained.length, canonicalUserChars: question.length,
    answerChars: answer.length, inlineImageParts: nativeImageParts.length, sourceReadBytes: receipt.combinedReadBytes, providerRuns: 0 }));
}
if (require.main === module) main().catch(e => { console.error('[MiniOriginalMain] ' + e.message); process.exitCode = 1; });
module.exports = { main, parseExactLines, instructionFingerprints };
