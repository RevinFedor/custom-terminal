'use strict';
// Explicitly authorized offline COPY. No app, model, provider or original write.
// Reads only the pinned selected-compact suffix; uses the existing pure Rewind
// planner/metadata rewriter, never its live mutation or shared storage functions.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { _api: codex } = require('../src/main/ipc/codex-data');
const folder = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/main');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const inside = (root, file) => file.startsWith(root + path.sep);
async function main() {
  const manifestPath = path.join(folder, 'REPLAY.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const pointer = path.join(folder, 'PROFILE.json');
  const existing = await fs.readFile(pointer, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    const root = await fs.realpath(existing.root);
    if (root !== existing.root || !path.basename(root).startsWith('noted-mini-dev-')
      || !inside(root, existing.sessionFile) || existing.sessionId !== manifest.targetSessionId
      || existing.tabId !== manifest.targetTabId || !(await fs.lstat(existing.sessionFile)).isFile()) throw Error('existing_replay_profile_mismatch');
    console.log('[MiniReplay] Existing independent copy retained. No session/profile/draft rewritten.'); return;
  }
  if (manifest.clonePrepared || manifest.targetSessionId) throw Error('existing_target_without_profile_pointer');
  const evidence = JSON.parse(await fs.readFile(path.join(folder, 'SOURCE-EVIDENCE.json'), 'utf8'));
  const boundary = JSON.parse(await fs.readFile(path.join(folder, 'RAW-BOUNDARY.json'), 'utf8'));
  const source = boundary.source;
  const compactId = evidence.selectedCompact.compactEventIdentity;
  const compactLine = Number(compactId.slice(compactId.lastIndexOf('-') + 1));
  const userLine = Number(evidence.canonical.ref.userUuid.slice(evidence.canonical.ref.userUuid.lastIndexOf('-') + 1));
  const compact = boundary.results.find(r => r.line === compactLine && r.type === 'compacted');
  const target = boundary.results.find(r => r.line === userLine && r.payloadType === 'user_message');
  const header = boundary.results.find(r => r.line === 0 && r.type === 'session_meta');
  if (!compact || !target || !header || compact.timestamp !== evidence.selectedCompact.timestamp
    || target.timestamp !== evidence.canonical.timestamp || target.end - compact.start > 24 * 1024 * 1024) throw Error('exact_pinned_suffix_required');
  const stat = await fs.lstat(source.file);
  const unchanged = s => s.isFile() && s.dev === source.dev && s.ino === source.ino && s.size === source.size && s.mtimeMs === source.mtimeMs;
  if (!unchanged(stat)) throw Error('source_changed_before_copy');
  const handle = await fs.open(source.file, 'r');
  let raw, meta;
  try {
    const rootBytes = Buffer.alloc(header.end);
    if ((await handle.read(rootBytes, 0, rootBytes.length, 0)).bytesRead !== rootBytes.length
      || sha(rootBytes.subarray(0, -1)) !== header.sha256) throw Error('source_header_changed');
    meta = JSON.parse(rootBytes.toString());
    if (meta.payload.id !== evidence.sessionId) throw Error('source_session_identity_changed');
    raw = Buffer.alloc(target.end - compact.start);
    let count = 0;
    while (count < raw.length) {
      const read = await handle.read(raw, count, Math.min(1024 * 1024, raw.length - count), compact.start + count);
      if (!read.bytesRead) throw Error('source_short_read'); count += read.bytesRead;
    }
    if (!unchanged(await handle.stat())) throw Error('source_changed_during_copy');
  } finally { await handle.close(); }
  const lines = raw.toString('utf8').split('\n');
  if (lines.pop() !== '') throw Error('source_suffix_not_line_aligned');
  if (sha(Buffer.from(lines[0])) !== compact.sha256 || sha(Buffer.from(lines.at(-1))) !== target.sha256) throw Error('exact_compact_or_user_changed');
  const records = [{ ...meta, __line: 0 }, ...lines.map((line, index) => ({ ...JSON.parse(line), __line: compactLine + index }))];
  const plan = codex.planCodexRangeRewrite(records, evidence.sessionId, evidence.canonical.ref.userUuid,
    evidence.canonical.ref.userUuid, null, { toPhysicalEnd: true });
  if (!plan.success || plan.removedUsers !== 1 || !plan.suffixProof) throw Error('existing_rewind_planner_refused:' + (plan.error || 'proof_missing'));
  // The current production planner retains part of this turn's developer/
  // world-state preamble. This fixture must be BEFORE the entire exact turn.
  // Strengthen ONLY this offline copy; do not repair production Rewind here.
  const selectedUserIndex = records.findIndex(r => r.__line === userLine);
  const context = records.slice(0, selectedUserIndex).findLast(r => r.type === 'turn_context');
  const turnId = context?.payload?.turn_id;
  let startIndex = records.findIndex(r => r.type === 'event_msg' && r.payload?.type === 'task_started' && r.payload?.turn_id === turnId);
  if (!turnId || startIndex < 1 || startIndex >= selectedUserIndex) throw Error('exact_turn_preamble_unavailable');
  if (records[startIndex - 1]?.payload?.type === 'thread_settings_applied') startIndex -= 1;
  const copyCut = Math.min(startIndex, plan.suffixProof.startRecordIndex);
  plan.outputRecords = records.slice(0, copyCut).map(({ __line, ...record }) => record);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mini-dev-')));
  console.log('[MiniReplay] Own offline profile: ' + root);
  for (const name of ['data', 'discovery', 'codex', 'claude', 'fixture', 'tmp', 'attachments']) await fs.mkdir(path.join(root, name), { mode: 0o700 });
  const sessionId = crypto.randomUUID(), tabId = 'mini-replay-main-' + sessionId.slice(0, 8);
  const createdAt = new Date().toISOString(), cwd = path.join(root, 'fixture');
  codex.rewriteCodexEditedForkMetadata(records, evidence.sessionId, cwd, plan.outputRecords, sessionId, createdAt);
  const sessionDir = path.join(root, 'codex', 'sessions', ...createdAt.slice(0, 10).split('-'));
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, 'rollout-' + createdAt.slice(0, 19).replace(/:/g, '-') + '-' + sessionId + '.jsonl');
  const output = await fs.open(sessionFile, 'wx', 0o600), outputHash = crypto.createHash('sha256');
  let outputBytes = 0;
  try {
    for (const record of plan.outputRecords) {
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      await output.writeFile(bytes); outputHash.update(bytes); outputBytes += bytes.length;
    }
    await output.sync();
  } finally { await output.close(); }
  const images = [];
  for (const image of evidence.receipt.authoringSnapshot.imagePaths) {
    const s = await fs.lstat(image.path);
    if (!s.isFile() || s.size !== image.size || s.size > 2 * 1024 * 1024) throw Error('original_image_unavailable');
    const bytes = await fs.readFile(image.path), digest = sha(bytes);
    const destination = path.join(root, 'attachments', 'Image-' + image.id + '.png');
    await fs.writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
    const exported = path.join(folder, 'Image-' + image.id + '.png');
    try { await fs.writeFile(exported, bytes, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || sha(await fs.readFile(exported)) !== digest) throw error; }
    images.push({ id: image.id, path: destination, exported, bytes: bytes.length, sha256: digest, sourceAssetId: image.assetId });
  }
  const post = await fs.lstat(source.file);
  if (!unchanged(post)) throw Error('source_changed_before_receipt');
  const result = { version: 1, root, cwd, tabId, sessionId, sessionFile, createdAt,
    selectedCompact: evidence.selectedCompact, beforeUser: evidence.canonical.ref,
    outputBytes, initialSha256: outputHash.digest('hex'), recordCount: plan.outputRecords.length,
    source: { file: source.file, size: source.size, dev: source.dev, ino: source.ino, mtimeMs: source.mtimeMs,
      selectedOffset: compact.start, readEnd: target.end, readBytes: raw.length,
      copiedSourceSha256: sha(raw), discardedEarlierBytes: compact.start, untouched: true },
    rewindProof: { ...plan.suffixProof, offlineCutRecordIndex: copyCut, sourceCutLine: records[copyCut].__line,
      exactTurnId: turnId, offlineOnlyPreambleRemoval: true }, removedUsers: plan.removedUsers,
    originalTurnHeaderRemoved: !plan.outputRecords.some(r => r?.payload?.turn_id === turnId),
    images, appLaunched: false, providerStarted: false, promptSubmitted: false };
  if (!result.originalTurnHeaderRemoved || result.sessionId === evidence.sessionId) throw Error('independent_prefix_validation_failed');
  await fs.writeFile(path.join(root, 'REPLAY-OWNER.json'), json(result), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(pointer, json(result), { mode: 0o600, flag: 'wx' });
  const next = { ...manifest, status: 'prepared', reason: null, clonePrepared: true,
    targetSessionId: sessionId, targetTabId: tabId, targetTabSeeded: false,
    privateProfile: { root, sessionFile, profileFile: 'PROFILE.json', sessionId, tabId },
    offlineCopy: { verified: true, method: 'explicit-user-authorized JSONL copy + existing pure Rewind planner',
      outputBytes, initialSha256: result.initialSha256, sourceUnchanged: true, originalTurnHeaderRemoved: true },
    privateTransfer: { available: true, method: 'offline independent writer inside private CODEX_HOME', publicMechanism: null } };
  await fs.writeFile(manifestPath, json(next), { mode: 0o600 });
  console.log('[MiniReplay] ' + json({ tabId, sessionId, outputBytes, recordCount: result.recordCount,
    discardedEarlierBytes: compact.start, sourceUntouched: true, originalTurnHeaderRemoved: true, appLaunched: false }).trim());
}
main().catch(error => { console.error('[MiniReplay] copy preparation failed: ' + error.message); process.exitCode = 1; });
