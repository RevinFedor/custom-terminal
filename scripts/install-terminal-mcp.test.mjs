import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installTerminalMcp, updateClaudeConfig, updateCodexTerminalSection } from './install-terminal-mcp.mjs';

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'mcp');

test('Codex update preserves unrelated sections and installs inherited parent identity', () => {
  const before = '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.terminal]\ncommand = "old"\ncustom = true\n\n[features]\nflag = true\n';
  const after = updateCodexTerminalSection(before, '/tmp/terminal-server.mjs');
  assert.match(after, /\[mcp_servers\.other\][\s\S]*command = "other"/);
  assert.match(after, /env_vars = \["NOTED_MAIN_PID", "NOTED_PARENT_PROJECT_ID", "NOTED_PARENT_TAB_ID"\]/);
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

test('installer is idempotent in a clean HOME and copies both standalone files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'noted-terminal-mcp-home-'));
  try {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), '[features]\nkeep = true\n', 'utf8');
    const first = await installTerminalMcp({ home, sourceDir });
    assert.equal(first.ok, true);
    const second = await installTerminalMcp({ home, sourceDir, dryRun: true });
    assert.equal(second.changed.claude, false);
    assert.equal(second.changed.codex, false);
    assert.match(await readFile(join(home, '.claude', 'mcp', 'terminal-server.mjs'), 'utf8'), /MCP Terminal Server/);
    assert.match(await readFile(join(home, '.claude', 'mcp', 'terminal-start-ai-request.mjs'), 'utf8'), /buildStartAiRequest/);
    assert.match(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), /keep = true/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
