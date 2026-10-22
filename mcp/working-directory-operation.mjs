import { isAbsolute, resolve } from 'node:path';

export const WORKING_DIRECTORY_GUIDANCE = 'An accepted receipt is not completion. Read get_working_directory_operation with the SAME tabId/operationId after ACK loss or for an explicit result check; never poll, resend cd/Resume, or invent a new operationId to retry an unknown outcome. Inspect cwdChanged, processStopped, launchWritten, inputReady and partial separately. New AGENTS/config apply in the destination; old conversation is retained. No Always policy is changed.';

export async function callWorkingDirectoryOperation(name, args, { target, get, post }) {
  const isRead = name === 'get_working_directory_operation';
  const allowed = isRead ? ['tabId', 'operationId', 'projectId', 'includeStatus']
    : ['tabId', 'operationId', 'expectedSessionId', 'targetCwd', 'expectedCwd', 'resume', 'projectId'];
  if (!args || Object.keys(args).some(key => !allowed.includes(key))) throw Error('cwd_operation_invalid_request');
  const tabId = args.tabId, operationId = args.operationId;
  if (typeof tabId !== 'string' || !tabId || tabId.length > 1024
    || typeof operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(operationId)) throw Error('cwd_operation_identity_required');
  let request;
  if (!isRead) {
    const directory = value => {
      if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 4096
        || /[\u0000-\u001f\u007f]/.test(value) || !isAbsolute(value)) throw Error('cwd_operation_path_invalid');
      return resolve(value);
    };
    if (typeof args.expectedSessionId !== 'string' || !args.expectedSessionId || args.expectedSessionId.length > 160
      || args.resume !== undefined && typeof args.resume !== 'boolean') throw Error('cwd_operation_invalid_request');
    request = { operationId, expectedSessionId: args.expectedSessionId, targetCwd: directory(args.targetCwd),
      resume: args.resume !== false, ...(args.expectedCwd === undefined ? {} : { expectedCwd: directory(args.expectedCwd) }) };
  }
  if (isRead && args.includeStatus !== undefined && typeof args.includeStatus !== 'boolean') throw Error('cwd_operation_invalid_request');
  let mutationAttempted = false;
  const check = value => {
    const op = value?.operation;
    if (value?.ok !== true || op?.tabId !== tabId || op.operationId !== operationId
      || !isRead && (op.expectedSessionId !== request.expectedSessionId || op.targetCwd !== request.targetCwd
        || op.resume !== request.resume)) throw Error('cwd_operation_response_mismatch');
    return { ...value, tabId, operationId, guidance: WORKING_DIRECTORY_GUIDANCE };
  };
  try {
    const me = await get(target, '/api/me'), cap = me?.capabilities?.workingDirectory;
    if (cap?.version !== 1 || cap.receipts !== true || cap.physicalCwdProof !== true
      || cap.expectedSessionId !== true || cap.globalPolicyUnchanged !== true || !cap.providers?.includes('codex')) {
      throw Object.assign(Error('Update Noted Terminal for the working-directory operation; no raw cd/SQL/Always fallback.'), { code: 'app_update_required' });
    }
    const endpoint = '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/working-directory-operations';
    if (isRead) {
      const value = check(await get(target, endpoint + '/' + encodeURIComponent(operationId)));
      if (args.includeStatus === true) {
        try { value.currentStatus = await get(target, '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/status'); }
        catch (error) { value.currentStatusError = String(error.message || error); }
      }
      return value;
    }
    mutationAttempted = true;
    try { return check(await post(target, endpoint, request)); }
    catch (error) { if (error.toolDetails?.ok === true && error.toolDetails.operation) return check(error.toolDetails); throw error; }
  } catch (cause) {
    throw Object.assign(Error(String(cause.message || cause) + ' ' + WORKING_DIRECTORY_GUIDANCE), { toolDetails: {
      ...(cause.toolDetails || {}), code: cause.code || 'cwd_operation_outcome_unavailable', tabId, operationId,
      mutationAttempted, receiptRead: { tabId, operationId },
    } });
  }
}
