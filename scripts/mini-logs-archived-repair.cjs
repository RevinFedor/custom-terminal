'use strict';
// Explicitly authorized OFFLINE historical copy. Never starts a CLI/model/app.
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { _api } = require('../src/main/ipc/codex-data');
const folder = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/logs-archived-repair-20261031');
const source = '/Users/fedor/.codex/sessions/2026/10/30/rollout-2026-10-30T12-48-00-aaac34fa-9e3e-43eb-a39e-c65e8a0eb939.jsonl';
const sourceId = 'aaac34fa-9e3e-43eb-a39e-c65e8a0eb939';
const sourceSHA = 'f56cb83ed7b3228c7b7e038906425589bb64a42243118d031e57c8ca8c3a2cc7';
const targetTurn = '01a18d1f-9c66-76a3-9c37-b8fbdcfa7910';
const question = 'Москва, Яга, наша за 5 миросложия 1.4 ГБ. Почему там чё по логам, чё это было?';
const finalId = 'msg_0bd51490253edc65016ae4a4da4c408191ac768e7230b264c7';
const disabled = ['apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'hooks', 'browser_use', 'computer_use', 'in_app_browser', 'multi_agent'];
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const json = x => JSON.stringify(x, null, 2) + '\n';
const save = (p, x) => fs.writeFile(p, typeof x === 'string' ? x : json(x), { flag: 'wx', mode: 0o600 });
const text = r => (r.payload?.content || []).map(c => c.text || '').join('');
const snapshot = s => ({ size: s.size, dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs });
const unchanged = (a, b) => ['size', 'dev', 'ino', 'mtimeMs'].every(k => a[k] === b[k]);
async function main() {
  const caseFile = path.join(folder, 'CASE.json');
  const previous = await fs.readFile(caseFile, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (previous) {
    if (!previous.historicalCopiedCompleted || previous.newProviderRun !== false
      || sha(await fs.readFile(previous.sessionFile)) !== previous.copyProof.sha256) throw Error('existing_archive_changed');
    console.log(JSON.stringify({ caseFile, status: 'existing_verified_offline_archive', newProviderRun: false }));
    return;
  }
  const before = await fs.lstat(source);
  if (!before.isFile() || before.size > 8 * 1024 * 1024) throw Error('source_cap_or_type');
  const raw = await fs.readFile(source), readAfter = await fs.lstat(source);
  if (sha(raw) !== sourceSHA || !unchanged(before, readAfter)) throw Error('pinned_closed_source_changed');
  const rows = []; let pos = 0;
  for (let end = raw.indexOf(10); end >= 0; end = raw.indexOf(10, pos)) {
    const line = raw.subarray(pos, end);
    rows.push({ record: JSON.parse(line.toString('utf8')), index: rows.length, start: pos, end: end + 1, sha256: sha(line) });
    pos = end + 1;
  }
  if (pos !== raw.length) throw Error('source_partial_last_record');
  const sourceMeta = rows[0].record;
  if (sourceMeta.type !== 'session_meta' || sourceMeta.payload.id !== sourceId) throw Error('source_identity');
  const user = rows.find(r => r.index === 862 && r.record.payload?.type === 'user_message' && r.record.payload.message === question);
  const nativeUser = rows.find(r => r.record.payload?.id === 'msg_01a18d1f-9d8f-7f93-bc6a-bdca5da06df5');
  const final = rows.find(r => r.record.payload?.id === finalId && r.record.payload.phase === 'final_answer');
  const complete = rows.find(r => r.record.type === 'event_msg' && r.record.payload?.type === 'task_complete' && r.record.payload.turn_id === targetTurn);
  const turnStart = rows.find(r => r.record.payload?.type === 'task_started' && r.record.payload.turn_id === targetTurn);
  const context = rows.find(r => r.record.type === 'turn_context' && r.record.payload?.turn_id === targetTurn);
  if (!user || !nativeUser || text(nativeUser.record) !== question || !final || !complete || !turnStart || !context
    || !(turnStart.index < user.index && user.index < final.index && final.index < complete.index)
    || text(final.record) !== complete.record.payload.last_agent_message) throw Error('exact_completed_boundary_missing');
  const next = rows.slice(complete.index + 1).find(r => r.record.payload?.type === 'task_started');
  if (!next || next.record.payload.turn_id === targetTurn) throw Error('next_turn_boundary_missing');
  const retained = rows.slice(0, complete.index + 1).map(r => structuredClone(r.record));
  const worldStates = retained.filter(r => r.type === 'world_state' && typeof r.payload?.state?.agents_md?.text === 'string');
  const latestPolicy = worldStates.at(-1)?.payload.state.agents_md.text;
  if (!latestPolicy) throw Error('retained_agents_missing');
  const instructionProof = retained.flatMap((r, i) => r.type === 'world_state' && r.payload?.state?.agents_md?.text
    ? [{ index: i, kind: 'world_state', sha256: sha(r.payload.state.agents_md.text) }]
    : r.type === 'response_item' && r.payload?.role === 'user' && text(r).startsWith('# AGENTS.md instructions for')
      ? [{ index: i, kind: 'instruction_carrier', sha256: sha(text(r)) }] : []);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mini-logs-archived-repair-')));
  const cwd = path.join(root, 'fixture'), home = path.join(root, 'codex');
  await fs.mkdir(cwd, { mode: 0o700 }); await fs.mkdir(home, { mode: 0o700 });
  const sessionId = crypto.randomUUID(), createdAt = new Date().toISOString();
  for (const r of worldStates) r.payload.state.agents_md.directory = cwd;
  _api.rewriteCodexEditedForkMetadata(rows.map(r => r.record), sourceId, cwd, retained, sessionId, createdAt);
  for (const p of instructionProof) {
    const r = retained[p.index];
    const body = p.kind === 'world_state' ? r.payload.state.agents_md.text : text(r);
    if (sha(body) !== p.sha256) throw Error('historical_instruction_body_changed');
  }
  await save(path.join(cwd, 'AGENTS.md'), latestPolicy);
  const sessionDir = path.join(home, 'sessions', ...createdAt.slice(0, 10).split('-'));
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, `rollout-${createdAt.slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`);
  const copy = retained.map(r => JSON.stringify(r)).join('\n') + '\n';
  await save(sessionFile, copy);
  await fs.copyFile('/Users/fedor/.codex/auth.json', path.join(home, 'auth.json'), constants.COPYFILE_EXCL);
  await fs.chmod(path.join(home, 'auth.json'), 0o600);
  const config = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\nmodel_context_window = 872000\nmodel_auto_compact_token_limit = 780000\nproject_doc_max_bytes = 200000\nweb_search = "disabled"\n\n[features]\n' + disabled.map(n => n + ' = false').join('\n') + '\n';
  await save(path.join(home, 'config.toml'), config);
  const args = ['-C', cwd, '-s', 'read-only', '-a', 'never', ...disabled.flatMap(n => ['--disable', n]),
    'exec', 'resume', '--model', 'gpt-6.1-sol', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-c', 'model_reasoning_effort="max"', '-c', 'web_search="disabled"', sessionId, '-'];
  const ref = r => ({ sourceSessionId: sourceId, rawLine: r.index, byteStart: r.start, byteEnd: r.end, rawRecordSha256: r.sha256,
    timestamp: r.record.timestamp, nativeResponseItemId: r.record.payload?.id || null });
  const priorUser = rows.slice(0, turnStart.index).findLast(r => r.record.type === 'event_msg' && r.record.payload?.type === 'user_message');
  const priorFinal = rows.slice(0, turnStart.index).findLast(r => r.record.type === 'response_item' && r.record.payload?.role === 'assistant' && r.record.payload.phase === 'final_answer');
  if (!priorUser || !priorFinal || priorUser.index >= priorFinal.index) throw Error('antecedents_not_paired');
  const antecedents = { kind: 'literal historical antecedents, not an improved request or future requirement',
    previousUser: { ...ref(priorUser), canonicalUserUuid: `codex-user-${sourceId}-${priorUser.index}`, text: priorUser.record.payload.message },
    previousFinal: { ...ref(priorFinal), text: text(priorFinal.record) }, afterTargetRequirementsIncluded: false };
  const requestTextFile = path.join(folder, 'REQUEST.txt'), answerTextFile = path.join(folder, 'ANSWER.txt');
  await save(requestTextFile, question); await save(answerTextFile, text(final.record));
  await save(path.join(folder, 'ANTECEDENTS.json'), antecedents);
  await save(path.join(folder, 'CONTINUATION-PREPARED-NOT-RUN.json'), { newProviderRun: false, permission: 'do not run before root reviewer verdict',
    executable: 'codex', args, environment: { CODEX_HOME: home }, noExternalMcpConfiguration: true,
    sanitizedEnvironmentRequired: true, preserveFrozenInstructions: true, correctionText: null });
  const after = await fs.lstat(source);
  if (!unchanged(before, after) || sha(await fs.readFile(sessionFile)) !== sha(copy)) throw Error('copy_bookend_failed');
  const c = { version: 1, case: 'historical-logs-turn11-archive-clone-A', root, cwd, codexHome: home, sessionId, sessionFile,
    tabId: 'mini-archived-logs-' + sessionId.slice(0, 8), createdAt, requestTextFile, answerTextFile,
    completed: true, historicalCopiedCompleted: true, newProviderRun: false, providerRuns: 0, turnId: targetTurn,
    model: context.record.payload.model, effort: context.record.payload.effort, historicalModelAndEffort: true,
    sourceProof: { file: source, sessionId: sourceId, bytes: raw.length, sha256: sourceSHA, before: snapshot(before), after: snapshot(after), sourceUnchanged: true,
      user: { ...ref(user), canonicalUserUuid: `codex-user-${sourceId}-${user.index}`, textHash: sha(question), nativeUser: ref(nativeUser) },
      final: { ...ref(final), textHash: sha(text(final.record)), nativeResponseItemId: finalId }, complete: ref(complete),
      cutoffInclusiveRawLine: complete.index, excludedNextTurn: ref(next), noFutureUser926: true },
    copyProof: { bytes: Buffer.byteLength(copy), sha256: sha(copy), recordCount: retained.length, standaloneHistoryMode: 'legacy',
      newHeaderSessionId: sessionId, originalNativeTurnAndMessageIdsPreserved: true, onlyHeaderAndWorldStateDirectoryRewritten: true },
    frozenInstructions: { path: path.join(cwd, 'AGENTS.md'), sha256: sha(latestPolicy), chars: latestPolicy.length,
      instructionBodiesPreserved: true, carriers: instructionProof, worldStateDirectory: cwd },
    launchPreparation: { freshHome: true, authMode: (await fs.stat(path.join(home, 'auth.json'))).mode & 0o777, disabledFeatures: disabled,
      externalMcpServers: 0, pluginsCopied: false, userConfigCopied: false, execInvoked: false },
    antecedentsFile: path.join(folder, 'ANTECEDENTS.json'), limitations: ['Historical completed answer copied, NOT a newly generated provider result.',
      'Question transcription preserved literally. Antecedents are separate historical data, not added requirements.',
      'No independent live memory verification or model verdict has been performed by this preparer.'] };
  await save(caseFile, c);
  await save(path.join(folder, 'PROFILE.json'), { root, cwd, sessionFile, sessionId, caseFile, newProviderRun: false });
  console.log(JSON.stringify({ caseFile, sessionId, root, retainedRecords: retained.length, copiedHistoricalCompleted: true,
    newProviderRun: false, originalSourceUnchanged: true }));
}
async function prepareFirst() {
  const firstFolder = path.join(path.dirname(folder), 'logs-original-first-20261031');
  const caseFile = path.join(firstFolder, 'CASE.json');
  const previous = await fs.readFile(caseFile, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (previous) {
    if (!previous.historicalCopiedCompleted || previous.newProviderRun !== false || sha(await fs.readFile(previous.sessionFile)) !== previous.copyProof.sha256)
      throw Error('existing_first_archive_changed');
    console.log(JSON.stringify({ caseFile, status: 'existing_verified_first_archive', newProviderRun: false })); return;
  }
  const aFile = path.join(folder, 'CASE.json'), a = JSON.parse(await fs.readFile(aFile, 'utf8'));
  const before = await fs.lstat(a.sessionFile);
  if (!before.isFile() || before.size > 8 * 1024 * 1024) throw Error('own_A_cap');
  const raw = await fs.readFile(a.sessionFile), afterRead = await fs.lstat(a.sessionFile);
  if (!unchanged(before, afterRead) || sha(raw) !== a.copyProof.sha256) throw Error('own_A_changed');
  const rows = []; let pos = 0;
  for (let end = raw.indexOf(10); end >= 0; end = raw.indexOf(10, pos)) {
    const line = raw.subarray(pos, end); rows.push({ record: JSON.parse(line.toString()), index: rows.length, start: pos, end: end + 1, sha256: sha(line) }); pos = end + 1;
    if (rows.length === 673) break;
  }
  const targetTurn = '01a18729-010e-7621-b2e5-a0310dc1b8c7', user = rows[12], extra = rows[389], final = rows[669], complete = rows[672];
  if (user.record.payload?.type !== 'user_message' || extra.record.payload?.type !== 'user_message'
    || final.record.payload?.id !== 'msg_0a5305349919adfd016ae32a2c5c9481919e51e5a8c9cc27fb'
    || final.record.payload.phase !== 'final_answer' || complete.record.payload?.type !== 'task_complete'
    || complete.record.payload.turn_id !== targetTurn || text(final.record) !== complete.record.payload.last_agent_message) throw Error('first_exact_boundary');
  let turn = null; const owners = new Map();
  for (const r of rows) { if (r.record.payload?.type === 'task_started') turn = r.record.payload.turn_id; owners.set(r.index, turn); }
  if ([12, 389, 669, 672].some(n => owners.get(n) !== targetTurn)) throw Error('first_inputs_not_same_turn');
  const context = rows.find(r => r.record.type === 'turn_context' && r.record.payload?.turn_id === targetTurn);
  if (!context?.record.payload.model || !context.record.payload.effort) throw Error('first_native_model_missing');
  const records = rows.map(r => structuredClone(r.record));
  const world = records.filter(r => r.type === 'world_state' && typeof r.payload?.state?.agents_md?.text === 'string');
  const policy = world.at(-1)?.payload.state.agents_md.text; if (!policy) throw Error('first_frozen_AGENTS_missing');
  const bodyProof = records.flatMap((r, index) => r.type === 'world_state' && r.payload?.state?.agents_md?.text
    ? [{ index, kind: 'world_state', sha256: sha(r.payload.state.agents_md.text) }]
    : r.type === 'response_item' && r.payload?.role === 'user' && text(r).startsWith('# AGENTS.md instructions for')
      ? [{ index, kind: 'instruction_carrier', sha256: sha(text(r)) }] : []);
  await fs.mkdir(firstFolder, { mode: 0o700 });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mini-logs-original-first-')));
  const cwd = path.join(root, 'fixture'), home = path.join(root, 'codex'); await fs.mkdir(cwd, { mode: 0o700 }); await fs.mkdir(home, { mode: 0o700 });
  const id = crypto.randomUUID(), at = new Date().toISOString();
  for (const r of world) r.payload.state.agents_md.directory = cwd;
  _api.rewriteCodexEditedForkMetadata(rows.map(r => r.record), a.sessionId, cwd, records, id, at);
  for (const p of bodyProof) if (sha(p.kind === 'world_state' ? records[p.index].payload.state.agents_md.text : text(records[p.index])) !== p.sha256)
    throw Error('first_instruction_changed');
  const dir = path.join(home, 'sessions', ...at.slice(0, 10).split('-')); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(dir, `rollout-${at.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), copy = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await save(sessionFile, copy); await save(path.join(cwd, 'AGENTS.md'), policy);
  await fs.copyFile(path.join(a.codexHome, 'auth.json'), path.join(home, 'auth.json'), constants.COPYFILE_EXCL); await fs.chmod(path.join(home, 'auth.json'), 0o600);
  await save(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\nweb_search = "disabled"\n\n[features]\n' + disabled.map(n => n + ' = false').join('\n') + '\n');
  const requestTextFile = path.join(firstFolder, 'REQUEST.txt'), answerTextFile = path.join(firstFolder, 'ANSWER.txt'), additionalInputsFile = path.join(firstFolder, 'ADDITIONAL-INPUTS.json');
  await save(requestTextFile, user.record.payload.message); await save(answerTextFile, text(final.record));
  await save(additionalInputsFile, [{ id: `codex-user-${id}-389`, rawLine: 389, text: extra.record.payload.message }]);
  const ref = r => ({ sourceArchiveSessionId: a.sessionId, originalSourceSessionId: a.sourceProof.sessionId, rawLine: r.index,
    byteStart: r.start, byteEnd: r.end, rawRecordSha256: r.sha256, timestamp: r.record.timestamp, nativeResponseItemId: r.record.payload?.id || null });
  const nativeFor = row => rows.slice(0, row.index).findLast(r => r.record.payload?.role === 'user' && text(r.record) === row.record.payload.message);
  const after = await fs.lstat(a.sessionFile);
  if (!unchanged(before, after) || sha(await fs.readFile(sessionFile)) !== sha(copy)) throw Error('first_bookend');
  const result = { version: 1, case: 'original-first-assignment-historical-clone-C', root, cwd, codexHome: home, sessionId: id, sessionFile,
    tabId: 'mini-original-first-' + id.slice(0, 8), createdAt: at, requestTextFile, answerTextFile, additionalInputsFile,
    completed: true, historicalCopiedCompleted: true, newProviderRun: false, providerRuns: 0, turnId: targetTurn,
    model: context.record.payload.model, effort: context.record.payload.effort, historicalModelAndEffort: true,
    sourceProof: { file: a.sessionFile, sessionId: a.sourceProof.sessionId, sourceArchiveSessionId: a.sessionId, sourceArchiveCase: aFile,
      bytes: raw.length, sha256: sha(raw), originalSourceReRead: false, before: snapshot(before), after: snapshot(after), sourceUnchanged: true,
      user: { ...ref(user), canonicalUserUuid: `codex-user-${a.sourceProof.sessionId}-12`, textHash: sha(user.record.payload.message), nativeUser: ref(nativeFor(user)) },
      additionalInputs: [{ ...ref(extra), canonicalUserUuid: `codex-user-${a.sourceProof.sessionId}-389`, ownCanonicalUuid: `codex-user-${id}-389`,
        textHash: sha(extra.record.payload.message), nativeUser: ref(nativeFor(extra)), sameNativeTurnId: targetTurn }],
      final: { ...ref(final), textHash: sha(text(final.record)) }, complete: ref(complete), nativeSettings: ref(context),
      cutoffInclusiveRawLine: 672, excludesFutureUserRawLines: [677, 710, 774, 802, 862, 926],
      excludedServiceCarrier: { ...ref(rows[190]), kind: 'literal Tab message reply, not a human task input' } },
    copyProof: { bytes: Buffer.byteLength(copy), sha256: sha(copy), recordCount: records.length, standaloneHistoryMode: 'legacy', newHeaderSessionId: id,
      originalNativeTurnAndMessageIdsPreserved: true, onlyHeaderAndWorldStateDirectoryRewritten: true },
    frozenInstructions: { path: path.join(cwd, 'AGENTS.md'), sha256: sha(policy), chars: policy.length, carriers: bodyProof,
      instructionBodiesPreserved: true, worldStateDirectory: cwd },
    launchPreparation: { freshHome: true, authMode: (await fs.stat(path.join(home, 'auth.json'))).mode & 0o777, disabledFeatures: disabled,
      externalMcpServers: 0, userConfigCopied: false, pluginsCopied: false, execInvoked: false, futureCorrectionModel: 'gpt-6.1-sol', futureCorrectionEffort: 'max' },
    limitations: ['Actual first completed historical turn; not a new generated answer.', 'Original task and same-turn human restart permission are literal; service reply is not a task input.',
      'No later follow-ups, findings, or expected verdict supplied. No live/provider actions run by this preparer.'] };
  await save(caseFile, result); await save(path.join(firstFolder, 'PROFILE.json'), { root, cwd, sessionId: id, sessionFile, caseFile, newProviderRun: false });
  console.log(JSON.stringify({ caseFile, sessionId: id, originalModel: result.model, originalEffort: result.effort, retainedRecords: records.length, newProviderRun: false }));
}
if (require.main === module) (process.argv[2] === 'prepare-first' ? prepareFirst() : main()).catch(e => { console.error('[MiniArchivedLogs] ' + e.message); process.exitCode = 1; });
module.exports = { main, prepareFirst };
