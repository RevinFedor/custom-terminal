'use strict';
// Offline private SQLite/JSONL preparation, not an Electron app or model run.
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3'), Manager = require('../src/main/database');
const { GLOBAL_EXECUTION_NAMESPACE: NS } = require('../src/shared/workflow-organization.cjs');
const { resolveMiniOrchestratorInstruction } = require('../src/main/mini-orchestrator-runtime');
const folder = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/main');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
async function main() {
  const profileFile = path.join(folder, 'PROFILE.json'), manifestFile = path.join(folder, 'REPLAY.json');
  const p = JSON.parse(await fs.readFile(profileFile, 'utf8'));
  const m = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (await fs.realpath(p.root) !== p.root || !path.basename(p.root).startsWith('noted-mini-dev-')
    || !p.sessionFile.startsWith(p.root + path.sep) || p.sessionId !== m.targetSessionId) throw Error('private_owner_mismatch');
  for (const name of ['DEV-LOCK.json', 'FIRST-START.json']) {
    try { await fs.access(path.join(p.root, name)); throw Error('profile_already_used:' + name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const canonicalName = path.join(path.dirname(p.sessionFile), 'rollout-' + p.createdAt.slice(0, 19).replace(/:/g, '-') + '-' + p.sessionId + '.jsonl');
  if (sha(await fs.readFile(p.sessionFile)) !== p.initialSha256) throw Error('copy_changed_before_manual_launch');
  if (p.sessionFile !== canonicalName) { await fs.rename(p.sessionFile, canonicalName); p.sessionFile = canonicalName; }
  const connection = new Database(path.join(p.root, 'data/noted-terminal-dev.db'), { readonly: true, fileMustExist: true });
  const db = new Manager({ existingConnection: connection });
  const tab = db.getExecutionTabV2({ executionNamespace: NS, tabId: p.tabId });
  const role = db.getAIPrompts().find(prompt => prompt.id === 'mini-orchestrator-review');
  if (tab.row.codex_session_id !== p.sessionId || tab.row.cwd !== p.cwd || !role) throw Error('private_db_owner_or_role_mismatch');
  const resolved = await resolveMiniOrchestratorInstruction({ prompt: role,
    settings: { model: role.model, thinkingLevel: role.thinkingLevel }, includeFileMetadata: true });
  if (sha(resolved.text) !== m.instruction.sha256) throw Error('live_instruction_changed_prepare_new_snapshot');
  const receipt = { version: 1, preparedAt: new Date().toISOString(), kind: 'offline-private-profile',
    testTabId: p.tabId, testSessionId: p.sessionId, name: tab.row.name, cwd: p.cwd,
    sessionFile: p.sessionFile, profileRoot: p.root, beforeUserUuid: p.beforeUser.userUuid,
    selectedCompact: p.selectedCompact.compactEventIdentity,
    instruction: { promptId: role.id, model: role.model, thinkingLevel: role.thinkingLevel,
      resolvedSHA256: sha(resolved.text), chars: resolved.text.length, file: m.instruction.file, linkedFiles: resolved.linkedFiles },
    mainModel: { planned: 'current catalog Luna / low at first human launch', runtimeObserved: false },
    appLaunched: false, providerReceived: false, runtimeRequestAudit: null };
  db.close();
  await fs.writeFile(profileFile, json(p), { mode: 0o600 });
  await fs.writeFile(path.join(p.root, 'REPLAY-OWNER.json'), json(p), { mode: 0o600 });
  await fs.writeFile(manifestFile, json({ ...m, targetTabSeeded: true, privateProfile: { ...m.privateProfile, sessionFile: p.sessionFile } }), { mode: 0o600 });
  await fs.writeFile(path.join(folder, 'PRELAUNCH.json'), json(receipt), { mode: 0o600, flag: 'wx' });
  console.log('[MiniReplay] ' + json({ testTabId: p.tabId, testSessionId: p.sessionId, privateDbVerified: true,
    instructionSHA: receipt.instruction.resolvedSHA256, appLaunched: false, providerReceived: false }).trim());
}
main().catch(error => { console.error('[MiniReplay] finalize failed: ' + error.message); process.exitCode = 1; });
