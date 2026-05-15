// Translates raw SDK messages (the same shape the desktop renderer gets via
// `claude-sdk:message` IPC) into a flat list of UI-friendly entries.
//
// SDK message shapes we care about (see fact-claude-sdk-tab.md::Tool-call rendering):
//   { type:'system', subtype:'init', ... }                 → ignored by UI
//   { type:'user', message: { role:'user', content: [...] } }
//       content can be: text blocks OR tool_result blocks (these update an
//       earlier assistant tool_use status; we ignore them for the UI flat list,
//       but apply their result text into the matching tool entry).
//   { type:'assistant', message: { role:'assistant', content: [...] } }
//       content = mix of text blocks, tool_use blocks, thinking blocks.
//   { type:'result', subtype:'success'|'error', result, is_error? }   → footer

export type UiEntry =
  // entryUuid (when present) anchors a chat bubble to its JSONL record so
  // the timeline drawer's GoTo can scroll to it via [data-entry-uuid].
  | { kind: 'user'; id: string; text: string; entryUuid?: string }
  | { kind: 'assistant'; id: string; text: string; entryUuid?: string }
  | { kind: 'thinking'; id: string; text: string; entryUuid?: string }
  | { kind: 'tool'; id: string; tool: string; input?: any; result?: string; isError?: boolean }
  | { kind: 'error'; id: string; text: string };

type State = {
  entries: UiEntry[];
  toolById: Map<string, UiEntry & { kind: 'tool' }>;
  // Per-assistant-message accumulation key — for streaming partials we want to
  // append onto the same entry, not push a new one.
  assistantById: Map<string, UiEntry & { kind: 'assistant' }>;
  // Same for thinking blocks — coalesce streaming chunks
  thinkingById: Map<string, UiEntry & { kind: 'thinking' }>;
};

export function createMessageReducer() {
  const state: State = { entries: [], toolById: new Map(), assistantById: new Map(), thinkingById: new Map() };
  let counter = 0;
  const nextId = () => `m-${++counter}-${Date.now()}`;

  function reset() {
    state.entries = [];
    state.toolById.clear();
    state.assistantById.clear();
    state.thinkingById.clear();
  }

  // Apply one SDK message; mutates `state.entries` and returns a snapshot.
  function apply(raw: any): UiEntry[] {
    if (!raw || typeof raw !== 'object') return state.entries.slice();
    const t = raw.type;

    if (t === 'user') {
      const content = raw.message?.content;
      // tool_result blocks live inside user messages — apply them to existing tools
      if (Array.isArray(content)) {
        let pushedUserText = false;
        for (const block of content) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            const tool = state.toolById.get(block.tool_use_id);
            if (tool) {
              const txt = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => c?.text || '').join('\n')
                  : '';
              tool.result = txt;
              tool.isError = !!block.is_error;
            }
          } else if (block?.type === 'text' && typeof block.text === 'string' && !pushedUserText) {
            state.entries.push({ kind: 'user', id: nextId(), text: block.text, entryUuid: raw.uuid });
            pushedUserText = true;
          }
        }
      } else if (typeof content === 'string') {
        state.entries.push({ kind: 'user', id: nextId(), text: content, entryUuid: raw.uuid });
      }
      return state.entries.slice();
    }

    if (t === 'assistant') {
      const msgId: string = raw.message?.id || raw.uuid || nextId();
      const content = raw.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'thinking' && typeof block.thinking === 'string') {
            // Thinking is its OWN entry — sits before the matching assistant
            // text in the flow so the user sees process → answer in order.
            let tEntry = state.thinkingById.get(msgId);
            if (!tEntry) {
              tEntry = { kind: 'thinking', id: 'thinking-' + msgId, text: '' };
              state.thinkingById.set(msgId, tEntry);
              state.entries.push(tEntry);
            }
            tEntry.text = block.thinking;
          } else if (block?.type === 'text' && typeof block.text === 'string') {
            let entry = state.assistantById.get(msgId);
            if (!entry) {
              entry = { kind: 'assistant', id: msgId, text: '', entryUuid: raw.uuid };
              state.assistantById.set(msgId, entry);
              state.entries.push(entry);
            }
            entry.text = block.text;
          } else if (block?.type === 'tool_use' && block.id) {
            if (!state.toolById.has(block.id)) {
              const toolEntry: UiEntry & { kind: 'tool' } = {
                kind: 'tool',
                id: block.id,
                tool: block.name || 'tool',
                input: block.input,
              };
              state.toolById.set(block.id, toolEntry);
              state.entries.push(toolEntry);
            }
          }
        }
      }
      return state.entries.slice();
    }

    if (t === 'result') {
      if (raw.is_error || raw.subtype === 'error') {
        state.entries.push({ kind: 'error', id: nextId(), text: String(raw.result || 'error') });
      }
      return state.entries.slice();
    }

    return state.entries.slice();
  }

  // Restore from cached entries — used by ChatView on mount when a localStorage
  // snapshot exists. Repopulates assistantById/toolById so subsequent streaming
  // chunks can still find and update existing assistant/tool entries by id.
  function restore(prefilled: UiEntry[]) {
    state.entries = prefilled.slice();
    state.assistantById.clear();
    state.toolById.clear();
    state.thinkingById.clear();
    for (const e of state.entries) {
      if (e.kind === 'assistant') state.assistantById.set(e.id, e);
      else if (e.kind === 'tool') state.toolById.set(e.id, e);
      else if (e.kind === 'thinking') {
        // Thinking ids in apply() are 'thinking-<msgId>'; restore as-is.
        const key = e.id.startsWith('thinking-') ? e.id.slice(9) : e.id;
        state.thinkingById.set(key, e);
      }
    }
  }

  return { apply, reset, restore, getEntries: () => state.entries.slice() };
}
