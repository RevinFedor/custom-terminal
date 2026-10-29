import { rewindAgentTimelineScenario } from './agentScenarios';
import { getHistoryAgentRuntime } from './historyAgentRuntimes';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useUIStore } from '../store/useUIStore';
import { beginHistoryOperationActivity } from './historyOperationActivity.mjs';
import { buildCodexRunPayload, buildCodexHistoryMutationResumePayload, getCodexHistoryMutationSettingsProof } from './codexLaunch';
import { executeHistoryRewriteRewindScenario } from './historyRewriteRewind';
const { ipcRenderer } = window.require('electron');
const requireSuccess = (reply: any) => {
  if (reply?.success !== true || reply?.accepted === false) throw new Error(reply?.error || reply?.reason || 'history_operation_unconfirmed');
  return reply;
};

export async function nativeTimelineViewRewind(address: any, subject: any, client: any) {
  const release = client.retain();
  try {
  const { entry, logicalRank } = subject;
  // Reader computes all-user order and exact normalized full-text duplicate
  // counts. Mounted neighbours cannot authorize the native picker index.
  const facts = await client.query('rewind', { logicalRank });
  if (!Number.isSafeInteger(facts.targetIndex) || facts.targetIndex < 0
    || !Number.isSafeInteger(facts.rewindableCount) || facts.rewindableCount <= facts.targetIndex
    || !Number.isSafeInteger(facts.skipDuplicates) || facts.skipDuplicates < 0 || facts.skipDuplicates >= facts.rewindableCount - facts.targetIndex || facts.menuSource !== 'full-text')
    throw new Error('TIMELINE_REWIND_FACTS_REQUIRED');
  if (entry.type !== 'user' || entry.isCompactSummary || entry.isGoalContinuation)
    throw new Error('TIMELINE_REWIND_TARGET_NOT_USER');
  const result = await rewindAgentTimelineScenario({
    ...address, tab: { cwd: address.cwd }, toolType: 'codex', runtime: getHistoryAgentRuntime('codex'),
    mode: 'native', targetIndex: facts.targetIndex, rewindableCount: facts.rewindableCount,
    skipDuplicates: facts.skipDuplicates, targetText: entry.content.replace(/\s+/g, ' ').trim(),
    targetFullText: entry.content.trim(), startUuid: entry.uuid, targetEntryRef: entry.entryRef,
    expectedContentRevision: entry.contentRevision, targetSourceIdentity: entry.sourceIdentity,
  });
  return requireSuccess(result);
  } finally { await release(); }
}

export async function rewriteTimelineViewTail(address: any, subject: any, range: any) {
  const release = subject.client.retain();
  try {
  // Supplying the exact frozen tail prevents the old scenario from resolving
  // it with Native getTimeline. The shared scenario still owns draft merging,
  // Stop, COW adoption, restart and failure recovery.
  return await executeHistoryRewriteRewindScenario({ ...address, toolType: 'codex', target: {
    uuid: subject.entry.uuid, text: subject.entry.content, endUuid: range.endUuid,
    promptChips: subject.entry.promptChips, imagePaths: subject.entry.imagePaths,
    entryRef: range.startEntryRef || subject.entry.entryRef, endEntryRef: range.endEntryRef,
    expectedContentRevision: range.expectedContentRevision || subject.entry.contentRevision,
  } });
  } finally { await release(); }
}

export async function mutateTimelineViewRange(address: any, range: any, compactText?: string,
  onProgress?: (stage: 'stopping' | 'editing' | 'restarting') => void) {
  const { tabId, sessionId, cwd } = address;
  if (!sessionId || typeof range?.startUuid !== 'string' || !range.startUuid
    || typeof range.endUuid !== 'string' || !range.endUuid || !Number.isSafeInteger(range.count) || range.count < 1)
    throw new Error('TIMELINE_RANGE_ENDPOINTS_REQUIRED');
  const channel = compactText === undefined ? 'codex:delete-range' : 'codex:edit-range';
  const kind = compactText === undefined ? 'delete' : 'edit';
  const activity = beginHistoryOperationActivity({ tabId, sourceSessionId: sessionId, kind,
    startUuid: range.startUuid, endUuid: range.endUuid });
  if (!activity) throw new Error('Изменение истории уже выполняется');
  let historyInput: any, proof = getCodexHistoryMutationSettingsProof(tabId, sessionId);
  let stopped = false, mutationIssued = false, committed = false, child: string | null = null, failure: string | null = null;
  const exact = { sessionId, cwd, startUuid: range.startUuid, endUuid: range.endUuid,
    startEntryRef: range.startEntryRef, endEntryRef: range.endEntryRef,
    expectedContentRevision: range.expectedContentRevision, ...(compactText === undefined ? {} : { compactText }) };
  try {
    historyInput = await ipcRenderer.invoke('history-mutation:begin', { tabId, sessionId, toolType: 'codex', operationId: activity.id });
    const preflight = requireSuccess(await ipcRenderer.invoke(channel, { ...exact, tabId, historyInput,
      validateOnly: true, ...(proof ? { codexSettingsProof: proof } : {}) }));
    proof = preflight.codexSettingsProof || proof;
    if (useWorkspaceStore.getState().getCodexSessionId(tabId) !== sessionId) throw new Error('stale_transcript_revision');
    activity.setPhase('stopping'); onProgress?.('stopping');
    const process = await ipcRenderer.invoke('terminal:getCommandState', {
      tabId, caller: 'Timeline.rootRange', expectedProcess: 'codex', allowProcessTreeLookup: true,
    });
    if (typeof process?.isRunning !== 'boolean' || process.processLookupUnknown && !process.isRunning)
      throw new Error('Codex process state is unknown; history unchanged');
    if (process.isRunning) requireSuccess(await ipcRenderer.invoke('terminal:stop-ai-process', {
      tabId, toolType: 'codex', reason: 'timeline-history-mutation', historyInput,
    }));
    stopped = true;
    activity.setPhase('rewriting'); onProgress?.('editing');
    mutationIssued = true;
    const result = await ipcRenderer.invoke(channel, { ...exact, tabId, historyInput,
      ...(proof ? { codexSettingsProof: proof } : {}) });
    committed = result?.committed === true || result?.success === true;
    child = committed && typeof result.newSessionId === 'string' ? result.newSessionId : null;
    requireSuccess(result);
    if (!child) throw new Error('Codex history mutation returned no child');
    activity.setPhase('restarting'); onProgress?.('restarting');
    const adopted = await useWorkspaceStore.getState().setCodexSessionId(tabId, child,
      compactText === undefined ? 'deleteRange' : 'editRange', {
        historyInput, ...(result.codexSettingsProof || proof ? { codexSettingsProof: result.codexSettingsProof || proof } : {}),
      });
    if (!adopted) throw new Error('Changed copy saved; tab adoption is unconfirmed: ' + child);
    requireSuccess(await ipcRenderer.invoke('codex:run-command', {
      ...buildCodexRunPayload({ tabId, command: 'codex-c', sessionId: child, cwd }), historyInput,
    }));
    window.dispatchEvent(new CustomEvent('timeline:force-refresh', { detail: { tabId } }));
    return result;
  } catch (error: any) {
    failure = String(error?.message || error);
    // A committed copy or unknown mutation outcome never authorizes rewriting
    // or replaying. Only a proven pre-mutation failure may resume the source.
    if (stopped && !mutationIssued && !committed && !child) {
      try { requireSuccess(await ipcRenderer.invoke('codex:run-command', {
        ...buildCodexHistoryMutationResumePayload({ tabId, command: 'codex-c', sessionId, cwd }, proof), historyInput,
      })); } catch (restartError) { console.warn('[TimelineRoot] source-restart-unconfirmed', restartError); }
    }
    if (committed) useUIStore.getState().showToast('Изменённая копия сохранена; продолжение не подтверждено: ' + (child || 'unknown'), 'error');
    throw error;
  } finally {
    if (historyInput) await ipcRenderer.invoke('history-mutation:finish', historyInput).catch((error: any) => {
      console.warn('[TimelineRoot] mutation-settlement-unconfirmed', error);
    });
    activity.finish(failure);
  }
}
