'use strict';

function normalizeSaveTabsAck(result) {
  if (result?.success === true) return result;
  return {
    success: false,
    error: typeof result?.error === 'string' && result.error.trim()
      ? result.error
      : 'save_tabs_not_committed',
  };
}

function runSaveTabsWithAck(save) {
  if (typeof save !== 'function') {
    return { success: false, error: 'save_tabs_callback_required' };
  }
  try {
    return normalizeSaveTabsAck(save());
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error),
    };
  }
}

module.exports = {
  normalizeSaveTabsAck,
  runSaveTabsWithAck,
};
