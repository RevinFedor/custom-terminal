/**
 * ClaudeAgentManager — isolated module for Claude Agent SDK V2.
 * Single point of dependency on @anthropic-ai/claude-agent-sdk.
 *
 * SDK is ESM-only → uses lazy dynamic import() (compatible with Electron's CommonJS main process).
 *
 * API:
 *   send(tabId, prompt, options?) → Promise<{ sessionId, result, meta }>
 *   sendNew(tabId, prompt, options?) → Force new session
 *   getSessionMeta(tabId) → { sessionId, turns, totalCostUsd, totalInputTokens, totalOutputTokens }
 *   cancel(tabId) → void
 *   getStatus(tabId) → 'idle' | 'running' | 'error'
 *   getSessionId(tabId) → string | null
 *   cleanup(tabId) → void
 */

// Lazy-loaded SDK functions (ESM dynamic import)
let _sdk = null;
async function getSDK() {
  if (!_sdk) {
    _sdk = await import('@anthropic-ai/claude-agent-sdk');
  }
  return _sdk;
}

class ClaudeAgentManager {
  constructor() {
    // tabId → { session, sessionId, status, abortController, queue, meta }
    this.tabs = new Map();
  }

  _getTab(tabId) {
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        session: null,
        sessionId: null,
        status: 'idle',
        abortController: null,
        queue: Promise.resolve(),
        meta: { turns: 0, totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 }
      });
    }
    return this.tabs.get(tabId);
  }

  /**
   * Send a prompt to Claude Agent for a given tab.
   * Queued: only one call runs at a time per tab.
   * Reuses session (multi-turn) if one exists.
   */
  send(tabId, prompt, options = {}) {
    const tab = this._getTab(tabId);
    const task = tab.queue.then(() => this._doSend(tabId, prompt, options));
    tab.queue = task.catch(() => {});
    return task;
  }

  /**
   * Force a new session (discard current).
   */
  sendNew(tabId, prompt, options = {}) {
    const tab = this._getTab(tabId);
    // Close existing session
    if (tab.session) {
      try { tab.session.close(); } catch {}
      tab.session = null;
    }
    tab.sessionId = null;
    tab.meta = { turns: 0, totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 };
    return this.send(tabId, prompt, options);
  }

  async _doSend(tabId, prompt, options = {}) {
    const tab = this._getTab(tabId);
    const { cwd, model = 'claude-sonnet-4-20250514', onStatus } = options;

    const sdk = await getSDK();

    tab.abortController = new AbortController();
    tab.status = 'running';
    if (onStatus) onStatus('running');

    try {
      // Create or resume session
      let session = tab.session;
      if (!session) {
        if (tab.sessionId) {
          console.log('[ClaudeAgent] Tab ' + tabId + ': Resuming session ' + tab.sessionId);
          session = sdk.unstable_v2_resumeSession(tab.sessionId, {
            model,
            cwd,
            permissionMode: 'acceptEdits',
            abortController: tab.abortController,
          });
        } else {
          console.log('[ClaudeAgent] Tab ' + tabId + ': Creating new session (cwd=' + cwd + ')');
          session = sdk.unstable_v2_createSession({
            model,
            cwd,
            permissionMode: 'acceptEdits',
            abortController: tab.abortController,
          });
        }
        tab.session = session;
      }

      // Send prompt
      await session.send(prompt);

      // Collect response
      let resultText = '';
      let costUsd = undefined;
      let durationMs = undefined;
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const msg of session.stream()) {
        // Capture session ID from init message
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          tab.sessionId = msg.session_id;
          console.log('[ClaudeAgent] Tab ' + tabId + ': Session ID = ' + tab.sessionId);
        }

        if (msg.type === 'assistant') {
          const text = msg.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
          if (text) resultText += text;

          // Track token usage from assistant message
          if (msg.message.usage) {
            inputTokens += msg.message.usage.input_tokens || 0;
            outputTokens += msg.message.usage.output_tokens || 0;
          }
        }

        if (msg.type === 'result') {
          if (msg.subtype === 'success' && msg.result) {
            if (!resultText) resultText = msg.result;
          } else if (msg.subtype !== 'success') {
            throw new Error('Claude agent error: ' + (msg.error || msg.subtype));
          }
          costUsd = msg.total_cost_usd;
          durationMs = msg.duration_ms;
          // Result-level usage overrides accumulated
          if (msg.usage) {
            inputTokens = msg.usage.input_tokens || inputTokens;
            outputTokens = msg.usage.output_tokens || outputTokens;
          }
        }
      }

      // Update cumulative meta
      tab.meta.turns += 1;
      tab.meta.totalCostUsd += costUsd || 0;
      tab.meta.totalInputTokens += inputTokens;
      tab.meta.totalOutputTokens += outputTokens;

      tab.status = 'idle';
      if (onStatus) onStatus('done');
      tab.abortController = null;

      const meta = {
        sessionId: tab.sessionId,
        turn: tab.meta.turns,
        turnCostUsd: costUsd || 0,
        turnDurationMs: durationMs || 0,
        turnInputTokens: inputTokens,
        turnOutputTokens: outputTokens,
        totalCostUsd: tab.meta.totalCostUsd,
        totalInputTokens: tab.meta.totalInputTokens,
        totalOutputTokens: tab.meta.totalOutputTokens,
      };

      return { sessionId: tab.sessionId, result: resultText, meta };
    } catch (err) {
      tab.session = null;
      tab.abortController = null;

      if (err.name === 'AbortError' || tab.status === 'cancelled') {
        tab.status = 'idle';
        if (onStatus) onStatus('cancelled');
        throw new Error('Cancelled');
      }

      tab.status = 'error';
      if (onStatus) onStatus('error');
      console.error('[ClaudeAgent] Tab ' + tabId + ' error:', err.message);
      throw err;
    }
  }

  /**
   * Get session metadata (for :::claude:status :::)
   */
  getSessionMeta(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    return {
      sessionId: tab.sessionId,
      status: tab.status,
      turns: tab.meta.turns,
      totalCostUsd: tab.meta.totalCostUsd,
      totalInputTokens: tab.meta.totalInputTokens,
      totalOutputTokens: tab.meta.totalOutputTokens,
    };
  }

  cancel(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.status = 'cancelled';
    if (tab.abortController) {
      tab.abortController.abort();
      tab.abortController = null;
    }
  }

  getStatus(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.status : 'idle';
  }

  getSessionId(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.sessionId : null;
  }

  cleanup(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.cancel(tabId);
    if (tab.session) {
      try { tab.session.close(); } catch {}
      tab.session = null;
    }
    this.tabs.delete(tabId);
    console.log('[ClaudeAgent] Tab ' + tabId + ': cleaned up');
  }
}

module.exports = ClaudeAgentManager;
