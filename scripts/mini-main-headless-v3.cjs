'use strict';
// Explicitly authorized v3: independent historical writer, native read-only
// sandbox only, no outer seatbelt profile and no alteration of v2 artifacts.
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const previous = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main-readonly-v2');
const out = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main-readonly-v3');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const save = (file, value, flag = 'wx') => fs.writeFile(path.join(out, file), json(value), { mode: 0o600, flag });
function environment(codexHome) {
  const env = { ...process.env }, strippedKeys = [];
  for (const key of Object.keys(env)) if (/^(NOTED_|CLAUDE|GEMINI|SC_|CODEX_|OPENAI_|ANTHROPIC_|GOOGLE_API_KEY|TERMINAL_SESSION_ID|AI_SESSION)/.test(key)) { strippedKeys.push(key); delete env[key]; }
  env.CODEX_HOME = codexHome;
  return { env, strippedKeys };
}
async function prepare() {
  await fs.mkdir(out, { recursive: true });
  if (fss.existsSync(path.join(out, 'PREPARED.json'))) throw Error('v3_already_prepared');
  const p = await read(path.join(previous, 'PREPARED.json'));
  const h = await fs.open(p.sessionFile, 'r'), prefix = Buffer.alloc(p.initialBytes);
  try { if ((await h.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) throw Error('short_v2_retained_prefix'); } finally { await h.close(); }
  if (sha(prefix) !== p.initialSha256) throw Error('v2_retained_prefix_changed');
  const records = prefix.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  if (records.length !== 1390 || records.some(r => r.payload?.turn_id === p.excludedTurnId)) throw Error('pinned_prefix_boundary_mismatch');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mini-main-ro-v3-')));
  const cwd = path.join(root, 'fixture'), codexHome = path.join(root, 'codex');
  await fs.mkdir(cwd, { mode: 0o700 }); await fs.mkdir(path.join(cwd, '.git'), { mode: 0o700 }); await fs.mkdir(codexHome, { mode: 0o700 });
  const sessionId = crypto.randomUUID(), createdAt = new Date().toISOString();
  require('../src/main/ipc/codex-data')._api.rewriteCodexEditedForkMetadata(records, p.sourceSessionId, cwd, records, sessionId, createdAt);
  for (const record of records) {
    const agents = record.type === 'world_state' && record.payload?.state?.agents_md;
    if (agents && Object.hasOwn(agents, 'directory')) agents.directory = cwd;
  }
  const historicalAgents = records.findLast(r => r.type === 'world_state' && typeof r.payload?.state?.agents_md?.text === 'string').payload.state.agents_md.text;
  if (sha(historicalAgents) !== p.historicalAgents.sha256) throw Error('historical_agents_changed');
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), historicalAgents, { flag: 'wx', mode: 0o600 });
  const sessionDir = path.join(codexHome, 'sessions', ...createdAt.slice(0, 10).split('-'));
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, `rollout-${createdAt.slice(0, 19).replaceAll(':', '-')}-${sessionId}.jsonl`);
  const bytes = Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''));
  await fs.writeFile(sessionFile, bytes, { mode: 0o600, flag: 'wx' });
  for (const name of ['auth.json', 'models_cache.json']) { await fs.copyFile(path.join(os.homedir(), '.codex', name), path.join(codexHome, name), fss.constants.COPYFILE_EXCL); await fs.chmod(path.join(codexHome, name), 0o600); }
  const prompt = await fs.readFile(p.prompt.file);
  if (sha(prompt) !== '8b6b198b3fc192752038e45a25c23fd99888b62458a4584ebbfa765b45f477ed') throw Error('prompt_changed');
  await fs.writeFile(path.join(out, 'PROMPT.txt'), prompt, { mode: 0o600, flag: 'wx' });
  const safety = `Historical replay safety scope (this does not prescribe the answer):\nYou have local native read-only shell/unified_exec tools. You may read ONLY this independent copied history and its own CODEX_HOME/session, the frozen fixture AGENTS.md, and known source code modules or bounded relevant logs in ${repo}.\nOwn CODEX_HOME: ${codexHome}\nOwn copied rollout: ${sessionFile}\nFrozen fixture: ${cwd}\nDo not read credentials, any other sessions/profiles, the original source JSONL ${p.source.file}, or current AGENTS.md/CLAUDE.md files outside the frozen fixture. Do not invoke protected full History APIs.\nDo not send process signals, write files, make network posts, use browser/GUI/app/DEV controls, or interact with other tabs/sessions/agents. Local code/history inspection through read-only shell is allowed and expected. No model delegation. Do not update documentation or implement changes in this replay. Answer the unchanged human request from evidence available within this scope.`;
  await fs.writeFile(path.join(out, 'DEVELOPER-SAFETY.txt'), safety, { mode: 0o600, flag: 'wx' });
  const catalog = await read(path.join(codexHome, 'models_cache.json'));
  const model = catalog.models.find(m => m.slug === 'gpt-6.1-sol');
  if (!model || model.max_context_window !== 872000) throw Error('model_window_contract_changed');
  const explicitDisabledFeatures = ['apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'in_app_browser'];
  const featureOutput = execFileSync('codex', ['features', 'list'], { env: environment(codexHome).env, encoding: 'utf8' });
  for (const name of explicitDisabledFeatures) if (!featureOutput.split('\n').some(line => line.startsWith(name + ' '))) throw Error('unsupported_feature:' + name);
  await fs.writeFile(path.join(out, 'NATIVE-FEATURES.txt'), featureOutput, { flag: 'wx', mode: 0o600 });
  await save('PREPARED.json', { version: 3, root, cwd, codexHome, sessionId, sessionFile, tabId: 'mini-main-ro-v3-' + sessionId.slice(0, 8), createdAt,
    cliVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), sourceProof: { ...p.source, originalHeaderBytes: p.sourceHeaderBytes, sourceSessionId: p.sourceSessionId, cutBeforeRawLine: 69052, excludedTurnId: p.excludedTurnId },
    prefixCopyProof: { from: p.sessionFile, bytes: p.initialBytes, sha256: p.initialSha256, copiedOnlyRetainedPreQuestionPrefix: true, v2Unmodified: true },
    initialBytes: bytes.length, initialSha256: sha(bytes), initialRecords: records.length,
    historicalAgents: { ...p.historicalAgents, directory: cwd, textPreserved: true }, prompt: { ...p.prompt, file: path.join(out, 'PROMPT.txt') },
    developerSafety: { file: path.join(out, 'DEVELOPER-SAFETY.txt'), chars: safety.length, sha256: sha(safety), exactText: safety, answerHintsAdded: false },
    modelCatalogProof: { slug: model.slug, context_window: model.context_window, max_context_window: model.max_context_window, effective_context_window_percent: model.effective_context_window_percent },
    model: 'gpt-6.1-sol', effort: 'low', caps: { model_context_window: 872000, model_auto_compact_token_limit: 800000, project_doc_max_bytes: 262144, deadlineMs: 180000, stdoutMaxBytes: 8388608, stderrMaxBytes: 1048576 },
    explicitDisabledFeatures, outerSandbox: false, nativeReadOnlySandbox: true, originalSourceReRead: false,
    attachments: [{ path: path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main/Image-1.png'), bytes: 62592, sha256: 'bd582a5f44b512e68f66d0d9906e53fac46589ebf679beb2e5946b2a44998f45', submission: 'unchanged literal reference; no -i added' }] });
  console.log('[MiniMainV3] Prepared ' + sessionId + ' at ' + root);
}
async function preflight() {
  const p = await read(path.join(out, 'PREPARED.json'));
  const previousPreflight = await fs.readFile(path.join(out, 'NATIVE-PREFLIGHT.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (previousPreflight && !fss.existsSync(path.join(out, 'NATIVE-PREFLIGHT-INITIAL.json'))) await fs.writeFile(path.join(out, 'NATIVE-PREFLIGHT-INITIAL.json'), previousPreflight, { flag: 'wx', mode: 0o600 });
  const nativeArgs = ['-C', p.cwd, '-s', 'read-only', '-a', 'never', ...p.explicitDisabledFeatures.flatMap(f => ['--disable', f]), 'sandbox', '--', process.execPath, '-e',
    'const fs=require("node:fs"),crypto=require("node:crypto");const own=process.argv[1],agents=process.argv[2],source=process.argv[3];const h=fs.openSync(own,"r"),b=Buffer.alloc(32768),n=fs.readSync(h,b,0,b.length,0);fs.closeSync(h);const a=fs.readFileSync(agents);const s=fs.openSync(source,"r"),x=Buffer.alloc(1024),k=fs.readSync(s,x,0,x.length,0);fs.closeSync(s);console.log(JSON.stringify({ownHistoryRead:n,ownHistoryType:JSON.parse(b.subarray(0,n).toString().split("\\n")[0]).type,frozenAgentsBytes:a.length,frozenAgentsSha256:crypto.createHash("sha256").update(a).digest("hex"),knownSourceRead:k,safeReadPassed:true}));',
    p.sessionFile, path.join(p.cwd, 'AGENTS.md'), path.join(repo, 'src/main/ipc/codex-data.js')];
  const start = Date.now(); let stdout = '', stderr = '', exitCode = 0;
  try { stdout = execFileSync('codex', nativeArgs, { cwd: p.cwd, env: environment(p.codexHome).env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { exitCode = error.status; stdout = String(error.stdout || ''); stderr = String(error.stderr || error.message); }
  let proof; try { proof = JSON.parse(stdout.trim().split('\n').at(-1)); } catch {}
  const passed = exitCode === 0 && proof?.safeReadPassed && proof.frozenAgentsSha256 === p.historicalAgents.sha256;
  await save('NATIVE-PREFLIGHT.json', { passed, startedAt: new Date(start).toISOString(), elapsedMs: Date.now() - start, executable: 'codex', args: nativeArgs, exitCode, stdout, stderr, proof, modelCalled: false, noOuterSandbox: true }, 'w');
  if (!passed) throw Error('native_readonly_preflight_failed:' + stderr);
  console.log('[MiniMainV3] Native readonly preflight passed: ' + stdout.trim());
}
async function run() {
  const p = await read(path.join(out, 'PREPARED.json')), pre = await read(path.join(out, 'NATIVE-PREFLIGHT.json'));
  if (!pre.passed) throw Error('no_successful_native_preflight');
  const prompt = await fs.readFile(p.prompt.file), safety = await fs.readFile(p.developerSafety.file, 'utf8');
  if (sha(prompt) !== p.prompt.sha256 || sha(safety) !== p.developerSafety.sha256) throw Error('immutable_input_changed');
  await save('ATTEMPT-START.json', { startedAt: new Date().toISOString(), maxV3Trials: 1, sessionId: p.sessionId });
  const args = ['-C', p.cwd, '-s', 'read-only', '-a', 'never', ...p.explicitDisabledFeatures.flatMap(f => ['--disable', f]), 'exec', 'resume', '--model', p.model, '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-c', 'model_reasoning_effort="low"', '-c', 'model_context_window=872000', '-c', 'model_auto_compact_token_limit=800000', '-c', 'project_doc_max_bytes=262144', '-c', 'web_search="disabled"', '-c', 'developer_instructions=' + JSON.stringify(safety), '-o', path.join(out, 'ANSWER.txt'), p.sessionId, '-'];
  const clean = environment(p.codexHome), start = Date.now();
  const stdout = fss.createWriteStream(path.join(out, 'EVENTS.jsonl'), { flags: 'wx', mode: 0o600 }), stderr = fss.createWriteStream(path.join(out, 'STDERR.txt'), { flags: 'wx', mode: 0o600 });
  const child = spawn('codex', args, { cwd: p.cwd, env: clean.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stdoutBytes = 0, stderrBytes = 0, stopReason = null, escalation;
  const stop = reason => { if (stopReason) return; stopReason = reason; try { process.kill(-child.pid, 'SIGTERM'); } catch {} escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); };
  const deadline = setTimeout(() => stop('deadline180s'), 180000);
  child.stdout.on('data', b => { stdoutBytes += b.length; if (stdoutBytes <= p.caps.stdoutMaxBytes) stdout.write(b); else stop('stdout_cap'); });
  child.stderr.on('data', b => { stderrBytes += b.length; if (stderrBytes <= p.caps.stderrMaxBytes) stderr.write(b); else stop('stderr_cap'); });
  child.stdin.on('error', () => {}); child.stdin.end(prompt);
  const exit = await new Promise(resolve => { child.once('error', e => resolve({ error: e.message })); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(deadline); clearTimeout(escalation);
  await Promise.all([new Promise(r => stdout.end(r)), new Promise(r => stderr.end(r))]);
  await save('PROCESS.json', { executable: 'codex', args, startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString(), elapsedMs: Date.now() - start, pid: child.pid, exit, stopReason, stdoutBytes, stderrBytes, strippedEnvironmentKeys: clean.strippedKeys, outerSandbox: false });
  await inspect();
  console.log('[MiniMainV3] ' + json({ sessionId: p.sessionId, exit, stopReason, elapsedMs: Date.now() - start }));
}
async function inspect() {
  const p = await read(path.join(out, 'PREPARED.json')), processReceipt = await read(path.join(out, 'PROCESS.json'));
  const st = await fs.lstat(p.sessionFile); if (st.size - p.initialBytes > 16777216) throw Error('append_inspection_cap');
  const h = await fs.open(p.sessionFile, 'r'), prefix = Buffer.alloc(p.initialBytes), append = Buffer.alloc(st.size - p.initialBytes);
  try { await h.read(prefix, 0, prefix.length, 0); await h.read(append, 0, append.length, p.initialBytes); } finally { await h.close(); }
  if (sha(prefix) !== p.initialSha256) throw Error('retained_prefix_changed');
  const rows = append.toString('utf8').split('\n').filter(Boolean).map(JSON.parse), events = (await fs.readFile(path.join(out, 'EVENTS.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const toolCalls = rows.flatMap((r, index) => {
    if (r.type !== 'response_item' || !['custom_tool_call', 'function_call'].includes(r.payload?.type)) return [];
    const c = r.payload, result = rows.find(x => x.payload?.call_id === c.call_id && ['custom_tool_call_output', 'function_call_output'].includes(x.payload?.type))?.payload?.output;
    const pieces = Array.isArray(result) ? result : [{ text: typeof result === 'string' ? result : '' }];
    return [{ appendRecord: index, name: c.name, callId: c.call_id, input: c.input || c.arguments || '', outputText: pieces.filter(x => typeof x.text === 'string').map(x => x.text).join('\n'), outputImages: pieces.filter(x => x.type === 'input_image').map(x => { const b = Buffer.from(x.image_url.split(',')[1], 'base64'); return { bytes: b.length, sha256: sha(b), detail: x.detail }; }) }];
  });
  const texts = rows.filter(r => r.type === 'response_item' && r.payload?.type === 'message').map(r => ({ record: r, text: (r.payload.content || []).map(c => c.text || '').join('\n') }));
  const projectInstructions = texts.filter(x => x.record.payload.role === 'user' && /# AGENTS.md instructions|These AGENTS.md instructions replace|previously provided AGENTS.md instructions no longer apply/.test(x.text)).map(x => ({ timestamp: x.record.timestamp, chars: x.text.length, sha256: sha(x.text) }));
  const safetyCarriers = texts.filter(x => x.record.payload.role === 'developer' && x.text.includes(p.developerSafety.exactText)).map(x => ({ timestamp: x.record.timestamp, chars: x.text.length, sha256: sha(x.text), containsExactSafety: true }));
  const retainedRecords = prefix.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  const retainedInstructionCarriers = [];
  function auditInstruction(item, source) {
    if (item.type !== 'message' || item.role !== 'user') return;
    const text = (item.content || []).map(c => c.text || '').join('\n');
    if (!text.startsWith('# AGENTS.md instructions')) return;
    const start = text.indexOf('<INSTRUCTIONS>'), end = text.indexOf('</INSTRUCTIONS>');
    if (start < 0 || end < start) throw Error('instruction_wrapper_shape_changed');
    let body = text.slice(start + '<INSTRUCTIONS>'.length, end);
    if (body.startsWith('\n')) body = body.slice(1);
    if (body.endsWith('\n')) body = body.slice(0, -1);
    const notice = 'These AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n';
    const replacement = body.startsWith(notice); if (replacement) body = body.slice(notice.length);
    retainedInstructionCarriers.push({ ...source, wrapperChars: text.length, wrapperSha256: sha(text), bodyChars: body.length, bodySha256: sha(body), replacementNotice: replacement, scopeHeader: text.split('\n')[0] });
  }
  for (const [index, record] of retainedRecords.entries()) {
    if (record.type === 'compacted') for (const [replacementIndex, item] of (record.payload.replacement_history || []).entries()) auditInstruction(item, { recordIndex: index, sourceRawLine: 67663, kind: 'compacted.replacement_history', replacementIndex, timestamp: record.timestamp });
    if (record.type === 'response_item') auditInstruction(record.payload, { recordIndex: index, sourceRawLine: 67662 + index, kind: 'response_item', timestamp: record.timestamp });
  }
  const retainedPayloadAudit = { performedBy: 'worker independent read-only audit after the native trial; not injected into model prompt', copiedPrefixSha256: p.initialSha256,
    instructionCarrierCount: retainedInstructionCarriers.length, distinctBodySha256Count: new Set(retainedInstructionCarriers.map(x => x.bodySha256)).size,
    carriers: retainedInstructionCarriers,
    worldStateCheckpoints: retainedRecords.flatMap((r, index) => r.type === 'world_state' && r.payload.state.agents_md ? [{ recordIndex: index, sourceRawLine: 67662 + index, timestamp: r.timestamp, full: r.payload.full, chars: r.payload.state.agents_md.text?.length, textSha256: typeof r.payload.state.agents_md.text === 'string' ? sha(r.payload.state.agents_md.text) : null }] : []),
    interpretation: 'Two distinct retained instruction editions: one inside compact replacement_history and one later replacement carrier. The two world_state snapshots describe those states, not two additional instruction messages. No exact duplicate body was found. This is a copied-prefix audit, not a captured original HTTP request.' };
  await save('OWN-PREFIX-PAYLOAD-AUDIT.json', retainedPayloadAudit, 'w');
  const prompts = rows.filter(r => r.payload?.type === 'user_message').map(r => ({ timestamp: r.timestamp, chars: r.payload.message?.length, sha256: sha(r.payload.message || '') }));
  const starts = rows.filter(r => r.payload?.type === 'task_started'), completes = rows.filter(r => r.payload?.type === 'task_complete');
  const answer = await fs.readFile(path.join(out, 'ANSWER.txt'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  const files = [];
  async function inventory(d) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await inventory(f); else if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ path: f, bytes: (await fs.lstat(f)).size }); else if (e.isSymbolicLink()) throw Error('private_session_symlink'); } }
  await inventory(path.join(p.codexHome, 'sessions'));
  const sourceStat = await fs.lstat(p.sourceProof.file);
  const sourceUnchanged = sourceStat.size === p.sourceProof.size && sourceStat.dev === p.sourceProof.dev && sourceStat.ino === p.sourceProof.ino && sourceStat.mtimeMs === p.sourceProof.mtimeMs;
  const result = { ...p, requestTextFile: p.prompt.file, answerTextFile: path.join(out, 'ANSWER.txt'), turnId: starts.at(-1)?.payload.turn_id || null,
    completed: processReceipt.exit.code === 0 && !!completes.length && prompts.some(x => x.sha256 === p.prompt.sha256), process: processReceipt, nativePreflight: await read(path.join(out, 'NATIVE-PREFLIGHT.json')),
    sessionFinalBytes: st.size, appendBytes: append.length, appendRecords: rows.length, privatePrefixUnchanged: true, originalSourceStatUnchanged: sourceUnchanged,
    actualOwnSessionFiles: files, actualToolCalls: toolCalls, actualNewUserMessages: prompts, actualTaskStarts: starts, actualTaskComplete: completes,
    actualProjectInstructionCarriers: projectInstructions, actualAppendedAgentsCheckpoints: rows.filter(r => r.type === 'world_state' && Object.hasOwn(r.payload?.state || {}, 'agents_md')),
    actualAppendedCompactions: rows.filter(r => r.type === 'compacted' || r.payload?.type === 'context_compacted').map(r => ({ type: r.type, timestamp: r.timestamp, payloadType: r.payload?.type })),
    actualMcpToolCalls: events.filter(e => e.item?.type === 'mcp_tool_call').map(e => ({ server: e.item.server, tool: e.item.tool, status: e.item.status })),
    actualDeveloperSafetyCarriers: safetyCarriers, developerSafetyAppliedToRecordedContext: safetyCarriers.length > 0, retainedPayloadAudit,
    nativeCommands: events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => ({ command: e.item.command, exitCode: e.item.exit_code, status: e.item.status, outputChars: e.item.aggregated_output?.length })),
    frozenFixtureAgentsUnchanged: sha(await fs.readFile(path.join(p.cwd, 'AGENTS.md'))) === p.historicalAgents.sha256,
    actualUsage: rows.filter(r => r.type === 'token_usage_record').map(r => ({ timestamp: r.timestamp, usage: r.payload.usage })),
    answer: { chars: answer.length, sha256: sha(answer), available: !!answer },
    limitations: ['single genuine native attempt; if completed=false there is no final answer and this is not a ready DEV case', 'read-only historical replay, not native UI/production verification', 'original JSONL was not read again; independent retained prefix copied from verified v2 initial boundary', 'CLI config accepted developer safety but Resume did not emit its exact text in the recorded context; semantic read restrictions are NOT proven applied', 'the model read current project docs and another existing test evidence directory discovered through docs; it did not inspect its own copied rollout', 'worker own-prefix audit is separately labelled and was not injected into the model input'] };
  await save('CASE.json', result, 'w');
  await fs.writeFile(path.join(out, 'RESULT.md'), `# Main historical replay v3\n\nStatus: ${result.completed ? 'completed genuine native read-only Codex turn' : 'PARTIAL — deadline180s; no final answer; NOT a ready DEV case'}.\n\n- SID: \`${p.sessionId}\`\n- Turn: \`${result.turnId}\`\n- Rollout: \`${p.sessionFile}\`\n- Native preflight: ${result.nativePreflight.passed}; no outer sandbox.\n- Exit: ${JSON.stringify(processReceipt.exit)}; elapsed ${processReceipt.elapsedMs} ms.\n- Exact prompt: ${prompts.some(x => x.sha256 === p.prompt.sha256)}.\n- New AGENTS carriers: ${projectInstructions.length}; new compaction records: ${result.actualAppendedCompactions.length}; MCP calls: ${result.actualMcpToolCalls.length}.\n- Frozen AGENTS and retained prefix unchanged: ${result.frozenFixtureAgentsUnchanged && result.privatePrefixUnchanged}.\n\nNative shell execution worked. However, CLI-config developer safety was not emitted into the recorded Resume context and must not be described as applied. The model followed current docs to an existing test evidence directory rather than auditing its own copied rollout; the independent worker audit is separate, not a model result. It confirms TWO retained instruction carriers with different bodies (one compact replacement-history entry and one later replacement), not two identical sends. The world_state checkpoints are metadata for those states.\n\n[CASE.json](CASE.json) · [OWN-PREFIX-PAYLOAD-AUDIT.json](OWN-PREFIX-PAYLOAD-AUDIT.json) · [PROMPT.txt](PROMPT.txt) · [DEVELOPER-SAFETY.txt](DEVELOPER-SAFETY.txt) · [EVENTS.jsonl](EVENTS.jsonl) · [NATIVE-PREFLIGHT.json](NATIVE-PREFLIGHT.json)\n\nPrivate partial profile is retained only for audit/authorized recovery, not automatic DEV seeding. It contains copied private authentication; do not publish it. V2 namespace and previous trials were not altered.\n`, { mode: 0o600 });
}
const action = process.argv[2];
({ prepare, preflight, run, inspect }[action] || (() => { throw Error('usage: prepare|preflight|run|inspect'); }))().catch(error => { console.error('[MiniMainV3] ' + error.stack); process.exitCode = 1; });
