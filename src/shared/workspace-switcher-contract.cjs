'use strict';

const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const id = value => typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f]/.test(value) && value.trim() === value;

function normalizeSwitcherRequest(input = {}) {
  if (!['desktop', 'native'].includes(input.scope)) fail('switcher_scope_required');
  if (input.scope === 'desktop') {
    if (Object.hasOwn(input, 'anchorTabId') || Object.hasOwn(input, 'visibleTabIds')) fail('switcher_desktop_context_forbidden');
    return { scope: 'desktop' };
  }
  if (!Object.hasOwn(input, 'anchorTabId') || !Object.hasOwn(input, 'visibleTabIds')) fail('switcher_native_context_required');
  const anchorTabId = input.anchorTabId === '' || input.anchorTabId === null ? null : input.anchorTabId;
  if (anchorTabId !== null && (!id(anchorTabId) || !anchorTabId)) fail('switcher_anchor_invalid');
  if (!Array.isArray(input.visibleTabIds) || input.visibleTabIds.length > 128
    || input.visibleTabIds.some(value => !id(value) || !value)) fail('switcher_visible_tabs_invalid');
  const visibleTabIds = [...new Set(input.visibleTabIds)].sort();
  if (anchorTabId && !visibleTabIds.includes(anchorTabId)) fail('switcher_anchor_not_visible');
  return { scope: 'native', anchorTabId, visibleTabIds };
}
function switcherRequestFromQuery(query = {}) {
  const input = { scope: query.scope };
  if (Object.hasOwn(query, 'anchorTabId')) input.anchorTabId = query.anchorTabId;
  if (Object.hasOwn(query, 'visibleTabIds')) {
    if (typeof query.visibleTabIds !== 'string' || query.visibleTabIds.length > 131072) fail('switcher_visible_tabs_invalid');
    try { input.visibleTabIds = JSON.parse(query.visibleTabIds); } catch { fail('switcher_visible_tabs_invalid'); }
  }
  return normalizeSwitcherRequest(input);
}
const switcherRequestKey = input => JSON.stringify(normalizeSwitcherRequest(input));
module.exports = { normalizeSwitcherRequest, switcherRequestFromQuery, switcherRequestKey };
