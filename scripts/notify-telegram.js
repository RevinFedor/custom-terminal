'use strict';
// Telegram delivery for a plain shell command, used by the `-tg` script suffix.
//
// WHY A SEPARATE PATH FROM `notify_user`:
// The Terminal MCP notification is addressed FROM an AI tab — the HTTP route
// validates that the sender is a live Claude/Codex session and refuses anything
// else (`source_agent_tab_not_found`). `npm run build:i-obs-tg` has no such
// sender: it is a shell command in a terminal. So this module speaks to the
// same SC Desktop receiver directly, with the same envelope shape and the same
// bearer token Noted itself uses.
//
// WHAT IT DOES NOT DO: it does not read, pause, Stop, or otherwise touch the
// build. The command owns its own exit status; this only reports it afterwards.
// A failed notification never changes the command's exit code — the build
// already happened, and hiding its result behind a messaging error would be
// strictly worse than a missing message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const SC_TERMINAL_USER_URL = 'http://127.0.0.1:53127/notifications/terminal-user';
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), 'Library', 'Application Support',
  'sc-desktop', 'notification-bridge-token');

// Same override Noted itself honours (`sc-desktop-notification-client.js`), so
// a relocated SC Desktop install does not need two different settings.
function resolveTokenPath(explicit) {
  const configured = String(explicit || process.env.SC_DESKTOP_NOTIFICATION_TOKEN_PATH || '').trim();
  if (!configured) return DEFAULT_TOKEN_PATH;
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}
// The receiver's own limit. Text is trimmed to fit rather than refused: a
// truncated report still tells the user the command finished.
const MAX_TEXT = 2000;
const TIMEOUT_MS = 8000;

function readToken(tokenPath) {
  try {
    const raw = fs.readFileSync(resolveTokenPath(tokenPath), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * The exact envelope `sc-desktop-notification-client.js` builds, so both
 * producers stay interchangeable for the receiver. `eventId` is derived from
 * (tabId, requestId) the same way, which is what makes a repeat idempotent
 * instead of a second message.
 */
function buildEnvelope({ text, label, requestId, projectId = 'custom-terminal', now = Date.now() }) {
  const clean = String(text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (!clean) throw new Error('text required');
  const tabId = 'shell:' + String(label || 'command').replace(/[^\w.:-]+/g, '-').slice(0, 80);
  const id = String(requestId || '').trim() || (tabId + ':' + now);
  return {
    kind: 'terminal-user',
    eventId: 'terminal-user:' + createHash('sha256').update(JSON.stringify([tabId, id])).digest('hex'),
    projectId,
    tabId,
    requestId: id.slice(0, 128),
    tabName: String(label || 'Terminal').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Terminal',
    text: clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT - 1) + '…' : clean,
    createdAt: now,
    waitSeconds: 0,
  };
}

/**
 * Send one notification. Never throws: the caller is a build wrapper whose own
 * result matters more than the message about it.
 *
 * @returns {Promise<{ok: boolean, reason?: string, status?: number, messageId?: number}>}
 */
async function notifyTelegram(detail = {}, { fetchImpl = globalThis.fetch, tokenPath = null } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'fetch_unavailable' };
  const token = readToken(tokenPath);
  if (!token) return { ok: false, reason: 'token_unavailable' };
  let envelope;
  try { envelope = buildEnvelope(detail); }
  catch (error) { return { ok: false, reason: 'invalid_request', error: error.message }; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(SC_TERMINAL_USER_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      // 404 here means an SC Desktop that predates the terminal-user route,
      // not a lost message.
      return { ok: false, reason: response.status === 404 ? 'sc_desktop_update_required' : 'http_error',
        status: response.status, error: payload?.error || payload?.message || null };
    }
    if (payload?.ok !== true) return { ok: false, reason: 'invalid_response', status: response.status };
    return { ok: true, status: response.status, messageId: payload.deliveries?.[0]?.message_id ?? null,
      duplicate: payload.duplicate === true };
  } catch (error) {
    // SC Desktop not running is the ordinary case, not an error worth a stack.
    const refused = /ECONNREFUSED|fetch failed/i.test(String(error?.message || ''));
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : refused ? 'sc_desktop_unavailable' : 'network_error',
      error: error?.message || String(error) };
  }
}

/** Human-readable one-liner for the end of a command. */
function describeOutcome({ command, code, signal, startedAt, finishedAt = Date.now() }) {
  const seconds = Number.isFinite(startedAt) ? Math.max(0, Math.round((finishedAt - startedAt) / 1000)) : null;
  const duration = seconds === null ? ''
    : seconds < 60 ? ' за ' + seconds + ' с'
      : ' за ' + Math.floor(seconds / 60) + ' мин ' + (seconds % 60) + ' с';
  const name = String(command || 'команда').trim();
  if (signal) return name + ' — остановлена (' + signal + ')' + duration;
  if (code === 0) return name + ' — выполнена успешно' + duration;
  return name + ' — завершилась с ошибкой (код ' + code + ')' + duration;
}

module.exports = { notifyTelegram, buildEnvelope, describeOutcome, readToken, resolveTokenPath, MAX_TEXT };
