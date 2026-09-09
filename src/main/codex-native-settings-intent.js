'use strict';

const { classifyCodexManualEnterFrame } = require('./codex-model-picker');
const { parseCodexVerifiedComposerFooter } = require('./codex-tui-readiness');
const { isCodexSettingsPickerVisible, parseCodexModelChangeAcknowledgement } = require('../shared/codex-native-picker-proof.cjs');

function createCodexNativeSettingsIntentTracker({ getScope, getIntent, commit, now = Date.now } = {}) {
  const pending = new Map();
  const sameScope = (before, after) => after && before.terminal === after.terminal
    && before.mirror === after.mirror && before.ownerId === after.ownerId
    && before.runSeq === after.runSeq && before.lifecycleGeneration === after.lifecycleGeneration
    && before.inputRevision === after.inputRevision;
  const current = tabId => {
    const candidate = pending.get(tabId);
    if (!candidate) return null;
    const intent = getIntent(tabId);
    if (!sameScope(candidate.scope, getScope(tabId))
      || candidate.intentRevision !== Number(intent?.revision || 0)
      || candidate.intentActionSequence !== Number(intent?.actionSequence || 0)) {
      pending.delete(tabId);
      return null;
    }
    return candidate;
  };
  return {
    hasPending: tabId => current(tabId)?.written === true,
    prepare(tabId, { terminal, data, origin, snapshot }) {
      // Called only at raw/manual input writes, never by the automatic picker.
      // Preserve that boundary's legacy user-owned unknown-origin fallback;
      // an explicit terminal protocol reply is not a selection gesture.
      if ((origin != null && origin !== 'user' && origin !== 'unknown')
        || (data !== '\r' && data !== '\n')) return null;
      const scope = getScope(tabId);
      if (!scope || scope.terminal !== terminal || snapshot?.authoritativeFrameCommitted !== true
        || Number(snapshot.writeSeq) !== Number(scope.mirror?.writeSeq)
        || Number(scope.mirror?.flushedSeq) !== Number(scope.mirror?.writeSeq)) return null;
      const frameText = (snapshot.lines || []).map(line => String(line?.text || '')).join('\n');
      const control = classifyCodexManualEnterFrame(frameText);
      if (control.reason !== 'active-model-effort-picker' || !isCodexSettingsPickerVisible(frameText)) return null;
      const intent = getIntent(tabId);
      const candidate = { scope: { ...scope }, intentRevision: Number(intent?.revision || 0),
        intentActionSequence: Number(intent?.actionSequence || 0),
        afterWriteSeq: Number(snapshot.writeSeq), at: now(), written: false, output: '', control: control.kind };
      pending.set(tabId, candidate);
      while (pending.size > 128) pending.delete(pending.keys().next().value);
      return candidate;
    },
    written(tabId, candidate) {
      if (!candidate || current(tabId) !== candidate) return false;
      candidate.written = true;
      return true;
    },
    output(tabId, terminal, data) {
      const candidate = current(tabId);
      if (!candidate?.written || candidate.scope.terminal !== terminal) return;
      candidate.output = (candidate.output + String(data || '')).slice(-16_000);
    },
    frame(tabId, mirror, snapshot) {
      const candidate = current(tabId);
      if (!candidate?.written || candidate.scope.mirror !== mirror
        || mirror.lastCommittedVisibleSnapshot !== snapshot
        || snapshot?.authoritativeFrameCommitted !== true
        || Number(snapshot.writeSeq) <= candidate.afterWriteSeq
        || Number(snapshot.writeSeq) !== Number(mirror.writeSeq)
        || Number(mirror.flushedSeq) !== Number(mirror.writeSeq)) return null;
      const frameText = (snapshot.lines || []).map(line => String(line?.text || '')).join('\n');
      const acknowledged = parseCodexModelChangeAcknowledgement(candidate.output);
      const footer = parseCodexVerifiedComposerFooter(frameText);
      if (!acknowledged || !footer || isCodexSettingsPickerVisible(frameText)
        || acknowledged.model !== footer.model
        || (acknowledged.effort && acknowledged.effort !== footer.effort)
        || (footer.effort === 'ultra' && acknowledged.applicationMode !== 'conversation-only')) return null;
      const observation = { ...acknowledged, effort: footer.effort,
        scope: candidate.scope, intentRevision: candidate.intentRevision,
        intentActionSequence: candidate.intentActionSequence, gestureAt: candidate.at,
        confirmedAt: now(), writeSeq: Number(snapshot.writeSeq), control: candidate.control };
      const result = commit(tabId, observation);
      if (result?.success === true) pending.delete(tabId);
      return result;
    },
  };
}

module.exports = { createCodexNativeSettingsIntentTracker };
