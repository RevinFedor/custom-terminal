import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'statusline-bridge.sh');

async function runStatusline(home, input, configDir = '') {
  await mkdir(join(home, '.claude'), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`statusline exited ${code}: ${stderr}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('bridge keeps provider decimal context and distinguishes missing from zero', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'noted-statusline-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  await runStatusline(home, {
    session_id: 'session-decimal',
    transcript_path: '/tmp/session.jsonl',
    model: { display_name: 'Opus 5 (1M context)' },
    workspace: { current_dir: '/tmp' },
    context_window: { used_percentage: 0.7895 },
  });
  const decimal = JSON.parse(await readFile(
    join(home, '.claude', 'bridge', 'session-decimal.json'),
    'utf8',
  ));
  assert.equal(decimal.context_pct, 0.7895);

  await runStatusline(home, {
    session_id: 'session-unknown',
    transcript_path: '/tmp/session-unknown.jsonl',
    model: { display_name: 'Opus 5 (1M context)' },
    workspace: { current_dir: '/tmp' },
  });
  const unknown = JSON.parse(await readFile(
    join(home, '.claude', 'bridge', 'session-unknown.json'),
    'utf8',
  ));
  assert.equal(unknown.context_pct, null);
});

test('statusline writes the selected private bridge and never the default directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'noted-private-statusline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'private-config');
  await mkdir(config);
  await runStatusline(root, { session_id: 'private-session', transcript_path: join(config, 'projects/S.jsonl'),
    model: { display_name: 'fixture' }, workspace: { current_dir: '/fixture' } }, config);
  const bridge = JSON.parse(await readFile(join(config, 'bridge/private-session.json'), 'utf8'));
  assert.equal(bridge.session_id, 'private-session');
  await assert.rejects(readFile(join(root, '.claude/bridge/private-session.json')), error => error.code === 'ENOENT');
});
