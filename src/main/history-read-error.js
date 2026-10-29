'use strict';
// Small explicit error vocabulary shared by worker, Main and renderer-facing
// registration. No response DTO, native stack, transcript or arbitrary props.
function historyReadErrorRecord(error) {
  return { message: String(error?.message || 'History read failed'), code: error?.code,
    ...(typeof error?.lineageReason === 'string' ? { lineageReason: error.lineageReason } : {}),
    ...(error?.code === 'HISTORY_ROOT_CREDIT_TOO_SMALL'
      && Object.hasOwn(error, 'minimumCreditBytes') && Number.isSafeInteger(error.minimumCreditBytes)
      && error.minimumCreditBytes > 0 ? { minimumCreditBytes: error.minimumCreditBytes } : {}) };
}
function historyReadErrorFromRecord(record) {
  return Object.assign(new Error(record?.message || 'History read failed'), historyReadErrorRecord(record));
}
function historyReadCreditRefusal(error) {
  const record = historyReadErrorRecord(error);
  if (record.code !== 'HISTORY_ROOT_CREDIT_TOO_SMALL' || !Object.hasOwn(record, 'minimumCreditBytes')) return null;
  return { success: false, error: record.code, minimumCreditBytes: record.minimumCreditBytes };
}
module.exports = { historyReadErrorRecord, historyReadErrorFromRecord, historyReadCreditRefusal };

