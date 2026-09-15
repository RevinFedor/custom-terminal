'use strict';

const { stripVTControlCharacters } = require('node:util');

// Value observation only. The caller must establish the exact command/owner
// and direct wrapper -> stdout relationship before treating this as evidence.
// No model catalog, environment, startup policy, clock or process state belongs
// here: in particular, a missing context suffix does not mean 200K or 1M.
function cleanText(value) {
  return stripVTControlCharacters(String(value || ''))
    .replace(/\u00a0|\u202f/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function unquote(value) {
  const text = cleanText(value);
  const quoted = text.match(/^(`+)([\s\S]*?)\1$/);
  return String(quoted?.[2] ?? text).trim();
}

function readStdout(record) {
  const content = record?.type === 'user' ? record?.message?.content
    : record?.type === 'system' && record?.subtype === 'local_command' ? record.content : null;
  if (typeof content !== 'string') return null;
  const match = cleanText(content).match(/^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/i);
  if (!match || /<\/?local-command-(?:stdout|stderr)>/i.test(match[1])) return null;
  return { rawOutput: content, outputText: cleanText(match[1]) };
}

function contextParts(value) {
  const contexts = [];
  let text = String(value || '').replace(/\[1m\](?=\s|\)|$)/gi, () => {
    contexts.push(1000000);
    return '';
  });
  const number = '(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*([km]?)';
  const contextPattern = new RegExp('\\((?:' + number
    + '\\s*(?:tokens?\\s+)?context(?:\\s+window)?|context(?:\\s+window)?\\s*[:=]\\s*'
    + number + '\\s*(?:tokens?)?)\\)', 'gi');
  text = text.replace(contextPattern, (_match, firstNumber, firstUnit, secondNumber, secondUnit) => {
    const amount = Number(String(firstNumber || secondNumber).replace(/,/g, ''));
    const unit = String(firstUnit || secondUnit || '').toLowerCase();
    const tokens = amount * (unit === 'm' ? 1000000 : unit === 'k' ? 1000 : 1);
    if (Number.isSafeInteger(tokens) && tokens > 0) contexts.push(tokens);
    return '';
  }).replace(/\s+/g, ' ').trim();
  const values = [...new Set(contexts)];
  return { text, contextTokens: values.length === 1 ? values[0] : null, conflicting: values.length > 1 };
}

function knownModelIdentity(value) {
  const text = unquote(value).toLowerCase();
  const family = '(opus|sonnet|haiku|fable|mythos)';
  // Anchored *complete* spellings, never family-prefix acceptance. Versions and
  // dated releases are separate components; 5 is not 5.1, and a label alone
  // cannot prove a specific dated model ID.
  let match = text.match(new RegExp('^claude-' + family + '-(\\d+)(?:-(\\d{1,2}))?(?:-(\\d{8}))?$'));
  if (match) return { family: match[1], version: match[2] + (match[3] ? '.' + match[3] : ''), release: match[4] || null, modelId: text };
  match = text.match(new RegExp('^claude-(\\d+)(?:-(\\d{1,2}))?-' + family + '(?:-(\\d{8}))?$'));
  if (match) return { family: match[3], version: match[1] + (match[2] ? '.' + match[2] : ''), release: match[4] || null, modelId: text };
  match = text.match(new RegExp('^(?:claude\\s+)?' + family + '\\s+(\\d+(?:\\.\\d+)?)$'));
  if (match) return { family: match[1], version: match[2], release: null, modelId: null };
  match = text.match(new RegExp('^claude\\s+(\\d+(?:\\.\\d+)?)\\s+' + family + '$'));
  return match ? { family: match[2], version: match[1], release: null, modelId: null } : null;
}

function modelParts(label) {
  const context = contextParts(label);
  let modelId = null;
  const explicitId = context.text.match(/\((?:(?:model\s+)?id\s*[:=]\s*)(`+)?([^()`\s]+)\1?\)/i)
    || context.text.match(/\((`+)?(claude-[a-z0-9][a-z0-9.-]*)\1?\)/i);
  let identityText = context.text;
  if (explicitId) {
    modelId = explicitId[2];
    identityText = identityText.replace(explicitId[0], '').trim();
  } else if (/^claude-[a-z0-9][a-z0-9.-]*$/i.test(unquote(identityText))) {
    modelId = unquote(identityText);
  }
  return { ...context, modelId, identityText };
}

// One grammar for both durable observation and later startup restoration.
// This exposes parsed facts only; callers still decide whether a display label
// is precise enough to become a runtime request.
function parseClaudeObservedModelValue(value) {
  const parts = modelParts(value);
  const identity = knownModelIdentity(parts.modelId) || knownModelIdentity(parts.identityText);
  if (!identity) return null;
  return {
    family: identity.family,
    version: identity.version,
    release: identity.release || null,
    modelId: parts.modelId || identity.modelId || null,
    contextTokens: parts.contextTokens,
    contextConflicting: parts.conflicting,
  };
}

function leadingModelValue(text) {
  // The environment/policy reminder describes the *next* session. Read only
  // the first current-value line; never mine the reminder for context or IDs.
  const line = text.split(/\n|\bANTHROPIC_MODEL\s+is\s+set\s+to\b/i)[0].trim();
  const quoted = line.match(/^(`+)([\s\S]*?)\1([\s\S]*)$/);
  if (quoted) {
    // Claude quotes the entire display label, including `(default)`. Context
    // may also be written immediately after the quoted label; retain only
    // such explicit context suffixes, not the remaining saved/Fast/reminder.
    const contextSuffix = quoted[3].match(/^(?:\s*(?:\[[^\]]+\]|\([^)]*\bcontext\b[^)]*\)))*/i)?.[0] || '';
    return (quoted[2].replace(/\s*\(default\)\s*$/i, '') + contextSuffix).trim() || null;
  }
  const cut = line.search(/\s+and\s+saved\b|\s+for\s+this\s+session\s+only\b|\s*\((?:this\s+session\s+only|saved\b|effort\s*:|default\s*\))|\s*[·•]\s*(?:Fast\s+mode|Draws\s+from|couldn['’]t\s+(?:save|confirm))/i);
  const value = unquote(cut >= 0 ? line.slice(0, cut) : line);
  return value || null;
}

function component(componentName, requested, observed, satisfied, reason) {
  return { component: componentName, requested, observed, satisfied, reason };
}

function comparison(components) {
  const failed = components.find(item => item.satisfied === false);
  const unknown = components.find(item => item.satisfied === null);
  return {
    requestSatisfied: failed ? false : unknown ? null : true,
    mismatch: failed || unknown ? { reason: (failed || unknown).reason, components } : null,
  };
}

function compareClaudeSettingObservation(requested = {}, observed = {}, { kind = requested.kind, resolvedRequest = null } = {}) {
  const requestedValue = String(requested.value || '').trim();
  if (!requestedValue) return comparison([component('request', null, null, null, 'request-value-unprovided')]);
  if (kind !== requested.kind) return comparison([component('kind', requested.kind, kind, false, 'setting-kind-mismatch')]);
  if (kind === 'effort') {
    const expected = unquote(requestedValue).toLowerCase();
    const actual = typeof observed.effort === 'string' ? observed.effort.toLowerCase() : null;
    return comparison([component('effort', expected, actual, actual === null ? null : actual === expected,
      actual === null ? 'effort-unobserved' : actual === expected ? 'exact-effort' : 'effort-mismatch')]);
  }
  if (kind !== 'model') return comparison([component('kind', requested.kind, kind, null, 'unsupported-setting-kind')]);

  const requestedParts = contextParts(unquote(requestedValue));
  const directIdentity = knownModelIdentity(requestedParts.text);
  // A caller may supply an already-authoritative exact resolution. It is only
  // an expected value for comparison and is NEVER copied into `observed`.
  const resolvedId = typeof resolvedRequest?.modelId === 'string' ? resolvedRequest.modelId.trim() : null;
  const expectedId = directIdentity?.modelId || (!directIdentity ? resolvedId : null);
  const expectedIdentity = directIdentity || knownModelIdentity(resolvedId);
  const actualParts = modelParts(observed.label || '');
  const actualId = typeof observed.modelId === 'string' && observed.modelId ? observed.modelId : null;
  const actualIdentity = knownModelIdentity(actualId) || knownModelIdentity(actualParts.identityText);
  let model;
  if (expectedId && actualId) {
    const matches = expectedId === actualId || (directIdentity && expectedId.toLowerCase() === actualId.toLowerCase());
    model = component('model', expectedId, actualId, !!matches, matches ? 'exact-model-id' : 'model-id-mismatch');
  } else if (expectedIdentity && actualIdentity) {
    const familyMatches = expectedIdentity.family === actualIdentity.family;
    const versionMatches = expectedIdentity.version === actualIdentity.version;
    const releaseMissing = expectedIdentity.release && !actualIdentity.release;
    const releaseMatches = !expectedIdentity.release || expectedIdentity.release === actualIdentity.release;
    const satisfied = !familyMatches || !versionMatches ? false : releaseMissing ? null : !!releaseMatches;
    model = component('model', requestedParts.text, actualId || observed.label || null, satisfied,
      !familyMatches ? 'model-family-mismatch' : !versionMatches ? 'model-version-mismatch'
        : releaseMissing ? 'model-release-unobserved' : !releaseMatches ? 'model-release-mismatch' : 'exact-model-family-version');
  } else {
    model = component('model', expectedId || requestedParts.text, actualId || observed.label || null, null,
      expectedId || expectedIdentity ? 'model-identity-unobserved' : 'request-model-resolution-unknown');
  }
  const components = [model];
  const contextTokens = requestedParts.contextTokens ?? (
    Number.isSafeInteger(resolvedRequest?.contextTokens) && resolvedRequest.contextTokens > 0
      ? resolvedRequest.contextTokens : null
  );
  if (requestedParts.conflicting || actualParts.conflicting) {
    components.push(component('context', contextTokens, null, null, 'context-observation-conflict'));
  } else if (contextTokens !== null) {
    const actual = Number.isSafeInteger(observed.contextTokens) && observed.contextTokens > 0 ? observed.contextTokens : null;
    components.push(component('context', contextTokens, actual, actual === null ? null : actual === contextTokens,
      actual === null ? 'context-unobserved' : actual === contextTokens ? 'exact-context' : 'context-mismatch'));
  }
  return comparison(components);
}

function parseClaudeSettingObservation(record, requested = {}, options = {}) {
  const stdout = readStdout(record);
  if (!stdout) return null;
  const modelMatch = stdout.outputText.match(/^Set\s+model\s+to\s+([\s\S]+)$/i);
  const effortMatch = stdout.outputText.match(/^Set\s+effort\s+level\s+to\s+(`*)([a-z][a-z0-9-]*)\1(?=\s|\(|$)/i);
  if (!modelMatch && !effortMatch) return null;
  const kind = modelMatch ? 'model' : 'effort';
  const label = modelMatch ? leadingModelValue(modelMatch[1]) : effortMatch[2].toLowerCase();
  if (!label) return null;
  const parts = modelMatch ? modelParts(label) : null;
  const currentLine = stdout.outputText.split(/\n|\bANTHROPIC_MODEL\s+is\s+set\s+to\b/i)[0];
  const annotatedEffort = currentLine.match(/\(effort\s*:\s*([a-z][a-z0-9-]*)\)/i)?.[1]?.toLowerCase();
  const observed = {
    label,
    modelId: parts?.modelId || null,
    contextTokens: parts?.contextTokens ?? null,
    ...(kind === 'effort' || annotatedEffort ? { effort: kind === 'effort' ? label : annotatedEffort } : {}),
  };
  return {
    recognized: true,
    kind,
    observed,
    requestedValue: String(requested.value || '').trim() || null,
    actualValue: observed.modelId || observed.label,
    ...compareClaudeSettingObservation(requested, observed, { ...options, kind }),
    ...stdout,
  };

}

module.exports = { parseClaudeSettingObservation, compareClaudeSettingObservation,
  parseClaudeObservedModelValue };
