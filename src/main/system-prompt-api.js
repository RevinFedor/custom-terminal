'use strict';

async function handleSystemPromptApi({ req, res, parsed, service, readBody, sendJson }) {
  const collection = parsed.pathname === '/api/system-prompts';
  const settings = parsed.pathname === '/api/system-prompts/settings';
  const item = parsed.pathname.match(/^\/api\/system-prompts\/([^/]+)$/);
  if (!collection && !item) return false;
  if (!service) { sendJson(res, 503, { error: 'System prompt API requires an app update', code: 'app_update_required' }); return true; }
  try {
    let body;
    if (settings && req.method === 'GET') body = { settings: service.getSettings() };
    else if (settings && req.method === 'PATCH') body = { settings: service.updateSettings(await readBody(req)) };
    else if (collection && req.method === 'GET') body = { prompts: service.list({ query: parsed.query?.query }), settings: service.getSettings() };
    else if (collection && req.method === 'POST') { sendJson(res, 201, { prompt: service.create(await readBody(req)) }); return true; }
    else if (item && !settings && req.method === 'GET') body = { prompt: service.get(decodeURIComponent(item[1])) };
    else if (item && !settings && req.method === 'PATCH') body = { prompt: service.update(decodeURIComponent(item[1]), await readBody(req)) };
    else if (item && !settings && req.method === 'DELETE') body = service.remove(decodeURIComponent(item[1]), (await readBody(req)).revision);
    else { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    sendJson(res, 200, body);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message, code: error.code || 'system_prompt_invalid', current: error.current });
  }
  return true;
}
module.exports = { handleSystemPromptApi };
