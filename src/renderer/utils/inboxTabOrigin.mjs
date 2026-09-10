/**
 * Inbox is also a normal user workspace, so project identity cannot prove how
 * a tab was created. Provider-chat tabs carry the durable external run receipt;
 * manual tabs in the same project do not.
 */
export function isInboxApiCreatedTab(tab) {
  const runId = tab?.externalRun?.runId;
  return typeof runId === 'string' && runId.trim().length > 0;
}
