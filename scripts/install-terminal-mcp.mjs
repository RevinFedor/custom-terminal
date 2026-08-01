#!/usr/bin/env node

import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ENV_VARS = [
  'NOTED_MAIN_PID',
  'NOTED_PARENT_PROJECT_ID',
  'NOTED_PARENT_TAB_ID',
];
const SOURCE_FILES = ['terminal-server.mjs', 'terminal-start-ai-request.mjs'];

function quoteToml(value) {
  return JSON.stringify(String(value));
}

function parseArgs(argv) {
  const result = { dryRun: false, home: homedir(), sourceDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') result.dryRun = true;
    else if (value === '--home') result.home = resolve(argv[++index]);
    else if (value === '--source') result.sourceDir = resolve(argv[++index]);
    else throw new Error('Unknown argument: ' + value);
  }
  return result;
}

export function updateCodexTerminalSection(source, serverPath) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const heading = '[mcp_servers.terminal]';
  let start = lines.findIndex((line) => line.trim() === heading);
  let end = lines.length;
  if (start >= 0) {
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
        end = index;
        break;
      }
    }
  } else {
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    if (lines.length) lines.push('');
    start = lines.length;
    end = start;
    lines.push(heading);
  }

  const section = lines.slice(start + 1, end);
  const unknown = section.filter((line) => !/^\s*(command|args|env_vars)\s*=/.test(line));
  while (unknown.length && !unknown.at(-1)?.trim()) unknown.pop();
  const replacement = [
    heading,
    `command = ${quoteToml('node')}`,
    `args = [${quoteToml(serverPath)}]`,
    `env_vars = [${REQUIRED_ENV_VARS.map(quoteToml).join(', ')}]`,
    ...unknown,
  ];
  lines.splice(start, end - start, ...replacement);
  return lines.join('\n').replace(/\n*$/, '\n');
}

export function updateClaudeConfig(source, serverPath) {
  const parsed = source.trim() ? JSON.parse(source) : {};
  const previous = parsed.mcpServers?.terminal;
  parsed.mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers
    : {};
  parsed.mcpServers.terminal = {
    ...(previous && typeof previous === 'object' ? previous : {}),
    type: 'stdio',
    command: 'node',
    args: [serverPath],
  };
  return JSON.stringify(parsed, null, 2) + '\n';
}

async function atomicWrite(filePath, content, { backup = true, mode = null } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  if (backup && existsSync(filePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(filePath, `${filePath}.bak-${stamp}`);
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, typeof content === 'string' ? 'utf8' : undefined);
    if (mode != null) await chmod(tempPath, mode);
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function readOptionalBuffer(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function installTerminalMcp(options = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sourceDir = options.sourceDir || resolve(scriptDir, '..', 'mcp');
  const home = options.home || homedir();
  const targetDir = join(home, '.claude', 'mcp');
  const serverPath = join(targetDir, 'terminal-server.mjs');
  const claudePath = join(home, '.claude.json');
  const codexPath = join(home, '.codex', 'config.toml');

  const runtimeChanges = [];
  for (const file of SOURCE_FILES) {
    const sourcePath = join(sourceDir, file);
    const targetPath = join(targetDir, file);
    if (!existsSync(sourcePath)) throw new Error('Missing MCP source: ' + sourcePath);
    const [contents, sourceStats, installed] = await Promise.all([
      readFile(sourcePath),
      stat(sourcePath),
      readOptionalBuffer(targetPath),
    ]);
    if (!installed || !contents.equals(installed)) {
      runtimeChanges.push({
        sourcePath,
        targetPath,
        contents,
        mode: sourceStats.mode & 0o777,
      });
    }
  }

  const claudeBefore = await readOptional(claudePath);
  const codexBefore = await readOptional(codexPath);
  const claudeAfter = updateClaudeConfig(claudeBefore, serverPath);
  const codexAfter = updateCodexTerminalSection(codexBefore, serverPath);
  const changed = {
    files: SOURCE_FILES.map((file) => join(targetDir, file)),
    runtime: runtimeChanges.length > 0,
    runtimeFiles: runtimeChanges.map((entry) => entry.targetPath),
    claude: claudeAfter !== claudeBefore,
    codex: codexAfter !== codexBefore,
  };

  if (!options.dryRun) {
    for (const entry of runtimeChanges) {
      await atomicWrite(entry.targetPath, entry.contents, { backup: false, mode: entry.mode });
    }
    if (changed.claude) await atomicWrite(claudePath, claudeAfter);
    if (changed.codex) await atomicWrite(codexPath, codexAfter);
  }

  return {
    ok: true,
    dryRun: options.dryRun === true,
    serverPath,
    changed,
    inheritedEnvVars: REQUIRED_ENV_VARS,
  };
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  installTerminalMcp(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch((error) => {
      process.stderr.write('[install-terminal-mcp] ' + (error?.message || error) + '\n');
      process.exitCode = 1;
    });
}
