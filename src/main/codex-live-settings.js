'use strict';

const { parseCodexVerifiedComposerFooter, hasCodexComposerStatusFooter,
  hasCodexComposerPromptGlyph, selectCodexCurrentInteractiveFrameText } = require('./codex-tui-readiness');
const { inspectCodexModelSwitchNotice } = require('./codex-usage-prompt');
const { sameCodexPolicyOwner } = require('./codex-runtime-policies');

// Only presentation proof. This store never edits requested settings, invokes
// /model, or authorizes Send. Writer adoption can label the same process proof.
function createCodexLiveSettingsObserver({ capture, publish, invalidate = () => {}, readModelCatalog = () => [], now = Date.now }) {
  const proofs = new Map();
  function read(tabId) {
    const value = proofs.get(tabId);
    const owner = capture(tabId);
    if (!value?.proof || !sameCodexPolicyOwner(value.owner, owner)) return null;
    return { ...value.proof, ownerId: owner.ownerId, sessionId: owner.sessionId || null };
  }
  function observe(tabId, frame) {
    const owner = capture(tabId);
    if (!owner?.live || !owner.ownerId || !frame?.valid) return;
    const previous = proofs.get(tabId);
    const same = previous && sameCodexPolicyOwner(previous.owner, owner);
    if (same && frame.seq <= previous.seq) return;
    let catalog = [];
    try { catalog = readModelCatalog() || []; } catch { /* Current model identity remains unproven. */ }
    const pair = parseCodexVerifiedComposerFooter(frame.text, catalog);
    if (!pair) {
      const currentFrame = selectCodexCurrentInteractiveFrameText(frame.text);
      // A committed newer composer with an unresolved label revokes the old
      // live pair; a menu, clipped frame or arbitrary prose does not.
      if (!hasCodexComposerPromptGlyph(currentFrame) || !hasCodexComposerStatusFooter(currentFrame, catalog)) return;
      const prior = same && previous.proof ? { ...previous.proof, ownerId: previous.owner.ownerId,
        sessionId: previous.owner.sessionId || null, frameSeq: frame.seq } : null;
      proofs.set(tabId, { owner, seq: frame.seq, proof: null });
      if (prior) invalidate(tabId, prior);
      return;
    }
    const notice = inspectCodexModelSwitchNotice(frame.text);
    const reason = notice?.model === pair.model && notice?.effort === pair.effort
      ? notice.reason : pair.model === 'gpt-reserve' ? 'provider-reserve' : 'committed-composer';
    const proof = { model: pair.model, effort: pair.effort, source: 'committed-composer-footer',
      proofAt: same && previous.proof?.model === pair.model && previous.proof.effort === pair.effort
        ? previous.proof.proofAt : now(),
      frameSeq: frame.seq, lifecycleGeneration: owner.lifecycleGeneration, runSeq: owner.runSeq, reason };
    proofs.set(tabId, { owner, seq: frame.seq, proof });
    if (!same || !previous.proof || previous.proof.model !== pair.model || previous.proof.effort !== pair.effort
      || previous.owner.ownerId !== owner.ownerId) publish(tabId, read(tabId));
  }
  return { observe, read, clear: tabId => proofs.delete(tabId) };
}

module.exports = { createCodexLiveSettingsObserver };
