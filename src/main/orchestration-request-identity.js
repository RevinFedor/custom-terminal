const crypto = require('crypto');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePrompt(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeWindowTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {
    spaceId: cleanString(value.spaceId),
    space: cleanString(value.space),
    anchor: cleanString(value.anchor),
    anchorTabId: cleanString(value.anchorTabId),
    windowRef: cleanString(value.windowRef),
    windowIndex: finiteNumberOrNull(value.windowIndex),
    mode: cleanString(value.mode),
    side: cleanString(value.side),
    insertIndex: finiteNumberOrNull(value.insertIndex),
    reveal: value.reveal === true,
  };
  return Object.values(out).some((entry) => entry !== '' && entry !== null && entry !== false)
    ? out
    : null;
}

function promptHash(value) {
  const normalized = normalizePrompt(value);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function normalizeOrchestrationRequestIdentity(input = {}) {
  const targetTabId = cleanString(input.targetTabId);
  const prompt = normalizePrompt(input.prompt);
  return {
    version: 1,
    sourceTabId: cleanString(input.sourceTabId),
    target: targetTabId
      ? { mode: 'existing', tabId: targetTabId }
      : {
        mode: 'new',
        projectId: cleanString(input.targetProjectId),
        toolType: input.targetToolType === 'codex' ? 'codex' : 'claude',
        name: cleanString(input.name),
        placement: cleanString(input.placement) || 'child',
        visualParentTabId: cleanString(input.visualParentTabId),
        afterTabId: cleanString(input.afterTabId),
        ...(cleanString(input.cwd) ? { cwd: cleanString(input.cwd) } : {}),
        ...(normalizeWindowTarget(input.windowTarget)
          ? { windowTarget: normalizeWindowTarget(input.windowTarget) }
          : {}),
        ...(cleanString(input.forkFromTabId) ? {
          fork: {
            sourceTabId: cleanString(input.forkFromTabId),
            mode: input.fullHistoryFork === true ? 'full' : 'latest-compact',
          },
        } : {}),
      },
    prompt: {
      hash: promptHash(prompt),
      chars: prompt.length,
    },
    label: cleanString(input.label),
    model: cleanString(input.model),
    effort: cleanString(input.effort),
    thinking: cleanString(input.thinking),
    queue: input.queue !== false,
    notifySource: input.notifySource !== false,
    waitForDescendants: input.waitForDescendants !== false,
    parentRunId: cleanString(input.parentRunId),
    causalParentMode: cleanString(input.parentRunId) ? 'explicit' : 'infer-if-proven',
    failureGraceMs: finiteNumberOrNull(input.failureGraceMs),
    successAutoStopMs: finiteNumberOrNull(input.successAutoStopMs),
    reactToManualInterrupt: typeof input.reactToManualInterrupt === 'boolean'
      ? input.reactToManualInterrupt
      : null,
    autoStopCreatedTargets: typeof input.autoStopCreatedTargets === 'boolean'
      ? input.autoStopCreatedTargets
      : null,
    ...(input.compactBeforeTask === true ? { compactBeforeTask: true } : {}),
  };
}

function orchestrationRequestFingerprint(input = {}) {
  const normalized = normalizeOrchestrationRequestIdentity(input);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function reservedOrchestrationTargetTabId(projectId, runId) {
  const project = cleanString(projectId);
  const run = cleanString(runId);
  if (!project || !run) throw new Error('projectId and runId required');
  return project + '-tab-orchestration-' + run;
}

module.exports = {
  normalizeOrchestrationRequestIdentity,
  orchestrationRequestFingerprint,
  reservedOrchestrationTargetTabId,
};
