const crypto = require('crypto');
const { normalizeExternalResearchFiles } = require('./sc-external-research-client');

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
  const provider = String(body.provider || 'chatgpt').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error('provider must be chatgpt, claude, or perplexity');
  }
  const prompt = String(body.prompt ?? body.text ?? '').trim();
  if (!prompt) throw new Error('prompt required');
  const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
    ? stableValue(body.options)
    : {};
  const files = normalizeExternalResearchFiles(body.files ?? body.attachments ?? []);
  if (files.length > 0 && provider !== 'chatgpt') {
    throw new Error('files are currently supported only for provider=chatgpt');
  }
  const conversationUrl = String(body.conversationUrl || body.continueUrl || '').trim();
  if (conversationUrl && provider !== 'chatgpt') {
    throw new Error('conversationUrl is supported only for provider=chatgpt');
  }
  return { provider, prompt, options, files, conversationUrl };
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

function continuationRequest(previous, body = {}) {
  if (previous?.runKind !== 'external-research') throw new Error('previousRunId is not an external research run');
  if (previous.status !== 'completed' || previous.resultComplete !== true) {
    throw new Error('previous external research result is not complete');
  }
  const conversationUrl = String(previous.externalResearchConversationUrl || '').trim();
  if (!conversationUrl) throw new Error('previous external research result has no conversationUrl');
  const previousIntent = previous.externalResearchIntent || {};
  const nextOptions = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
    ? { ...(previousIntent.options || {}), ...body.options }
    : previousIntent.options;
  return normalizeExternalResearchRequest({
    provider: previousIntent.provider || previous.externalResearchProvider,
    prompt: body.prompt ?? body.text,
    options: nextOptions,
    files: body.files ?? body.attachments,
    conversationUrl,
  });
}

module.exports = {
  PROVIDERS,
  externalResearchJobId,
  normalizeExternalResearchRequest,
  externalResearchRequestFingerprint,
  externalResearchTargetLabel,
  continuationRequest,
};
