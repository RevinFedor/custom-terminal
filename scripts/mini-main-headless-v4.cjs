'use strict';
// Explicitly authorized v4: independent historical writer + explicit operator carrier, native read-only
// sandbox only, no outer seatbelt profile and no alteration of v2 artifacts.
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const previous = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main-readonly-v2');
const out = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main-readonly-v4');
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
  if (fss.existsSync(path.join(out, 'PREPARED.json'))) throw Error('v4_already_prepared');
  const p = await read(path.join(previous, 'PREPARED.json'));
  const h = await fs.open(p.sessionFile, 'r'), prefix = Buffer.alloc(p.initialBytes);
  try { if ((await h.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) throw Error('short_v2_retained_prefix'); } finally { await h.close(); }
  if (sha(prefix) !== p.initialSha256) throw Error('v2_retained_prefix_changed');
  const records = prefix.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  if (records.length !== 1390 || records.some(r => r.payload?.turn_id === p.excludedTurnId)) throw Error('pinned_prefix_boundary_mismatch');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mini-main-ro-v4-')));
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

  for (const name of ['auth.json', 'models_cache.json']) { await fs.copyFile(path.join(os.homedir(), '.codex', name), path.join(codexHome, name), fss.constants.COPYFILE_EXCL); await fs.chmod(path.join(codexHome, name), 0o600); }
  const prompt = await fs.readFile(p.prompt.file);
  if (sha(prompt) !== '8b6b198b3fc192752038e45a25c23fd99888b62458a4584ebbfa765b45f477ed') throw Error('prompt_changed');
  await fs.writeFile(path.join(out, 'PROMPT.txt'), prompt, { mode: 0o600, flag: 'wx' });
  const visibilityNonce = 'MAIN-V4-' + sessionId.slice(0, 8);
  const allowedSourcePaths = [
    path.join(repo, 'src/main/ipc/codex-data.js'),
    path.join(repo, 'packages/codex/codex-rs/core/src/context/world_state/agents_md.rs'),
    path.join(repo, 'packages/codex/codex-rs/core/src/context/world_state/agents_md_tests.rs'),
    path.join(repo, 'packages/codex/codex-rs/core/src/context_manager'),
    path.join(repo, 'packages/codex/codex-rs/core/src/session/mod.rs'),
  ];
  const imagePath = path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main/Image-1.png');
  const safety = `Operator safety/source context for this experiment (not the historical human prompt; no product answer is prescribed).
In your first commentary include the exact visibility nonce ${visibilityNonce}, solely to prove that this operator context is visible.
The unchanged human question below is being investigated against THIS independent historical copy, not other sessions or past test cases. Primary history source:
Own session ID: ${sessionId}
Own copied rollout: ${sessionFile}
Own CODEX_HOME: ${codexHome}
Current fixture cwd: ${cwd}
Frozen historical project instructions: ${path.join(cwd, 'AGENTS.md')}
Provided screenshot: ${imagePath}
Native local read-only shell/unified_exec is available and should be used for local inspection. For actual history/payload claims inspect this own copied rollout. For relevant implementation, only bounded reads of these known source paths are allowed:
${allowedSourcePaths.join('\n')}
Do not substitute old investigations, docs/tmp evidence, /private/tmp test directories, other profiles, or current knowledge-doc conclusions for reading this own history. Do not read credentials, any other sessions/profiles, the original source JSONL ${p.source.file}, current AGENTS.md/CLAUDE.md outside the frozen fixture, or protected full History APIs.
No filesystem writes, documentation updates, process signals, network requests/posts, GUI/browser/DEV/app controls, or interactions/delegations to other tabs/sessions/agents. Do not implement changes. Read-only source/history/image inspection is permitted. Answer the unchanged human request naturally from the evidence you inspect; uncertainty is acceptable when identified precisely.`;
  const operatorCarrier = { timestamp: createdAt, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: safety }] } };
  records.push(operatorCarrier);
  if (records.at(-1) !== operatorCarrier) throw Error('operator_carrier_not_last');
  const bytes = Buffer.from(records.map(r => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  await fs.writeFile(sessionFile, bytes, { mode: 0o600, flag: 'wx' });
  await save('OPERATOR-CARRIER.json', operatorCarrier);

  await fs.writeFile(path.join(out, 'DEVELOPER-SAFETY.txt'), safety, { mode: 0o600, flag: 'wx' });
  const catalog = await read(path.join(codexHome, 'models_cache.json'));
  const model = catalog.models.find(m => m.slug === 'gpt-6.1-sol');
  if (!model || model.max_context_window !== 872000) throw Error('model_window_contract_changed');
  const explicitDisabledFeatures = ['apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'in_app_browser'];
  const featureOutput = execFileSync('codex', ['features', 'list'], { env: environment(codexHome).env, encoding: 'utf8' });
  for (const name of explicitDisabledFeatures) if (!featureOutput.split('\n').some(line => line.startsWith(name + ' '))) throw Error('unsupported_feature:' + name);
  await fs.writeFile(path.join(out, 'NATIVE-FEATURES.txt'), featureOutput, { flag: 'wx', mode: 0o600 });
  await save('PREPARED.json', { version: 4, root, cwd, codexHome, sessionId, sessionFile, tabId: 'mini-main-ro-v4-' + sessionId.slice(0, 8), createdAt,
    cliVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), sourceProof: { ...p.source, originalHeaderBytes: p.sourceHeaderBytes, sourceSessionId: p.sourceSessionId, cutBeforeRawLine: 69052, excludedTurnId: p.excludedTurnId },
    prefixCopyProof: { from: p.sessionFile, bytes: p.initialBytes, sha256: p.initialSha256, copiedOnlyRetainedPreQuestionPrefix: true, v2Unmodified: true },
    initialBytes: bytes.length, initialSha256: sha(bytes), initialRecords: records.length,
    historicalAgents: { ...p.historicalAgents, directory: cwd, textPreserved: true }, prompt: { ...p.prompt, file: path.join(out, 'PROMPT.txt') },
    developerSafety: { file: path.join(out, 'DEVELOPER-SAFETY.txt'), chars: safety.length, sha256: sha(safety), exactText: safety, answerHintsAdded: false, visibilityNonce, allowedSourcePaths, operatorCarrierFile: path.join(out, 'OPERATOR-CARRIER.json'), carrierRecordIndex: records.length - 1, lastBeforeTrial: true, carrierSha256: sha(JSON.stringify(operatorCarrier)) },
    experimentalCondition: 'Explicit new operator safety/source developer carrier in the independent copy. This is NOT an exact historical runtime: it maps the unchanged question to the own copy and forbids substituting other investigations, without prescribing any product answer.',
    modelCatalogProof: { slug: model.slug, context_window: model.context_window, max_context_window: model.max_context_window, effective_context_window_percent: model.effective_context_window_percent },
    model: 'gpt-6.1-sol', effort: 'low', caps: { model_context_window: 872000, model_auto_compact_token_limit: 780000, project_doc_max_bytes: 262144, deadlineMs: 420000, stdoutMaxBytes: 8388608, stderrMaxBytes: 1048576 },
    explicitDisabledFeatures, outerSandbox: false, nativeReadOnlySandbox: true, originalSourceReRead: false,
    attachments: [{ path: path.join(repo, 'docs/tmp/мини-оркестратор-20261030/replay/main/Image-1.png'), bytes: 62592, sha256: 'bd582a5f44b512e68f66d0d9906e53fac46589ebf679beb2e5946b2a44998f45', submission: 'unchanged literal reference; no -i added' }] });
  console.log('[MiniMainV4] Prepared ' + sessionId + ' at ' + root);
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
  console.log('[MiniMainV4] Native readonly preflight passed: ' + stdout.trim());
}
async function repairPrepared() {
  if (fss.existsSync(path.join(out, 'ATTEMPT-START.json'))) throw Error('cannot_repair_started_trial');
  const p = await read(path.join(out, 'PREPARED.json'));
  const old = await fs.readFile(p.sessionFile);
  if (sha(old) !== p.initialSha256) throw Error('unrecognized_prepared_bytes');
  const handle = await fs.open(p.prefixCopyProof.from, 'r'), prefix = Buffer.alloc(p.prefixCopyProof.bytes);
  try { if ((await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) throw Error('short_retained_prefix'); } finally { await handle.close(); }
  if (sha(prefix) !== p.prefixCopyProof.sha256) throw Error('retained_prefix_mismatch');
  const records = prefix.toString('utf8').split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse);
  require('../src/main/ipc/codex-data')._api.rewriteCodexEditedForkMetadata(records, p.sourceProof.sourceSessionId, p.cwd, records, p.sessionId, p.createdAt);
  for (const record of records) {
    const agents = record.type === 'world_state' && record.payload?.state?.agents_md;
    if (agents && Object.hasOwn(agents, 'directory')) agents.directory = p.cwd;
  }
  const carrier = await read(p.developerSafety.operatorCarrierFile);
  if (sha(JSON.stringify(carrier)) !== p.developerSafety.carrierSha256) throw Error('operator_carrier_changed');
  records.push(carrier);
  const bytes = Buffer.from(records.map(r => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  await save('PREPARED-BEFORE-JSONL-REPAIR.json', p);
  await fs.writeFile(p.sessionFile, bytes, { mode: 0o600 });
  await save('PREPARED.json', { ...p, initialBytes: bytes.length, initialSha256: sha(bytes), initialRecords: records.length, preparationRepair: { reason: 'own helper used literal backslash-n between JSON objects; caught by no-model native preflight before any trial', oldSha256: sha(old), newSha256: sha(bytes), originalRetainedContentUnchanged: true, operatorCarrierUnchanged: true } }, 'w');
  console.log('[MiniMainV4] Own unstarted JSONL line framing repaired; no model call performed.');
}
async function run() {
  const p = await read(path.join(out, 'PREPARED.json')), pre = await read(path.join(out, 'NATIVE-PREFLIGHT.json'));
  if (!pre.passed) throw Error('no_successful_native_preflight');
  const prompt = await fs.readFile(p.prompt.file), safety = await fs.readFile(p.developerSafety.file, 'utf8');
  if (sha(prompt) !== p.prompt.sha256 || sha(safety) !== p.developerSafety.sha256) throw Error('immutable_input_changed');
  const initial = await fs.readFile(p.sessionFile, 'utf8');
  if (sha(initial) !== p.initialSha256) throw Error('prepared_prefix_changed');
  const last = JSON.parse(initial.trimEnd().split('\n').at(-1));
  if (sha(JSON.stringify(last)) !== p.developerSafety.carrierSha256 || !last.payload.content.some(x => x.text === safety)) throw Error('last_operator_carrier_missing');
  await save('ATTEMPT-START.json', { startedAt: new Date().toISOString(), maxV4Trials: 1, sessionId: p.sessionId });
  const args = ['-C', p.cwd, '-s', 'read-only', '-a', 'never', ...p.explicitDisabledFeatures.flatMap(f => ['--disable', f]), 'exec', 'resume', '--model', p.model, '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-c', 'model_reasoning_effort="low"', '-c', 'model_context_window=872000', '-c', 'model_auto_compact_token_limit=780000', '-c', 'project_doc_max_bytes=262144', '-c', 'web_search="disabled"', '-o', path.join(out, 'ANSWER.txt'), p.sessionId, '-'];
  const clean = environment(p.codexHome), start = Date.now();
  const stdout = fss.createWriteStream(path.join(out, 'EVENTS.jsonl'), { flags: 'wx', mode: 0o600 }), stderr = fss.createWriteStream(path.join(out, 'STDERR.txt'), { flags: 'wx', mode: 0o600 });
  const child = spawn('codex', args, { cwd: p.cwd, env: clean.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stdoutBytes = 0, stderrBytes = 0, stopReason = null, escalation;
  const stop = reason => { if (stopReason) return; stopReason = reason; try { process.kill(-child.pid, 'SIGTERM'); } catch {} escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); };
  const deadline = setTimeout(() => stop('deadline420s'), 420000);
  child.stdout.on('data', b => { stdoutBytes += b.length; if (stdoutBytes <= p.caps.stdoutMaxBytes) stdout.write(b); else stop('stdout_cap'); });
  child.stderr.on('data', b => { stderrBytes += b.length; if (stderrBytes <= p.caps.stderrMaxBytes) stderr.write(b); else stop('stderr_cap'); });
  child.stdin.on('error', () => {}); child.stdin.end(prompt);
  const exit = await new Promise(resolve => { child.once('error', e => resolve({ error: e.message })); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(deadline); clearTimeout(escalation);
  await Promise.all([new Promise(r => stdout.end(r)), new Promise(r => stderr.end(r))]);
  await save('PROCESS.json', { executable: 'codex', args, startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString(), elapsedMs: Date.now() - start, pid: child.pid, exit, stopReason, stdoutBytes, stderrBytes, strippedEnvironmentKeys: clean.strippedKeys, outerSandbox: false });
  await inspect();
  console.log('[MiniMainV4] ' + json({ sessionId: p.sessionId, exit, stopReason, elapsedMs: Date.now() - start }));
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
  const preparedOperator = JSON.parse(prefix.toString('utf8').trimEnd().split('\n').at(-1));
  const preparedOperatorVerified = sha(JSON.stringify(preparedOperator)) === p.developerSafety.carrierSha256;
  const nonceCommentaryProof = texts.filter(x => x.record.payload.role === 'assistant' && x.text.includes(p.developerSafety.visibilityNonce)).map(x => ({ timestamp: x.record.timestamp, channel: x.record.payload.channel, text: x.text }));
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
    actualTurnContexts: rows.filter(r => r.type === 'turn_context').map(r => ({ timestamp: r.timestamp, turnId: r.payload.turn_id, model: r.payload.model, effort: r.payload.effort, cwd: r.payload.cwd, sandboxPolicy: r.payload.sandbox_policy, permissionProfile: r.payload.permission_profile })),
    actualProjectInstructionCarriers: projectInstructions, actualAppendedAgentsCheckpoints: rows.filter(r => r.type === 'world_state' && Object.hasOwn(r.payload?.state || {}, 'agents_md')),
    actualAppendedCompactions: rows.filter(r => r.type === 'compacted' || r.payload?.type === 'context_compacted').map(r => ({ type: r.type, timestamp: r.timestamp, payloadType: r.payload?.type })),
    actualMcpToolCalls: events.filter(e => e.item?.type === 'mcp_tool_call').map(e => ({ server: e.item.server, tool: e.item.tool, status: e.item.status })),
    actualDeveloperSafetyCarriers: safetyCarriers, developerSafetyAppliedToRecordedContext: preparedOperatorVerified && nonceCommentaryProof.length > 0, preparedOperatorVerified, nonceCommentaryProof, retainedPayloadAudit,
    nativeCommands: events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => ({ command: e.item.command, exitCode: e.item.exit_code, status: e.item.status, outputChars: e.item.aggregated_output?.length })),
    frozenFixtureAgentsUnchanged: sha(await fs.readFile(path.join(p.cwd, 'AGENTS.md'))) === p.historicalAgents.sha256,
    actualUsage: rows.filter(r => r.type === 'token_usage_record').map(r => ({ timestamp: r.timestamp, usage: r.payload.usage })),
    answer: { chars: answer.length, sha256: sha(answer), available: !!answer },
    limitations: ['single genuine native attempt; if completed=false there is no final answer and this is not a ready DEV case', 'read-only historical replay, not native UI/production verification', 'original JSONL was not read again; independent retained prefix copied from verified v2 initial boundary', 'explicit operator carrier is verified last in prepared history; nonce commentary is the model-visibility proof', 'operator source/safety context is an explicit new experimental condition, not an exact historical runtime', 'worker own-prefix audit is separately labelled and was not injected into the model input'] };
  await save('CASE.json', result, 'w');
  await fs.writeFile(path.join(out, 'RESULT.md'), `# Main historical replay v4\n\nStatus: ${result.completed ? 'completed genuine native read-only Codex turn' : 'PARTIAL — deadline420s; no final answer; NOT a ready DEV case'}.\n\n- SID: \`${p.sessionId}\`\n- Turn: \`${result.turnId}\`\n- Rollout: \`${p.sessionFile}\`\n- Native preflight: ${result.nativePreflight.passed}; no outer sandbox.\n- Exit: ${JSON.stringify(processReceipt.exit)}; elapsed ${processReceipt.elapsedMs} ms.\n- Exact prompt: ${prompts.some(x => x.sha256 === p.prompt.sha256)}.\n- New AGENTS carriers: ${projectInstructions.length}; new compaction records: ${result.actualAppendedCompactions.length}; MCP calls: ${result.actualMcpToolCalls.length}.\n- Frozen AGENTS and retained prefix unchanged: ${result.frozenFixtureAgentsUnchanged && result.privatePrefixUnchanged}.\n\nExplicit operator developer carrier verified last before trial: ${preparedOperatorVerified}. Visibility nonce in model commentary: ${nonceCommentaryProof.length > 0}. The source/safety mapping is an explicit new experimental condition, not an expected answer. Independent worker audit remains separate from the model's actual tool results.\n\n[CASE.json](CASE.json) · [OWN-PREFIX-PAYLOAD-AUDIT.json](OWN-PREFIX-PAYLOAD-AUDIT.json) · [PROMPT.txt](PROMPT.txt) · [DEVELOPER-SAFETY.txt](DEVELOPER-SAFETY.txt) · [EVENTS.jsonl](EVENTS.jsonl) · [NATIVE-PREFLIGHT.json](NATIVE-PREFLIGHT.json)\n\nPrivate profile is retained for audit/authorized DEV seeding only if completed=true. It contains copied private authentication; do not publish it. V2/V3 namespaces and previous trials were not altered.\n`, { mode: 0o600 });
}
const action = process.argv[2];
({ prepare, preflight, run, inspect, repairPrepared }[action] || (() => { throw Error('usage: prepare|preflight|run|inspect|repairPrepared'); }))().catch(error => { console.error('[MiniMainV4] ' + error.stack); process.exitCode = 1; });

