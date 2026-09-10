import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CLAUDE_TURN_HOOK_COMMAND,
  CLAUDE_TURN_HOOK_SPECS,
  installClaudeTurnHook,
} from './install-claude-turn-hook.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptsDir, '..');
const sourcePath = join(scriptsDir, 'claude-hooks', 'noted-turn-event.js');
const statuslineSourcePath = join(scriptsDir, 'statusline-bridge.sh');

async function runHookAgainstSocket(root, payload, { serverReadDelayMs = 0 } = {}) {
  const home = join(root, 'home');
  const discoveryDir = join(home, '.noted-terminal');
  const socketPath = join(root, 'hook.sock');
  const diagnosticPath = join(root, 'hook-diag.log');
  await mkdir(discoveryDir, { recursive: true });

  let resolveEnvelope;
  let rejectEnvelope;
  const envelopePromise = new Promise((resolvePromise, rejectPromise) => {
    resolveEnvelope = resolvePromise;
    rejectEnvelope = rejectPromise;
  });
  const server = net.createServer((socket) => {
    if (serverReadDelayMs) {
      socket.pause();
      setTimeout(() => socket.resume(), serverReadDelayMs);
    }
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        resolveEnvelope(JSON.parse(buffer.slice(0, newline)));
        socket.write('ok\n');
      } catch (error) {
        rejectEnvelope(error);
      }
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(socketPath, resolvePromise);
  });
  await writeFile(
    join(discoveryDir, `claude-hook-${process.pid}.json`),
    JSON.stringify({
      sock: socketPath,
      pid: process.pid,
      openProjectPaths: [projectDir],
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  const child = spawn(process.execPath, [sourcePath], {
    env: {
      ...process.env,
      HOME: home,
      NOTED_MAIN_PID: String(process.pid),
      NOTED_CLAUDE_HOOK_DIAG: diagnosticPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(payload));

  const exitPromise = new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  const timeout = new Promise((_, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error('hook execution timed out')), 2000).unref();
  });

  try {
    const [envelope, exit] = await Promise.race([
      Promise.all([envelopePromise, exitPromise]),
      timeout,
    ]);
    const diagnostic = await readFile(diagnosticPath, 'utf8');
    return { envelope, exit, stdout, stderr, diagnostic };
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

test('real hook forwards exact UserPromptSubmit prompt without logging it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noted-turn-hook-exec-'));
  try {
    const prompt = 'delegate exact nested task\nwith a second line';
    const result = await runHookAgainstSocket(root, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-exact',
      transcript_path: '/tmp/session-exact.jsonl',
      cwd: projectDir,
      prompt,
    });

    assert.equal(result.exit.code, 0);
    assert.equal(result.envelope.event, 'UserPromptSubmit');
    assert.equal(result.envelope.prompt, prompt);
    assert.equal(result.envelope.session_id, 'session-exact');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.diagnostic.includes(prompt), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const event of ['UserPromptSubmit', 'Stop']) test('large ' + event + ' survives socket backpressure beyond the old 250ms cutoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noted-turn-hook-backpressure-'));
  try {
    const prompt = 'Длинный первый запрос 🧩\n'.repeat(40000);
    const result = await runHookAgainstSocket(root, {
      hook_event_name: event,
      session_id: 'large-first-turn',
      cwd: projectDir,
      ...(event === 'UserPromptSubmit' ? { prompt } : { last_assistant_message: prompt }),
    }, { serverReadDelayMs: 400 });
    assert.equal(result.exit.code, 0);
    assert.equal(event === 'UserPromptSubmit' ? result.envelope.prompt : result.envelope.last_assistant_message, prompt);
    assert.match(result.diagnostic, /outcome=acked_/);
    assert.equal(result.diagnostic.includes('Длинный первый запрос'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real hook keeps old and non-prompt event envelopes compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noted-turn-hook-compat-'));
  try {
    const result = await runHookAgainstSocket(root, {
      hook_event_name: 'Stop',
      session_id: 'session-stop',
      cwd: projectDir,
      prompt: 'must not leave this event',
      last_assistant_message: 'done',
    });

    assert.equal(result.exit.code, 0);
    assert.equal(result.envelope.event, 'Stop');
    assert.equal(result.envelope.last_assistant_message, 'done');
    assert.equal(Object.hasOwn(result.envelope, 'prompt'), false);
    assert.equal(result.diagnostic.includes('must not leave this event'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real hook forwards exact tool identity and bounded result metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noted-turn-hook-tool-'));
  try {
    const result = await runHookAgainstSocket(root, {
      hook_event_name: 'PostToolUse',
      session_id: 'session-tool',
      cwd: projectDir,
      tool_name: 'Edit',
      tool_use_id: 'toolu_123',
      tool_input: { file_path: '/tmp/file.md' },
      tool_response: { structuredPatch: [{ oldStart: 1, lines: ['+new'] }] },
    });

    assert.equal(result.exit.code, 0);
    assert.equal(result.envelope.tool_use_id, 'toolu_123');
    assert.equal(result.envelope.tool_name, 'Edit');
    assert.deepEqual(result.envelope.tool_response, {
      structuredPatch: [{ oldStart: 1, lines: ['+new'] }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer mirrors repo hook, preserves settings, repairs drift, and is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'noted-turn-hook-home-'));
  try {
    await mkdir(join(home, '.claude', 'hooks'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
      theme: 'keep-me',
      hooks: {
        UserPromptSubmit: [{
          customGroupField: 'keep-group',
          hooks: [
            { type: 'command', command: 'node /old/noted-turn-event.js', timeout: 7 },
            { type: 'command', command: 'node /keep/other-hook.js' },
          ],
        }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'node /keep/session.js' }] }],
      },
      unknownTopLevel: { keep: true },
    }, null, 2) + '\n', 'utf8');

    const first = await installClaudeTurnHook({ home, sourcePath, statuslineSourcePath });
    assert.equal(first.changed.runtime, true);
    assert.equal(first.changed.statusline, true);
    assert.equal(first.changed.settings, true);
    const targetPath = join(home, '.claude', 'hooks', 'noted-turn-event.js');
    const statuslineTargetPath = join(home, '.claude', 'statusline-bridge.sh');
    assert.deepEqual(await readFile(targetPath), await readFile(sourcePath));
    assert.notEqual((await stat(targetPath)).mode & 0o111, 0);
    assert.deepEqual(await readFile(statuslineTargetPath), await readFile(statuslineSourcePath));
    assert.notEqual((await stat(statuslineTargetPath)).mode & 0o111, 0);

    const installedSettings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(installedSettings.theme, 'keep-me');
    assert.equal(installedSettings.unknownTopLevel.keep, true);
    assert.equal(installedSettings.hooks.SessionStart[0].hooks[0].command, 'node /keep/session.js');
    assert.equal(
      installedSettings.hooks.UserPromptSubmit[0].hooks.some((hook) => hook.command === 'node /keep/other-hook.js'),
      true,
    );
    for (const spec of CLAUDE_TURN_HOOK_SPECS) {
      const groups = installedSettings.hooks[spec.event] || [];
      const matching = groups.flatMap((group) => group.hooks || [])
        .filter((hook) => hook.command === CLAUDE_TURN_HOOK_COMMAND);
      assert.equal(matching.length, 1, `${spec.event} has one canonical hook`);
      const canonicalGroup = groups.find((group) => (group.hooks || []).includes(matching[0]));
      assert.equal(canonicalGroup.matcher || null, spec.matcher || null);
    }

    const filesBeforeRepeat = await Promise.all([
      readFile(targetPath),
      readFile(statuslineTargetPath),
      readFile(join(home, '.claude', 'settings.json')),
    ]);
    const backupsBeforeRepeat = (await readdir(join(home, '.claude')))
      .filter((name) => name.includes('.bak-')).length;
    const second = await installClaudeTurnHook({ home, sourcePath, statuslineSourcePath });
    assert.equal(second.changed.runtime, false);
    assert.equal(second.changed.statusline, false);
    assert.equal(second.changed.settings, false);
    assert.deepEqual(await Promise.all([
      readFile(targetPath),
      readFile(statuslineTargetPath),
      readFile(join(home, '.claude', 'settings.json')),
    ]), filesBeforeRepeat);
    assert.equal(
      (await readdir(join(home, '.claude'))).filter((name) => name.includes('.bak-')).length,
      backupsBeforeRepeat,
    );

    await writeFile(targetPath, 'stale runtime\n', 'utf8');
    await chmod(targetPath, 0o644);
    await writeFile(statuslineTargetPath, 'stale statusline\n', 'utf8');
    await chmod(statuslineTargetPath, 0o644);
    const repaired = await installClaudeTurnHook({ home, sourcePath, statuslineSourcePath });
    assert.equal(repaired.changed.runtime, true);
    assert.equal(repaired.changed.statusline, true);
    assert.deepEqual(await readFile(targetPath), await readFile(sourcePath));
    assert.notEqual((await stat(targetPath)).mode & 0o111, 0);
    assert.deepEqual(await readFile(statuslineTargetPath), await readFile(statuslineSourcePath));
    assert.notEqual((await stat(statuslineTargetPath)).mode & 0o111, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('canonical build install syncs the Claude turn hook before app replacement', async () => {
  const packageJson = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts?.['build:install'], 'node scripts/build-install-noted-terminal.mjs');
  const { PREPARE_SCRIPTS } = await import('./build-install-noted-terminal.mjs');
  assert.equal(PREPARE_SCRIPTS.filter(step => step === 'install:claude-hook').length, 1);
  assert.ok(PREPARE_SCRIPTS.indexOf('build') < PREPARE_SCRIPTS.indexOf('install:claude-hook'));
  const driver = await readFile(join(projectDir, 'scripts', 'build-install-noted-terminal.mjs'), 'utf8');
  assert.ok(driver.indexOf('for (const script of PREPARE_SCRIPTS)') < driver.indexOf("step = 'quit'"));
  assert.equal(
    packageJson.scripts?.['install:claude-hook'],
    'node scripts/install-claude-turn-hook.mjs',
  );
});
