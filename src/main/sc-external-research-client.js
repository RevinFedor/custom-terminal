const path = require('path');
const { normalizeBrowserId, assertBrowserSelectionCapability } = require('./external-research-browser');

const DEFAULT_SC_RESEARCH_URL = process.env.NOTED_SC_RESEARCH_URL || 'http://127.0.0.1:53127';
const MAX_FILES = 1000;

class ScExternalResearchHttpError extends Error {
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.name = 'ScExternalResearchHttpError';
    this.status = status;
    this.statusCode = status;
    this.code = code || null;
    this.body = body;
  }
}

function normalizeExternalResearchFiles(files) {
  if (files == null) return [];
  if (!Array.isArray(files)) throw new Error('files must be an array');
  if (files.length > MAX_FILES) throw new Error(`files exceeds the ${MAX_FILES}-item limit`);
  return files.map((item, index) => {
    const value = typeof item === 'string' ? { path: item } : item;
    if (!value || typeof value !== 'object') throw new Error(`files[${index}] must be a path or descriptor`);
    const filePath = String(value.path || '').trim();
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new Error(`files[${index}].path must be absolute`);
    }
    const normalized = { path: filePath };
    if (value.name != null && String(value.name).trim()) normalized.name = String(value.name).trim();
    if (value.lines != null && String(value.lines).trim()) {
      const lines = String(value.lines).trim();
      const match = lines.match(/^(\d+)(?:-(\d+))?$/);
      if (!match || Number(match[1]) < 1 || (match[2] && Number(match[2]) < Number(match[1]))) {
        throw new Error(`files[${index}].lines must be an inclusive positive range such as 10-80`);
      }
      normalized.lines = lines;
    }
    if (normalized.lines && (value.startLine != null || value.endLine != null)) {
      throw new Error(`files[${index}] must use lines or startLine/endLine, not both`);
    }
    if (value.startLine != null) {
      const startLine = Number(value.startLine);
      if (!Number.isInteger(startLine) || startLine < 1) throw new Error(`files[${index}].startLine must be a positive integer`);
      normalized.startLine = startLine;
    }
    if (value.endLine != null) {
      const endLine = Number(value.endLine);
      if (!Number.isInteger(endLine) || endLine < 1) throw new Error(`files[${index}].endLine must be a positive integer`);
      normalized.endLine = endLine;
    }
    if (normalized.startLine && normalized.endLine && normalized.startLine > normalized.endLine) {
      throw new Error(`files[${index}] line range is reversed`);
    }
    return normalized;
  });
}

async function responseJson(response) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new ScExternalResearchHttpError(
      body?.error || `SC Desktop returned HTTP ${response.status}`,
      { status: response.status, code: body?.code || null, body },
    );
  }
  return body;
}

class ScExternalResearchClient {
  constructor({
    baseUrl = DEFAULT_SC_RESEARCH_URL,
    fetchImpl = globalThis.fetch,
    capabilityTimeoutMs = 5_000,
    startTimeoutMs = 45_000,
    statusOverheadMs = 5_000,
    stopTimeoutMs = 10_000,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.capabilityTimeoutMs = capabilityTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.statusOverheadMs = statusOverheadMs;
    this.stopTimeoutMs = stopTimeoutMs;
  }

  async _request(url, init, timeoutMs) {
    const controller = new AbortController();
    const outerSignal = init?.signal;
    let timedOut = false;
    const relayAbort = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) relayAbort();
    else outerSignal?.addEventListener?.('abort', relayAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, Number(timeoutMs) || 1));
    try {
      const response = await this.fetch(url, { ...(init || {}), signal: controller.signal });
      // Fetch resolves at headers. Keep the existing deadline and caller abort
      // attached until the body is consumed as well.
      return await responseJson(response);
    } catch (cause) {
      if (timedOut) {
        throw new ScExternalResearchHttpError('SC Desktop research request timed out', {
          code: 'sc_research_request_timeout',
        });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener?.('abort', relayAbort);
    }
  }

  async capabilities({ signal } = {}) {
    return this._request(
      `${this.baseUrl}/research-capabilities`,
      { signal },
      this.capabilityTimeoutMs,
    );
  }

  async start({ jobId, provider, prompt, options, files, conversationUrl, browserId }, { signal, beforeStart } = {}) {
    if (options && (Object.hasOwn(options, 'browserId') || Object.hasOwn(options, 'browserInstanceId'))) {
      throw Object.assign(new Error('Use top-level browserId, not options, for research browser selection'),
        { code: 'external_research_browser_id_invalid', statusCode: 400 });
    }
    const selected = normalizeBrowserId(browserId);
    if (selected) assertBrowserSelectionCapability(await this.capabilities({ signal }));
    if (beforeStart && !await beforeStart()) return null;
    return this._request(`${this.baseUrl}/research-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        requestId: jobId,
        provider,
        prompt,
        options: options || {},
        files: normalizeExternalResearchFiles(files),
        ...(conversationUrl ? { conversationUrl } : {}),
        ...(selected ? { browserId: selected } : {}),
      }),
    }, this.startTimeoutMs);
  }

  async status(jobId, { waitMs = 0, signal } = {}) {
    const wait = Math.max(0, Math.min(60_000, Number(waitMs) || 0));
    return this._request(
      `${this.baseUrl}/research-status?id=${encodeURIComponent(jobId)}&wait=${wait}`,
      { signal },
      wait + this.statusOverheadMs,
    );
  }

  async jobMetadata(jobId, { capabilities, signal } = {}) {
    const supported = capabilities || await this.capabilities({ signal });
    assertBrowserSelectionCapability(supported);
    if (supported.browserSelection.jobMetadataReadOnly !== true) {
      throw Object.assign(new Error('Update SC Desktop for effect-free exact research job metadata'),
        { code: 'external_research_browser_update_required', statusCode: 503 });
    }
    const metadata = await this._request(`${this.baseUrl}/research-status?id=${encodeURIComponent(jobId)}&metadataOnly=true`,
      { signal }, this.statusOverheadMs);
    if (metadata?.id !== jobId || metadata.metadataOnly !== true
      || !['memory', 'durable'].includes(metadata.metadataSource)) {
      throw Object.assign(new Error('SC Desktop did not confirm exact read-only job metadata'),
        { code: 'external_research_browser_metadata_unproven', statusCode: 503 });
    }
    return metadata;
  }

  async operationalRecheck(jobId, { checkId, controlEpoch, browserInstanceId, capabilities, signal } = {}) {
    try { return await this._operationalRecheck(jobId, { checkId, controlEpoch, browserInstanceId, capabilities, signal }); }
    catch (error) {
      // A failed read-only probe is never an authoritative provider verdict.
      // Preserve the typed HTTP/correlation error for same-intent recovery.
      error.operationalCheckOnly = true;
      throw error;
    }
  }

  async _operationalRecheck(jobId, { checkId, controlEpoch, browserInstanceId, capabilities, signal }) {
    if (typeof checkId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(checkId)
      || typeof controlEpoch !== 'string' || !controlEpoch || typeof browserInstanceId !== 'string' || !browserInstanceId) {
      throw new ScExternalResearchHttpError('Exact operational check identity is required', { code: 'sc_research_check_identity_invalid', status: 400 });
    }
    const supported = capabilities || await this.capabilities({ signal });
    const feature = supported?.execution?.operationalRecheck;
    if (feature?.version !== 1 || feature.observational !== true || feature.durableReceipt !== true
      || feature.endpoint !== '/research-recheck') throw new ScExternalResearchHttpError('Update SC Desktop for a correlated operational check', {
      code: 'sc_research_operational_recheck_unavailable', status: 503 });
    // Separate bounded observational RPC, not a new Send preparation deadline.
    // It covers at most two existing 8-second worker/reader checks plus I/O.
    const result = await this._request(`${this.baseUrl}/research-recheck`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ version: 1, jobId, checkId, controlEpoch, browserInstanceId }),
    }, 20_000 + this.statusOverheadMs);
    const check = result?.check;
    if (result?.ok !== true || check?.version !== 1 || check.state !== 'complete' || check.checkId !== checkId
      || check.jobId !== jobId || check.controlEpoch !== controlEpoch || check.browserInstanceId !== browserInstanceId
      || !Number.isFinite(check.startedAt) || !Number.isFinite(check.completedAt)
      || !['open', 'healthy', 'settled', 'changed', 'unconfirmed'].includes(check.verdict)
      || result.execution?.version !== 1 || result.execution.controlEpoch !== controlEpoch
      || typeof result.current !== 'boolean') throw new ScExternalResearchHttpError('SC did not certify the exact completed operational check', {
      code: 'sc_research_operational_check_unproven', status: 503 });
    return result;
  }

  async stop(jobId, { signal } = {}) {
    return this._request(`${this.baseUrl}/research-stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ id: jobId }),
    }, this.stopTimeoutMs);
  }

  async openBrowser(jobId, { requestId, signal } = {}) {
    const capabilities = await this.capabilities({ signal });
    if (capabilities?.browserNavigation?.version !== 1
      || capabilities.browserNavigation.exactJob !== true || capabilities.browserNavigation.confirmedTab !== true) {
      throw new ScExternalResearchHttpError('Обновите SC Desktop: переход к вкладке research в браузере недоступен', {
        code: 'sc_research_browser_navigation_unavailable',
      });
    }
    const result = await this._request(`${this.baseUrl}/research-open-browser`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ jobId, requestId }),
    }, 15_000);
    if (result?.ok !== true || result.opened !== true || result.jobId !== jobId
      || result.requestId !== requestId || !Number.isInteger(result.tabId) || result.tabId < 0) {
      throw new ScExternalResearchHttpError('SC Desktop не подтвердил переход к вкладке research в браузере', {
        code: 'sc_research_browser_navigation_not_confirmed',
      });
    }
    return result;
  }

  async openJob(jobId, { requestId, signal } = {}) {
    const capabilities = await this.capabilities({ signal });
    if (capabilities?.navigation?.version !== 1 || capabilities.navigation.renderedAck !== true) {
      throw new ScExternalResearchHttpError('Обновите SC Desktop: переход к research-задаче недоступен', {
        code: 'sc_research_navigation_unavailable',
      });
    }
    const result = await this._request(`${this.baseUrl}/research-open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ jobId, requestId }),
    }, 20_000);
    if (result?.ok !== true || result.opened !== true || result.jobId !== jobId || result.requestId !== requestId) {
      throw new ScExternalResearchHttpError('SC Desktop не подтвердил открытие этой задачи', { code: 'sc_research_navigation_not_confirmed' });
    }
    return result;
  }
}

function isScResearchNotFound(error) {
  return error?.status === 404 || error?.statusCode === 404;
}

function isScResearchTerminalStatus(value) {
  return value === 'done' || value === 'error';
}

module.exports = {
  DEFAULT_SC_RESEARCH_URL,
  MAX_FILES,
  ScExternalResearchClient,
  ScExternalResearchHttpError,
  normalizeExternalResearchFiles,
  isScResearchNotFound,
  isScResearchTerminalStatus,
};
