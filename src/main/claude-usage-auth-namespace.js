'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildChildProcessEnv } = require('./child-process-env');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });

/**
 * Claude Code 2.1.270 secureStorage iH/Fw/b_: explicit config directory uses
 * SHA256(NFC directory).slice(0,8), AFTER the -credentials suffix; the account
 * selector is USER (or OS username). Do not realpath/trim the hash input: the
 * CLI uses its literal NFC directory, including a trailing slash.
 * Public contract: code.claude.com/docs/en/authentication#credential-management.
 * No credentials are read by this pure address calculation.
 */
function captureClaudeUsageAuthNamespace({ env = process.env, home = os.homedir(), username } = {}) {
  const childEnv = Object.freeze(buildChildProcessEnv({}, env));
  const configured = childEnv.CLAUDE_CONFIG_DIR;
  const explicit = configured !== undefined;
  const configDir = (explicit ? String(configured) : path.join(home, '.claude')).normalize('NFC');
  if (!path.isAbsolute(configDir)) throw failure('auth_namespace_invalid', 'Claude usage config directory must be absolute');
  const secureOverride = childEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  // An internal CLI override can deliberately use another storage root. It
  // must not make this private Usage reader fall back to production keys.
  if (secureOverride !== undefined && String(secureOverride).normalize('NFC') !== configDir
    && !(secureOverride === '' && !explicit)) {
    throw failure('auth_namespace_mismatch', 'Claude usage and credential storage namespaces do not match');
  }
  if (childEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    throw failure('auth_source_unsupported', 'Claude usage cannot use a custom OAuth source with the production quota endpoint');
  }
  let account = childEnv.USER || username;
  if (!account) { try { account = os.userInfo().username; } catch {} }
  if (!/^[a-zA-Z0-9._-]+$/.test(account || '')) account = 'claude-code-user';
  const storageExplicit = secureOverride !== undefined ? !!secureOverride : explicit;
  const suffix = storageExplicit ? '-' + hash(configDir).slice(0, 8) : '';
  return Object.freeze({ env: childEnv, configDir, explicit, account,
    scopeKey: hash('claude-usage-scope-v1|' + configDir + '|' + account + '|' + suffix),
    key: explicit || storageExplicit ? hash('claude-usage-namespace-v1|' + configDir + '|' + account + '|' + suffix) : 'default',
    apiService: 'Claude Code' + suffix,
    oauthService: 'Claude Code-credentials' + suffix,
    credentialsFile: path.join(configDir, '.credentials.json'),
  });
}

async function readClaudeUsageCredentialFile(filePath, scope) {
  // Only the exact namespace fallback used by the CLI; never search a global
  // file or follow a credential symlink outside the selected configuration.
  try {
    if (filePath !== scope.credentialsFile) throw failure('auth_namespace_mismatch', 'Claude credential file is not the selected namespace file');
    const root = await fs.promises.realpath(scope.configDir);
    const actual = await fs.promises.realpath(filePath);
    if (path.dirname(actual) !== root) throw failure('auth_namespace_mismatch', 'Claude credential file is outside its config namespace');
    const fd = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw failure('auth_source_invalid', 'Claude credential storage is not a bounded file');
      const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4 * 1024 * 1024) throw failure('auth_source_invalid', 'Claude credential storage exceeds its size limit');
      return buffer.toString('utf8', 0, bytesRead);
    } finally { await fd.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('auth_')) throw error;
    throw failure('auth_source_unavailable', 'Claude credential storage could not be read safely');
  }
}

module.exports = { captureClaudeUsageAuthNamespace, readClaudeUsageCredentialFile };
