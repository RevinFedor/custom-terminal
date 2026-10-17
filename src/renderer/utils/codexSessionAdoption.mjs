/**
 * Convert a proven-writer IPC event into the explicit store contract.
 *
 * The reason string is diagnostic text and may change as the observer moves
 * through different code paths. It must never decide whether settings proof
 * belongs to a newly adopted rollout writer.
 */
export function codexSessionAdoptionOptionsFromEvent(event) {
  const rawProof = event?.codexSettingsProof;
  const model = typeof rawProof?.model === 'string' ? rawProof.model.trim() : '';
  const effort = typeof rawProof?.effort === 'string' ? rawProof.effort.trim().toLowerCase() : '';
  const proofAt = Number(rawProof?.proofAt);
  const exactProof = model && effort && Number.isFinite(proofAt) && proofAt > 0
    ? {
      model,
      effort,
      proofAt,
      ...(typeof rawProof?.fast === 'boolean' ? { fast: rawProof.fast } : {}),
    }
    : null;
  return {
    carryCodexSettingsProof: event?.carryCodexSettingsProof === true && (
      !event?.requiresExactCodexSettingsProof || !!exactProof
    ),
    codexSettingsProof: exactProof,
    codexSettingsProofInvalid: event?.requiresExactCodexSettingsProof === true && !exactProof,
  };
}

/**
 * Apply a source JSONL pair only after main has proven the first writer. Ultra
 * remains a conversation overlay; it must never become a future-launch default.
 */
export function planCarriedCodexSettingsProofApplication({
  proof,
  nextSessionId,
  currentPersistentEffort,
  currentProofAt,
  currentProofSessionId,
  currentLiveProofAt,
  currentLiveSettingsSessionId,
  currentProviderState,
} = {}) {
  const model = typeof proof?.model === 'string' ? proof.model.trim() : '';
  const effort = typeof proof?.effort === 'string' ? proof.effort.trim().toLowerCase() : '';
  const proofAt = Number(proof?.proofAt);
  const owner = typeof nextSessionId === 'string' ? nextSessionId.trim() : '';
  if (!model || !effort || !owner || !Number.isFinite(proofAt) || proofAt <= 0) {
    return { allowed: false, reason: 'carried-codex-settings-proof-invalid' };
  }
  // Binding is still adopted by its caller. Only an older settings projection
  // loses to the child's newer explicit/applied choice; a foreign source proof
  // never gains this priority merely because its timestamp happens to be high.
  const newerPersistent = (!currentProofSessionId || currentProofSessionId === owner)
    && Number(currentProofAt || 0) > proofAt;
  const newerLive = (currentLiveSettingsSessionId === owner
    || String(currentLiveSettingsSessionId || '').startsWith('launch:'))
    && Number(currentLiveProofAt || 0) > proofAt;
  if (newerPersistent || newerLive) return { allowed: false, reason: 'newer-child-settings-present' };
  if (Number(currentProviderState?.codexSettingsIntentRevision || 0) > 0
    && currentProviderState.codexSettingsIntentModel && currentProviderState.codexSettingsIntentEffort
    && (currentProviderState.codexSettingsIntentModel !== model || currentProviderState.codexSettingsIntentEffort !== effort)) {
    return { allowed: false, reason: 'child-settings-choice-present' };
  }
  const serviceTierPatch = typeof proof?.fast === 'boolean'
    ? {
      codexLiveServiceTier: proof.fast ? 'priority' : 'default',
      codexLiveServiceTierSessionId: owner,
      codexLiveServiceTierSource: 'verified-composer-footer',
    }
    : {};
  if (effort === 'ultra') {
    return {
      allowed: true,
      conversationOnly: true,
      persistentPatch: {
        ...(String(currentPersistentEffort || '').trim().toLowerCase() === 'ultra'
          ? { codexEffort: undefined }
          : {}),
        codexSettingsProofAt: proofAt,
        codexSettingsProofSessionId: owner,
      },
      livePatch: {
        codexLiveModel: model,
        codexLiveEffort: effort,
        codexLiveSettingsSessionId: owner,
        ...serviceTierPatch,
      },
    };
  }
  return {
    allowed: true,
    conversationOnly: false,
    persistentPatch: {
      codexModel: model,
      codexEffort: effort,
      codexSettingsProofAt: proofAt,
      codexSettingsProofSessionId: owner,
    },
    livePatch: {
      codexLiveModel: undefined,
      codexLiveEffort: undefined,
      codexLiveSettingsSessionId: undefined,
      ...serviceTierPatch,
    },
  };
}

/**
 * Native Rewind may move rollout ownership A → B without changing the live
 * Codex process or its model/effort. Only an explicit semantic proof may move
 * the settings owner with it. Generic session changes deliberately retain the
 * old owner so consumers fail closed until B supplies its own settings proof.
 */
export function projectCodexSettingsProofOwner({
  currentProofAt,
  currentProofSessionId,
  nextSessionId,
  carryCodexSettingsProof,
}) {
  if (carryCodexSettingsProof === true && currentProofAt && nextSessionId) {
    return nextSessionId;
  }
  return currentProofSessionId;
}
