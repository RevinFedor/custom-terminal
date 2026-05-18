// Shared JSONL → SDKChatMessage parser.
// Used by ClaudeSDKTab.loadHistory (main thread) AND TaskDetailPane (subagent
// mini-thread). Single source of truth keeps shape changes (block types, role
// classification) in one place.

export type ToolCallPart = {
  type: 'tool';
  id: string;
  name: string;
  args: Record<string, any>;
  result?: any;
  status: 'running' | 'done' | 'error';
};
export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | ToolCallPart;

export interface SDKChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'compact-summary';
  parts?: AssistantPart[];
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, any>; result?: any; status: 'running' | 'done' | 'error' }>;
  thinking: string | null;
  timestamp: number;
  compactMetrics?: { preTokens: number; postTokens: number; durationMs: number; trigger?: string };
}

export function extractToolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

export function assembleMessageFields(parts: AssistantPart[]): { text: string; thinking: string | null; toolCalls: SDKChatMessage['toolCalls'] } {
  const textPieces: string[] = [];
  const thinkingPieces: string[] = [];
  const toolCalls: SDKChatMessage['toolCalls'] = [];
  for (const p of parts) {
    if (p.type === 'text') textPieces.push(p.text);
    else if (p.type === 'thinking') thinkingPieces.push(p.text);
    else if (p.type === 'tool') toolCalls.push({ id: p.id, name: p.name, args: p.args, result: p.result, status: p.status });
  }
  return {
    text: textPieces.join('\n'),
    thinking: thinkingPieces.length ? thinkingPieces.join('\n') : null,
    toolCalls,
  };
}

// Parse raw SDK JSONL messages array → SDKChatMessage[].
// Subset of ClaudeSDKTab.loadHistory: drops compact-boundary/summary handling
// (subagent transcripts never have /compact boundaries), drops slash-command
// chips (subagents can't run them). The remaining shape is identical so the
// existing render components consume it without modification.
export function parseSubagentMessages(rawMessages: any[]): SDKChatMessage[] {
  if (!rawMessages || !rawMessages.length) return [];

  // PASS 1: collect tool_result blocks.
  const toolResults = new Map<string, { result: string; isError: boolean }>();
  for (const m of rawMessages) {
    if (m.type !== 'user' || !Array.isArray(m.message?.content)) continue;
    for (const block of m.message.content) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        toolResults.set(block.tool_use_id, {
          result: extractToolResultText(block.content),
          isError: !!block.is_error,
        });
      }
    }
  }

  // PASS 2: build messages.
  const loaded: SDKChatMessage[] = rawMessages.map((m: any, i: number): SDKChatMessage | null => {
    const contentArr = Array.isArray(m.message?.content) ? m.message.content : null;
    const parts: AssistantPart[] = [];
    if (contentArr) {
      for (const b of contentArr) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          parts.push({ type: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          const tid = b.id || 'tool-' + i;
          const tr = toolResults.get(tid);
          parts.push({
            type: 'tool',
            id: tid,
            name: b.name || 'unknown',
            args: typeof b.input === 'object' ? b.input : {},
            result: tr ? tr.result : undefined,
            status: tr ? (tr.isError ? 'error' : 'done') : 'done',
          });
        }
      }
    } else if (typeof m.message?.content === 'string') {
      parts.push({ type: 'text', text: m.message.content });
    }

    const derived = assembleMessageFields(parts);
    const role = m.type as 'user' | 'assistant' | 'system';

    if (role === 'system') return null; // subagent doesn't get system bubbles
    if (role === 'user') {
      const trimmed = derived.text.trim();
      // Drop wrappers — same filters as main loadHistory.
      if (m.isReplay || m.isSynthetic || m.isVisibleInTranscriptOnly) return null;
      const hasToolResultBlock = contentArr && contentArr.some((b: any) => b?.type === 'tool_result');
      if (hasToolResultBlock && !trimmed) return null;
      if (trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command-stdout>')) return null;
      if (trimmed === '[tool_result]' || trimmed.startsWith('<tool_result>')) return null;
      if (trimmed.startsWith('<system-reminder>') || trimmed.startsWith('<local-command-caveat>')) return null;
    }

    const out: SDKChatMessage = {
      id: m.uuid || ('sub-' + i),
      role,
      text: role === 'assistant' ? derived.text : derived.text,
      toolCalls: role === 'assistant' ? derived.toolCalls : [],
      thinking: role === 'assistant' ? derived.thinking : null,
      timestamp: Date.now() - (rawMessages.length - i) * 100,
    };
    if (role === 'assistant') out.parts = parts;
    return out;
  }).filter((m: SDKChatMessage | null): m is SDKChatMessage => {
    if (!m) return false;
    if (m.role === 'user' && !m.text.trim()) return false;
    return true;
  });

  // Merge consecutive assistant messages (same split-by-block JSONL pattern).
  const merged: SDKChatMessage[] = [];
  for (const m of loaded) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === 'assistant' && m.role === 'assistant') {
      const combined = [...(prev.parts || []), ...(m.parts || [])];
      const d = assembleMessageFields(combined);
      prev.parts = combined;
      prev.text = d.text;
      prev.thinking = d.thinking;
      prev.toolCalls = d.toolCalls;
    } else {
      merged.push({ ...m });
    }
  }
  return merged.filter(m => {
    if (m.role === 'assistant' && !m.text.trim() && m.toolCalls.length === 0 && !m.thinking) return false;
    return true;
  });
}
