'use strict';

const crypto = require('crypto');

const MAX_EVENT_HISTORY = 96;
const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_ITEM_TEXT_CHARS = 256 * 1024;

const normalizeText = (value) => String(value || '')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+\n/g, '\n')
  .trim();

const textHash = (value) => crypto
  .createHash('sha256')
  .update(normalizeText(value))
  .digest('hex')
  .slice(0, 16);

const short = (value, size = 16) => {
  const text = String(value || '');
  return text ? text.slice(-size) : '-';
};

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return String(value[0] || '');
    return String(value || '');
  }
  return '';
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '')); } catch { return null; }
}

function boundedHead(value, size = 96) {
  return normalizeText(value).replace(/\s+/g, ' ').slice(0, size);
}

function boundedItemText(value) {
  const text = String(value || '');
  if (text.length <= MAX_ITEM_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_ITEM_TEXT_CHARS), truncated: true };
}

function appendItemText(item, delta) {
  const addition = String(delta || '');
  item.totalChars = Number(item.totalChars ?? String(item?.text || '').length) + addition.length;
  if (item.truncated === true) return;
  const next = boundedItemText(String(item?.text || '') + addition);
  item.text = next.text;
  item.truncated = next.truncated;
}

function replaceItemText(item, text) {
  const raw = String(text || '');
  const next = boundedItemText(raw);
  item.text = next.text;
  item.truncated = next.truncated;
  item.totalChars = raw.length;
}

function createSseParser({ onEvent, onGap, maxBufferBytes = MAX_SSE_BUFFER_BYTES } = {}) {
  if (typeof onEvent !== 'function') throw new TypeError('onEvent is required');
  let buffer = '';
  let dropped = false;

  const consumeBlock = (block) => {
    const lines = String(block || '').split(/\r?\n/);
    let event = '';
    const data = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon >= 0 ? line.slice(0, colon) : line;
      let value = colon >= 0 ? line.slice(colon + 1) : '';
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!event && data.length === 0) return;
    onEvent({ event: event || 'message', data: data.join('\n') });
  };

  const drain = (final = false) => {
    for (;;) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      consumeBlock(block);
    }
    if (final && buffer.trim()) {
      consumeBlock(buffer);
      buffer = '';
    }
  };

  return {
    push(chunk) {
      if (dropped || chunk === null || chunk === undefined) return;
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(buffer) > maxBufferBytes) {
        dropped = true;
        buffer = '';
        onGap?.('sse-buffer-limit');
        return;
      }
      drain(false);
    },
    end() { if (!dropped) drain(true); },
    get dropped() { return dropped; },
  };
}

function claudeSessionId(body, headers) {
  const direct = headerValue(headers, 'x-claude-code-session-id');
  if (direct) return direct;
  const userId = String(body?.metadata?.user_id || '');
  const match = userId.match(/(?:session[_:=/-])([0-9a-f-]{16,})/i);
  return match?.[1] || '';
}

function claudeUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return normalizeText(message.content);
    if (!Array.isArray(message.content)) continue;
    return normalizeText(message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n'));
  }
  return '';
}

function claudeToolResultIds(body) {
  const result = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_result' && block.tool_use_id) result.push(String(block.tool_use_id));
    }
  }
  return result;
}

function isClaudeStructuredSideRequest(body) {
  return !!(body?.output_config?.format || body?.output_format || body?.response_format);
}

function codexRequestIdentity(payload) {
  const root = payload?.response && typeof payload.response === 'object'
    ? payload.response
    : payload || {};
  const metadata = root.metadata && typeof root.metadata === 'object' ? root.metadata : {};
  const clientMetadata = root.client_metadata && typeof root.client_metadata === 'object'
    ? root.client_metadata
    : payload?.client_metadata && typeof payload.client_metadata === 'object'
      ? payload.client_metadata
      : {};
  const turnMetadata = parseJson(clientMetadata['x-codex-turn-metadata']) || {};
  const sessionId = root.session_id
    || payload?.session_id
    || turnMetadata.session_id
    || metadata.session_id
    || null;
  const threadId = root.thread_id
    || payload?.thread_id
    || turnMetadata.thread_id
    || metadata.thread_id
    || sessionId
    || null;
  const turnId = root.turn_id
    || payload?.turn_id
    || turnMetadata.turn_id
    || metadata.turn_id
    || null;
  const requestKind = root.request_kind
    || payload?.request_kind
    || turnMetadata.request_kind
    || metadata.request_kind
    || (payload?.generate === false || root.generate === false ? 'prewarm' : null);
  const subagent = root.subagent
    || payload?.subagent
    || metadata.subagent
    || clientMetadata['x-openai-subagent']
    || root.subagent_id
    || payload?.subagent_id
    || metadata.subagent_id
    || turnMetadata.subagent_kind
    || turnMetadata.parent_thread_id
    || null;
  return {
    sessionId: sessionId ? String(sessionId) : null,
    threadId: threadId ? String(threadId) : null,
    turnId: turnId ? String(turnId) : null,
    requestKind: requestKind ? String(requestKind) : null,
    subagent: subagent ? String(subagent) : null,
  };
}

function responseOutputText(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if ((block?.type === 'output_text' || block?.type === 'text') && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('');
}

function createProviderSemanticShadow({
  log = console,
  now = () => Date.now(),
  maxEventHistory = MAX_EVENT_HISTORY,
  onCodexSemanticEvent = null,
} = {}) {
  const tabs = new Map();
  let requestSequence = 0;

  const ensureProvider = (tabId, provider) => {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { tabId, updatedAt: now(), events: [], providers: {} };
      tabs.set(tabId, tab);
    }
    if (!tab.providers[provider]) {
      tab.providers[provider] = {
        mainRequests: 0,
        sideRequests: 0,
        subagentRequests: 0,
        unknownRequests: 0,
        assistantDeltaEvents: 0,
        assistantCompletedEvents: 0,
        canonicalMatches: 0,
        canonicalPending: 0,
        latestDelta: null,
        latestMain: null,
        mainItems: [],
      };
    }
    tab.updatedAt = now();
    return { tab, providerState: tab.providers[provider] };
  };

  const record = (tabId, provider, type, detail = {}) => {
    const { tab, providerState } = ensureProvider(tabId, provider);
    const event = { at: now(), provider, type, ...detail };
    tab.events.push(event);
    if (tab.events.length > maxEventHistory) tab.events.splice(0, tab.events.length - maxEventHistory);
    const printable = {
      tab: short(tabId, 12),
      provider,
      type,
      ...detail,
    };
    log.log?.('[ProviderSemanticShadow] ' + Object.entries(printable)
      .map(([key, value]) => key + '=' + String(value ?? '-'))
      .join(' '));
    return providerState;
  };

  const classifyCount = (providerState, classification) => {
    if (classification === 'main') providerState.mainRequests += 1;
    else if (classification === 'side') providerState.sideRequests += 1;
    else if (classification === 'subagent') providerState.subagentRequests += 1;
    else providerState.unknownRequests += 1;
  };

  // Codex uses the provider stream as the live History producer. Keep this
  // callback observational with respect to transport: a renderer/preview bug
  // must never interrupt forwarding the provider response to the CLI.
  const emitCodexSemanticEvent = (detail) => {
    if (typeof onCodexSemanticEvent !== 'function') return false;
    try {
      onCodexSemanticEvent(detail);
      return true;
    } catch (error) {
      log.warn?.('[ProviderSemanticShadow] type=CODEX_LIVE_EVENT_ERROR'
        + ' tab=' + short(detail?.tabId, 12)
        + ' event=' + String(detail?.event?.type || '-')
        + ' error=' + (error?.message || String(error)));
      return false;
    }
  };

  const armClaudeTurn = ({ tabId, sessionId = null, turnId = null, prompt = '' } = {}) => {
    if (!tabId) return false;
    const { tab } = ensureProvider(tabId, 'claude');
    tab.claudeArm = {
      sessionId: sessionId ? String(sessionId) : null,
      turnId: turnId ? String(turnId) : null,
      prompt: normalizeText(prompt),
      claimed: false,
      pendingToolUseIds: new Set(),
      items: new Map(),
      itemOrder: [],
      armedAt: now(),
    };
    record(tabId, 'claude', 'TURN_ARMED', {
      session: short(sessionId, 8),
      turn: short(turnId, 18),
      promptChars: normalizeText(prompt).length,
      promptHash: prompt ? textHash(prompt) : '-',
    });
    return true;
  };

  const finishClaudeTurn = ({ tabId, reason = 'finished' } = {}) => {
    const tab = tabs.get(tabId);
    if (!tab?.claudeArm) return false;
    record(tabId, 'claude', 'TURN_FINISHED', {
      turn: short(tab.claudeArm.turnId, 18),
      reason,
    });
    tab.claudeArm = null;
    return true;
  };

  const publishMainItem = (tabId, provider, item, reason) => {
    const { providerState } = ensureProvider(tabId, provider);
    const text = String(item?.text || '');
    if (!text) return false;
    const normalized = normalizeText(text);
    const descriptor = {
      itemId: item.itemId,
      requestId: item.requestId || null,
      turnId: item.turnId || null,
      text: normalized,
      chars: Number(item.totalChars ?? normalized.length),
      hash: item.truncated === true ? null : textHash(normalized),
      completed: item.completed === true,
      truncated: item.truncated === true,
      gap: item.gap === true,
      at: now(),
    };
    const existingIndex = providerState.mainItems.findIndex((entry) => entry.itemId === descriptor.itemId);
    if (existingIndex >= 0) providerState.mainItems[existingIndex] = descriptor;
    else providerState.mainItems.push(descriptor);
    if (providerState.mainItems.length > 64) providerState.mainItems.splice(0, providerState.mainItems.length - 64);
    providerState.latestMain = {
      itemId: descriptor.itemId,
      requestId: descriptor.requestId,
      turnId: descriptor.turnId,
      chars: descriptor.chars,
      hash: descriptor.hash,
      head: boundedHead(normalized),
      completed: descriptor.completed,
      truncated: descriptor.truncated,
      gap: descriptor.gap,
      reason,
      at: descriptor.at,
    };
    return true;
  };

  const observeMainDelta = (tabId, provider, item) => {
    const { providerState } = ensureProvider(tabId, provider);
    providerState.assistantDeltaEvents += 1;
    providerState.latestDelta = {
      itemId: item.itemId,
      turnId: item.turnId || null,
      chars: Number(item.totalChars ?? String(item.text || '').length),
      head: boundedHead(String(item.text || '').slice(0, 160)),
      truncated: item.truncated === true,
      at: now(),
    };
  };

  const beginClaudeRequest = ({
    tabId,
    headers = {},
    body,
    transport = 'http-sse',
    requestId = null,
  } = {}) => {
    const parsedBody = parseJson(body) || {};
    const { tab, providerState } = ensureProvider(tabId, 'claude');
    const id = requestId || 'claude-' + (++requestSequence);
    const sessionId = claudeSessionId(parsedBody, headers) || null;
    const agentId = headerValue(headers, 'x-claude-code-agent-id') || null;
    const userText = claudeUserText(parsedBody);
    const toolResultIds = claudeToolResultIds(parsedBody);
    const arm = tab.claudeArm || null;
    const sameSession = !arm?.sessionId || !sessionId || arm.sessionId === sessionId;
    const exactPrompt = !!arm && sameSession && !!arm.prompt && userText === arm.prompt;
    const promptContained = !!arm && sameSession && !!arm.prompt && userText.includes(arm.prompt);
    const continuation = !!arm && sameSession && toolResultIds.some((toolId) => arm.pendingToolUseIds.has(toolId));
    let classification = 'unknown';
    let classificationReason = 'no-causal-owner';
    if (agentId) {
      classification = 'subagent';
      classificationReason = 'agent-header';
    } else if (isClaudeStructuredSideRequest(parsedBody)) {
      classification = 'side';
      classificationReason = 'structured-output-request';
    } else if (continuation) {
      classification = 'main';
      classificationReason = 'tool-result-chain';
    } else if (!arm?.claimed && (exactPrompt || promptContained || (!!arm && !arm.prompt))) {
      classification = 'main';
      classificationReason = exactPrompt ? 'exact-user-prompt' : promptContained ? 'contained-user-prompt' : 'hook-turn-without-prompt';
      arm.claimed = true;
    } else if (arm?.claimed && sameSession && (exactPrompt || promptContained)) {
      classification = 'main';
      classificationReason = 'main-request-retry';
    }
    classifyCount(providerState, classification);

    const context = {
      provider: 'claude',
      tabId,
      requestId: id,
      transport,
      sessionId,
      turnId: arm?.turnId || null,
      classification,
      classificationReason,
      blocks: new Map(),
      blockOrder: [],
      toolUseIds: new Set(),
      gap: false,
      finished: false,
    };
    record(tabId, 'claude', 'REQUEST', {
      request: short(id, 20),
      transport,
      session: short(sessionId, 8),
      turn: short(context.turnId, 18),
      classification,
      reason: classificationReason,
      toolResults: toolResultIds.length,
    });

    const ensureBlock = (index, kind = 'unknown', blockId = null) => {
      const key = String(index ?? context.blockOrder.length);
      let block = context.blocks.get(key);
      if (!block) {
        block = {
          itemId: blockId || id + ':' + key,
          requestId: id,
          kind,
          text: '',
          truncated: false,
          inputJson: '',
          completed: false,
          gap: false,
          turnId: context.turnId,
        };
        context.blocks.set(key, block);
        context.blockOrder.push(key);
      }
      if (kind && block.kind === 'unknown') block.kind = kind;
      if (blockId) block.itemId = String(blockId);
      return block;
    };

    const observeEvent = ({ event, data } = {}) => {
      const payload = parseJson(data);
      if (!payload) return false;
      const type = payload.type || event;
      if (type === 'content_block_start') {
        const blockType = payload.content_block?.type || 'unknown';
        const block = ensureBlock(payload.index, blockType, payload.content_block?.id || null);
        if (blockType === 'text' && typeof payload.content_block?.text === 'string') {
          replaceItemText(block, payload.content_block.text);
        }
        if (blockType === 'tool_use' && payload.content_block?.id) {
          context.toolUseIds.add(String(payload.content_block.id));
        }
        return true;
      }
      if (type === 'content_block_delta') {
        const deltaType = payload.delta?.type;
        const block = ensureBlock(payload.index, deltaType === 'text_delta' ? 'text' : 'unknown');
        if (deltaType === 'text_delta' && typeof payload.delta.text === 'string') {
          appendItemText(block, payload.delta.text);
          if (classification === 'main') {
            observeMainDelta(tabId, 'claude', block);
          }
        } else if (deltaType === 'input_json_delta' && typeof payload.delta.partial_json === 'string') {
          block.inputJson += payload.delta.partial_json;
        }
        return true;
      }
      if (type === 'content_block_stop') {
        const block = ensureBlock(payload.index);
        block.completed = true;
        if (classification === 'main' && block.kind === 'text' && block.text) {
          providerState.assistantCompletedEvents += 1;
          publishMainItem(tabId, 'claude', block, 'network-assistant-completed');
        }
        return true;
      }
      if (type === 'message_stop' || type === 'message_delta') {
        if (type === 'message_stop') context.finish('message-stop');
        return true;
      }
      if (type === 'error') {
        context.finish('provider-error');
        return true;
      }
      return false;
    };

    context.observeSseEvent = observeEvent;
    context.markGap = (reason = 'stream-gap') => {
      context.gap = true;
      for (const block of context.blocks.values()) block.gap = true;
      for (const item of providerState.mainItems) {
        if (item.requestId === id) item.gap = true;
      }
      if (providerState.latestMain?.requestId === id) providerState.latestMain.gap = true;
      record(tabId, 'claude', 'GAP', {
        request: short(id, 20),
        classification,
        reason,
      });
    };
    context.finish = (reason = 'response-end') => {
      if (context.finished) return false;
      context.finished = true;
      if (classification === 'main' && arm) {
        arm.pendingToolUseIds = new Set(context.toolUseIds);
        for (const key of context.blockOrder) {
          const block = context.blocks.get(key);
          if (!block || block.kind !== 'text' || !block.text || context.gap) continue;
          const wasCompleted = block.completed === true;
          block.completed = true;
          if (!wasCompleted) providerState.assistantCompletedEvents += 1;
          publishMainItem(tabId, 'claude', block, 'network-response-finished');
        }
      }
      const mainText = context.blockOrder
        .map((key) => context.blocks.get(key))
        .filter((block) => block?.kind === 'text')
        .map((block) => block.text)
        .join('\n\n');
      const responseTextBlocks = context.blockOrder
        .map((key) => context.blocks.get(key))
        .filter((block) => block?.kind === 'text');
      const responseTruncated = responseTextBlocks.some((block) => block.truncated === true);
      const responseChars = responseTextBlocks.reduce(
        (total, block) => total + Number(block.totalChars ?? String(block.text || '').length),
        0,
      );
      record(tabId, 'claude', 'RESPONSE_END', {
        request: short(id, 20),
        classification,
        reason,
        chars: responseChars,
        hash: responseTruncated ? 'truncated' : mainText ? textHash(mainText) : '-',
        tools: context.toolUseIds.size,
        gap: context.gap,
      });
      return true;
    };
    return context;
  };

  const createCodexConnection = ({
    tabId,
    transport = 'websocket',
    sourceId = null,
  } = {}) => {
    const { providerState } = ensureProvider(tabId, 'codex');
    const contexts = new Map();
    let current = null;

    const beginRequest = (payload) => {
      const identity = codexRequestIdentity(payload);
      const requestId = 'codex-' + (++requestSequence);
      const classification = identity.subagent
        ? 'subagent'
        : identity.requestKind === 'prewarm'
          ? 'side'
          : identity.turnId
            ? 'main'
            : 'unknown';
      const classificationReason = identity.subagent
        ? 'subagent-marker'
        : identity.requestKind === 'prewarm'
          ? 'prewarm'
          : identity.turnId
            ? 'exact-turn-id'
            : 'turn-identity-missing';
      classifyCount(providerState, classification);
      current = {
        provider: 'codex',
        tabId,
        requestId,
        transport,
        ...identity,
        classification,
        classificationReason,
        responseId: null,
        items: new Map(),
        itemOrder: [],
        finished: false,
      };
      contexts.set(requestId, current);
      record(tabId, 'codex', 'REQUEST', {
        request: short(requestId, 20),
        transport,
        session: short(identity.sessionId, 8),
        thread: short(identity.threadId, 12),
        turn: short(identity.turnId, 18),
        kind: identity.requestKind || '-',
        classification,
        reason: classificationReason,
      });
      if (classification === 'main' && sourceId) {
        emitCodexSemanticEvent({
          tabId,
          sourceId,
          transport,
          event: {
            type: 'turn_started',
            requestId,
            threadId: current.threadId,
            turnId: current.turnId,
          },
        });
      }
      return current;
    };

    const ensureItem = (context, itemId) => {
      const id = String(itemId || context.requestId + ':' + context.itemOrder.length);
      let item = context.items.get(id);
      if (!item) {
        item = {
          itemId: id,
          requestId: context.requestId,
          turnId: context.turnId,
          text: '',
          truncated: false,
          completed: false,
          gap: false,
          semanticStarted: false,
        };
        context.items.set(id, item);
        context.itemOrder.push(id);
      }
      return item;
    };

    const emitAssistantItemStarted = (context, item) => {
      if (!sourceId || context?.classification !== 'main' || item?.semanticStarted === true) {
        return false;
      }
      item.semanticStarted = true;
      return emitCodexSemanticEvent({
        tabId,
        sourceId,
        transport,
        event: {
          type: 'item_started',
          requestId: context.requestId,
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: item.itemId,
          item: {
            kind: 'agentMessage',
            itemId: item.itemId,
            requestId: context.requestId,
            phase: 'provider-stream',
          },
        },
      });
    };

    const emitAssistantDelta = (context, item, delta) => {
      if (!sourceId || context?.classification !== 'main' || typeof delta !== 'string') {
        return false;
      }
      emitAssistantItemStarted(context, item);
      return emitCodexSemanticEvent({
        tabId,
        sourceId,
        transport,
        event: {
          type: 'assistant_delta',
          requestId: context.requestId,
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: item.itemId,
          delta,
        },
      });
    };

    const emitAssistantCompleted = (context, item) => {
      if (!sourceId || context?.classification !== 'main' || !item) return false;
      emitAssistantItemStarted(context, item);
      return emitCodexSemanticEvent({
        tabId,
        sourceId,
        transport,
        event: {
          type: 'item_completed',
          requestId: context.requestId,
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: item.itemId,
          item: {
            kind: 'agentMessage',
            itemId: item.itemId,
            requestId: context.requestId,
            phase: 'provider-stream',
            text: item.text,
          },
        },
      });
    };

    const findContext = (payload) => {
      const responseId = payload?.response_id || payload?.response?.id || null;
      if (responseId) {
        for (const context of Array.from(contexts.values()).reverse()) {
          if (context.responseId === responseId) return context;
        }
      }
      return current;
    };

    const finishContext = (context, reason, response = null) => {
      if (!context || context.finished) return false;
      context.finished = true;
      if (reason !== 'response-completed') {
        context.gap = true;
        for (const item of context.items.values()) item.gap = true;
        for (const item of providerState.mainItems) {
          if (item.requestId === context.requestId) item.gap = true;
        }
        if (providerState.latestMain?.requestId === context.requestId) {
          providerState.latestMain.gap = true;
        }
        if (context.classification === 'main' && sourceId) {
          emitCodexSemanticEvent({
            tabId,
            sourceId,
            transport,
            event: {
              type: 'request_failed',
              requestId: context.requestId,
              threadId: context.threadId,
              turnId: context.turnId,
              reason,
            },
          });
        }
      }
      const recovered = responseOutputText(response);
      if (recovered && context.gap !== true) {
        const item = ensureItem(context, response?.output?.find((entry) => entry?.type === 'message')?.id);
        replaceItemText(item, recovered);
        item.completed = true;
        if (context.classification === 'main') {
          providerState.assistantCompletedEvents += 1;
          publishMainItem(tabId, 'codex', item, 'network-response-recovered');
          emitAssistantCompleted(context, item);
        }
      }
      const fullText = context.itemOrder.map((id) => context.items.get(id)?.text || '').join('\n\n');
      const responseItems = context.itemOrder.map((id) => context.items.get(id)).filter(Boolean);
      const responseTruncated = responseItems.some((item) => item.truncated === true);
      const responseChars = responseItems.reduce(
        (total, item) => total + Number(item.totalChars ?? String(item.text || '').length),
        0,
      );
      record(tabId, 'codex', 'RESPONSE_END', {
        request: short(context.requestId, 20),
        turn: short(context.turnId, 18),
        classification: context.classification,
        reason,
        chars: responseChars,
        hash: responseTruncated ? 'truncated' : fullText ? textHash(fullText) : '-',
      });
      if (reason === 'response-completed' && context.classification === 'main' && sourceId) {
        emitCodexSemanticEvent({
          tabId,
          sourceId,
          transport,
          event: {
            type: 'turn_completed',
            requestId: context.requestId,
            threadId: context.threadId,
            turnId: context.turnId,
          },
        });
      }
      return true;
    };

    const observeClientFrame = (data, isBinary = false) => {
      if (isBinary) return false;
      const payload = parseJson(data);
      if (!payload || payload.type !== 'response.create') return false;
      beginRequest(payload);
      return true;
    };

    const observeServerFrame = (data, isBinary = false) => {
      if (isBinary) return false;
      const payload = parseJson(data);
      if (!payload) return false;
      const type = String(payload.type || '');
      const context = findContext(payload);
      if (type === 'response.created' && context && payload.response?.id) {
        context.responseId = String(payload.response.id);
        return true;
      }
      if (!context) return false;
      if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        const item = ensureItem(context, payload.item_id || payload.itemId);
        appendItemText(item, payload.delta);
        if (context.classification === 'main') {
          observeMainDelta(tabId, 'codex', item);
          emitAssistantDelta(context, item, payload.delta);
        }
        return true;
      }
      if (type === 'response.output_text.done' && typeof payload.text === 'string') {
        const item = ensureItem(context, payload.item_id || payload.itemId);
        replaceItemText(item, payload.text);
        item.completed = true;
        if (context.classification === 'main') {
          providerState.assistantCompletedEvents += 1;
          publishMainItem(tabId, 'codex', item, 'network-assistant-completed');
          emitAssistantCompleted(context, item);
        }
        return true;
      }
      if (type === 'response.output_item.done' && payload.item?.type === 'message') {
        const text = responseOutputText({ output: [payload.item] });
        if (text) {
          const item = ensureItem(context, payload.item.id);
          replaceItemText(item, text);
          item.completed = true;
          if (context.classification === 'main') {
            providerState.assistantCompletedEvents += 1;
            publishMainItem(tabId, 'codex', item, 'network-assistant-item-completed');
            emitAssistantCompleted(context, item);
          }
        }
        return true;
      }
      if (type === 'response.completed') return finishContext(context, 'response-completed', payload.response);
      if (type === 'response.failed' || type === 'error') return finishContext(context, type);
      return false;
    };

    const observeHttpRequest = (body) => beginRequest(parseJson(body) || {});
    const observeHttpEvent = (context, { event, data } = {}) => {
      const payload = parseJson(data);
      if (!payload) return false;
      if (!payload.type && event && event !== 'message') payload.type = event;
      const previous = current;
      current = context;
      try { return observeServerFrame(JSON.stringify(payload), false); } finally { current = previous; }
    };
    const finishAll = (reason = 'transport-closed') => {
      let finished = 0;
      for (const context of contexts.values()) {
        if (finishContext(context, reason)) finished += 1;
      }
      return finished;
    };

    return {
      beginRequest,
      finishAll,
      observeClientFrame,
      observeHttpEvent,
      observeHttpRequest,
      observeServerFrame,
    };
  };

  const observeCanonical = ({ tabId, provider, turnId = null, itemId = null, text = '' } = {}) => {
    const normalized = normalizeText(text);
    if (!tabId || !normalized || (provider !== 'claude' && provider !== 'codex')) return false;
    const { providerState } = ensureProvider(tabId, provider);
    const candidates = providerState.mainItems.filter((item) => (
      item.truncated !== true
      && item.gap !== true
      &&
      (!turnId || !item.turnId || String(item.turnId) === String(turnId))
      && (!itemId || item.itemId === itemId || item.text === normalized)
    ));
    const exact = candidates.find((item) => item.text === normalized)
      || providerState.mainItems.find((item) => (
        item.truncated !== true
        && item.gap !== true
        && item.text === normalized
      ));
    if (exact) providerState.canonicalMatches += 1;
    else providerState.canonicalPending += 1;
    record(tabId, provider, exact ? 'CANONICAL_MATCH' : 'CANONICAL_PENDING', {
      turn: short(turnId, 18),
      item: short(itemId, 18),
      chars: normalized.length,
      hash: textHash(normalized),
      networkItem: short(exact?.itemId, 18),
    });
    return !!exact;
  };

  const snapshot = (tabId = null) => {
    const selected = tabId ? [tabs.get(tabId)].filter(Boolean) : Array.from(tabs.values());
    return selected.map((tab) => ({
      tabId: tab.tabId,
      updatedAt: tab.updatedAt,
      providers: Object.fromEntries(Object.entries(tab.providers).map(([provider, state]) => [provider, {
        mainRequests: state.mainRequests,
        sideRequests: state.sideRequests,
        subagentRequests: state.subagentRequests,
        unknownRequests: state.unknownRequests,
        assistantDeltaEvents: state.assistantDeltaEvents,
        assistantCompletedEvents: state.assistantCompletedEvents,
        canonicalMatches: state.canonicalMatches,
        canonicalPending: state.canonicalPending,
        latestDelta: state.latestDelta ? { ...state.latestDelta } : null,
        latestMain: state.latestMain ? { ...state.latestMain } : null,
      }])),
      events: tab.events.map((event) => ({ ...event })),
    }));
  };

  const clear = (tabId, reason = 'clear') => {
    if (!tabId || !tabs.has(tabId)) return false;
    const tab = tabs.get(tabId);
    log.log?.('[ProviderSemanticShadow] tab=' + short(tabId, 12)
      + ' type=CLEAR reason=' + reason
      + ' events=' + (tab?.events?.length || 0));
    tabs.delete(tabId);
    return true;
  };

  return {
    armClaudeTurn,
    beginClaudeRequest,
    clear,
    createCodexConnection,
    finishClaudeTurn,
    observeCanonical,
    snapshot,
  };
}

module.exports = {
  MAX_EVENT_HISTORY,
  MAX_ITEM_TEXT_CHARS,
  MAX_SSE_BUFFER_BYTES,
  claudeSessionId,
  claudeToolResultIds,
  claudeUserText,
  codexRequestIdentity,
  createProviderSemanticShadow,
  createSseParser,
  headerValue,
  isClaudeStructuredSideRequest,
  normalizeText,
  responseOutputText,
  textHash,
};
