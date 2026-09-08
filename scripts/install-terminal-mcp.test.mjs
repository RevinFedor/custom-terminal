import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installTerminalMcp, updateClaudeConfig, updateCodexTerminalSection } from './install-terminal-mcp.mjs';

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'mcp');
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = ['terminal-server.mjs', 'terminal-start-ai-request.mjs', 'terminal-prompt-catalog.mjs'];

test('Codex update preserves unrelated sections and installs inherited instance routing', () => {
  const before = '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.terminal]\ncommand = "old"\ncustom = true\n\n[features]\nflag = true\n';
  const after = updateCodexTerminalSection(before, '/tmp/terminal-server.mjs');
  assert.match(after, /\[mcp_servers\.other\][\s\S]*command = "other"/);
  assert.match(after, /env_vars = \["NOTED_MAIN_PID", "NOTED_PARENT_PROJECT_ID", "NOTED_PARENT_TAB_ID", "NOTED_DISCOVERY_DIR"\]/);
  assert.match(after, /custom = true/);
  assert.match(after, /\[features\]\nflag = true/);
});

test('Claude update preserves other MCP servers and terminal-specific unknown fields', () => {
  const before = JSON.stringify({ mcpServers: { other: { command: 'other' }, terminal: { disabled: false } }, setting: 1 });
  const after = JSON.parse(updateClaudeConfig(before, '/tmp/terminal-server.mjs'));
  assert.equal(after.mcpServers.other.command, 'other');
  assert.equal(after.mcpServers.terminal.disabled, false);
  assert.deepEqual(after.mcpServers.terminal.args, ['/tmp/terminal-server.mjs']);
  assert.equal(after.setting, 1);
});

test('canonical build install syncs Terminal MCP after packaging and before replacing or launching the app', async () => {
  const packageJson = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts?.['build:install'], 'node scripts/build-install-noted-terminal.mjs');
  const { PREPARE_SCRIPTS } = await import('./build-install-noted-terminal.mjs');
  assert.equal(PREPARE_SCRIPTS.filter(step => step === 'install:terminal-mcp').length, 1);
  assert.ok(PREPARE_SCRIPTS.indexOf('build') < PREPARE_SCRIPTS.indexOf('install:terminal-mcp'));
  assert.match(packageJson.scripts.build, /electron-builder.*sign:local-fast/);
  const driver = await readFile(join(projectDir, 'scripts', 'build-install-noted-terminal.mjs'), 'utf8');
  assert.ok(driver.indexOf('for (const script of PREPARE_SCRIPTS)') < driver.indexOf("step = 'quit'"));
  assert.ok(driver.indexOf("step = 'quit'") < driver.indexOf('await fileSystem.rename(stagedApp, installedApp)'));
  assert.doesNotMatch(driver, /rm -rf/);
  assert.equal(packageJson.scripts?.['build:i'], 'npm run build:install');

  const observer = await readFile(join(projectDir, 'scripts', 'build-when-idle.js'), 'utf8');
  assert.match(observer, /spawn\('npm', \['run', 'build:install'\]/);
});

test('installer atomically mirrors repo bytes, preserves config, and is idempotent in a temp HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'noted-terminal-mcp-home-'));
  try {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        other: { command: 'keep-other' },
        terminal: { disabled: false, custom: 'keep-terminal' },
      },
      setting: { keep: true },
    }), 'utf8');
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.other]\ncommand = "keep-other"\n\n[mcp_servers.terminal]\ncommand = "old"\ncustom = true\n\n[features]\nkeep = true\n',
      'utf8',
    );

    const first = await installTerminalMcp({ home, sourceDir });
    assert.equal(first.ok, true);
    assert.equal(first.changed.runtime, true);

    for (const file of runtimeFiles) {
      assert.deepEqual(
        await readFile(join(home, '.claude', 'mcp', file)),
        await readFile(join(sourceDir, file)),
      );
    }

    const claudeInstalled = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    assert.equal(claudeInstalled.mcpServers.other.command, 'keep-other');
    assert.equal(claudeInstalled.mcpServers.terminal.disabled, false);
    assert.equal(claudeInstalled.mcpServers.terminal.custom, 'keep-terminal');
    assert.equal(claudeInstalled.setting.keep, true);
    const codexInstalled = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(codexInstalled, /\[mcp_servers\.other\]\ncommand = "keep-other"/);
    assert.match(codexInstalled, /custom = true/);
    assert.match(codexInstalled, /\[features\]\nkeep = true/);

    const beforeRepeat = await Promise.all([
      readFile(join(home, '.claude.json')),
      readFile(join(home, '.codex', 'config.toml')),
      ...runtimeFiles.map((file) => readFile(join(home, '.claude', 'mcp', file))),
    ]);
    const backupsBefore = (await readdir(home)).filter((name) => name.includes('.bak-')).length
      + (await readdir(join(home, '.codex'))).filter((name) => name.includes('.bak-')).length;

    const second = await installTerminalMcp({ home, sourceDir });
    assert.equal(second.changed.runtime, false);
    assert.equal(second.changed.claude, false);
    assert.equal(second.changed.codex, false);
    const afterRepeat = await Promise.all([
      readFile(join(home, '.claude.json')),
      readFile(join(home, '.codex', 'config.toml')),
      ...runtimeFiles.map((file) => readFile(join(home, '.claude', 'mcp', file))),
    ]);
    assert.deepEqual(afterRepeat, beforeRepeat);
    const backupsAfter = (await readdir(home)).filter((name) => name.includes('.bak-')).length
      + (await readdir(join(home, '.codex'))).filter((name) => name.includes('.bak-')).length;
    assert.equal(backupsAfter, backupsBefore);
    assert.equal((await readdir(join(home, '.claude', 'mcp'))).some((name) => name.includes('.tmp-')), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
