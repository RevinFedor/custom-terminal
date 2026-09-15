'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { buildChildProcessEnv } = require('./child-process-env');

const CODEX_ACCOUNT_PROFILES_KEY = 'codexAccountProfiles.v1';
const DEFAULT_PROFILE_ID = 'default';
const LOGIN_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const PROFILE_REFRESH_TTL_MS = 55 * 1000;

function safeJsonParse(value, fallback = null) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function shortCodexId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= 12 ? text : `${text.slice(0, 8)}…${text.slice(-4)}`;
}

function maskCodexEmail(value) {
  if (!value || typeof value !== 'string') return null;
  const [local, domain] = value.trim().split('@');
  if (!local || !domain) return shortCodexId(value);
  const prefix = local.slice(0, Math.min(2, Math.max(1, local.length)));
  return `${prefix}***@${domain}`;
}

function decodeBase64UrlJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function hashCodexAccountKey(value) {
  const identity = String(value || '').trim().toLowerCase();
  if (!identity) return null;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function readCodexProfileIdentity(codexHome, account = null) {
  let raw = null;
  try {
    raw = safeJsonParse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), null);
  } catch {}

  const tokens = raw?.tokens || {};
  const accessPayload = decodeBase64UrlJson(String(tokens.access_token || '').split('.')[1]);
  const idPayload = decodeBase64UrlJson(String(tokens.id_token || '').split('.')[1]);
  const authClaims = accessPayload?.['https://api.openai.com/auth']
    || idPayload?.['https://api.openai.com/auth']
    || {};
  const profileClaims = accessPayload?.['https://api.openai.com/profile']
    || idPayload?.['https://api.openai.com/profile']
    || {};
  const accountId = tokens.account_id
    || authClaims.chatgpt_account_id
    || account?.accountId
    || account?.id
    || null;
  const email = profileClaims.email
    || idPayload?.email
    || accessPayload?.email
    || account?.email
    || null;
  const accountKey = hashCodexAccountKey(accountId || email);
  return {
    accountId,
    email,
    accountKey,
    label: maskCodexEmail(email) || (accountId ? `Account ${shortCodexId(accountId)}` : 'Codex account'),
    accountHint: maskCodexEmail(email) || shortCodexId(accountId),
  };
}

function buildCodexProcessPath(sourceEnv = process.env) {
  const home = os.homedir();
  const extras = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return [...extras, sourceEnv.PATH || ''].filter(Boolean).join(path.delimiter);
}

class CodexAppServerClient extends EventEmitter {
  constructor({
    codexHome,
    command = 'codex',
    spawnImpl = spawn,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    env = process.env,
    initializeCapabilities = null,
  } = {}) {
    super();
    this.codexHome = codexHome;
    this.command = command;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.baseEnv = env;
    this.initializeCapabilities = initializeCapabilities && typeof initializeCapabilities === 'object'
      ? { ...initializeCapabilities }
      : null;
    this.child = null;
    this.lineReader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.closed = false;
    this.stderrTail = '';
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
        const env = buildChildProcessEnv({
          CODEX_HOME: this.codexHome,
          PATH: buildCodexProcessPath(this.baseEnv),
        }, this.baseEnv);
        this.child = this.spawnImpl(this.command, ['app-server'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const failStart = (error) => {
        if (this.closed) return;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this.child.once('error', failStart);
      this.child.once('spawn', async () => {
        try {
          this.attachStreams();
          const initializeParams = {
            clientInfo: {
              name: 'noted_terminal',
              title: 'Noted Terminal',
              version: '1.0.0',
            },
          };
          if (this.initializeCapabilities) initializeParams.capabilities = this.initializeCapabilities;
          await this.request('initialize', initializeParams);
          this.notify('initialized', {});
          this.child.removeListener('error', failStart);
          resolve(this);
        } catch (error) {
          failStart(error);
          this.close();
        }
      });
      this.child.once('exit', (code, signal) => {
        const error = new Error(
          `Codex app-server exited (${code ?? signal ?? 'unknown'})${this.stderrTail ? `: ${this.stderrTail}` : ''}`
        );
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        if (!this.closed) this.emit('exit', { code, signal, error });
      });
    });
    return this.startPromise;
  }

  attachStreams() {
    if (!this.child?.stdout || this.lineReader) return;
    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));
    this.child.stderr?.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk || '')}`.slice(-4000).trim();
    });
  }

  handleLine(line) {
    const message = safeJsonParse(line, null);
    if (!message || typeof message !== 'object') {
      this.emit('protocol-error', new Error('Codex app-server returned invalid JSON'));
      return;
    }
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'Codex app-server request failed');
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  send(message) {
    if (this.closed || !this.child?.stdin?.writable) {
      throw new Error('Codex app-server is not running');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.lineReader?.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server closed'));
    }
    this.pending.clear();
    try { this.child?.stdin?.end(); } catch {}
    try { this.child?.kill?.('SIGTERM'); } catch {}
  }
}

function normalizeStoredProfile(raw, defaultCodexHome, profilesRoot) {
  const profileId = raw?.profileId === DEFAULT_PROFILE_ID
    ? DEFAULT_PROFILE_ID
    : (typeof raw?.profileId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(raw.profileId)
      ? raw.profileId
      : null);
  if (!profileId) return null;
  const isDefault = profileId === DEFAULT_PROFILE_ID;
  const status = ['connected', 'signed_out', 'error'].includes(raw?.status)
    ? raw.status
    : 'signed_out';
  return {
    profileId,
    isDefault,
    homePath: isDefault ? defaultCodexHome : path.join(profilesRoot, profileId),
    label: typeof raw?.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 80)
      : (isDefault ? 'Default Codex' : 'Codex account'),
    accountHint: typeof raw?.accountHint === 'string' ? raw.accountHint.trim().slice(0, 80) : null,
    accountKey: typeof raw?.accountKey === 'string' ? raw.accountKey.trim().slice(0, 160) : null,
    planType: typeof raw?.planType === 'string' ? raw.planType.trim().slice(0, 80) : null,
    status,
    lastError: typeof raw?.lastError === 'string' ? raw.lastError.trim().slice(0, 240) : null,
    lastCheckedAt: Number(raw?.lastCheckedAt) || null,
    createdAt: Number(raw?.createdAt) || Date.now(),
  };
}

class CodexAccountProfileManager {
  constructor({
    store = null,
    defaultCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    profilesRoot = path.join(os.homedir(), '.noted-terminal', 'codex-accounts'),
    clientFactory = (options) => new CodexAppServerClient(options),
    onChange = null,
    now = () => Date.now(),
  } = {}) {
    this.store = store;
    this.defaultCodexHome = defaultCodexHome;
    this.profilesRoot = profilesRoot;
    this.clientFactory = clientFactory;
    this.onChange = onChange;
    this.now = now;
    this.profiles = new Map();
    this.pendingLogins = new Map();
    this.latestResults = new Map();
    this.hydrate();
    this.seedDefaultProfileIdentity();
  }

  hydrate() {
    const stored = safeJsonParse(this.store?.getAppState?.(CODEX_ACCOUNT_PROFILES_KEY), null);
    const rows = stored?.version === 1 && Array.isArray(stored.profiles) ? stored.profiles : [];
    for (const row of rows) {
      const profile = normalizeStoredProfile(row, this.defaultCodexHome, this.profilesRoot);
      if (profile) this.profiles.set(profile.profileId, profile);
    }
    if (!this.profiles.has(DEFAULT_PROFILE_ID)) {
      this.profiles.set(DEFAULT_PROFILE_ID, normalizeStoredProfile({
        profileId: DEFAULT_PROFILE_ID,
        label: 'Default Codex',
        status: 'signed_out',
      }, this.defaultCodexHome, this.profilesRoot));
    }
  }

  seedDefaultProfileIdentity() {
    const profile = this.profiles.get(DEFAULT_PROFILE_ID);
    if (!profile) return;
    const identity = readCodexProfileIdentity(this.defaultCodexHome);
    if (!identity.accountKey) return;
    profile.accountKey = identity.accountKey;
    profile.label = identity.label || profile.label;
    profile.accountHint = identity.accountHint || profile.accountHint;
  }

  serialize() {
    return {
      version: 1,
      profiles: [...this.profiles.values()].map((profile) => ({
        profileId: profile.profileId,
        label: profile.label,
        accountHint: profile.accountHint,
        accountKey: profile.accountKey,
        planType: profile.planType,
        status: profile.status === 'signing_in' ? 'signed_out' : profile.status,
        lastError: profile.status === 'signing_in' ? null : profile.lastError,
        lastCheckedAt: profile.lastCheckedAt,
        createdAt: profile.createdAt,
      })),
    };
  }

  persist() {
    try {
      this.store?.setAppState?.(CODEX_ACCOUNT_PROFILES_KEY, this.serialize());
    } catch (error) {
      console.warn('[CodexProfiles] could not persist profiles:', error?.message || String(error));
    }
  }

  publicProfile(profile) {
    const pending = this.pendingLogins.get(profile.profileId) || null;
    return {
      profileId: profile.profileId,
      label: profile.label,
      accountHint: profile.accountHint,
      accountKey: profile.accountKey,
      planType: profile.planType,
      status: pending ? 'signing_in' : profile.status,
      isDefault: profile.isDefault,
      canRemove: !profile.isDefault,
      lastError: profile.lastError,
      lastCheckedAt: profile.lastCheckedAt,
      login: pending ? {
        verificationUrl: pending.verificationUrl,
        userCode: pending.userCode,
        expiresAt: pending.expiresAt,
      } : null,
    };
  }

  listPublicProfiles() {
    return [...this.profiles.values()]
      .sort((left, right) => {
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        return left.createdAt - right.createdAt;
      })
      .map((profile) => this.publicProfile(profile));
  }

  emitChange(event = null) {
    this.persist();
    this.onChange?.({ profiles: this.listPublicProfiles(), event });
  }

  createManagedProfile() {
    fs.mkdirSync(this.profilesRoot, { recursive: true, mode: 0o700 });
    const profileId = crypto.randomUUID();
    const profile = normalizeStoredProfile({
      profileId,
      label: 'Codex account',
      status: 'signed_out',
      createdAt: this.now(),
    }, this.defaultCodexHome, this.profilesRoot);
    fs.mkdirSync(profile.homePath, { recursive: true, mode: 0o700 });
    this.profiles.set(profileId, profile);
    this.emitChange({ type: 'profile-created', profileId });
    return profile;
  }

  getProfile(profileId) {
    return this.profiles.get(profileId || DEFAULT_PROFILE_ID) || null;
  }

  updateProfileFromAccount(profile, account, { status = 'connected', error = null } = {}) {
    const identity = readCodexProfileIdentity(profile.homePath, account);
    profile.accountKey = identity.accountKey || profile.accountKey;
    profile.label = identity.label || profile.label;
    profile.accountHint = identity.accountHint || profile.accountHint;
    profile.planType = account?.planType || profile.planType || null;
    profile.status = status;
    profile.lastError = error;
    profile.lastCheckedAt = this.now();
    return identity;
  }

  markProfileConnected(profileId, patch = {}) {
    const profile = this.getProfile(profileId);
    if (!profile) return null;
    if (patch.accountKey) profile.accountKey = patch.accountKey;
    if (patch.label) profile.label = patch.label;
    if (patch.accountHint) profile.accountHint = patch.accountHint;
    if (patch.planType) profile.planType = patch.planType;
    profile.status = 'connected';
    profile.lastError = null;
    profile.lastCheckedAt = this.now();
    this.emitChange({ type: 'profile-connected', profileId });
    return profile;
  }

  syncDefaultProfile({ accountKey = null, label = null, accountHint = null, planType = null, connected = false, error = null } = {}) {
    const profile = this.getProfile(DEFAULT_PROFILE_ID);
    if (!profile) return;
    const before = JSON.stringify({
      accountKey: profile.accountKey,
      label: profile.label,
      accountHint: profile.accountHint,
      planType: profile.planType,
      status: profile.status,
      lastError: profile.lastError,
    });
    if (accountKey) profile.accountKey = accountKey;
    if (label) profile.label = label;
    if (accountHint) profile.accountHint = accountHint;
    if (planType) profile.planType = planType;
    profile.status = connected ? 'connected' : 'signed_out';
    profile.lastError = error;
    profile.lastCheckedAt = this.now();
    const after = JSON.stringify({
      accountKey: profile.accountKey,
      label: profile.label,
      accountHint: profile.accountHint,
      planType: profile.planType,
      status: profile.status,
      lastError: profile.lastError,
    });
    if (before !== after) {
      this.emitChange({ type: 'default-profile-updated', profileId: DEFAULT_PROFILE_ID });
    }
  }

  async probeProfile(profile, { refreshToken = false, includeRateLimits = true } = {}) {
    const client = this.clientFactory({ codexHome: profile.homePath });
    try {
      await client.start();
      const accountResult = await client.request('account/read', { refreshToken });
      const account = accountResult?.account || null;
      if (!account) {
        profile.status = 'signed_out';
        profile.lastError = null;
        profile.lastCheckedAt = this.now();
        const result = { profile, account: null, rateLimits: null, error: null };
        this.latestResults.set(profile.profileId, result);
        return result;
      }
      const identity = this.updateProfileFromAccount(profile, account);
      const duplicate = [...this.profiles.values()].find((candidate) => (
        candidate.profileId !== profile.profileId
        && candidate.accountKey
        && candidate.accountKey === identity.accountKey
      ));
      if (duplicate) {
        const error = new Error(`This Codex account is already connected as ${duplicate.label}.`);
        error.code = 'duplicate_account';
        throw error;
      }
      const rateLimits = includeRateLimits
        ? await client.request('account/rateLimits/read', {})
        : null;
      const result = { profile, account, rateLimits, error: null };
      this.latestResults.set(profile.profileId, result);
      return result;
    } catch (error) {
      profile.status = profile.accountKey ? 'error' : 'signed_out';
      profile.lastError = error?.message || String(error);
      profile.lastCheckedAt = this.now();
      const result = { profile, account: null, rateLimits: null, error: profile.lastError, code: error?.code || null };
      this.latestResults.set(profile.profileId, result);
      return result;
    } finally {
      client.close();
    }
  }

  async refreshManagedProfiles({ force = false, accountKey = null } = {}) {
    const now = this.now();
    const profiles = [...this.profiles.values()].filter((profile) => (
      !profile.isDefault
      && (!accountKey || profile.accountKey === accountKey)
    ));
    const results = await Promise.all(profiles.map(async (profile) => {
      if (this.pendingLogins.has(profile.profileId)) {
        return this.latestResults.get(profile.profileId)
          || { profile, account: null, rateLimits: null, error: null };
      }
      const cached = this.latestResults.get(profile.profileId);
      if (!force && cached && now - Number(profile.lastCheckedAt || 0) < PROFILE_REFRESH_TTL_MS) {
        return cached;
      }
      return this.probeProfile(profile, { refreshToken: false, includeRateLimits: true });
    }));
    this.emitChange({ type: 'profiles-refreshed' });
    return results;
  }

  async startLogin(profileId = null) {
    const created = !profileId;
    const profile = profileId ? this.getProfile(profileId) : this.createManagedProfile();
    if (!profile) throw new Error('Codex account profile not found');
    if (this.pendingLogins.has(profile.profileId)) {
      return {
        profile: this.publicProfile(profile),
        login: this.publicProfile(profile).login,
      };
    }

    const expectedAccountKey = created ? null : profile.accountKey;
    const client = this.clientFactory({ codexHome: profile.homePath });
    let login;
    try {
      await client.start();
      login = await client.request('account/login/start', { type: 'chatgptDeviceCode' });
    } catch (error) {
      client.close();
      profile.status = 'signed_out';
      profile.lastError = error?.message || String(error);
      profile.lastCheckedAt = this.now();
      this.emitChange({ type: 'login-failed', profileId: profile.profileId, error: profile.lastError });
      throw error;
    }
    if (!login?.loginId || !login?.verificationUrl || !login?.userCode) {
      client.close();
      throw new Error('Codex did not return a device login code');
    }

    const pending = {
      client,
      loginId: login.loginId,
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      expiresAt: this.now() + LOGIN_TTL_MS,
      expectedAccountKey,
      created,
      timer: null,
      settling: false,
    };
    this.pendingLogins.set(profile.profileId, pending);
    profile.status = 'signing_in';
    profile.lastError = null;

    client.on('notification', (message) => {
      if (message.method !== 'account/login/completed') return;
      const params = message.params || {};
      if (params.loginId && params.loginId !== pending.loginId) return;
      void this.finishLogin(profile.profileId, params);
    });
    client.once('exit', () => {
      if (!pending.settling && this.pendingLogins.get(profile.profileId) === pending) {
        this.failPendingLogin(profile.profileId, 'Codex sign-in process stopped before completion.');
      }
    });
    pending.timer = setTimeout(() => {
      void this.cancelLogin(profile.profileId, { reason: 'Codex sign-in code expired.' });
    }, LOGIN_TTL_MS);
    pending.timer.unref?.();
    this.emitChange({ type: 'login-started', profileId: profile.profileId });
    return {
      profile: this.publicProfile(profile),
      login: this.publicProfile(profile).login,
    };
  }

  async finishLogin(profileId, completion = {}) {
    const pending = this.pendingLogins.get(profileId);
    const profile = this.getProfile(profileId);
    if (!pending || !profile || pending.settling) return;
    pending.settling = true;
    clearTimeout(pending.timer);
    try {
      if (completion.success !== true) {
        throw new Error(completion.error || 'Codex sign-in failed');
      }
      const accountResult = await pending.client.request('account/read', { refreshToken: false });
      const account = accountResult?.account || null;
      if (!account) throw new Error('Codex sign-in completed without an account');
      const identity = readCodexProfileIdentity(profile.homePath, account);
      if (pending.expectedAccountKey && identity.accountKey !== pending.expectedAccountKey) {
        await pending.client.request('account/logout', {}).catch(() => {});
        throw Object.assign(new Error('A different Codex account was selected. Sign in with the account shown in this row.'), {
          code: 'account_mismatch',
        });
      }
      const duplicate = [...this.profiles.values()].find((candidate) => (
        candidate.profileId !== profileId
        && candidate.accountKey
        && candidate.accountKey === identity.accountKey
      ));
      if (duplicate) {
        await pending.client.request('account/logout', {}).catch(() => {});
        if (pending.created) {
          this.profiles.delete(profileId);
          this.latestResults.delete(profileId);
          await fs.promises.rm(profile.homePath, { recursive: true, force: true }).catch(() => {});
        }
        this.pendingLogins.delete(profileId);
        pending.client.close();
        this.emitChange({
          type: 'login-failed',
          profileId,
          error: `This Codex account is already connected as ${duplicate.label}.`,
        });
        return;
      }
      this.updateProfileFromAccount(profile, account, { status: 'connected', error: null });
      const rateLimits = await pending.client.request('account/rateLimits/read', {}).catch(() => null);
      this.latestResults.set(profileId, { profile, account, rateLimits, error: null });
      this.pendingLogins.delete(profileId);
      pending.client.close();
      this.emitChange({ type: 'login-completed', profileId });
    } catch (error) {
      pending.client.close();
      this.pendingLogins.delete(profileId);
      profile.status = profile.accountKey ? 'error' : 'signed_out';
      profile.lastError = error?.message || String(error);
      profile.lastCheckedAt = this.now();
      this.emitChange({ type: 'login-failed', profileId, error: profile.lastError });
    }
  }

  failPendingLogin(profileId, message) {
    const pending = this.pendingLogins.get(profileId);
    const profile = this.getProfile(profileId);
    if (!pending || !profile) return;
    clearTimeout(pending.timer);
    this.pendingLogins.delete(profileId);
    profile.status = profile.accountKey ? 'error' : 'signed_out';
    profile.lastError = message;
    profile.lastCheckedAt = this.now();
    this.emitChange({ type: 'login-failed', profileId, error: message });
  }

  async cancelLogin(profileId, { reason = null } = {}) {
    const pending = this.pendingLogins.get(profileId);
    const profile = this.getProfile(profileId);
    if (!pending || !profile) return false;
    pending.settling = true;
    clearTimeout(pending.timer);
    await pending.client.request('account/login/cancel', { loginId: pending.loginId }).catch(() => {});
    pending.client.close();
    this.pendingLogins.delete(profileId);
    profile.status = 'signed_out';
    profile.lastError = reason;
    profile.lastCheckedAt = this.now();
    this.emitChange({ type: 'login-cancelled', profileId, error: reason });
    return true;
  }

  async logout(profileId) {
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error('Codex account profile not found');
    if (this.pendingLogins.has(profileId)) await this.cancelLogin(profileId);
    const client = this.clientFactory({ codexHome: profile.homePath });
    try {
      await client.start();
      await client.request('account/logout', {});
    } finally {
      client.close();
    }
    profile.status = 'signed_out';
    profile.lastError = null;
    profile.lastCheckedAt = this.now();
    this.latestResults.delete(profileId);
    this.emitChange({ type: 'logout-completed', profileId });
    return this.publicProfile(profile);
  }

  async removeProfile(profileId) {
    const profile = this.getProfile(profileId);
    if (!profile) return false;
    if (profile.isDefault) throw new Error('The default Codex profile cannot be removed');
    if (this.pendingLogins.has(profileId)) await this.cancelLogin(profileId);
    if (profile.status === 'connected' || profile.accountKey) {
      await this.logout(profileId).catch(() => {});
    }
    this.profiles.delete(profileId);
    this.latestResults.delete(profileId);
    const resolvedRoot = path.resolve(this.profilesRoot);
    const resolvedHome = path.resolve(profile.homePath);
    if (resolvedHome.startsWith(`${resolvedRoot}${path.sep}`)) {
      await fs.promises.rm(resolvedHome, { recursive: true, force: true }).catch(() => {});
    }
    this.emitChange({ type: 'profile-removed', profileId });
    return true;
  }

  shutdown() {
    for (const pending of this.pendingLogins.values()) {
      clearTimeout(pending.timer);
      pending.client.close();
    }
    this.pendingLogins.clear();
  }
}

module.exports = {
  CODEX_ACCOUNT_PROFILES_KEY,
  DEFAULT_PROFILE_ID,
  LOGIN_TTL_MS,
  CodexAppServerClient,
  CodexAccountProfileManager,
  buildCodexProcessPath,
  hashCodexAccountKey,
  maskCodexEmail,
  readCodexProfileIdentity,
};
