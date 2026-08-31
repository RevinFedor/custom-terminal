'use strict';

function normalizeCodexFastIntent(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeCodexFastTier(value) {
  const tier = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (tier === 'fast') return 'priority';
  return tier === 'priority' || tier === 'default' ? tier : null;
}

function nextCodexFastIntent({ currentIntent, serviceTier } = {}) {
  const intent = normalizeCodexFastIntent(currentIntent);
  if (intent !== null) return !intent;
  return normalizeCodexFastTier(serviceTier) !== 'priority';
}

function planCodexFastIntentReconcile({
  desiredFast,
  revision,
  processRunning,
  tuiReady,
  serviceTier,
} = {}) {
  const desired = normalizeCodexFastIntent(desiredFast);
  if (desired === null || !Number.isInteger(Number(revision)) || Number(revision) <= 0) {
    return { action: 'none', reason: 'intent-missing' };
  }
  if (processRunning !== true) {
    return { action: 'queue', reason: 'process-not-running', desiredFast: desired };
  }
  if (tuiReady !== true) {
    return { action: 'queue', reason: 'tui-not-ready', desiredFast: desired };
  }
  const tier = normalizeCodexFastTier(serviceTier);
  if (!tier) {
    return { action: 'queue', reason: 'service-tier-unproven', desiredFast: desired };
  }
  const active = tier === 'priority';
  if (active === desired) {
    return {
      action: 'settled',
      reason: 'desired-tier-already-active',
      desiredFast: desired,
      serviceTier: tier,
    };
  }
  return {
    action: 'toggle',
    reason: 'desired-tier-differs',
    desiredFast: desired,
    serviceTier: tier,
  };
}

module.exports = {
  nextCodexFastIntent,
  normalizeCodexFastIntent,
  normalizeCodexFastTier,
  planCodexFastIntentReconcile,
};
