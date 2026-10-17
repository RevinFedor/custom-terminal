'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let codec;
async function handleTerminalMessageOpen(req, res, deps) {
  if (!deps.checkAuth(req)) return deps.sendJson(res, 401, { ok: false, error: 'unauthorized' });
  let body;
  try { body = await deps.readBody(req); }
  catch { return deps.sendJson(res, 400, { ok: false, error: 'invalid body' }); }
  codec ||= import(pathToFileURL(path.join(__dirname, '../shared/terminal-message-reference.mjs')).href);
  const source = (await codec).normalizeTerminalMessageTarget(body?.source);
  const referenceId = typeof body?.referenceId === 'string' && /^[\w-]{1,128}$/.test(body.referenceId) ? body.referenceId : null;
  if (!source || !referenceId || !Number.isSafeInteger(body?.expectedPid)) {
    return deps.sendJson(res, 400, { ok: false, error: 'invalid message reference' });
  }
  if (body.expectedPid !== deps.pid) return deps.sendJson(res, 409, { ok: false, error: 'terminal instance changed' });
  try {
    const focus = deps.reveal('message-reference');
    if (!focus.ok) return deps.sendJson(res, 503, { ok: false, error: 'window unavailable', referenceId });
    // Existing renderer openTabById + History hydration/convergence is the
    // navigation owner. Neither dispatch nor a mounted row is an acceptance.
    const result = await deps.bridgeRequest('terminalMessageReferenceOpen', { source, referenceId }, 35000);
    console.log('[MessageReference] open id=' + referenceId + ' found=' + (result?.found === true));
    if (result?.found !== true) return deps.sendJson(res, 404, { ok: false, error: result?.reason || 'exact message unavailable', referenceId });
    return deps.sendJson(res, focus.ok ? 200 : 503, { ok: focus.ok, found: true, focused: focus.revealed === true, referenceId,
      ...(focus.ok ? {} : { error: focus.reason || focus.error || 'window unavailable' }) });
  } catch {
    // Unknown bridge outcome is not permission to retry navigation.
    return deps.sendJson(res, 503, { ok: false, error: 'message navigation unavailable', referenceId });
  }
}
module.exports = { handleTerminalMessageOpen };
