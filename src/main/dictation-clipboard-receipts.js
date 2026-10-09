'use strict';
const { createHash } = require('node:crypto');

// A receipt proves these exact bytes passed the focused xterm's input boundary.
// It does not claim that the agent submitted/accepted a prompt.
function clipboardTextDescriptor(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  return { textChars: normalized.length, textHash: createHash('sha256').update(normalized).digest('hex') };
}

class DictationClipboardReceipts {
  constructor({ now = Date.now, maxEntries = 64, log = line => console.log(line) } = {}) {
    this.now = now; this.maxEntries = maxEntries; this.log = log;
    this.entries = new Map(); this.pendingByTab = new Map();
  }
  sweep() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.status === 'pending' && entry.expiresAt <= now) this.finish(entry, 'timeout');
      if (entry.retainUntil <= now) this.entries.delete(id);
    }
  }
  view(entry) {
    return { requestId: entry.requestId, tabId: entry.tabId, status: entry.status,
      ...(entry.surface === 'editable' ? { surface: entry.surface, targetId: entry.targetId } : {}),
      captured: entry.status === 'captured', textChars: entry.textChars, textHash: entry.textHash,
      capturedAt: entry.capturedAt || null, lastObservedChars: entry.lastObservedChars ?? null,
      enterRequested: entry.enterRequested === true, enterWritten: entry.enterWritten === true };
  }
  prepare(body) {
    this.sweep();
    const { requestId, tabId, textChars, textHash, surface, targetId } = body || {};
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)
      || typeof tabId !== 'string' || !tabId.length || tabId.length > 1024 || /[\s\p{Cc}\p{Cf}]/u.test(tabId)
      || !Number.isInteger(textChars) || textChars < 1 || textChars > 8 * 1024 * 1024
      || typeof textHash !== 'string' || !/^[0-9a-f]{64}$/.test(textHash)
      || (surface !== undefined && surface !== 'editable')
      || (surface === 'editable' && (typeof targetId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(targetId)))) {
      return { ok: false, error: 'invalid-receipt-request' };
    }
    const existing = this.entries.get(requestId);
    if (existing) return existing.tabId === tabId && existing.textHash === textHash && existing.textChars === textChars
      && existing.surface === surface && existing.targetId === targetId
      ? { ok: true, ...this.view(existing) } : { ok: false, error: 'receipt-conflict' };
    const pendingKey = surface === 'editable' ? 'field:' + targetId : tabId;
    if (this.entries.size >= this.maxEntries || this.pendingByTab.has(pendingKey))
      return { ok: false, error: 'receipt-busy' };
    const now = this.now();
    const entry = { requestId, tabId, textChars, textHash, surface, targetId, pendingKey, status: 'pending',
      expiresAt: now + 15000, retainUntil: now + 60000, waiters: new Set() };
    this.entries.set(requestId, entry); this.pendingByTab.set(pendingKey, entry);
    this.log('[DictationClipboard] prepare id=' + requestId + ' tab=' + tabId.slice(-12) + ' chars=' + textChars);
    return { ok: true, ...this.view(entry) };
  }
  finish(entry, status) {
    if (entry.status !== 'pending') return;
    entry.status = status;
    if (status === 'captured') entry.capturedAt = this.now();
    if (this.pendingByTab.get(entry.pendingKey) === entry) this.pendingByTab.delete(entry.pendingKey);
    this.log('[DictationClipboard] settle id=' + entry.requestId + ' status=' + status
      + ' observedChars=' + (entry.lastObservedChars ?? '-') + ' expectedChars=' + entry.textChars);
    for (const resolve of entry.waiters) resolve(this.view(entry));
    entry.waiters.clear();
  }
  observeWritten(tabId, data, enterRequestId, writer) {
    const enter = enterRequestId && this.entries.get(enterRequestId);
    if (enter?.status === 'captured' && enter.tabId === tabId && enter.enterRequested && data === '\r') {
      enter.enterWritten = true;
      this.log('[DictationClipboard] enter written id=' + enterRequestId + ' tab=' + tabId.slice(-12));
    }
    const entry = this.pendingByTab.get(tabId);
    if (!entry || typeof data !== 'string') return;
    if (entry.expiresAt <= this.now()) return this.finish(entry, 'timeout');
    const text = data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~') ? data.slice(6, -6) : data;
    const descriptor = clipboardTextDescriptor(text);
    entry.lastObservedChars = descriptor.textChars;
    if (descriptor.textChars === entry.textChars && descriptor.textHash === entry.textHash) {
      if (writer && typeof writer === 'object') entry.writerRef = new WeakRef(writer);
      this.finish(entry, 'captured');
    }
    else this.log('[DictationClipboard] unmatched id=' + entry.requestId + ' observedChars=' + descriptor.textChars);
  }
  prepareField(body, senderId) {
    if (body?.surface !== 'editable' || !Number.isInteger(senderId)) return { ok: false, error: 'invalid-editable-owner' };
    const prior = this.entries.get(body.requestId);
    if (prior && prior.senderId !== senderId) return { ok: false, error: 'editable-owner-changed' };
    const result = this.prepare(body);
    if (result.ok) this.entries.get(body.requestId).senderId = senderId;
    return result;
  }
  observeField(report, senderId) {
    const entry = this.entries.get(report?.requestId);
    if (!entry || entry.surface !== 'editable' || entry.senderId !== senderId || entry.targetId !== report.targetId
      || entry.tabId !== report.tabId || entry.status !== 'pending') return false;
    if (entry.expiresAt <= this.now()) { this.finish(entry, 'timeout'); return false; }
    entry.lastObservedChars = report.observedChars ?? null;
    const exact = report.textHash === entry.textHash && report.textChars === entry.textChars;
    this.finish(entry, report.status === 'captured' && exact ? 'captured' : 'unconfirmed');
    return true;
  }
  pressFieldEnter(request, senderId, press) {
    const entry = this.entries.get(request?.requestId);
    if (!entry || entry.surface !== 'editable' || entry.status !== 'captured' || entry.senderId !== senderId
      || entry.targetId !== request.targetId || !entry.enterRequested || entry.pressRequested)
      return { ok: false, error: 'editable-enter-unavailable' };
    entry.pressRequested = true;
    press(); return { ok: true };
  }
  async wait(requestId, waitMs = 10000) {
    this.sweep();
    const entry = this.entries.get(requestId);
    if (!entry) return { requestId, captured: false, status: 'unknown' };
    if (entry.status !== 'pending') return this.view(entry);
    if (entry.waiters.size >= 4) return { ...this.view(entry), error: 'too-many-waiters' };
    return new Promise(resolve => {
      let timer;
      const done = value => { clearTimeout(timer); entry.waiters.delete(done); resolve(value); };
      entry.waiters.add(done);
      timer = setTimeout(() => {
        if (entry.expiresAt <= this.now()) this.finish(entry, 'timeout');
        done(this.view(entry));
      }, Math.max(0, Math.min(Number(waitMs) || 0, 10000)));
    });
  }
  release(requestId) {
    const entry = this.entries.get(requestId);
    if (entry?.status === 'pending') this.finish(entry, 'unconfirmed');
    return entry ? this.view(entry) : { requestId, captured: false, status: 'unknown' };
  }
  async enter(requestId) {
    this.sweep();
    const entry = this.entries.get(requestId);
    if (!entry || entry.status !== 'captured') return { requestId, captured: false, enterWritten: false, error: 'capture-not-confirmed' };
    if (entry.enterRequested) return this.view(entry); // no repeat after lost ACK
    entry.enterRequested = true;
    try {
      if (entry.surface === 'editable') {
        const result = await this.editableEnterWriter?.(entry);
        entry.enterWritten = result?.delivered === true && result.requestId === requestId;
        return this.view(entry);
      }
      if (typeof this.enterWriter !== 'function') throw Error('enter-writer-unavailable');
      await this.enterWriter(entry.tabId, entry.requestId, entry.writerRef?.deref());
    } catch (error) {
      this.log('[DictationClipboard] enter unconfirmed id=' + requestId + ' reason=' + error.message);
    }
    return this.view(entry);
  }
}
const dictationClipboardReceipts = new DictationClipboardReceipts();

async function handleDictationClipboardHttp({ req, res, parsed, checkAuth, readBody, sendJson,
  registry = dictationClipboardReceipts, pid = process.pid, armEditable, releaseEditable }) {
  const prefix = '/api/dictation-clipboard/receipts';
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(prefix + '/')) return false;
  if (!checkAuth(req)) { sendJson(res, 401, { ok: false, error: 'unauthorized' }); return true; }
  if (parsed.pathname === prefix && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { sendJson(res, 400, { ok: false, error: 'bad-body' }); return true; }
    if (body?.expectedPid !== pid) { sendJson(res, 409, { ok: false, error: 'terminal-instance-changed' }); return true; }
    let result;
    try { result = body?.surface === 'editable'
      ? await armEditable?.(body) || { ok: false, error: 'editable-bridge-unavailable' }
      : registry.prepare(body); }
    catch { result = { ok: false, error: 'editable-bridge-unavailable' }; }
    sendJson(res, result.ok ? 200 : 409, { ...result, instancePid: pid }); return true;
  }
  if (req.method === 'POST' && parsed.pathname.startsWith(prefix + '/') && parsed.pathname.endsWith('/enter')) {
    let body;
    try { body = await readBody(req); } catch { sendJson(res, 400, { ok: false, error: 'bad-body' }); return true; }
    if (body?.expectedPid !== pid) { sendJson(res, 409, { ok: false, error: 'terminal-instance-changed' }); return true; }
    const requestId = parsed.pathname.slice(prefix.length + 1, -6);
    const result = await registry.enter(requestId);
    sendJson(res, 200, { ok: true, instancePid: pid, ...result }); return true;
  }
  if (req.method === 'GET' && parsed.pathname.startsWith(prefix + '/')) {
    const requestId = parsed.pathname.slice(prefix.length + 1);
    const result = await registry.wait(requestId, parsed.query?.waitMs);
    sendJson(res, 200, { ok: true, instancePid: pid, ...result }); return true;
  }
  if (req.method === 'DELETE' && parsed.pathname.startsWith(prefix + '/')) {
    const result = registry.release(parsed.pathname.slice(prefix.length + 1));
    if (result.surface === 'editable') {
      try { await releaseEditable?.({ requestId: result.requestId, targetId: result.targetId,
        noDispatch: parsed.query?.noDispatch === '1' }); } catch { /* expiry still bounds the lease */ }
    }
    sendJson(res, 200, { ok: true, instancePid: pid, ...result }); return true;
  }
  sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return true;
}
module.exports = { clipboardTextDescriptor, DictationClipboardReceipts, dictationClipboardReceipts, handleDictationClipboardHttp };
