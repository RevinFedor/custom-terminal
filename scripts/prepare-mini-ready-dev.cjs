'use strict';
// Assemble actual completed Codex/Gemini evidence into a NEW isolated view-only
// DEV profile. Never replace the user's existing mini profile or any source.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const topic = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030');
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!['--generation', '--reviews-folder'].includes(flag) || !value || value.startsWith('--') || result[flag]) throw Error('invalid_arguments');
    result[flag] = value;
  }
  const generation = result['--generation'] || 'v2';
  if (!/^[a-z0-9-]+$/.test(generation)) throw Error('invalid_generation');
  return { generation, reviewsFolder: result['--reviews-folder'] ? path.resolve(result['--reviews-folder']) : path.join(topic, 'replay/reviews-readonly-v2') };
}
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const save = (file, value) => fs.writeFile(file, typeof value === 'string' ? value : json(value), { flag: 'wx', mode: 0o600 });
async function main() {
  const opts = options(process.argv.slice(2));
  const ready = path.join(topic, 'replay', 'ready-' + opts.generation);
  await fs.mkdir(ready, { recursive: true, mode: 0o700 });
  const profileFile = path.join(ready, 'PROFILE.json');
  const previous = await fs.readFile(profileFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous) {
    if (await fs.realpath(previous.root) !== previous.root) throw Error('existing_ready_profile_changed');
    console.log('[MiniReady] Existing prepared profile retained; no history, DB or draft replaced.'); return;
  }
  const latest = JSON.parse(await fs.readFile(path.join(opts.reviewsFolder, 'LATEST.json'), 'utf8'));
  if (latest.results.length !== 2 || latest.results.some(r => !r.apiReceivedAndReturned || r.rpcCount !== 2 || r.automaticSends !== 0)) throw Error('two_genuine_reviews_required');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-mini-dev-ready-')));
  for (const name of ['data', 'codex', 'claude', 'discovery', 'fixture', 'tmp']) await fs.mkdir(path.join(root, name), { mode: 0o700 });
  const cases = [];
  for (const [index, result] of latest.results.entries()) {
    const c = JSON.parse(await fs.readFile(result.caseFile, 'utf8'));
    const proof = JSON.parse(await fs.readFile(result.nativeProof, 'utf8'));
    if (!c.completed || c.sessionId !== result.sessionId || c.turnId !== result.turnId) throw Error('completed_case_identity_mismatch');
    const sourceRoot = await fs.realpath(c.root), sourceFile = await fs.realpath(c.sessionFile);
    if (!sourceFile.startsWith(sourceRoot + path.sep)) throw Error('foreign_native_source');
    const bytes = await fs.readFile(sourceFile);
    if (bytes.length > 32 * 1024 * 1024 || sha(bytes) !== proof.sha256) throw Error('completed_native_source_changed');
    const header = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString());
    if (header.type !== 'session_meta' || header.payload?.id !== c.sessionId) throw Error('completed_header_mismatch');
    const day = String(header.payload.timestamp || header.timestamp).slice(0, 10).split('-');
    const sessionDir = path.join(root, 'codex/sessions', ...day); await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const sessionFile = path.join(sessionDir, path.basename(sourceFile));
    await fs.writeFile(sessionFile, bytes, { flag: 'wx', mode: 0o600 });
    const tabId = (index === 0 ? 'mini-ready-main-' : 'mini-ready-ram-') + c.sessionId.slice(0, 8);
    const name = index === 0 ? 'Main · Rewind · результат' : 'Logs · RAM · результат';
    const archive = JSON.parse(await fs.readFile(result.archive, 'utf8'));
    const originTabId = archive.tabId; archive.tabId = tabId; archive.originTabId = originTabId;
    const archiveFile = path.join(ready, (index === 0 ? 'MAIN' : 'RAM') + '-ARCHIVE.json');
    require('../src/main/mini-orchestrator-archive').normalizeMiniReviewArchive(archive, tabId);
    await save(archiveFile, archive);
    cases.push({ tabId, name, sessionId: c.sessionId, sessionFile, cwd: c.cwd, archiveFile,
      initialSha256: proof.sha256, sourceCase: result.caseFile, actualGeminiResult: result, originTabId });
  }
  // No copy of user histories/config/MCP; login/model metadata are provisioned
  // by the existing human DEV command only if absent.
  const profile = { version: 2, root, presentationOnly: true, ...cases[0], cases };
  await save(path.join(root, 'codex/config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n'
    + 'model_context_window = 872000\nmodel_auto_compact_token_limit = 780000\nproject_doc_max_bytes = 262144\n'
    + 'approval_policy = "on-request"\nsandbox_mode = "read-only"\n\n[memories]\nuse_memories = false\n\n[features]\n'
    + ['apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'hooks', 'browser_use', 'computer_use', 'in_app_browser'].map(key => key + ' = false').join('\n') + '\n');
  await save(profileFile, profile); await save(path.join(root, 'REPLAY-OWNER.json'), profile);
  const candidatePrompt = path.join(opts.reviewsFolder, 'SYSTEM-PROMPT.json');
  const systemPromptFile = await fs.access(candidatePrompt).then(() => candidatePrompt).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return path.join(topic, 'replay/reviews-readonly-v2/SYSTEM-PROMPT.json');
  });
  const role = JSON.parse(await fs.readFile(systemPromptFile, 'utf8'));
  await new Promise((resolve, reject) => {
    const child = spawn(path.resolve(__dirname, '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      [path.join(__dirname, 'seed-mini-orchestrator-dev.cjs'), root], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NOTED_MINI_REPLAY_PROFILE: profileFile,
          NOTED_MINI_SYSTEM_PROMPT_SNAPSHOT: systemPromptFile, NOTED_MINI_REVIEW_PROMPT_FILE: role.filePaths[0] } });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('private_seed_failed:' + code)));
  });
  const oldManifest = path.join(topic, 'replay/main/REPLAY.json');
  const old = JSON.parse(await fs.readFile(oldManifest, 'utf8'));
  await save(path.join(ready, 'PREVIOUS-MAIN-MANIFEST.json'), old);
  const instruction = JSON.parse(await fs.readFile(path.join(latest.run, 'INSTRUCTION.json'), 'utf8'));
  const text = await fs.readFile(path.join(latest.run, 'INSTRUCTION.txt'), 'utf8');
  const manifest = { version: 2, case: 'two-completed-readonly-cases', status: 'prepared', clonePrepared: true,
    targetTabId: profile.tabId, targetSessionId: profile.sessionId, targetTabSeeded: true,
    sourceSessionId: old.sourceSessionId, sourceTabId: old.sourceTabId, presentationOnly: true,
    privateProfile: { root, tabId: profile.tabId, sessionId: profile.sessionId, sessionFile: profile.sessionFile, profileFile },
    offlineCopy: { verified: true, sourceUnchanged: true, actualCompletedNativeFiles: true },
    instruction: { ...instruction, file: path.join(latest.run, 'INSTRUCTION.txt'), sha256: sha(text) },
    systemPromptFile, cases: cases.map(({ tabId, name, sessionId }) => ({ tabId, name, sessionId })),
    previousProfileRetained: true, futureModelCallsOnLaunch: 0, GUIAcceptance: 'Fedor' };
  await fs.writeFile(oldManifest, json(manifest), { mode: 0o600 });
  await save(path.join(ready, 'PREPARATION.json'), { profileFile, manifest, actualResults: latest.results,
    preparedAt: new Date().toISOString(), appLaunched: false, originalMutations: 0 });
  console.log('[MiniReady] ' + json({ root, cases: manifest.cases, ready: true, appLaunched: false, automaticModelCalls: 0 }).trim());
}
main().catch(error => { console.error('[MiniReady] ' + error.message); process.exitCode = 1; });
