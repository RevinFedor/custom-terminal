/**
 * ClaudeAgentManager — isolated module for Claude Agent SDK V2.
 * Single point of dependency on @anthropic-ai/claude-agent-sdk.
 *
 * SDK is ESM-only → uses lazy dynamic import() (compatible with Electron's CommonJS main process).
 *
 * API:
 *   send(tabId, prompt, options?) → Promise<{ sessionId, result, usage }>
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
    // tabId → { session, sessionId, status, abortController, queue }
    this.tabs = new Map();
  }

  _getTab(tabId) {
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, {
        session: null,
        sessionId: null,
        status: 'idle',
        abortController: null,
        queue: Promise.resolve() // serializes calls per tab
      });
    }
    return this.tabs.get(tabId);
  }

  /**
   * Send a prompt to Claude Agent for a given tab.
   * Queued: only one call runs at a time per tab.
   * Reuses session (multi-turn) if one exists.
   *
   * @param {string} tabId
   * @param {string} prompt
   * @param {{ cwd?: string, model?: string, onStatus?: (status: string) => void }} options
   * @returns {Promise<{ sessionId: string, result: string, costUsd?: number, durationMs?: number }>}
   */
  send(tabId, prompt, options = {}) {
    const tab = this._getTab(tabId);
    // Chain onto the queue so parallel calls serialize
    const task = tab.queue.then(() => this._doSend(tabId, prompt, options));
    tab.queue = task.catch(() => {}); // swallow to keep queue alive
    return task;
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
          // Resume existing session
          console.log('[ClaudeAgent] Tab ' + tabId + ': Resuming session ' + tab.sessionId);
          session = sdk.unstable_v2_resumeSession(tab.sessionId, {
            model,
            cwd,
            permissionMode: 'acceptEdits',
            abortController: tab.abortController,
          });
        } else {
          // New session
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

      for await (const msg of session.stream()) {
        // Capture session ID from any message
        if (msg.session_id && !tab.sessionId) {
          tab.sessionId = msg.session_id;
          console.log('[ClaudeAgent] Tab ' + tabId + ': Session ID = ' + tab.sessionId);
        }

        if (msg.type === 'assistant') {
          const text = msg.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
          if (text) resultText += text;
        }

        if (msg.type === 'result') {
          if (msg.subtype === 'success' && msg.result) {
            // Use result text if we didn't capture from assistant messages
            if (!resultText) resultText = msg.result;
          } else if (msg.subtype !== 'success') {
            throw new Error('Claude agent error: ' + (msg.error || msg.subtype));
          }
          costUsd = msg.total_cost_usd;
          durationMs = msg.duration_ms;
        }
      }

      tab.status = 'idle';
      if (onStatus) onStatus('done');
      tab.abortController = null;

      return {
        sessionId: tab.sessionId,
        result: resultText,
        costUsd,
        durationMs,
      };
    } catch (err) {
      // Session may be broken after abort/error — force re-create on next call
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
   * Cancel a running request for a tab.
   */
  cancel(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.status = 'cancelled';
    if (tab.abortController) {
      tab.abortController.abort();
      tab.abortController = null;
    }
  }

  /**
   * @returns {'idle' | 'running' | 'error'}
   */
  getStatus(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.status : 'idle';
  }

  /**
   * @returns {string | null}
   */
  getSessionId(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.sessionId : null;
  }

  /**
   * Clean up a tab's session (e.g. when tab closes).
   */
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
