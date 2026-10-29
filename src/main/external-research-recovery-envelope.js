'use strict';
// Data for the calling agent, not permission to Send or modify a provider page.
// Only exact SC journal evidence may attest no-Send; a timeout never does.
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const text = value => typeof value === 'string' && value.length <= 1024 ? value : null;
const time = value => Number.isFinite(value) && value >= 0 ? value : null;
function recoveryEnvelope(run, snapshot = null) {
  if (!snapshot && run.externalResearchRecoveryEnvelope?.version === 1) return clone(run.externalResearchRecoveryEnvelope);
  const e = snapshot?.execution?.version === 1 ? snapshot.execution : null;
  if (snapshot?.id && snapshot.id !== run.externalResearchJobId) throw new Error('external_recovery_job_mismatch');
  if (run.externalResearchBrowserInstanceId && snapshot?.browserInstanceId
    && run.externalResearchBrowserInstanceId !== snapshot.browserInstanceId) throw new Error('external_recovery_browser_mismatch');
  const send = e?.send;
  const noSend = e?.purpose !== 'observe' && e?.failure?.noSend === true && send?.state === 'not_attempted'
    && ['attemptId', 'startedAt', 'acceptedAt'].every(key => Object.hasOwn(send, key) && send[key] === null);
  const rawAccount = e?.beforeSendAccount || e?.readAccount || snapshot?.browserAccount || null;
  const userId = text(rawAccount?.userId || rawAccount?.user_id), accountId = text(rawAccount?.accountId || rawAccount?.account_id);
  const handoff = e?.sourceHandoff || snapshot?.result?.recovery_handoff;
  return { version: 1, policy: 'agent_owned', automaticActions: false,
    runId: run.runId, jobId: run.externalResearchJobId,
    controlEpoch: text(e?.controlEpoch), controlRevision: Number.isInteger(e?.controlRevision) ? e.controlRevision : null,
    browserInstanceId: text(snapshot?.browserInstanceId || run.externalResearchBrowserInstanceId || run.externalResearchExpectedBrowserInstanceId),
    browserBinding: snapshot?.browserInstanceId || run.externalResearchBrowserInstanceId ? 'recorded_owner' : 'requested_profile',
    account: userId && accountId ? { userId, accountId, binding: text(rawAccount.binding) } : null,
    conversationId: text(e?.turn?.conversationId || snapshot?.conversationId || run.externalResearchConversationId),
    conversationUrl: text(snapshot?.conversationUrl || snapshot?.url || run.externalResearchConversationUrl),
    tabId: Number.isInteger(snapshot?.tabId) ? snapshot.tabId : run.externalResearchTabId ?? null,
    reader: clone(e?.reader), turn: clone(e?.turn), purpose: text(e?.purpose),
    send: { state: text(send?.state || run.externalResearchUiState?.sendState) || 'unknown',
      attemptId: text(send?.attemptId), startedAt: time(send?.startedAt), acceptedAt: time(send?.acceptedAt),
      noSend: noSend ? true : e?.failure?.noSend === false || send?.state && send.state !== 'not_attempted' ? false : null,
      evidence: e ? 'sc_control_journal' : 'not_provided' },
    remoteOutcome: e?.finalReceipt ? 'terminal_proven' : noSend ? 'not_started' : 'unknown',
    localOutcome: clone(e?.observationOutcome || run.externalResearchLocalOutcome), stage: text(snapshot?.stage || run.externalResearchStage),
    errorCode: text(handoff?.reason || e?.failure?.code || e?.operation?.blocker?.code || snapshot?.code || run.resultErrorCode),
    providerMessage: text(handoff?.providerMessage || e?.recoveryUi?.observedError?.text),
    inputDigest: text(e?.inputDigest), attachmentDigest: text(e?.attachmentDigest),
    capture: clone(e?.capture), finalReceipt: clone(e?.finalReceipt),
    refusal: handoff?.reason === 'provider_content_blocked' || e?.recoveryUi?.observedError?.kind === 'provider_content_blocked',
    generationEffects: clone(e?.generationEffects || []),
    manualGenerationEffect: clone(e?.manualGenerationEffect),
  };
}
function recoveryInstructions(envelope) {
  return [
    'SC передал управление вызвавшему агенту. Сохрани исходные run/job и квитанции; не жди обязательного разрешения владельца SC для обычной диагностики.',
    'Осмотри ту же страницу через Browser MCP. Сначала проверь, не готов ли собственный ответ и оригинальные файлы. Затем допустима ограниченная ручная проверка разрешённых Stop/Reload/Retry. Эти действия не гарантируют восстановление; disabled Retry не нажимай циклом.',
    'Неработающий Stop, F5 и закрытие вкладки не доказывают остановку backend. При accepted/UNKNOWN не повторяй отправку и не создавай платную копию без подтверждения исхода или явного разрешения на дополнительный запуск. При доказанном noSend сохрани неизменное задание, модель и полный набор файлов для разрешённого восстановления.',
    'После ручной отправки SC должен наблюдать точно новый ход: номер вкладки — только locator, обычный URL-import может вернуть старый final и не является строгой подпиской. Не используй continue как подписку: он создаёт новый вопрос.',
    envelope?.refusal ? 'ChatGPT отказал в показе контента. Передай исходный отказ; не обходи его переформулировками или новым чатом. Уточнение легитимной цели не является разрешением обойти отказ.' : '',
    'Сбой канала не является заключением эксперта и не разрешает заменить зависимую консультацию своей реализацией. Независимая разрешённая работа продолжается. Единственную копию ответа не закрывай до сохранения.',
  ].filter(Boolean).join('\n');
}
module.exports = { recoveryEnvelope, recoveryInstructions };
