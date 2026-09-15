#!/usr/bin/env node
// Read-only source corpus for the user-requested paired architecture review.
// No app, provider, credentials, profiles, production data or test processes.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const followup = process.argv.includes('--followup');
const settings = process.argv.includes('--settings');
const names = new Set([
  'src/main/main.js', 'src/main/web-server.js', 'src/main/agent-ready-wait.js',
  'src/main/project-api-runtime-contract.js', 'src/main/ai-process-liveness.js',
  'src/main/ai-lifecycle-authority.js', 'src/main/pty-input-ownership.js',
  'src/main/agent-input-compare-and-swap.js', 'src/main/agent-settings-activity.js',
  'src/main/ipc/codex-data.js', 'src/renderer/App.tsx',
  'src/renderer/store/useUIStore.ts', 'src/renderer/store/useWorkspaceStore.ts',
  'src/renderer/components/UI/SettingsModal.tsx',
  'src/renderer/components/Workspace/ClaudeControlBar.tsx',
  'src/renderer/components/Workspace/useAgentLifecycle.ts',
  'src/renderer/components/Workspace/agentLifecycleSummary.ts',
  'src/renderer/utils/sessionStartingState.mjs', 'src/renderer/utils/agentScenarios.ts',
  'src/renderer/utils/historyAgentRuntimes.ts', 'src/renderer/utils/agentActionCoordinator.mjs',
  'src/renderer/utils/agentSendFlow.mjs', 'src/renderer/utils/agentSendPreparation.ts',
  'src/renderer/utils/agentSendAdapter.ts', 'src/renderer/utils/agentSendSequencer.mjs',
  'src/renderer/utils/agentSendSettingsContract.ts',
  'package.json', 'package-lock.json',
]);
// Full Codex adapter/contract siblings, not selected line ranges. Tests and
// author incident reports are not first-round hints; local auditor retains
// read access to the repository and must disclose any extra evidence used.
for (const folder of ['src/main', 'src/shared', 'src/renderer/utils']) {
  for (const name of await fs.readdir(path.join(root, folder))) {
    if (/^codex[-A-Z]/.test(name) && /\.(js|cjs|mjs|ts|json)$/.test(name)
      && !/\.(test|spec)\./.test(name)) names.add(folder + '/' + name);
  }
}
if (followup || settings) {
  // A second-phase audit may see incidents, the other review and executed
  // regressions. Never mutate or reuse the first blind corpus as a newer one.
  for (const name of [
    'CLAUDE.md', 'src/main/terminal-history-preview.js',
    'src/renderer/utils/agentSettingsPresentation.mjs',
    'src/main/orchestration-runs.js', 'src/main/orchestration-result-proof.js',
    'src/main/orchestration-source-context.js', 'src/main/orchestration-source-context.test.js',
    'src/main/tab-work-context.js', 'src/main/tab-work-context.test.js',
    'src/main/subagent-transcript.js', 'src/main/structured-authoring.js',
    'src/main/structured-send-route.test.js', 'src/main/structured-authoring.test.js',
    'src/main/conversation-owner.boundaries.test.js', 'src/main/claude-send-target-boundary.integration.test.js',
    'src/main/codex-readiness-observation.test.js', 'src/main/codex-settings-observation.test.js',
    'src/main/codex-settings-native-current.test.js',
    'src/main/agent-send-startup-reconcile.js', 'src/main/terminal-history-preview-controller.js',
    'src/main/compact-operation-state.js', 'src/renderer/hooks/useAgentSettingsActivity.ts',
    'src/main/agent-current-params.js', 'src/main/agent-current-params.test.js',
    'src/main/agent-params-operations.js', 'src/main/agent-params-service.js',
    'src/main/claude-settings-outcome.js', 'src/shared/claude-startup-failure.cjs',
    'src/main/diagnostic-log-export.js',
    'src/main/history-authoring-projection.js', 'src/shared/prompt-origin.cjs', 'src/shared/prompt-origin.mjs',
    'src/renderer/utils/tabWorkContext.ts', 'src/renderer/utils/historyPromptHandoffs.ts',
    'src/main/agent-send-receipt-registry.js', 'src/main/agent-send-receipt-store.js',
    'src/main/agent-send-target-precondition.js', 'src/main/agent-prompt-audit-identity.js',
    'src/main/prompt-audit-fingerprint.js', 'src/main/history-prompt-presentations.js',
    'src/main/orchestration-runs.test.js', 'src/main/codex-runtime-policies.test.js',
    'src/main/codex-runtime-contract.test.js', 'src/main/codex-service-tier-proof-wiring.test.js',
    'src/main/codex-service-tier-current-frame-race.test.js',
    'src/main/codex-fast-intent.test.js', 'src/main/codex-fast-intent.wiring.test.js',
    'src/main/codex-settings-send.integration.test.js', 'src/main/codex-settings-send.audit.test.js',
    'src/shared/agent-send-target-precondition.cjs', 'src/shared/agent-local-command.cjs',
    'src/shared/history-action-grammar.cjs', 'src/shared/composer-chips.mjs',
    'src/shared/prompt-image-attachments.mjs',
    'scripts/codex-policy-review-probes.cjs', 'scripts/codex-policy-pro-review-probes.cjs',
    'scripts/codex-runtime-query-coherence-probe.cjs',
    'docs/tmp/codex-resume-usage-policy-2026-09-14.md',
    'docs/tmp/codex-policy-max-answer-2026-09-14.md',
    'docs/tmp/codex-policy-pro-answer-2026-09-14.md',
    'docs/tmp/codex-policy-pro-activity-2026-09-14.json',
    'docs/tmp/codex-policy-max-exact-model-2026-09-14.json',
    'docs/tmp/codex-policy-accepted-retry-pro-answer-2026-09-15.md',
    'docs/tmp/codex-c1-final-pro-answer-2026-09-15.md',
    'docs/tmp/codex-fast-late-ack-retake-2026-09-15.json',
    'docs/tmp/codex-r1-final-followup-pro-answer-2026-09-15.md',
    'docs/tmp/codex-fast-current-frame-retake-2026-09-15.json',
    'docs/tmp/claude-settings-source-retake-2026-09-15.json',
  ]) names.add(name);
}
if (settings) {
  const previous = JSON.parse(await fs.readFile(path.join(root, 'docs/tmp/claude-astra-round3-request-2026-09-14.json'), 'utf8'));
  // Reuse only the earlier repository-code corpus. External incident storage
  // or private stand supplements are not copied by this source-only script.
  for (const item of previous.request.files) {
    if (item.path.startsWith(root + '/')) names.add(path.relative(root, item.path));
  }
  const retake = JSON.parse(await fs.readFile(path.join(root, 'docs/tmp/claude-settings-source-retake-2026-09-15.json'), 'utf8'));
  for (const name of retake.suites) names.add(name);
  for (const name of ['src/main/claude-setting-evidence.js', 'src/main/claude-setting-observation.js',
    'src/main/claude-thinking-proof.js', 'src/main/claude-thinking-picker-state.js',
    'src/main/database.js', 'src/main/agent-context-usage-state.js',
    'src/main/agent-context-usage-state.test.js', 'src/main/agent-context-usage-wiring.test.js',
    'src/main/agent-params-operations.test.js', 'src/main/agent-params-service.test.js',
    'src/renderer/hooks/usePromptQueueRunner.ts',
    'src/renderer/utils/claudeSettingsQueue.test.mjs',
    'docs/tmp/claude-remaining-max-answer-2026-09-15.md',
    'docs/tmp/claude-proof-params-final-pro-answer-2026-09-15.md',
    'docs/tmp/claude-f1-f8-final-followup-pro-answer-2026-09-15.md',
    'docs/tmp/claude-f2-f3-f7-retake-2026-09-15.json',
    'docs/tmp/claude-f2-f3-f7-final-pro-answer-2026-09-15.md',
    'docs/tmp/claude-f2-f3-final-retake-2-2026-09-15.json',
    'docs/tmp/claude-causal-retry-final-pro-answer-2026-09-15.md',
    'docs/tmp/claude-final-causal-retake-3-2026-09-15.json',
    'docs/tmp/claude-source-pass-review-pro-answer-2026-09-15.md',
    'docs/tmp/claude-source-pass-retake-4-2026-09-15.json',
    'docs/tmp/claude-final-emission-pro-answer-2026-09-15.md',
    'docs/tmp/claude-immutable-retry-identity-retake-2026-09-15.json']) names.add(name);
}
const hashes = {}, files = [];
for (const name of names) await fs.access(path.join(root, name));
const lease = await fs.mkdtemp('/private/tmp/noted-codex-policy-review-');
let bytes = 0;
for (const name of [...names].sort()) {
  const from = path.join(root, name), to = path.join(lease, 'source', name);
  const data = await fs.readFile(from);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, data, { flag: 'wx', mode: 0o444 });
  hashes[name] = crypto.createHash('sha256').update(data).digest('hex');
  bytes += data.length;
  files.push({ path: to, name });
}
// A mutation during copying must be visible, not a falsely atomic snapshot.
for (const [name, expected] of Object.entries(hashes)) {
  const data = await fs.readFile(path.join(root, name));
  if (crypto.createHash('sha256').update(data).digest('hex') !== expected) {
    throw new Error('source changed during snapshot: ' + name + '; preserve this rejected lease, prepare a new one');
  }
}
const manifest = { createdAt: new Date().toISOString(), phase: settings ? 'main-settings-followup' : followup ? 'post-fix-followup' : 'blind-first', lease, sourceRoot: root,
  corpusRoot: path.join(lease, 'source'), count: files.length, bytes, hashes,
  notFrozen: ['node_modules', 'OS/CLI/provider', 'auditor harness/system prompts', 'any extra repository files read by local auditor'] };
await fs.writeFile(path.join(lease, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o444 });
await fs.writeFile(path.join(lease, 'files.json'), JSON.stringify(files, null, 2), { flag: 'wx', mode: 0o444 });
console.log(JSON.stringify({ lease, count: files.length, bytes, manifest: path.join(lease, 'manifest.json'), files: path.join(lease, 'files.json') }));
