#!/usr/bin/env node

import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_TURN_HOOK_COMMAND = 'node ~/.claude/hooks/noted-turn-event.js';
export const CLAUDE_TURN_HOOK_SPECS = Object.freeze([
  Object.freeze({ event: 'UserPromptSubmit', matcher: null }),
  Object.freeze({ event: 'Stop', matcher: null }),
  Object.freeze({ event: 'StopFailure', matcher: null }),
  // All tools feed the same local ownership socket. AskUserQuestion keeps its
  // dedicated UI handling in main, while Edit/Read/Bash/etc. provide exact
  // tool_use_id brackets so clipped TUI bodies can never become assistant
  // streaming text after their visual root scrolls away.
  Object.freeze({ event: 'PreToolUse', matcher: null }),
  Object.freeze({ event: 'PostToolUse', matcher: null }),
  Object.freeze({ event: 'PostToolUseFailure', matcher: null }),
]);

function parseArgs(argv) {
  const result = { dryRun: false, home: homedir(), sourcePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') result.dryRun = true;
    else if (value === '--home') result.home = resolve(argv[++index]);
    else if (value === '--source') result.sourcePath = resolve(argv[++index]);
    else throw new Error('Unknown argument: ' + value);
  }
  return result;
}

function isManagedTurnHook(hook) {
  return hook
    && typeof hook === 'object'
    && typeof hook.command === 'string'
    && hook.command.includes('noted-turn-event.js');
}

function normalizeEventHooks(groups, spec) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  const retained = [];
  let managedHookTemplate = null;
  let managedGroupTemplate = null;

  for (const rawGroup of sourceGroups) {
    if (!rawGroup || typeof rawGroup !== 'object' || !Array.isArray(rawGroup.hooks)) {
      retained.push(rawGroup);
      continue;
    }
    const managed = rawGroup.hooks.filter(isManagedTurnHook);
    if (managed.length === 0) {
      retained.push(rawGroup);
      continue;
    }
    if (!managedHookTemplate) managedHookTemplate = { ...managed[0] };
    const otherHooks = rawGroup.hooks.filter((hook) => !isManagedTurnHook(hook));
    if (otherHooks.length > 0) {
      retained.push({ ...rawGroup, hooks: otherHooks });
    } else if (!managedGroupTemplate) {
      managedGroupTemplate = { ...rawGroup };
      delete managedGroupTemplate.hooks;
    }
  }

  const canonicalHook = {
    ...(managedHookTemplate || {}),
    type: 'command',
    command: CLAUDE_TURN_HOOK_COMMAND,
  };
  const canonicalGroup = { ...(managedGroupTemplate || {}) };
  delete canonicalGroup.hooks;
  delete canonicalGroup.matcher;
  if (spec.matcher) canonicalGroup.matcher = spec.matcher;
  canonicalGroup.hooks = [canonicalHook];
  retained.push(canonicalGroup);
  return retained;
}

export function updateClaudeTurnHookSettings(source) {
  const parsed = String(source || '').trim() ? JSON.parse(source) : {};
  parsed.hooks = parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
    ? parsed.hooks
    : {};
  for (const spec of CLAUDE_TURN_HOOK_SPECS) {
    parsed.hooks[spec.event] = normalizeEventHooks(parsed.hooks[spec.event], spec);
  }
  return JSON.stringify(parsed, null, 2) + '\n';
}

async function readOptional(filePath, encoding = null) {
  try {
    return await readFile(filePath, encoding || undefined);
  } catch (error) {
    if (error?.code === 'ENOENT') return encoding ? '' : null;
    throw error;
  }
}

async function atomicWrite(filePath, contents, { backup = false, mode = null } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  if (backup && existsSync(filePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(filePath, filePath + '.bak-' + stamp);
  }
  const temporaryPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    await writeFile(
      temporaryPath,
      contents,
      typeof contents === 'string' ? 'utf8' : undefined,
    );
    if (mode != null) await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function installClaudeTurnHook(options = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sourcePath = options.sourcePath
    || resolve(scriptDir, 'claude-hooks', 'noted-turn-event.js');
  const home = options.home || homedir();
  const targetPath = join(home, '.claude', 'hooks', 'noted-turn-event.js');
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(sourcePath)) throw new Error('Missing Claude hook source: ' + sourcePath);

  const [sourceBytes, targetBytes, targetStat, settingsBefore] = await Promise.all([
    readFile(sourcePath),
    readOptional(targetPath),
    stat(targetPath).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }),
    readOptional(settingsPath, 'utf8'),
  ]);
  const settingsAfter = updateClaudeTurnHookSettings(settingsBefore);
  const runtimeChanged = !targetBytes
    || !sourceBytes.equals(targetBytes)
    || !targetStat
    || (targetStat.mode & 0o111) === 0;
  const settingsChanged = settingsAfter !== settingsBefore;

  if (!options.dryRun) {
    if (runtimeChanged) {
      await atomicWrite(targetPath, sourceBytes, { mode: 0o755 });
    }
    if (settingsChanged) {
      await atomicWrite(settingsPath, settingsAfter, { backup: true, mode: 0o600 });
    }
  }

  return {
    ok: true,
    dryRun: options.dryRun === true,
    sourcePath,
    targetPath,
    settingsPath,
    changed: {
      runtime: runtimeChanged,
      settings: settingsChanged,
    },
  };
}

const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  installClaudeTurnHook(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch((error) => {
      process.stderr.write('[install-claude-turn-hook] '
        + (error?.message || error)
        + '\n');
      process.exitCode = 1;
    });
}
