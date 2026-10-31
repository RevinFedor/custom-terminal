'use strict';
// One explicitly authorized historical replay. Never writes source/user profiles.
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main-readonly-v2');
const original = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const save = (file, value, flag = 'wx') => fs.writeFile(file, json(value), { mode: 0o600, flag });
const sourceUnchanged = (stat, p) => stat.isFile() && stat.size === p.size && stat.dev === p.dev && stat.ino === p.ino && stat.mtimeMs === p.mtimeMs;
async function prepare() {
  await fs.mkdir(out, { recursive: true });
  if (fss.existsSync(path.join(out, 'PREPARED.json'))) throw Error('already_prepared_no_overwrite');
  const profile = await readJson(path.join(original, 'PROFILE.json'));
  const boundaries = await readJson(path.join(original, 'RAW-BOUNDARY.json'));
  const p = profile.source;
  if (p.selectedOffset !== 642387127 || p.readEnd !== 657789765 || p.readBytes !== 15402638) throw Error('pinned_range_changed');
  if (!sourceUnchanged(await fs.lstat(p.file), p)) throw Error('source_stat_changed');
  const fh = await fs.open(p.file, 'r');
  let raw, meta;
  try {
    const h = boundaries.results.find(r => r.line === 0);
    const header = Buffer.alloc(h.end);
    if ((await fh.read(header, 0, header.length, 0)).bytesRead !== header.length || sha(header.subarray(0, -1)) !== h.sha256) throw Error('header_changed');
    meta = JSON.parse(header.toString());
    raw = Buffer.alloc(p.readBytes);
    let n = 0;
    while (n < raw.length) {
      const r = await fh.read(raw, n, Math.min(1048576, raw.length - n), p.selectedOffset + n);
      if (!r.bytesRead) throw Error('short_source');
      n += r.bytesRead;
    }
    if (!sourceUnchanged(await fh.stat(), p)) throw Error('source_changed_during_read');
  } finally { await fh.close(); }
  if (sha(raw) !== 'b6d47f1f93eb9bd367d8e55e6420a21253d8ea6afd6b38a7b52b76ccf249e367') throw Error('source_digest_changed');
  const lines = raw.toString('utf8').split('\n');
  if (lines.pop() !== '') throw Error('line_alignment');
  const records = [meta, ...lines.slice(0, 69052 - 67663).map(JSON.parse)];
  if (records.some(r => r.payload?.turn_id === '01a18cdc-2d72-7140-a1f6-a6ebef8bdc8c')) throw Error('target_preamble_retained');
  const states = records.filter(r => r.type === 'world_state' && r.payload?.state?.agents_md);
  const latestAgents = states.findLast(r => typeof r.payload.state.agents_md.text === 'string').payload.state.agents_md.text;
  if (latestAgents.length !== 110397) throw Error('historical_agents_mismatch');
  const promptHandle = await fs.open(profile.sessionFile, 'r');
  let promptRecord;
  try {
    const b = Buffer.alloc(32768), { bytesRead } = await promptHandle.read(b, 0, b.length, 22587133);
    const s = b.subarray(0, bytesRead).toString('utf8');
    if (!s.includes('\n')) throw Error('prompt_record_too_large');
    promptRecord = JSON.parse(s.split('\n')[0]);
  } finally { await promptHandle.close(); }
  const prompt = promptRecord.payload?.message;
  if (promptRecord.timestamp !== '2026-10-30T14:16:22.519Z' || promptRecord.payload?.type !== 'user_message' || prompt.length !== 1259 || sha(prompt) !== '8b6b198b3fc192752038e45a25c23fd99888b62458a4584ebbfa765b45f477ed') throw Error('prompt_identity_changed');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mini-main-ro-v2-')));
  const cwd = path.join(root, 'fixture'), codexHome = path.join(root, 'codex');
  await fs.mkdir(cwd, { mode: 0o700 });
  await fs.mkdir(path.join(cwd, '.git'), { mode: 0o700 });
  await fs.mkdir(codexHome, { mode: 0o700 });
  const sessionId = crypto.randomUUID(), createdAt = new Date().toISOString();
  const { _api } = require('../src/main/ipc/codex-data');
  _api.rewriteCodexEditedForkMetadata(records, profile.beforeUser.sessionId, cwd, records, sessionId, createdAt);
  const changedDirectories = [];
  for (const [index, record] of records.entries()) {
    const agents = record.type === 'world_state' && record.payload?.state?.agents_md;
    if (agents && Object.hasOwn(agents, 'directory')) {
      changedDirectories.push({ recordIndex: index, previous: agents.directory, next: cwd });
      agents.directory = cwd;
    }
  }
  const sessionDir = path.join(codexHome, 'sessions', ...createdAt.slice(0, 10).split('-'));
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, `rollout-${createdAt.slice(0, 19).replaceAll(':', '-')}-${sessionId}.jsonl`);
  const output = Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''));
  await fs.writeFile(sessionFile, output, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), latestAgents, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(out, 'PROMPT.txt'), prompt, { flag: 'wx', mode: 0o600 });
  await save(path.join(out, 'PROMPT-RECORD.json'), promptRecord);
  // Only authentication and live model metadata are copied, never global config,
  // hooks, MCP bindings, sessions, skills or account settings. Contents stay private.
  for (const name of ['auth.json', 'models_cache.json']) {
    await fs.copyFile(path.join(os.homedir(), '.codex', name), path.join(codexHome, name), fss.constants.COPYFILE_EXCL);
    await fs.chmod(path.join(codexHome, name), 0o600);
  }
  const catalog = await readJson(path.join(codexHome, 'models_cache.json'));
  const model = catalog.models.find(m => m.slug === 'gpt-6.1-sol');
  if (!model || model.max_context_window !== 872000 || !model.supported_reasoning_levels.some(r => r.effort === 'low')) throw Error('live_model_contract_changed');
  const denyPaths = [path.join(os.homedir(), '.codex', 'sessions'), profile.root, path.join(repo, 'AGENTS.md'), path.join(repo, 'CLAUDE.md')];
  const sb = '(version 1)\n(allow default)\n' + denyPaths.map(p => `(deny file-read* (${p.endsWith('.md') ? 'literal' : 'subpath'} ${JSON.stringify(p)}))`).join('\n') + '\n';
  const sandboxFile = path.join(out, 'guard.sb');
  await fs.writeFile(sandboxFile, sb, { flag: 'wx', mode: 0o600 });
  const sourcePost = await fs.lstat(p.file);
  if (!sourceUnchanged(sourcePost, p)) throw Error('source_changed_before_receipt');
  const result = {
    version: 2, root, cwd, codexHome, sessionId, tabId: 'mini-main-ro-v2-' + sessionId.slice(0, 8), sessionFile, createdAt,
    cliVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), source: p,
    sourceHeaderBytes: boundaries.results.find(r => r.line === 0).end,
    sourceSessionId: profile.beforeUser.sessionId, copyCutBeforeRawLine: 69052,
    excludedTurnId: '01a18cdc-2d72-7140-a1f6-a6ebef8bdc8c', initialBytes: output.length, initialSha256: sha(output), initialRecords: records.length,
    historicalAgents: { chars: latestAgents.length, bytes: Buffer.byteLength(latestAgents), sha256: sha(latestAgents), sourceLatestRawLine: 68760, changedDirectories, historicalTextUnchanged: true },
    prompt: { file: path.join(out, 'PROMPT.txt'), chars: prompt.length, sha256: sha(prompt), canonicalSourceFile: profile.sessionFile, canonicalSourceByteOffset: 22587133, timestamp: promptRecord.timestamp, images: [], literalImageReferenceOnly: true },
    model: { slug: model.slug, context_window: model.context_window, max_context_window: model.max_context_window, effective_context_window_percent: model.effective_context_window_percent, supported_reasoning_levels: model.supported_reasoning_levels },
    caps: { model_context_window: 872000, model_auto_compact_token_limit: 800000, project_doc_max_bytes: 262144, deadlineMs: 180000, stdoutMaxBytes: 8388608, stderrMaxBytes: 1048576 },
    sandboxFile, deniedReadPaths: denyPaths,
    differencesFromOriginal: ['native CLI0.166.0, not screenshot CLI', 'gpt-6.1-sol/low instead of original gpt-6.1-sol/max', 'private cwd and read-only/never policy', 'no MCP/hooks/config inherited', 'historical AGENTS text frozen locally; retained checkpoint directory changed only in copy', 'expanded model window872000 and auto-compact800000'],
    sourceUnchanged: true, preparedOnly: true, attempts: 0
  };
  await save(path.join(out, 'PREPARED.json'), result);
  console.log('[MiniMain] ' + json({ root, sessionId, sessionFile, initialBytes: output.length, historicalAgentsSha256: sha(latestAgents), sourceUnchanged: true }));
}
async function run() {
  const p = await readJson(path.join(out, 'PREPARED.json'));
  await save(path.join(out, 'ATTEMPT-START.json'), { startedAt: new Date().toISOString(), sessionId: p.sessionId, maxAttempts: 1 });
  const prompt = await fs.readFile(p.prompt.file);
  if (sha(prompt) !== p.prompt.sha256) throw Error('saved_prompt_changed');
  const env = { ...process.env }, strippedEnvironmentKeys = [];
  for (const key of Object.keys(env)) {
    if (/^(NOTED_|CLAUDE|GEMINI|SC_|CODEX_|OPENAI_|ANTHROPIC_|GOOGLE_API_KEY|TERMINAL_SESSION_ID|AI_SESSION)/.test(key)) {
      strippedEnvironmentKeys.push(key); delete env[key];
    }
  }
  env.CODEX_HOME = p.codexHome;
  const disabledFeatures = p.explicitDisabledFeatures || [];
  const codexArgs = ['-C', p.cwd, '-s', 'read-only', '-a', 'never', ...disabledFeatures.flatMap(name => ['--disable', name]), 'exec', 'resume', '--model', 'gpt-6.1-sol', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-c', 'model_reasoning_effort="low"', '-c', 'model_context_window=872000', '-c', 'model_auto_compact_token_limit=800000', '-c', 'project_doc_max_bytes=262144',
    '-c', 'web_search="disabled"', '-o', path.join(out, 'ANSWER.txt'), p.sessionId, '-'];
  const args = ['-f', p.sandboxFile, 'codex', ...codexArgs];
  const stdout = fss.createWriteStream(path.join(out, 'EVENTS.jsonl'), { flags: 'wx', mode: 0o600 });
  const stderr = fss.createWriteStream(path.join(out, 'STDERR.txt'), { flags: 'wx', mode: 0o600 });
  const start = Date.now();
  let stdoutBytes = 0, stderrBytes = 0, stopReason = null, escalation;
  const child = spawn('/usr/bin/sandbox-exec', args, { cwd: p.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  }
  const deadline = setTimeout(() => stop('deadline180s'), p.caps.deadlineMs);
  child.stdout.on('data', b => { stdoutBytes += b.length; if (stdoutBytes <= p.caps.stdoutMaxBytes) stdout.write(b); else stop('stdout_cap'); });
  child.stderr.on('data', b => { stderrBytes += b.length; if (stderrBytes <= p.caps.stderrMaxBytes) stderr.write(b); else stop('stderr_cap'); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const exit = await new Promise(resolve => { child.once('error', e => resolve({ error: e.message })); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(deadline); clearTimeout(escalation);
  await Promise.all([new Promise(r => stdout.end(r)), new Promise(r => stderr.end(r))]);
  const receipt = { startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString(), elapsedMs: Date.now() - start, pid: child.pid, exit, stopReason, stdoutBytes, stderrBytes, executable: '/usr/bin/sandbox-exec', args, strippedEnvironmentKeys, authCopiedPrivately: true, credentialsPrinted: false };
  await save(path.join(out, 'PROCESS.json'), receipt);
  await inspect();
  console.log('[MiniMain] ' + json({ sessionId: p.sessionId, exit, stopReason, elapsedMs: receipt.elapsedMs }));
}
async function prepareSecond() {
  const p = await readJson(path.join(out, 'PREPARED.json'));
  const previousCase = await readJson(path.join(out, 'CASE.json'));
  if (previousCase.process.exit.signal !== 'SIGTERM' || previousCase.exactPromptCompleted || p.explicitDisabledFeatures) throw Error('second_trial_only_for_proven_setup_failure');
  const events = (await fs.readFile(path.join(out, 'EVENTS.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  if (!events.some(e => e.item?.type === 'mcp_tool_call' && e.item.tool === 'list_mcp_resources')) throw Error('expected_setup_failure_evidence_missing');
  const allowedMetadataTools = ['list_mcp_resources', 'noted_terminal.terminal_instructions', 'asdk_app_6ad48c9ff77c8191858d1d447e95e1b4.repositories'];
  if (events.some(e => e.item?.type === 'mcp_tool_call' && !allowedMetadataTools.includes(e.item.tool))) throw Error('unexpected_first_trial_external_tool_requires_review');
  const archive = path.join(out, 'first-setup-failure');
  await fs.mkdir(archive, { mode: 0o700 });
  for (const name of ['PREPARED.json', 'ATTEMPT-START.json', 'CASE.json', 'PROCESS.json', 'EVENTS.jsonl', 'STDERR.txt', 'RESULT.md']) await fs.rename(path.join(out, name), path.join(archive, name));
  if (fss.existsSync(path.join(out, 'ANSWER.txt'))) await fs.rename(path.join(out, 'ANSWER.txt'), path.join(archive, 'ANSWER.txt'));
  await save(path.join(archive, 'SETUP-FAILURE.json'), { reason: 'Account-cloud apps enabled by native default despite fresh CODEX_HOME/ignore config. Stopped only own process after catalog/instructions metadata; repository inventory began with unknown completion. No session/history/write call observed.', stop: { signal: 'SIGTERM', pid: previousCase.process.pid, externallyStoppedByOwner: true }, partialSessionId: p.sessionId, partialSessionFile: p.sessionFile, completed: false, actualCalls: events.filter(e => e.item?.type === 'mcp_tool_call').map(e => ({ eventType: e.type, server: e.item.server, tool: e.item.tool, status: e.item.status })), unknownDeliveryNotRetried: ['asdk_app_6ad48c9ff77c8191858d1d447e95e1b4.repositories'], retry: 'one independent session with explicit locally verified feature disables', originalSourceUntouched: true });
  const handle = await fs.open(p.sessionFile, 'r'), prefix = Buffer.alloc(p.initialBytes);
  try { if ((await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) throw Error('short_private_prefix'); } finally { await handle.close(); }
  if (sha(prefix) !== p.initialSha256) throw Error('private_prefix_changed');
  const records = prefix.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mini-main-ro-v2-final-')));
  const cwd = path.join(root, 'fixture'), codexHome = path.join(root, 'codex');
  await fs.mkdir(cwd, { mode: 0o700 }); await fs.mkdir(path.join(cwd, '.git'), { mode: 0o700 }); await fs.mkdir(codexHome, { mode: 0o700 });
  const sessionId = crypto.randomUUID(), createdAt = new Date().toISOString();
  require('../src/main/ipc/codex-data')._api.rewriteCodexEditedForkMetadata(records, p.sourceSessionId, cwd, records, sessionId, createdAt);
  for (const record of records) {
    const agents = record.type === 'world_state' && record.payload?.state?.agents_md;
    if (agents && Object.hasOwn(agents, 'directory')) agents.directory = cwd;
  }
  const sessionDir = path.join(codexHome, 'sessions', ...createdAt.slice(0, 10).split('-'));
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, `rollout-${createdAt.slice(0, 19).replaceAll(':', '-')}-${sessionId}.jsonl`);
  const output = Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''));
  await fs.writeFile(sessionFile, output, { mode: 0o600, flag: 'wx' });
  await fs.copyFile(path.join(p.cwd, 'AGENTS.md'), path.join(cwd, 'AGENTS.md'), fss.constants.COPYFILE_EXCL);
  for (const name of ['auth.json', 'models_cache.json']) await fs.copyFile(path.join(p.codexHome, name), path.join(codexHome, name), fss.constants.COPYFILE_EXCL);
  const featuresOutput = execFileSync('codex', ['features', 'list'], { encoding: 'utf8' });
  await fs.writeFile(path.join(out, 'NATIVE-FEATURES.txt'), featuresOutput, { flag: 'wx', mode: 0o600 });
  const explicitDisabledFeatures = ['apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'in_app_browser'];
  for (const name of explicitDisabledFeatures) if (!featuresOutput.split('\n').some(line => line.startsWith(name + ' '))) throw Error('unsupported_feature:' + name);
  const result = { ...p, root, cwd, codexHome, sessionId, tabId: 'mini-main-ro-v2-' + sessionId.slice(0, 8), sessionFile, createdAt, initialBytes: output.length, initialSha256: sha(output), explicitDisabledFeatures,
    historicalAgents: { ...p.historicalAgents, changedDirectories: [{ previous: '/Users/fedor/Desktop/custom-terminal', next: cwd }] },
    trialOrdinal: 2, setupFailure: { file: path.join(archive, 'SETUP-FAILURE.json'), sessionId: p.sessionId, noReplayOfPartialTurn: true },
    prefixPreparedFrom: { sessionFile: p.sessionFile, bytes: p.initialBytes, sha256: p.initialSha256, onlyOriginalRetainedPrefix: true },
    differencesFromOriginal: [...p.differencesFromOriginal, 'explicit apps/plugins/remote_plugin/hooks/native secondary-agent/browser features disabled after proven default cloud exposure'] };
  await save(path.join(out, 'PREPARED.json'), result);
  console.log('[MiniMain] Independent final trial prepared: ' + json({ sessionId, sessionFile, root, initialBytes: output.length, explicitDisabledFeatures }));
}
async function inspect() {
  const p = await readJson(path.join(out, 'PREPARED.json'));
  const processReceipt = await readJson(path.join(out, 'PROCESS.json'));
  const stat = await fs.lstat(p.sessionFile);
  if (stat.size - p.initialBytes > 16777216) throw Error('append_exceeds_inspection_cap');
  const fh = await fs.open(p.sessionFile, 'r');
  const head = Buffer.alloc(p.initialBytes), tail = Buffer.alloc(stat.size - p.initialBytes);
  try {
    await fh.read(head, 0, head.length, 0);
    await fh.read(tail, 0, tail.length, p.initialBytes);
  } finally { await fh.close(); }
  const unchangedPrefix = sha(head) === p.initialSha256;
  if (!unchangedPrefix) throw Error('private_prefix_changed');
  const rows = tail.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  const events = (await fs.readFile(path.join(out, 'EVENTS.jsonl'), 'utf8')).split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch { return { unparsed: s }; } });
  const projectCarriers = rows.flatMap((r, i) => {
    if (r.type !== 'response_item' || r.payload?.type !== 'message' || r.payload?.role !== 'user') return [];
    const text = (r.payload.content || []).map(c => c.text || '').join('\n');
    if (!text.includes('# AGENTS.md instructions') && !text.includes('These AGENTS.md instructions replace') && !text.includes('previously provided AGENTS.md instructions no longer apply')) return [];
    return [{ appendRecord: i, timestamp: r.timestamp, chars: text.length, sha256: sha(text), replacement: text.includes('These AGENTS.md instructions replace'), header: text.slice(0, 180) }];
  });
  const worldAgents = rows.flatMap((r, i) => r.type === 'world_state' && Object.hasOwn(r.payload?.state || {}, 'agents_md') ? [{ appendRecord: i, full: r.payload.full, agents: { directory: r.payload.state.agents_md?.directory, chars: r.payload.state.agents_md?.text?.length, sha256: typeof r.payload.state.agents_md?.text === 'string' ? sha(r.payload.state.agents_md.text) : null } }] : []);
  const prompts = rows.filter(r => r.type === 'event_msg' && r.payload?.type === 'user_message').map(r => ({ timestamp: r.timestamp, chars: r.payload.message?.length, sha256: sha(r.payload.message || '') }));
  const completed = rows.filter(r => r.type === 'event_msg' && ['task_complete', 'turn_complete'].includes(r.payload?.type));
  const lastAnswer = await fs.readFile(path.join(out, 'ANSWER.txt'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  const completionEvents = events.filter(e => ['turn.completed', 'turn.failed', 'thread.started', 'error'].includes(e.type));
  const sourceStatAfter = await fs.lstat(p.source.file);
  const actualToolCalls = rows.flatMap((r, index) => {
    if (r.type !== 'response_item' || !['custom_tool_call', 'function_call'].includes(r.payload?.type)) return [];
    const call = r.payload;
    const output = rows.find(x => x.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(x.payload?.type) && x.payload.call_id === call.call_id)?.payload?.output;
    const pieces = Array.isArray(output) ? output : [{ text: typeof output === 'string' ? output : '' }];
    return [{ appendRecord: index, callId: call.call_id, name: call.name, input: call.input || call.arguments || '',
      outputText: pieces.filter(x => typeof x.text === 'string').map(x => x.text).join('\n'),
      outputImages: pieces.filter(x => x.type === 'input_image').map(x => { const data = x.image_url?.split(',')[1]; const bytes = data ? Buffer.from(data, 'base64') : null; return { mime: x.image_url?.slice(5, x.image_url.indexOf(';')), bytes: bytes?.length, sha256: bytes ? sha(bytes) : null, detail: x.detail }; }) }];
  });
  const sessionFiles = [];
  async function inventory(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) await inventory(full);
      else if (item.isFile() && item.name.endsWith('.jsonl')) sessionFiles.push({ path: full, bytes: (await fs.lstat(full)).size });
      else if (item.isSymbolicLink()) throw Error('unexpected_private_session_symlink');
    }
  }
  await inventory(path.join(p.codexHome, 'sessions'));
  const actualTaskStarts = rows.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_started').map(r => ({ timestamp: r.timestamp, ...r.payload }));
  const fixtureAgentsSha256 = sha(await fs.readFile(path.join(p.cwd, 'AGENTS.md')));
  const completedProof = prompts.some(x => x.sha256 === p.prompt.sha256) && completed.length > 0 && processReceipt.exit.code === 0;
  const turnIds = rows.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_started').map(r => r.payload.turn_id);
  const result = { ...p, requestTextFile: p.prompt.file, answerTextFile: path.join(out, 'ANSWER.txt'), turnId: turnIds.at(-1) || null, model: p.model.slug, effort: 'low', completed: completedProof,
    sourceProof: { ...p.source, headerBytes: p.sourceHeaderBytes, cutBeforeRawLine: p.copyCutBeforeRawLine, excludedTurnId: p.excludedTurnId, initialSha256: p.initialSha256 },
    attachments: [{ path: path.join(original, 'Image-1.png'), bytes: 62592, sha256: 'bd582a5f44b512e68f66d0d9906e53fac46589ebf679beb2e5946b2a44998f45', submission: 'literal path in unchanged prompt; no native -i' }],
    modelCatalogProof: p.model, preparedOnly: false, attempts: p.trialOrdinal || 1, process: processReceipt, sessionFinalBytes: stat.size, appendBytes: tail.length, appendRecords: rows.length, privatePrefixUnchanged: unchangedPrefix,
    sourceUnchangedAfterTrial: sourceUnchanged(sourceStatAfter, p.source), actualNewUserMessages: prompts, exactPromptCompleted: prompts.some(x => x.sha256 === p.prompt.sha256) && completed.length > 0 && processReceipt.exit.code === 0,
    turnIds,
    taskComplete: completed.map(r => ({ timestamp: r.timestamp, payload: r.payload })), completionEvents,
    actualAppendedCompactions: rows.filter(r => r.type === 'compacted' || r.payload?.type === 'context_compacted').map(r => ({ type: r.type, payloadType: r.payload?.type, timestamp: r.timestamp })),
    actualProjectInstructionCarriers: projectCarriers, actualAppendedAgentsCheckpoints: worldAgents,
    answer: { file: path.join(out, 'ANSWER.txt'), chars: lastAnswer.length, sha256: sha(lastAnswer), available: !!lastAnswer },
    actualTurnContexts: rows.filter(r => r.type === 'turn_context').map(r => ({ timestamp: r.timestamp, turnId: r.payload.turn_id, model: r.payload.model, effort: r.payload.effort, cwd: r.payload.cwd, sandbox_policy: r.payload.sandbox_policy, permission_profile: r.payload.permission_profile })),
    actualMcpToolCalls: events.filter(e => e.item?.type === 'mcp_tool_call').map(e => ({ eventType: e.type, server: e.item.server, tool: e.item.tool, status: e.item.status })),
    actualToolCalls, actualTaskStarts, actualOwnSessionFiles: sessionFiles,
    frozenFixtureAgentsUnchanged: fixtureAgentsSha256 === p.historicalAgents.sha256,
    noRepeatedProjectInstructionsProof: { frozenFileSha256: fixtureAgentsSha256, historicalSha256: p.historicalAgents.sha256, appendedAgentStateDiffCount: worldAgents.length, appendedProjectInstructionCarrierCount: projectCarriers.length, scope: 'this exact completed resumed turn only' },
    environmentLimitations: actualToolCalls.filter(t => t.outputText.includes('sandbox_apply: Operation not permitted')).map(t => ({ callId: t.callId, exactRefusal: 'sandbox-exec: sandbox_apply: Operation not permitted', scope: 'outer source-read guard prevents inner sandbox application; exact non-model contrast in SANDBOX-SELFTEST.json; not the AGENTS logic or a model reasoning counterexample', noThirdTrial: true })),
    actualUsage: rows.filter(r => r.type === 'token_usage_record').map(r => ({ timestamp: r.timestamp, usage: r.payload?.usage })),
    limitations: ['single uncontrolled natural answer, not proof of general model reliability', 'no GUI/native TUI verification', 'history is an independent physical copy; original source read denied to child', 'read-only child may inspect current source code, but original project instruction files are denied'] };
  await save(path.join(out, 'CASE.json'), result, 'w');
  const summary = `# Main historical replay v2\n\nStatus: ${result.exactPromptCompleted ? 'completed genuine native Codex turn' : 'not completed / inspect PROCESS and events'}.\n\n- Session: \`${p.sessionId}\`\n- Rollout: \`${p.sessionFile}\`\n- Process exit: ${JSON.stringify(processReceipt.exit)}; elapsed ${processReceipt.elapsedMs} ms.\n- Exact prompt SHA: \`${p.prompt.sha256}\`; canonical user records: ${prompts.length}.\n- New project-instruction carriers: ${projectCarriers.length}; appended compaction records: ${result.actualAppendedCompactions.length}.\n- Original source stat unchanged: ${result.sourceUnchangedAfterTrial}; private retained prefix unchanged: ${unchangedPrefix}.\n- Artifacts: [CASE.json](CASE.json), [ANSWER.txt](ANSWER.txt), [EVENTS.jsonl](EVENTS.jsonl), [STDERR.txt](STDERR.txt), [PROCESS.json](PROCESS.json), [PROMPT.txt](PROMPT.txt).\n\nThe native image tool actually returned the screenshot. Native shell execution returned exact \`sandbox-exec: sandbox_apply: Operation not permitted\` under the outer source-read guard. The answer explicitly preserves uncertainty about transport/history; do not call this a reproduced product defect or a model reasoning counterexample. First trial was stopped after unexpected cloud catalog/instructions metadata (one repository inventory UNKNOWN, never retried); see [setup failure](first-setup-failure/SETUP-FAILURE.json). Second trial explicitly disabled cloud apps/plugins/hooks and made no MCP call. No third trial is authorized or performed.\n\nPrivate scope is intentionally retained for the parent to seed the prepared DEV tab. It holds one ~15 MB independent rollout, frozen historical AGENTS, private authentication and model metadata. The first partial trial remains forensic evidence, not a completed case. No app/build/dependency copies were created. Do not publish authentication.\n`;
  await fs.writeFile(path.join(out, 'RESULT.md'), summary, { mode: 0o600 });
}
const action = process.argv[2];
({ prepare, run, inspect, prepareSecond }[action] || (() => { throw Error('usage: prepare | prepareSecond | run | inspect'); }))().catch(error => { console.error('[MiniMain] ' + error.stack); process.exitCode = 1; });
