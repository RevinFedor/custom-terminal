const { ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { callGeminiApi } = require('./docs');
const { buildChildProcessEnv } = require('../child-process-env');

const GIT_TIMEOUT_MS = 90 * 1000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_PROMPT_DIFF_CHARS = 240 * 1024;
const MAX_UNTRACKED_FILE_CHARS = 48 * 1024;
const MAX_PREVIEW_DIFF_CHARS = 320 * 1024;
const GIT_COMMIT_PROMPT_ID = 'git-commit';
const DEFAULT_GIT_COMMIT_SYSTEM_PROMPT = 'You write concise Git commit messages for local commits.\nReturn only JSON with keys "summary" and "description".\n\nRules:\n- The summary must be one line, imperative mood when possible, no trailing period, under 72 characters.\n- The description may be empty. If non-empty, use 1-4 short lines with concrete facts.\n- Do not mention files that are not present in the provided changes.\n- If docs/ changed, base the commit message on changed docs files only when the prompt data says docs-only context was applied.\n- If docs/ did not change, use all included changes.';
const GIT_STATUS_WATCH_DEBOUNCE_MS = 300;
const gitStatusWatchers = new Map();
const activeGitOperations = new Map();
let activeGitOperationSeq = 0;

function startGitOperation(status, root) {
  const id = `git:${Date.now()}:${++activeGitOperationSeq}`;
  const repoName = root ? path.basename(root) : 'Git';
  activeGitOperations.set(id, {
    tabId: id,
    kind: 'git',
    status,
    project: repoName,
    name: `Git ${status}`,
    cwd: root || null,
    command: status,
    startedAt: Date.now(),
  });
  return () => activeGitOperations.delete(id);
}

function getActiveOperations() {
  return Array.from(activeGitOperations.values());
}

function safeProjectPath(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Project path is required');
  }
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) throw new Error('Project path does not exist');
  return resolved;
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: options.timeout || GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || GIT_MAX_BUFFER,
      env: buildChildProcessEnv({ GIT_TERMINAL_PROMPT: '0' }),
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        return resolve({
          success: false,
          code: typeof error.code === 'number' ? error.code : null,
          error: error.message,
          stdout,
          stderr,
        });
      }
      resolve({ success: true, code: 0, stdout, stderr });
    });
  });
}

async function getRepoRoot(projectPath, options = {}) {
  const cwd = safeProjectPath(projectPath);
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], options);
  if (!result.success) return null;
  return result.stdout.trim();
}

function parseBranchLine(line) {
  const raw = String(line || '').replace(/^##\s*/, '').trim();
  const metaMatch = raw.match(/\[(.+)\]$/);
  const meta = metaMatch ? metaMatch[1] : '';
  const withoutMeta = meta ? raw.slice(0, raw.length - meta.length - 2).trim() : raw;
  const [namePart, upstreamPart] = withoutMeta.split('...');
  let branch = (namePart || '').trim();
  if (branch.startsWith('No commits yet on ')) branch = branch.replace('No commits yet on ', '').trim();
  if (!branch || branch === 'HEAD (no branch)') branch = 'HEAD';
  const aheadMatch = meta.match(/ahead\s+(\d+)/i);
  const behindMatch = meta.match(/behind\s+(\d+)/i);
  return {
    branch,
    upstream: upstreamPart ? upstreamPart.trim() : '',
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function fileStatusLabel(xy) {
  if (xy === '??') return 'Untracked';
  if (xy.includes('U')) return 'Conflict';
  if (xy.includes('A')) return 'Added';
  if (xy.includes('D')) return 'Deleted';
  if (xy.includes('R')) return 'Renamed';
  if (xy.includes('C')) return 'Copied';
  if (xy.includes('M')) return 'Modified';
  return 'Changed';
}

function fileStatusFromNameStatus(code) {
  const raw = String(code || '').trim();
  if (raw.startsWith('A')) return 'A ';
  if (raw.startsWith('D')) return 'D ';
  if (raw.startsWith('R')) return 'R ';
  if (raw.startsWith('C')) return 'C ';
  if (raw.startsWith('U')) return 'UU';
  return 'M ';
}

function parseStatus(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const branchInfo = parseBranchLine(lines[0] || '');
  const files = [];
  for (const line of lines.slice(1)) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rawPath = line.slice(3);
    const arrow = rawPath.includes(' -> ');
    const displayPath = arrow ? rawPath.split(' -> ').pop() : rawPath;
    const oldPath = arrow ? rawPath.split(' -> ')[0] : null;
    files.push({
      path: displayPath,
      oldPath,
      rawPath,
      xy,
      staged: xy[0] !== ' ' && xy[0] !== '?',
      unstaged: xy[1] !== ' ' || xy === '??',
      label: fileStatusLabel(xy),
    });
  }
  return { ...branchInfo, files };
}

function isDocsPath(filePath) {
  return filePath === 'docs' || filePath.startsWith('docs/');
}

function uniqueNonEmptyStrings(items) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeSelectedChangedPaths(status, selectedPaths) {
  const files = Array.isArray(status?.files) ? status.files : [];
  const allowed = new Set(files.map((file) => file.path));
  const selected = Array.isArray(selectedPaths) && selectedPaths.length
    ? uniqueNonEmptyStrings(selectedPaths)
    : files.map((file) => file.path);
  const paths = [];
  const invalid = [];
  for (const filePath of selected) {
    if (allowed.has(filePath)) paths.push(filePath);
    else invalid.push(filePath);
  }
  return { paths, invalid };
}

function staleSelectionError(invalidPaths) {
  const preview = invalidPaths.slice(0, 3).join(', ');
  const suffix = invalidPaths.length > 3 ? ` and ${invalidPaths.length - 3} more` : '';
  return `Selected files changed. Refresh Changes and select files again${preview ? `: ${preview}${suffix}` : ''}`;
}

function trimText(text, maxChars) {
  if (!text || text.length <= maxChars) return { text: text || '', truncated: false };
  const head = text.slice(0, maxChars);
  return {
    text: head + '\n\n[TRUNCATED: diff was longer than ' + maxChars + ' characters]\n',
    truncated: true,
  };
}

async function getStatusForRoot(root) {
  const [statusResult, remoteResult, userNameResult, userEmailResult, credentialHelperResult, merge] = await Promise.all([
    runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-b']),
    runGit(root, ['config', '--get', 'remote.origin.url']),
    runGit(root, ['config', '--get', 'user.name']),
    runGit(root, ['config', '--get', 'user.email']),
    runGit(root, ['config', '--get', 'credential.helper']),
    getMergeState(root),
  ]);
  if (!statusResult.success) throw new Error(statusResult.stderr || statusResult.error || 'git status failed');
  const parsed = parseStatus(statusResult.stdout);
  const remote = remoteResult.success ? remoteResult.stdout.trim() : '';
  const repoName = path.basename(root);
  return {
    isRepo: true,
    repoRoot: root,
    repoName,
    remote,
    remoteInfo: parseRemoteInfo(remote),
    userName: userNameResult.success ? userNameResult.stdout.trim() : '',
    userEmail: userEmailResult.success ? userEmailResult.stdout.trim() : '',
    credentialHelper: credentialHelperResult.success ? credentialHelperResult.stdout.trim() : '',
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files: parsed.files,
    changedCount: parsed.files.length,
    hasDocsChanges: parsed.files.some((file) => isDocsPath(file.path)),
    merge,
  };
}

async function readUntrackedFile(root, relPath) {
  const abs = path.join(root, relPath);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) return '';
  if (stat.size > 2 * 1024 * 1024) {
    return '--- UNTRACKED FILE: ' + relPath + ' ---\n[Skipped: file is larger than 2MB]\n';
  }
  const buf = await fs.promises.readFile(abs);
  if (buf.includes(0)) {
    return '--- UNTRACKED FILE: ' + relPath + ' ---\n[Skipped: binary file]\n';
  }
  const raw = buf.toString('utf8');
  const limited = trimText(raw, MAX_UNTRACKED_FILE_CHARS);
  return [
    '--- UNTRACKED FILE: ' + relPath + ' ---',
    limited.text,
    limited.truncated ? '[TRUNCATED UNTRACKED FILE]' : '',
  ].filter(Boolean).join('\n') + '\n';
}

async function buildUntrackedPreviewDiff(root, relPath) {
  const abs = path.join(root, relPath);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) return '';
  if (stat.size > 2 * 1024 * 1024) {
    return [
      'diff --git a/' + relPath + ' b/' + relPath,
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/' + relPath,
      '[Skipped: file is larger than 2MB]',
    ].join('\n') + '\n';
  }
  const buf = await fs.promises.readFile(abs);
  if (buf.includes(0)) {
    return [
      'diff --git a/' + relPath + ' b/' + relPath,
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/' + relPath,
      '[Skipped: binary file]',
    ].join('\n') + '\n';
  }
  const raw = buf.toString('utf8');
  const limited = trimText(raw, MAX_PREVIEW_DIFF_CHARS);
  const lines = limited.text.split(/\r?\n/);
  const body = lines.map((line) => '+' + line).join('\n');
  return [
    'diff --git a/' + relPath + ' b/' + relPath,
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/' + relPath,
    '@@ -0,0 +1,' + lines.length + ' @@',
    body,
    limited.truncated ? '[TRUNCATED UNTRACKED FILE]' : '',
  ].filter(Boolean).join('\n') + '\n';
}

function diffStats(diffText) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function parseCommitNameStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const [hash = '', shortHash = '', author = '', date = '', ...subjectParts] = (lines.shift() || '').split('\t');
  const files = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const code = parts[0] || 'M';
    const xy = fileStatusFromNameStatus(code);
    const isRename = code.startsWith('R') || code.startsWith('C');
    const oldPath = isRename ? (parts[1] || null) : null;
    const filePath = isRename ? parts[2] : parts[1];
    if (!filePath) continue;
    const rawPath = isRename && oldPath ? `${oldPath} -> ${filePath}` : filePath;
    files.push({
      path: filePath,
      oldPath,
      rawPath,
      xy,
      staged: true,
      unstaged: false,
      label: fileStatusLabel(xy),
    });
  }
  return {
    hash,
    shortHash,
    author,
    date,
    subject: subjectParts.join('\t'),
    files,
  };
}

function commitDescriptionFromBody(bodyText, subject) {
  const lines = String(bodyText || '').replace(/\r\n/g, '\n').split('\n');
  const normalizedSubject = String(subject || '').replace(/\s+/g, ' ').trim();
  if (!lines.length) return '';
  while (lines.length) {
    const first = (lines[0] || '').replace(/\s+/g, ' ').trim();
    if (!first || (normalizedSubject && first === normalizedSubject)) {
      lines.shift();
      continue;
    }
    break;
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n').trim();
}

function parseNumstat(stdout) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const [add, del] = line.trim().split(/\s+/);
    const a = Number(add);
    const d = Number(del);
    if (Number.isFinite(a)) additions += a;
    if (Number.isFinite(d)) deletions += d;
  }
  return { additions, deletions };
}

function addRepository(found, repoPath, source) {
  if (!repoPath || found.has(repoPath)) return;
  found.set(repoPath, { path: repoPath, source });
}

async function listRepositories(projectPath) {
  const homeRoot = await getRepoRoot(projectPath);
  const scanRoot = safeProjectPath(projectPath);
  const skipNames = new Set([
    '.git', 'node_modules', 'dist', 'build', 'out', 'release', '.next', '.vite',
    '.cache', 'coverage', 'tmp', '.venv', 'venv',
  ]);
  const found = new Map();
  if (homeRoot) addRepository(found, homeRoot, 'home');

  async function walk(dir, depth) {
    if (found.size >= 300 || depth > 5) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGit = entries.some((entry) => entry.name === '.git');
    if (hasGit) {
      addRepository(found, dir, dir === homeRoot ? 'home' : 'nested');
      if (dir !== scanRoot) return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipNames.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(scanRoot, 0);
  const roots = Array.from(found.values()).sort((a, b) => {
    if (a.path === homeRoot) return -1;
    if (b.path === homeRoot) return 1;
    const rank = { nested: 0, home: -1 };
    const ar = rank[a.source] ?? 2;
    const br = rank[b.source] ?? 2;
    if (ar !== br) return ar - br;
    return a.path.localeCompare(b.path);
  });
  return roots.map((repo) => ({
    path: repo.path,
    name: path.basename(repo.path),
    relativePath: repo.path === homeRoot
      ? ''
      : (repo.path.startsWith(scanRoot + path.sep)
        ? path.relative(scanRoot, repo.path)
        : repo.path),
    home: repo.path === homeRoot,
  }));
}

async function collectDiffForPrompt(root, status, selectedPaths, docsOnlyWhenPresent) {
  const selected = Array.isArray(selectedPaths) && selectedPaths.length
    ? selectedPaths.filter((p) => typeof p === 'string' && p.trim())
    : status.files.map((file) => file.path);
  const uniqueSelected = Array.from(new Set(selected));
  const docsSelected = uniqueSelected.filter(isDocsPath);
  const includedPaths = docsOnlyWhenPresent && docsSelected.length > 0 ? docsSelected : uniqueSelected;
  if (!includedPaths.length) {
    return {
      includedPaths,
      docsOnlyApplied: false,
      diffText: '',
      truncated: false,
    };
  }

  const statusByPath = new Map(status.files.map((file) => [file.path, file]));
  const argsSuffix = ['--', ...includedPaths];
  const staged = await runGit(root, ['diff', '--cached', '--color=never', ...argsSuffix]);
  const unstaged = await runGit(root, ['diff', '--color=never', ...argsSuffix]);

  const sections = [];
  if (staged.stdout.trim()) sections.push('=== STAGED DIFF ===\n' + staged.stdout.trim());
  if (unstaged.stdout.trim()) sections.push('=== UNSTAGED DIFF ===\n' + unstaged.stdout.trim());

  for (const relPath of includedPaths) {
    const file = statusByPath.get(relPath);
    if (file?.xy === '??') {
      const body = await readUntrackedFile(root, relPath).catch((error) => {
        return '--- UNTRACKED FILE: ' + relPath + ' ---\n[Read failed: ' + error.message + ']\n';
      });
      if (body.trim()) sections.push(body.trim());
    }
  }

  const joined = sections.join('\n\n');
  const limited = trimText(joined, MAX_PROMPT_DIFF_CHARS);
  return {
    includedPaths,
    docsOnlyApplied: docsOnlyWhenPresent && docsSelected.length > 0,
    diffText: limited.text,
    truncated: limited.truncated,
  };
}

function getGitCommitPromptConfig(projectManager) {
  try {
    const prompt = projectManager?.getAIPrompts?.().find((item) => item.id === GIT_COMMIT_PROMPT_ID);
    return {
      content: String(prompt?.content || '').trim() || DEFAULT_GIT_COMMIT_SYSTEM_PROMPT,
      model: prompt?.model || 'gemini-3.1-flash-lite',
      thinking: prompt?.thinkingLevel || 'NONE',
    };
  } catch {
    return {
      content: DEFAULT_GIT_COMMIT_SYSTEM_PROMPT,
      model: 'gemini-3.1-flash-lite',
      thinking: 'NONE',
    };
  }
}

function buildCommitPrompt(status, diffBundle, systemPrompt) {
  const fileLines = status.files
    .filter((file) => diffBundle.includedPaths.includes(file.path))
    .map((file) => '- ' + file.xy + ' ' + file.path)
    .join('\n');

  const policy = diffBundle.docsOnlyApplied
    ? 'Docs-only setting is enabled, and docs changes exist. Only docs changes are included below.'
    : 'All selected changed files are included below. If docs changes exist, prioritize docs when choosing the commit message; if docs did not change, use all included changes.';

  const prompt = [
    'Repository: ' + status.repoName,
    'Branch: ' + status.branch,
    '',
    'Selection policy:',
    policy,
    diffBundle.truncated ? 'Some diff content is truncated. Do not invent details beyond visible changes.' : '',
    '',
    'Changed files included:',
    fileLines || '(none)',
    '',
    'Diff/content:',
    diffBundle.diffText || '(no textual diff)',
  ].filter((part) => part !== '').join('\n');

  return { system: systemPrompt || DEFAULT_GIT_COMMIT_SYSTEM_PROMPT, prompt };
}

function parseCommitMessage(text) {
  const raw = String(text || '').trim();
  const unwrapped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const jsonStart = unwrapped.indexOf('{');
  const jsonEnd = unwrapped.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(unwrapped.slice(jsonStart, jsonEnd + 1));
      return {
        summary: String(parsed.summary || '').trim(),
        description: String(parsed.description || '').trim(),
      };
    } catch (_) {
      // Fall back to line parsing below.
    }
  }
  const lines = unwrapped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    summary: (lines[0] || '').replace(/^summary:\s*/i, '').trim(),
    description: lines.slice(1).join('\n').replace(/^description:\s*/i, '').trim(),
  };
}

function usageTotal(usage) {
  const input = Number(usage?.input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  return input + output;
}

function authError(stderrOrError) {
  return /Authentication failed|Permission denied|could not read Username|Repository not found|password authentication|terminal prompts disabled|access denied|publickey|not authorized|403|401/i.test(String(stderrOrError || ''));
}

function trimGitSuffix(value) {
  return String(value || '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

function remoteProvider(host) {
  const normalized = String(host || '').toLowerCase();
  if (normalized.includes('github.')) return { key: 'github', label: 'GitHub' };
  if (normalized.includes('gitlab')) return { key: 'gitlab', label: 'GitLab' };
  return { key: normalized ? 'git' : 'none', label: normalized ? 'Git remote' : 'No remote' };
}

function sanitizeRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return raw.replace(/:\/\/[^/@]+@/, '://').replace(/^([^@\s]+)@([^:\s]+):/, '$2:');
  }
}

function parseRemoteInfo(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) {
    return {
      provider: 'none',
      providerLabel: 'No remote',
      protocol: '',
      host: '',
      path: '',
      displayUrl: '',
      webUrl: '',
    };
  }

  const safeUrl = sanitizeRemoteUrl(raw);
  let protocol = 'git';
  let host = '';
  let repoPath = '';
  let webUrl = '';

  try {
    const parsed = new URL(raw);
    protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
    host = parsed.hostname;
    repoPath = decodeURIComponent(trimGitSuffix(parsed.pathname.replace(/^\/+/, '')));
    if (host && repoPath && (protocol === 'http' || protocol === 'https' || protocol === 'ssh' || protocol === 'git')) {
      webUrl = `https://${host}/${repoPath}`;
    }
  } catch (_) {
    const scpLike = raw.match(/^(?:([^@\s]+)@)?([^:\s]+):(.+)$/);
    if (scpLike) {
      protocol = 'ssh';
      host = scpLike[2];
      repoPath = trimGitSuffix(scpLike[3]);
      webUrl = host && repoPath ? `https://${host}/${repoPath}` : '';
    } else {
      repoPath = trimGitSuffix(raw);
    }
  }

  const provider = remoteProvider(host);
  return {
    provider: provider.key,
    providerLabel: provider.label,
    protocol,
    host,
    path: repoPath,
    displayUrl: safeUrl,
    webUrl,
  };
}

async function listBranches(root) {
  const [result, currentResult, originHeadResult] = await Promise.all([
    runGit(root, [
      'branch',
      '--all',
      '--sort=-committerdate',
      '--format=%(HEAD)%09%(refname:short)%09%(committerdate:relative)%09%(committerdate:unix)%09%(refname)',
    ]),
    runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  if (!result.success) throw new Error(result.stderr || result.error || 'git branch failed');
  const current = currentResult.success ? currentResult.stdout.trim() : '';
  let defaultBranch = originHeadResult.success
    ? originHeadResult.stdout.trim().replace(/^origin\//, '')
    : '';
  if (!defaultBranch) {
    const mainResult = await runGit(root, ['show-ref', '--verify', '--quiet', 'refs/heads/main']);
    if (mainResult.success) defaultBranch = 'main';
    else {
      const masterResult = await runGit(root, ['show-ref', '--verify', '--quiet', 'refs/heads/master']);
      defaultBranch = masterResult.success ? 'master' : current;
    }
  }
  const seen = new Set();
  return result.stdout.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [head, name, updated, updatedUnix, refname] = line.split('\t');
      const remote = String(refname || '').startsWith('refs/remotes/');
      return {
        name,
        updated: updated || '',
        updatedUnix: Number(updatedUnix) || 0,
        current: head === '*' || (!remote && name === current),
        default: !remote && name === defaultBranch,
        remote,
      };
    })
    .filter((branch) => branch.name && branch.name !== 'origin/HEAD')
    .filter((branch) => {
      if (seen.has(branch.name)) return false;
      seen.add(branch.name);
      return true;
    });
}

function parseNulPaths(stdout) {
  return String(stdout || '').split('\0').map((item) => item.trim()).filter(Boolean);
}

function parseMergeTreeConflictFiles(stdout) {
  const lines = String(stdout || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= 1) return [];
  const files = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    const filePath = line.trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    files.push(filePath);
  }
  return files;
}

function mergeMessage(sourceBranch, targetBranch) {
  const source = String(sourceBranch || '').replace(/[\r\n\0]+/g, ' ').trim();
  const target = String(targetBranch || '').replace(/[\r\n\0]+/g, ' ').trim();
  return `Merge ${source || 'branch'} into ${target || 'current branch'}`;
}

function parseMergeMessageSource(message) {
  const firstLine = String(message || '').replace(/\r\n/g, '\n').split('\n')[0].trim();
  const match = firstLine.match(/^Merge (.+) into (.+)$/);
  return match ? { sourceBranch: match[1], targetBranch: match[2] } : null;
}

async function readMergeMessage(root) {
  const mergeMessagePath = await runGit(root, ['rev-parse', '--git-path', 'MERGE_MSG']);
  if (!mergeMessagePath.success || !mergeMessagePath.stdout.trim()) return '';
  const candidate = mergeMessagePath.stdout.trim();
  const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
  return fs.promises.readFile(absolutePath, 'utf8').catch(() => '');
}

async function getMergeState(root) {
  const mergeHeadResult = await runGit(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  if (!mergeHeadResult.success || !mergeHeadResult.stdout.trim()) {
    return {
      inProgress: false,
      readyToCommit: false,
      mergeHead: '',
      sourceBranch: '',
      targetBranch: '',
      conflictFiles: [],
      conflictCount: 0,
      message: '',
    };
  }

  const [conflictsResult, message, targetBranch] = await Promise.all([
    runGit(root, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U', '-z']),
    readMergeMessage(root),
    currentBranch(root),
  ]);
  const conflictFiles = conflictsResult.success ? parseNulPaths(conflictsResult.stdout) : [];
  const parsedMessage = parseMergeMessageSource(message);
  return {
    inProgress: true,
    readyToCommit: conflictFiles.length === 0,
    mergeHead: mergeHeadResult.stdout.trim(),
    sourceBranch: parsedMessage?.sourceBranch || mergeHeadResult.stdout.trim().slice(0, 12),
    targetBranch: parsedMessage?.targetBranch || targetBranch,
    conflictFiles,
    conflictCount: conflictFiles.length,
    message: String(message || '').trim(),
  };
}

async function resolveMergeSource(root, sourceBranch) {
  const source = String(sourceBranch || '').trim();
  if (!source || /[\r\n\0]/.test(source)) throw new Error('Source branch is required');
  const result = await runGit(root, ['rev-parse', '--verify', '--end-of-options', `${source}^{commit}`]);
  if (!result.success || !result.stdout.trim()) {
    throw new Error(result.stderr || result.error || `Branch not found: ${source}`);
  }
  return { sourceBranch: source, sourceHash: result.stdout.trim() };
}

async function previewMergeForRoot(root, sourceBranch) {
  const merge = await getMergeState(root);
  const targetBranch = await currentBranch(root);
  if (merge.inProgress) {
    return {
      success: true,
      state: 'merge-in-progress',
      sourceBranch: merge.sourceBranch,
      targetBranch: merge.targetBranch || targetBranch,
      conflictFiles: merge.conflictFiles,
      conflictCount: merge.conflictCount,
      commitCount: 0,
      changedFileCount: 0,
      merge,
    };
  }

  const source = await resolveMergeSource(root, sourceBranch);
  const headResult = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (!headResult.success || !headResult.stdout.trim()) throw new Error('Unable to read HEAD');
  const headHash = headResult.stdout.trim();
  if (source.sourceHash === headHash || source.sourceBranch === targetBranch) {
    return {
      success: true,
      state: 'same',
      sourceBranch: source.sourceBranch,
      targetBranch,
      conflictFiles: [],
      conflictCount: 0,
      commitCount: 0,
      changedFileCount: 0,
    };
  }

  const statusResult = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-b']);
  if (!statusResult.success) throw new Error(statusResult.stderr || statusResult.error || 'git status failed');
  const dirtyFiles = parseStatus(statusResult.stdout).files;
  if (dirtyFiles.length) {
    return {
      success: true,
      state: 'dirty',
      sourceBranch: source.sourceBranch,
      targetBranch,
      conflictFiles: [],
      conflictCount: 0,
      commitCount: 0,
      changedFileCount: dirtyFiles.length,
    };
  }

  const alreadyMerged = await runGit(root, ['merge-base', '--is-ancestor', source.sourceHash, headHash]);
  if (alreadyMerged.success) {
    return {
      success: true,
      state: 'up-to-date',
      sourceBranch: source.sourceBranch,
      targetBranch,
      conflictFiles: [],
      conflictCount: 0,
      commitCount: 0,
      changedFileCount: 0,
    };
  }

  const [commitCountResult, changedFilesResult, mergeTreeResult] = await Promise.all([
    runGit(root, ['rev-list', '--count', `${headHash}..${source.sourceHash}`]),
    runGit(root, ['-c', 'core.quotepath=false', 'diff', '--name-only', '-z', `${headHash}...${source.sourceHash}`]),
    runGit(root, [
      '-c', 'core.quotepath=false',
      'merge-tree', '--write-tree', '--name-only', '--messages',
      headHash, source.sourceHash,
    ]),
  ]);
  const conflictFiles = parseMergeTreeConflictFiles(mergeTreeResult.stdout);
  if (!mergeTreeResult.success && !conflictFiles.length) {
    throw new Error(mergeTreeResult.stderr || mergeTreeResult.error || 'Unable to preview merge');
  }
  return {
    success: true,
    state: conflictFiles.length ? 'conflicts' : 'ready',
    sourceBranch: source.sourceBranch,
    sourceHash: source.sourceHash,
    targetBranch,
    conflictFiles,
    conflictCount: conflictFiles.length,
    commitCount: commitCountResult.success ? Math.max(0, Number(commitCountResult.stdout.trim()) || 0) : 0,
    changedFileCount: changedFilesResult.success ? parseNulPaths(changedFilesResult.stdout).length : 0,
  };
}

async function startMergeForRoot(root, sourceBranch) {
  const preview = await previewMergeForRoot(root, sourceBranch);
  if (preview.state !== 'ready' && preview.state !== 'conflicts') return preview;

  const source = await resolveMergeSource(root, preview.sourceBranch);
  const result = await runGit(root, [
    'merge', '--no-ff', '--no-commit',
    '-m', mergeMessage(preview.sourceBranch, preview.targetBranch),
    source.sourceHash,
  ]);
  const merge = await getMergeState(root);
  if (merge.inProgress && merge.conflictCount > 0) {
    return {
      success: true,
      state: 'conflicts',
      sourceBranch: preview.sourceBranch,
      targetBranch: preview.targetBranch,
      conflictFiles: merge.conflictFiles,
      conflictCount: merge.conflictCount,
      commitCount: preview.commitCount,
      changedFileCount: preview.changedFileCount,
      merge,
    };
  }
  if (!result.success) {
    throw new Error(result.stderr || result.error || 'git merge failed');
  }
  if (!merge.inProgress) {
    return { ...preview, success: true, state: 'up-to-date' };
  }

  const commitResult = await runGit(root, ['commit', '--no-edit']);
  if (!commitResult.success) throw new Error(commitResult.stderr || commitResult.error || 'git merge commit failed');
  const hashResult = await runGit(root, ['rev-parse', '--short', 'HEAD']);
  return {
    success: true,
    state: 'merged',
    sourceBranch: preview.sourceBranch,
    targetBranch: preview.targetBranch,
    conflictFiles: [],
    conflictCount: 0,
    commitCount: preview.commitCount,
    changedFileCount: preview.changedFileCount,
    hash: hashResult.success ? hashResult.stdout.trim() : '',
  };
}

async function continueMergeForRoot(root) {
  const merge = await getMergeState(root);
  if (!merge.inProgress) throw new Error('No merge is in progress');
  if (merge.conflictCount > 0) {
    throw new Error(`${merge.conflictCount} conflicted file${merge.conflictCount === 1 ? '' : 's'} still unresolved`);
  }
  const commitResult = await runGit(root, ['commit', '--no-edit']);
  if (!commitResult.success) throw new Error(commitResult.stderr || commitResult.error || 'git merge commit failed');
  const hashResult = await runGit(root, ['rev-parse', '--short', 'HEAD']);
  return { success: true, state: 'merged', hash: hashResult.success ? hashResult.stdout.trim() : '' };
}

async function abortMergeForRoot(root) {
  const merge = await getMergeState(root);
  if (!merge.inProgress) throw new Error('No merge is in progress');
  const result = await runGit(root, ['merge', '--abort']);
  if (!result.success) throw new Error(result.stderr || result.error || 'git merge --abort failed');
  return { success: true, state: 'aborted' };
}

async function currentBranch(root) {
  const result = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!result.success) return '';
  return result.stdout.trim();
}

async function hasUpstream(root) {
  const result = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return result.success && result.stdout.trim();
}

function gitWatchKey(sender, projectPath) {
  return String(sender?.id || 'unknown') + ':' + path.resolve(projectPath);
}

function shouldIgnoreGitWatchPath(filePath) {
  const normalized = String(filePath || '').split(path.sep).join('/');
  if (!normalized) return false;
  return normalized.includes('/node_modules/')
    || normalized.startsWith('node_modules/')
    || normalized.includes('/.cache/')
    || normalized.startsWith('.cache/')
    || normalized.includes('/dist/')
    || normalized.startsWith('dist/')
    || normalized.includes('/release/')
    || normalized.startsWith('release/');
}

function stopGitStatusWatcher(key) {
  const state = gitStatusWatchers.get(key);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  for (const watcher of state.watchers || []) {
    try { watcher?.close?.(); } catch {}
  }
  gitStatusWatchers.delete(key);
}

function register({ projectManager }) {
  ipcMain.handle('git:status', async (event, { projectPath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) return { success: true, isRepo: false };
      const status = await getStatusForRoot(root);
      return { success: true, ...status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:history', async (event, { projectPath, limit = 30, skip = 0 }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) return { success: true, commits: [], hasMore: false, skip: 0, limit: 0 };
      const count = Math.max(1, Math.min(100, Number(limit) || 30));
      const offset = Math.max(0, Number(skip) || 0);
      const result = await runGit(root, [
        'log',
        '--date=relative',
        '--pretty=format:%h%x09%cr%x09%s',
        '--skip',
        String(offset),
        '-n',
        String(count + 1),
      ]);
      if (!result.success) return { success: true, commits: [], hasMore: false, skip: offset, limit: count };
      const pageLines = result.stdout.split(/\r?\n/).filter(Boolean);
      const hasMore = pageLines.length > count;
      const visibleLines = pageLines.slice(0, count);
      const upstream = await hasUpstream(root);
      const unpushedHashes = new Set();
      let markAllVisibleUnpushed = false;
      if (upstream) {
        const aheadResult = await runGit(root, ['log', '--pretty=format:%h', `${upstream}..HEAD`]);
        if (aheadResult.success) {
          for (const line of aheadResult.stdout.split(/\r?\n/)) {
            const hash = line.trim();
            if (hash) unpushedHashes.add(hash);
          }
        }
      } else {
        const branch = await currentBranch(root);
        if (branch && branch !== 'HEAD') {
          const originBranch = await runGit(root, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
          if (originBranch.success) {
            const aheadResult = await runGit(root, ['log', '--pretty=format:%h', `origin/${branch}..HEAD`]);
            if (aheadResult.success) {
              for (const line of aheadResult.stdout.split(/\r?\n/)) {
                const hash = line.trim();
                if (hash) unpushedHashes.add(hash);
              }
            }
          } else {
            markAllVisibleUnpushed = true;
          }
        }
      }
      const commits = visibleLines.map((line) => {
        const [hash, date, ...subjectParts] = line.split('\t');
        return { hash, date, subject: subjectParts.join('\t'), unpushed: markAllVisibleUnpushed || unpushedHashes.has(hash) };
      });
      return { success: true, commits, hasMore, skip: offset, limit: count };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:commit-details', async (event, { projectPath, hash, filePath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const commitHash = String(hash || '').trim();
      if (!commitHash) throw new Error('Commit hash is required');

      const meta = await runGit(root, [
        '-c', 'core.quotepath=false',
        'show',
        '--format=%H%x09%h%x09%an%x09%cr%x09%s',
        '--name-status',
        '--find-renames',
        '--color=never',
        '--no-ext-diff',
        commitHash,
      ], { maxBuffer: GIT_MAX_BUFFER });
      if (!meta.success) throw new Error(meta.stderr || meta.error || 'git show failed');
      const details = parseCommitNameStatus(meta.stdout);
      const body = await runGit(root, ['show', '-s', '--format=%B', commitHash], { maxBuffer: GIT_MAX_BUFFER });
      const commitDescription = body.success ? commitDescriptionFromBody(body.stdout, details.subject) : '';
      const requestedPath = String(filePath || '').trim();
      const activeFile = details.files.find((file) => file.path === requestedPath)
        || details.files[0]
        || null;

      const diffArgs = [
        'show',
        '--format=',
        '--color=never',
        '--find-renames',
        '--no-ext-diff',
        commitHash,
      ];
      if (activeFile?.path) diffArgs.push('--', activeFile.path);
      const diffResult = await runGit(root, diffArgs, { maxBuffer: GIT_MAX_BUFFER });
      const diffText = diffResult.success ? diffResult.stdout : '';
      const limited = trimText(diffText, MAX_PREVIEW_DIFF_CHARS);

      const numstat = await runGit(root, ['show', '--format=', '--numstat', commitHash], { maxBuffer: GIT_MAX_BUFFER });
      const stats = numstat.success ? parseNumstat(numstat.stdout) : diffStats(limited.text);
      const fileStats = diffStats(limited.text);

      return {
        success: true,
        hash: details.hash,
        shortHash: details.shortHash,
        author: details.author,
        date: details.date,
        subject: details.subject,
        description: commitDescription,
        files: details.files,
        activeFilePath: activeFile?.path || '',
        diff: limited.text,
        truncated: limited.truncated,
        additions: fileStats.additions,
        deletions: fileStats.deletions,
        totalAdditions: stats.additions,
        totalDeletions: stats.deletions,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:branches', async (event, { projectPath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) return { success: true, branches: [] };
      return { success: true, branches: await listBranches(root) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:list-repositories', async (event, { projectPath }) => {
    try {
      return { success: true, repositories: await listRepositories(projectPath) };
    } catch (error) {
      return { success: false, error: error.message, repositories: [] };
    }
  });

  ipcMain.handle('git:watch-status', async (event, { projectPath }) => {
    try {
      const requestPath = safeProjectPath(projectPath);
      const root = await getRepoRoot(requestPath);
      if (!root) return { success: false, error: 'Not a Git repository' };
      const key = gitWatchKey(event.sender, requestPath);
      if (gitStatusWatchers.has(key)) {
        return { success: true, repoRoot: root, projectPath: requestPath, reused: true };
      }

      const state = {
        watchers: [],
        timer: null,
      };
      const notify = (basePath, eventType, filename) => {
        const rel = String(filename || '');
        if (shouldIgnoreGitWatchPath(rel)) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          if (event.sender.isDestroyed()) {
            stopGitStatusWatcher(key);
            return;
          }
          event.sender.send('git:status-changed', {
            eventType,
            path: rel ? path.join(basePath, rel) : basePath,
            repoRoot: root,
            projectPath: requestPath,
          });
        }, GIT_STATUS_WATCH_DEBOUNCE_MS);
      };

      try {
        state.watchers.push(fs.watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
          notify(root, eventType, filename);
        }));
        const gitDirResult = await runGit(root, ['rev-parse', '--absolute-git-dir']);
        const gitDir = gitDirResult.success ? gitDirResult.stdout.trim() : '';
        if (gitDir && path.resolve(gitDir) !== path.resolve(root)) {
          state.watchers.push(fs.watch(gitDir, { recursive: true, persistent: false }, (eventType, filename) => {
            notify(gitDir, eventType, filename);
          }));
        }
      } catch (error) {
        for (const watcher of state.watchers) {
          try { watcher?.close?.(); } catch {}
        }
        return { success: false, error: error.message };
      }

      gitStatusWatchers.set(key, state);
      event.sender.once('destroyed', () => stopGitStatusWatcher(key));
      return { success: true, repoRoot: root, projectPath: requestPath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:unwatch-status', async (event, { projectPath }) => {
    try {
      if (!projectPath) return { success: true };
      stopGitStatusWatcher(gitWatchKey(event.sender, safeProjectPath(projectPath)));
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:file-diff', async (event, { projectPath, filePath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const relPath = String(filePath || '').trim();
      if (!relPath) throw new Error('File path is required');
      const status = await getStatusForRoot(root);
      const file = status.files.find((item) => item.path === relPath) || null;
      const argsSuffix = ['--', relPath];
      const staged = await runGit(root, ['diff', '--cached', '--color=never', '--find-renames', ...argsSuffix], { maxBuffer: GIT_MAX_BUFFER });
      const unstaged = await runGit(root, ['diff', '--color=never', '--find-renames', ...argsSuffix], { maxBuffer: GIT_MAX_BUFFER });
      const sections = [];
      if (staged.success && staged.stdout.trim()) sections.push(staged.stdout.trim());
      if (unstaged.success && unstaged.stdout.trim()) sections.push(unstaged.stdout.trim());
      if (!sections.length && file?.xy === '??') {
        const preview = await buildUntrackedPreviewDiff(root, relPath).catch((error) => {
          return [
            'diff --git a/' + relPath + ' b/' + relPath,
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/' + relPath,
            '[Read failed: ' + error.message + ']',
          ].join('\n') + '\n';
        });
        if (preview.trim()) sections.push(preview.trim());
      }
      const joined = sections.join('\n\n');
      const limited = trimText(joined, MAX_PREVIEW_DIFF_CHARS);
      const stats = diffStats(limited.text);
      return {
        success: true,
        file,
        diff: limited.text,
        truncated: limited.truncated,
        additions: stats.additions,
        deletions: stats.deletions,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:merge-preview', async (event, { projectPath, sourceBranch }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      return await previewMergeForRoot(root, sourceBranch);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:merge-start', async (event, { projectPath, sourceBranch }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('merge', root);
      try {
        return await startMergeForRoot(root, sourceBranch);
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:merge-continue', async (event, { projectPath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('merge', root);
      try {
        return await continueMergeForRoot(root);
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:merge-abort', async (event, { projectPath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('abort merge', root);
      try {
        return await abortMergeForRoot(root);
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:checkout', async (event, { projectPath, branch }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      if (!branch || typeof branch !== 'string') throw new Error('Branch is required');
      const finishGitOperation = startGitOperation('checkout', root);
      try {
        const result = await runGit(root, ['checkout', branch]);
        if (!result.success) {
          return { success: false, error: result.stderr || result.error || 'git checkout failed' };
        }
        return { success: true };
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:generate-commit-message', async (event, payload) => {
    const projectPath = payload?.projectPath;
    const docsOnlyWhenPresent = payload?.docsOnlyWhenPresent === true;
    let model = 'gemini-3.1-flash-lite';
    let thinking = 'NONE';
    let prompt = '';
    let output = '';
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('generate', root);
      try {
        const status = await getStatusForRoot(root);
        if (!status.files.length) throw new Error('No changed files');
        const selection = normalizeSelectedChangedPaths(status, payload?.selectedPaths);
        if (selection.invalid.length) {
          return { success: false, staleSelection: true, error: staleSelectionError(selection.invalid) };
        }
        const diffBundle = await collectDiffForPrompt(root, status, selection.paths, docsOnlyWhenPresent);
        if (!diffBundle.includedPaths.length) throw new Error('No selected files');
        const promptConfig = getGitCommitPromptConfig(projectManager);
        model = promptConfig.model;
        thinking = promptConfig.thinking;
        const built = buildCommitPrompt(status, diffBundle, promptConfig.content);
        prompt = built.prompt;
        const response = await callGeminiApi(built.system, built.prompt, model, thinking);
        output = response.text || '';

        projectManager?.logAIPromptCall?.({
          promptId: GIT_COMMIT_PROMPT_ID,
          taskType: 'Git commit message',
          model,
          thinkingLevel: thinking,
          promptTokens: Number(response.usage?.input_tokens || 0),
          candidateTokens: Number(response.usage?.output_tokens || 0),
          totalTokens: usageTotal(response.usage),
          status: response.success ? 'success' : 'error',
          error: response.success ? null : response.error,
          sourceChars: prompt.length,
          outputChars: output.length,
          projectId: payload?.projectId,
          projectName: payload?.projectName,
          projectPath,
          tabId: payload?.tabId,
          tabName: payload?.tabName,
          toolType: 'git',
        });

        if (!response.success) {
          return { success: false, error: response.error || 'AI request failed', meta: diffBundle };
        }

        const message = parseCommitMessage(response.text);
        if (!message.summary) return { success: false, error: 'AI response did not include a commit summary', raw: response.text, meta: diffBundle };
        return { success: true, message, raw: response.text, meta: diffBundle, usage: response.usage };
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      projectManager?.logAIPromptCall?.({
        promptId: GIT_COMMIT_PROMPT_ID,
        taskType: 'Git commit message',
        model,
        thinkingLevel: thinking,
        status: 'error',
        error: error.message,
        sourceChars: prompt.length,
        outputChars: output.length,
        projectPath,
        projectId: payload?.projectId,
        projectName: payload?.projectName,
        tabId: payload?.tabId,
        tabName: payload?.tabName,
        toolType: 'git',
      });
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:commit', async (event, { projectPath, selectedPaths, summary, description }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('commit', root);
      try {
        const status = await getStatusForRoot(root);
        if (!status.files.length) throw new Error('No changed files');
        const selection = normalizeSelectedChangedPaths(status, selectedPaths);
        if (selection.invalid.length) {
          return { success: false, staleSelection: true, error: staleSelectionError(selection.invalid) };
        }
        const paths = selection.paths;
        if (!paths.length) throw new Error('Select at least one changed file');
        const cleanSummary = String(summary || '').trim();
        if (!cleanSummary) throw new Error('Commit summary is required');
        const addResult = await runGit(root, ['add', '--', ...paths]);
        if (!addResult.success) {
          const addError = addResult.stderr || addResult.error || 'git add failed';
          if (/pathspec.+did not match any files/i.test(addError)) {
            return { success: false, staleSelection: true, error: staleSelectionError(paths) };
          }
          return { success: false, error: addError };
        }
        const commitArgs = ['commit', '--only', '-m', cleanSummary];
        const cleanDescription = String(description || '').trim();
        if (cleanDescription) commitArgs.push('-m', cleanDescription);
        commitArgs.push('--', ...paths);
        const commitResult = await runGit(root, commitArgs);
        if (!commitResult.success) {
          return { success: false, error: commitResult.stderr || commitResult.error || 'git commit failed' };
        }
        const hash = await runGit(root, ['rev-parse', '--short', 'HEAD']);
        return { success: true, hash: hash.success ? hash.stdout.trim() : '', output: commitResult.stdout };
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:undo-last-commit', async (event, { projectPath, hash }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('undo', root);
      try {
        const targetHash = String(hash || '').trim();
        if (!targetHash) throw new Error('Commit hash is required');
        const head = await runGit(root, ['rev-parse', '--short', 'HEAD']);
        if (!head.success) throw new Error(head.stderr || head.error || 'Unable to read HEAD');
        if (head.stdout.trim() !== targetHash) throw new Error('Only the latest commit can be undone');
        const parents = await runGit(root, ['rev-list', '--parents', '-n', '1', 'HEAD']);
        if (!parents.success) throw new Error(parents.stderr || parents.error || 'Unable to inspect commit parents');
        if (parents.stdout.trim().split(/\s+/).length < 2) {
          throw new Error('Cannot undo the initial commit from this panel');
        }
        const upstream = await hasUpstream(root);
        let protectRef = upstream;
        if (!protectRef) {
          const branch = await currentBranch(root);
          if (branch && branch !== 'HEAD') {
            const originBranch = await runGit(root, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
            if (originBranch.success) protectRef = `origin/${branch}`;
          }
        }
        if (protectRef) {
          const pushedCheck = await runGit(root, ['merge-base', '--is-ancestor', 'HEAD', protectRef]);
          if (pushedCheck.success) {
            throw new Error('Latest commit is already pushed');
          }
        }
        const result = await runGit(root, ['reset', '--soft', 'HEAD~1']);
        if (!result.success) {
          return { success: false, error: result.stderr || result.error || 'git reset failed' };
        }
        return { success: true };
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:push', async (event, { projectPath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('push', root);
      try {
        const branch = await currentBranch(root);
        const upstream = await hasUpstream(root);
        const args = upstream ? ['push'] : ['push', '-u', 'origin', branch || 'HEAD'];
        const result = await runGit(root, args, { timeout: 120 * 1000 });
        if (!result.success) {
          const err = result.stderr || result.error || 'git push failed';
          return { success: false, error: err, authError: authError(err) };
        }
        return { success: true, output: result.stdout || result.stderr };
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message, authError: authError(error.message) };
    }
  });

  ipcMain.handle('git:fetch', async (event, { projectPath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const finishGitOperation = startGitOperation('fetch', root);
      try {
        const result = await runGit(root, ['fetch', 'origin', '--prune'], { timeout: 120 * 1000 });
        if (!result.success) {
          const err = result.stderr || result.error || 'git fetch failed';
          return { success: false, error: err, authError: authError(err) };
        }
        return { success: true, output: result.stdout || result.stderr };
      } finally {
        finishGitOperation();
      }
    } catch (error) {
      return { success: false, error: error.message, authError: authError(error.message) };
    }
  });

  ipcMain.handle('git:open-github-desktop', async (event, { projectPath }) => {
    try {
      const target = projectPath ? safeProjectPath(projectPath) : process.cwd();
      const result = await new Promise((resolve) => {
        execFile('open', ['-a', 'GitHub Desktop', target], {
          timeout: 20 * 1000,
          env: buildChildProcessEnv(),
        }, (error, stdout = '', stderr = '') => {
          if (error) return resolve({ success: false, error: stderr || error.message });
          resolve({ success: true, output: stdout || stderr });
        });
      });
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('git:open-remote', async (event, { projectPath }) => {
    try {
      const root = await getRepoRoot(projectPath);
      if (!root) throw new Error('Not a Git repository');
      const remoteResult = await runGit(root, ['config', '--get', 'remote.origin.url']);
      const remote = remoteResult.success ? remoteResult.stdout.trim() : '';
      const info = parseRemoteInfo(remote);
      if (!info.webUrl) throw new Error('Remote URL is not openable');
      await shell.openExternal(info.webUrl);
      return { success: true, url: info.webUrl };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  register,
  getActiveOperations,
  __test: {
    abortMergeForRoot,
    continueMergeForRoot,
    getMergeState,
    listBranches,
    mergeMessage,
    parseMergeMessageSource,
    parseMergeTreeConflictFiles,
    previewMergeForRoot,
    startMergeForRoot,
  },
};
