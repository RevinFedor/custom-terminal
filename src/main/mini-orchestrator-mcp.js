'use strict';

const { randomUUID } = require('node:crypto');

// Speak to the existing HTTP MCP hub; do not launch a second Terminal server,
// invent a PTY reviewer SID, or bypass its ordinary Project API send scenario.
function createMiniOrchestratorMcpSender({ endpointFor, fetchImpl = fetch, timeoutMs = 70000 } = {}) {
  // targetTabId differs from tabId only in forward mode: the calling identity
  // stays the reviewed tab, while the recipient is its chosen reviewer tab.
  return async function sendCorrection({ tabId, owner, turnId, jobId, prompt, handoffId, isCurrent, targetTabId }) {
    const base = { handoffId, status: 'unknown' };
    const recipient = typeof targetTabId === 'string' && targetTabId ? targetTabId : tabId;
    if (!tabId || handoffId !== 'mini-orchestrator:' + jobId || isCurrent?.() !== true) return { ...base, status: 'refused', error: 'mini_review_stale' };
    const endpoint = await endpointFor({ tabId, owner, turnId, jobId });
    if (isCurrent() !== true) return { ...base, status: 'refused', error: 'mini_review_stale' };
    // Two transports, one scenario layer: the shared MCP hub when this app
    // owns it, otherwise this instance's own Project API. Both end in the same
    // guarded send; neither invents a second writer.
    const local = typeof endpoint === 'object' && endpoint?.kind === 'project-api'
      ? { ...endpoint, url: endpoint.base + encodeURIComponent(recipient) + '/send' } : null;
    const parsed = new URL(local ? local.url : endpoint);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || (local ? !parsed.pathname.endsWith('/send') : parsed.pathname !== '/mcp/terminal')) throw new Error('mini_mcp_endpoint_invalid');
    const rpcId = randomUUID();
    try {
      if (local) {
        const response = await fetchImpl(local.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
            ...(local.token ? { Authorization: 'Bearer ' + local.token } : {}) },
          // Same authorship as the hub transport below (`send_prompt` sends
          // source:'terminal-mcp'). Without it the route has no author at all,
          // so History records no provenance and renders the delivery as an
          // ordinary human paste instead of a Terminal MCP message. This is the
          // author of the send, not the transport: `sendSurface:'project-api'`
          // stays owned by the route.
          body: JSON.stringify({ prompt, handoffId, source: 'terminal-mcp' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const wire = await response.json().catch(() => ({}));
        if (!response.ok) {
          try { console.log('[MiniOrchestrator] local-send-failed http=' + response.status
            + ' error=' + String(wire.error || wire.code || '-').slice(0, 120)
            + ' reason=' + String(wire.reason || wire.status || '-').slice(0, 120)
            + ' keys=' + Object.keys(wire).join(',').slice(0, 160)); } catch {}
          return { ...base, error: 'mini_mcp_outcome_unknown' };
        }
        const status = ['sent', 'queued', 'unknown', 'refused', 'no-input'].includes(wire.status)
          ? wire.status : wire.ok === true || wire.success === true ? 'sent' : 'unknown';
        return { ...base, status, rpcId };
      }
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call',
          params: { name: 'send_prompt', arguments: { tabId: recipient, prompt, submit: true, queue: true, handoffId } } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const wire = await response.json();
      if (wire.id !== rpcId || wire.error || wire.result?.isError || !response.ok) return { ...base, error: 'mini_mcp_outcome_unknown' };
      const text = (wire.result?.content || []).filter(x => x.type === 'text').map(x => x.text || '').join('\n');
      const status = /delivery state is unknown|confirmation is pending/i.test(text) ? 'unknown'
        : /Status:\s*(?:application-queued|queued)\b/i.test(text) ? 'queued'
          : /Status:\s*(?:sent|confirmed)\b/i.test(text) ? 'sent' : 'unknown';
      return { ...base, status, rpcId };
    } catch (transportError) {
      try { console.log('[MiniOrchestrator] send-transport-error local=' + String(!!local)
        + ' err=' + String(transportError?.message || transportError).slice(0, 200)); } catch {}
      // No blind replay after a transport error. The exact handoff already
      // exists in the controller journal; existing receipt API can recover it.
      return { ...base, rpcId, error: 'mini_mcp_outcome_unknown' };
    }
  };
}

module.exports = { createMiniOrchestratorMcpSender };
