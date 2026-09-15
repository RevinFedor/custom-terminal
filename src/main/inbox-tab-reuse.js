'use strict';

// Reusing a saved tab is not proof that its process is running. Every reuse
// path must enter the same existing resume operation before waiting for input.
async function prepareReusedInboxTab({ tabId, provider, readStatus, resume, clearTimers }) {
  const status = await readStatus(tabId);
  if (status?.toolType && status.toolType !== provider) {
    const error = new Error('Inbox tab provider changed before reuse');
    error.code = 'external_tab_provider_changed';
    throw error;
  }
  clearTimers(tabId);
  if (status?.status !== 'inactive') return { resumed: false, status, admission: status };
  const result = await resume(tabId);
  if (result?.success === false || result?.ok === false) {
    const error = new Error(result.error || 'Inbox process could not be resumed');
    error.code = result.code || 'external_tab_resume_failed';
    throw error;
  }
  return { resumed: true, status, admission: result };
}

module.exports = { prepareReusedInboxTab };
