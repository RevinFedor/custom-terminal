'use strict';

async function handleWorkingDirectoryOperationApi({ req, res, parsed, service, readBody, sendJson }) {
  const match = parsed.pathname.match(/^\/api\/terminal-tabs\/([^/]+)\/working-directory-operations(?:\/([^/]+))?$/);
  if (!match) return false;
  if (!service) { sendJson(res, 503, { ok: false, error: 'app_update_required' }); return true; }
  try {
    const tabId = decodeURIComponent(match[1]);
    let operation;
    if (req.method === 'POST' && !match[2]) operation = service.accept(tabId, await readBody(req));
    else if (req.method === 'GET' && match[2]) operation = service.read(tabId, decodeURIComponent(match[2]));
    else { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    if (!operation) { sendJson(res, 404, { ok: false, error: 'cwd_operation_not_found' }); return true; }
    sendJson(res, req.method === 'GET' ? 200 : operation.pending ? 202 : operation.success ? 200 : 409,
      { ok: true, operation });
  } catch (error) { sendJson(res, error.statusCode || 500, { ok: false, error: error.code || error.message }); }
  return true;
}

const WORKING_DIRECTORY_CAPABILITY = Object.freeze({ version: 1, providers: ['codex'], receipts: true,
  expectedSessionId: true, physicalCwdProof: true, globalPolicyUnchanged: true });
module.exports = { handleWorkingDirectoryOperationApi, WORKING_DIRECTORY_CAPABILITY };
