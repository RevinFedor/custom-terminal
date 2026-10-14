import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { installTerminalMcp } from './install-terminal-mcp.mjs';
import { installClaudeTurnHook } from './install-claude-turn-hook.mjs';
const require = createRequire(import.meta.url);
const { createDiagnosticSanitizer, exportDiagnosticLog } = require('../src/main/diagnostic-log-export.js');

test('JSON credentials are removed with either message-text policy, preserving diagnostic IDs', () => {
  for (const includeMessageText of [false, true]) {
    const sanitizer = createDiagnosticSanitizer({ includeMessageText });
    const line = sanitizer.sanitizeLine(JSON.stringify({token:'fixture-opaque-token',apiKey:'fixture-key',
      Authorization:'Bearer fixture-auth',cookie:'session=fixture-cookie',password:987654321,refreshToken:false,sessionId:'fixture-session',tabId:'fixture-tab'}));
    for (const value of ['fixture-opaque-token','fixture-key','fixture-auth','fixture-cookie']) assert.ok(!line.includes(value));
    assert.ok(!line.includes('987654321')); assert.match(line, /\"refreshToken\":\"<redacted>\"/);
    assert.ok(line.includes('fixture-session')); assert.ok(line.includes('fixture-tab'));
  }
});
test('full export sanitizes JSON in problem report and selected log, with real filesystem publication', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-public-export-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const log = path.join(dir,'runtime.log'), destination = path.join(dir,'report.txt');
  await fs.writeFile(log,'10:00:01.000 date=2026-10-14 seq=1 [Fixture] {"token":"fixture-log-secret"}\n');
  const result = await exportDiagnosticLog({sourcePaths:[log],destinationPath:destination,
    fromMs:Date.parse('2026-10-14T10:00:00Z'),toMs:Date.parse('2026-10-14T10:01:00Z'),
    problemDescription:'{"apiKey":"fixture-report-secret"}',includeMessageText:true});
  assert.equal(result.selectedLines,1);
  const body=await fs.readFile(destination,'utf8');assert.ok(!body.includes('fixture-log-secret'));assert.ok(!body.includes('fixture-report-secret'));
});
test('installers preserve another MCP/hook and are idempotent in a new temporary user directory', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'noted-public-home-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'.claude'),{recursive:true});await fs.mkdir(path.join(dir,'.codex'),{recursive:true});
  await fs.writeFile(path.join(dir,'.claude.json'),JSON.stringify({mcpServers:{unrelated:{command:'fixture-other'}}}));
  await fs.writeFile(path.join(dir,'.codex/config.toml'),'[mcp_servers.unrelated]\ncommand = "fixture-other"\n');
  await fs.writeFile(path.join(dir,'.claude/settings.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'echo fixture-other'}]}]}}));
  await installTerminalMcp({home:dir});await installClaudeTurnHook({home:dir});
  const before=await fs.readFile(path.join(dir,'.claude.json'),'utf8');
  const hook=await fs.readFile(path.join(dir,'.claude/settings.json'),'utf8');
  assert.ok(before.includes('fixture-other'));assert.ok(hook.includes('fixture-other'));
  await installTerminalMcp({home:dir});await installClaudeTurnHook({home:dir});
  assert.equal(await fs.readFile(path.join(dir,'.claude.json'),'utf8'),before);
  assert.equal(await fs.readFile(path.join(dir,'.claude/settings.json'),'utf8'),hook);
  for(const name of ['agent-input-capture-protocol.js','noted-code-grab-v2.js'])assert.ok((await fs.stat(path.join(dir,'.claude/hooks',name))).isFile());
});
