'use strict';

// Observability only. The legacy dialog classifier accepts text fragments;
// capture the first live counterexample before deciding a broader repair.
// Do not change permission to write from this diagnostic descriptor.
function describeClaudeSettingsDialogObservation({ snapshot, dialogType, operation } = {}) {
  if (snapshot?.success !== true || !Array.isArray(snapshot.lines)) return null;
  const lines = snapshot.lines.map(line => String(line?.text || '')
    .replace(/\u00a0/g, ' ').replace(/^[\s│┃║]+|[\s│┃║]+$/g, '').replace(/\s+/g, ' '));
  const title = dialogType === 'EffortDialog' ? /^Change effort level\?$/i : /^Switch model\?$/i;
  const titleRow = lines.findIndex(line => title.test(line));
  const yesRow = lines.findIndex(line => /^(?:❯|›|>)\s*(?:\d+\.\s*)?Yes,?\s*switch to\s+\S/i.test(line));
  const noRow = lines.findIndex(line => /^(?:\d+\.\s*)?No,?\s*go back$/i.test(line));
  const structured = titleRow >= 0 && yesRow > titleRow && noRow > titleRow;
  const operationKind = operation?.kind || null;
  const competingWrite = !!operationKind
    && !['claude-setting', 'claude-settings-send'].includes(operationKind);
  if (structured && !competingWrite) return null;
  return {
    kind: 'claude-settings-dialog-observation',
    dialogType,
    reason: !structured ? 'fragment-without-complete-selected-dialog' : 'competing-pty-write',
    titleRow, yesRow, noRow, structured,
    operationKind, operationSource: operation?.source || null,
    operationPhase: operation?.phase || null,
    operationSubmitted: operation?.submitted === true,
    // No prompt text or image bytes in the descriptor. The existing private
    // incident collector separately captures the bounded replay/frame packet.
    generation: snapshot.generation || null,
    writeSeq: snapshot.writeSeq ?? null,
    committedFrameGeneration: snapshot.committedFrameGeneration ?? null,
  };
}

function observeClaudeSettingsDialogWrite({ snapshot, dialogType, operation, capture } = {}) {
  try {
    const detail = describeClaudeSettingsDialogObservation({ snapshot, dialogType, operation });
    if (!detail) return;
    // Do not await a diagnostic before a write and never let it fail the action.
    Promise.resolve(capture?.(detail)).catch(() => {});
  } catch {}
}

module.exports = { describeClaudeSettingsDialogObservation, observeClaudeSettingsDialogWrite };
