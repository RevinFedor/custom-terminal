const crypto = require('crypto');
const { normalizeExternalResearchFiles } = require('./sc-external-research-client');
const { normalizeBrowserId, browserError, browserInstanceId, exactBrowserOwner,
  configuredBrowserInstanceId } = require('./external-research-browser');

const PROVIDERS = new Set(['chatgpt', 'claude', 'perplexity']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = stableValue(value[key]);
  }
  return out;
}

function externalResearchJobId(runId) {
  const value = String(runId || '').trim();
  if (!value) throw new Error('runId required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,193}$/.test(value)) {
    throw new Error('external research runId must be 2-194 characters using letters, digits, _ or -');
  }
  return `noted_${value}`;
}

function normalizeExternalResearchRequest(body = {}) {
  if (Object.hasOwn(body, 'browserInstanceId')) throw new Error('Use browserId to select a research profile');
  const provider = String(body.provider || 'chatgpt').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error('provider must be chatgpt, claude, or perplexity');
  }
  const prompt = String(body.prompt ?? body.text ?? '').trim();
  if (!prompt) throw new Error('prompt required');
  const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
    ? stableValue(body.options)
    : {};
  if (Object.hasOwn(options, 'browserId') || Object.hasOwn(options, 'browserInstanceId')) {
    throw new Error('Use top-level browserId, not options, for research browser selection');
  }
  const browserId = normalizeBrowserId(body.browserId);
  const files = normalizeExternalResearchFiles(body.files ?? body.attachments ?? []);
  if (files.length > 0 && provider !== 'chatgpt') {
    throw new Error('files are currently supported only for provider=chatgpt');
  }
  const conversationUrl = String(body.conversationUrl || body.continueUrl || '').trim();
  if (conversationUrl && provider !== 'chatgpt') {
    throw new Error('conversationUrl is supported only for provider=chatgpt');
  }
  return { provider, prompt, options, files, conversationUrl, ...(browserId ? { browserId } : {}) };
}

function externalResearchRequestFingerprint({
  runId,
  sourceTabId,
  request,
  label,
  parentRunId,
  continueFromRunId,
  notifySource,
} = {}) {
  const value = stableValue({
    runId: String(runId || ''),
    sourceTabId: String(sourceTabId || ''),
    provider: request?.provider,
    prompt: request?.prompt,
    options: request?.options || {},
    files: request?.files || [],
    conversationUrl: request?.conversationUrl || '',
    ...(request?.browserId ? { browserId: request.browserId } : {}),
    label: String(label || ''),
    parentRunId: String(parentRunId || ''),
    continueFromRunId: String(continueFromRunId || ''),
    notifySource: notifySource !== false,
  });
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function externalResearchTargetLabel(request) {
  const provider = request.provider === 'chatgpt'
    ? 'ChatGPT'
    : request.provider === 'claude'
      ? 'Claude'
      : 'Perplexity';
  const model = String(request.options?.model || '').trim();
  return model ? `${provider} · ${model}` : provider;
}

function continuationRequest(previous, body = {}, { validateMode = true, existingRequest = null } = {}) {
  if (previous?.runKind !== 'external-research') throw new Error('previousRunId is not an external research run');
  if (previous.status !== 'completed' || previous.resultComplete !== true) {
    throw new Error('previous external research result is not complete');
  }
  const conversationUrl = String(previous.externalResearchConversationUrl || '').trim();
  if (!conversationUrl) throw new Error('previous external research result has no conversationUrl');
  const previousIntent = previous.externalResearchIntent || {};
  const oldMode = String(previousIntent.options?.mode || previous.externalResearchMode || '').trim().toLowerCase();
  const requestedMode = String(body.options?.mode || '').trim().toLowerCase();
  if (validateMode && (previousIntent.provider || previous.externalResearchProvider || 'chatgpt') === 'chatgpt'
    && ['chat', 'work'].includes(oldMode) && ['chat', 'work'].includes(requestedMode) && requestedMode !== oldMode) {
    throw Object.assign(new Error(`Saved ChatGPT conversation is ${oldMode}; continuation cannot change it to ${requestedMode}. Research was not started. Report the channel owner and wait for a context-preserving recovery decision.`),
      { code: 'external_research_continuation_mode_conflict', statusCode: 409 });
  }
  const nextOptions = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
    ? { ...(previousIntent.options || {}), ...body.options }
    : { ...(previousIntent.options || {}) };
  const operationOptions = ['readOnlyImport', 'composeOnly', 'importWaitForFinal', 'importTimeoutMs', 'importIncludeActivity'];
  // A follow-up is an author operation, even when the previous result arrived
  // through a read-only import. Only presentation/model preferences inherit.
  // Preserve normalization of already frozen legacy operations for SAME-ID
  // replay: never silently rewrite an accepted observer into a new Send.
  const legacyReplay = existingRequest && operationOptions.some(key => Object.hasOwn(existingRequest.options || {}, key));
  if (!legacyReplay) for (const key of operationOptions) delete nextOptions[key];
  return normalizeExternalResearchRequest({
    provider: previousIntent.provider || previous.externalResearchProvider,
    prompt: body.prompt ?? body.text,
    options: nextOptions,
    files: body.files ?? body.attachments,
    conversationUrl,
    browserId: body.browserId,
  });
}

async function resolveExternalResearchBrowserBinding({ request, previous, existingRun, capabilities, client, store }) {
  // Replays keep the originally reserved target, not today's alias/primary.
  if (existingRun) return existingRun.externalResearchExpectedBrowserInstanceId || null;
  const selected = request.browserId ? configuredBrowserInstanceId(request.browserId, capabilities) : null;
  if (!previous) return selected;
  const previousRunId = previous.runId;
  const previousJobId = previous.externalResearchJobId;
  const previousUrl = previous.externalResearchConversationUrl;
  let owner = browserInstanceId(previous.externalResearchBrowserInstanceId);
  if (!owner && previous.externalResearchJobId) {
    const metadata = await client.jobMetadata(previousJobId, { capabilities });
    owner = exactBrowserOwner(metadata, previousJobId);
    if (owner) await store.recordExternalResearchBrowser(previousRunId, metadata, { allowTerminal: true });
  }
  if (!owner) throw browserError('external_research_browser_owner_unproven',
    'The previous exact SC job browser owner is unavailable; continuation was not started');
  if (selected && selected !== owner) throw browserError('external_research_browser_owner_mismatch',
    'Continuation must use the previous SC job browser profile');
  const current = await store.getInternal(previousRunId);
  if (!current || current.runKind !== 'external-research' || current.status !== 'completed'
    || current.resultComplete !== true || current.externalResearchJobId !== previousJobId
    || current.externalResearchConversationUrl !== previousUrl
    || current.externalResearchBrowserInstanceId !== owner) {
    throw browserError('external_research_browser_owner_unproven', 'Previous research owner changed during continuation preparation');
  }
  return owner;
}

module.exports = {
  PROVIDERS,
  externalResearchJobId,
  normalizeExternalResearchRequest,
  externalResearchRequestFingerprint,
  externalResearchTargetLabel,
  continuationRequest,
  resolveExternalResearchBrowserBinding,
};
