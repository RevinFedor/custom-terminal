const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const BROWSER_SELECTION_CAPABILITY = Object.freeze({
  version: 1, field: 'browserId', jobOwnerPinned: true, offlinePreflight: true,
});

function browserError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function browserInstanceId(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function normalizeBrowserId(value) {
  if (value === undefined) return undefined;
  if (value === 'chrome' || value === 'yandex') return value;
  const id = browserInstanceId(value);
  if (!id) throw browserError('external_research_browser_id_invalid',
    'browserId must be chrome, yandex or a registered profile UUID', 400);
  return id;
}

function assertBrowserSelectionCapability(capabilities) {
  const value = capabilities?.browserSelection;
  if (value?.version !== 1 || value.field !== 'browserId'
    || value.jobOwnerPinned !== true || value.offlinePreflight !== true) {
    throw browserError('external_research_browser_update_required',
      'Update SC Desktop for explicit/pinned research browser selection; no start was attempted', 503);
  }
}

function configuredBrowserInstanceId(selector, capabilities) {
  const direct = browserInstanceId(selector);
  if (direct) return direct;
  const configured = capabilities?.browserSelection?.configuredTargets;
  if (configured?.version !== 1 || configured.state !== 'known') {
    throw browserError('external_research_browser_mapping_unavailable',
      'SC Desktop configured browser mapping is unavailable; no start was attempted', 503);
  }
  const id = browserInstanceId(configured.aliases?.[selector]);
  if (!id) throw browserError('external_research_browser_unconfigured', 'Selected research browser profile is not configured');
  return id;
}

function publicBrowserAccount(value) {
  const id = input => typeof input === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input);
  if (value?.source !== 'browser_auth_session' || !id(value.user_id) || !id(value.account_id)
    || !Number.isSafeInteger(value.observed_at) || value.observed_at <= 0) return null;
  return { user_id: value.user_id, account_id: value.account_id, source: value.source,
    observed_at: value.observed_at, binding: value.binding === 'before_send' ? 'before_send' : 'read' };
}

function exactBrowserOwner(snapshot, jobId) {
  return snapshot?.id === jobId ? browserInstanceId(snapshot.browserInstanceId) : null;
}

function assertBrowserOwner(run, snapshot) {
  const id = exactBrowserOwner(snapshot, run.externalResearchJobId);
  const expected = run.externalResearchBrowserInstanceId || run.externalResearchExpectedBrowserInstanceId
    || browserInstanceId(run.externalResearchIntent?.browserId);
  if (id && expected && id !== expected) {
    throw browserError('external_research_browser_owner_mismatch', 'SC job browser does not match the saved research owner');
  }
  if (!id && (expected || run.externalResearchIntent?.browserId)) {
    throw browserError('external_research_browser_owner_unproven', 'Exact SC job browser owner is unavailable', 503);
  }
  return id;
}

function assertExactResearchSnapshot(run, snapshot) {
  if (snapshot?.id !== run.externalResearchJobId) {
    throw browserError('external_research_job_mismatch', 'SC Desktop returned a different research job id');
  }
  return assertBrowserOwner(run, snapshot);
}

function isOfflineBrowserPreflight(error) {
  const body = error?.body;
  return error?.code === 'BROWSER_UNAVAILABLE' && body?.availability === 'profile_offline'
    && body.preflightOnly === true && body.deliveryUnknown === false && body.retrySafe === true
    && !!browserInstanceId(body.browserInstanceId);
}

module.exports = { BROWSER_SELECTION_CAPABILITY, browserError, browserInstanceId, normalizeBrowserId,
  assertBrowserSelectionCapability, publicBrowserAccount, exactBrowserOwner, assertBrowserOwner,
  isOfflineBrowserPreflight, configuredBrowserInstanceId, assertExactResearchSnapshot };
