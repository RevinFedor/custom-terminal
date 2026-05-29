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
  // wasQueued — desktop отправил из type-ahead очереди (Enter во время
  // стриминга). Live-only флаг, после reload теряется (Anthropic JSONL не
  // хранит UI-метаданные). EntryView рендерит маленький "queued" chip.
  | { kind: 'user'; id: string; text: string; entryUuid?: string; wasQueued?: boolean }
  | { kind: 'assistant'; id: string; text: string; entryUuid?: string }
  | { kind: 'thinking'; id: string; text: string; entryUuid?: string }
  | { kind: 'tool'; id: string; tool: string; input?: any; result?: string; isError?: boolean }
  // Slash command marker (e.g. /compact, /usage, /model). Rendered as a
  // compact violet chip — visually distinct from regular user prompts so
  // it reads as "this was a system action, не обычный диалог".
  | { kind: 'slash'; id: string; text: string; entryUuid?: string }
  // Compact summary — orange card with metrics chip (preTokens → postTokens
  // · durationMs). Long body collapses to first 600 chars with toggle.
  | { kind: 'compact-summary'; id: string; text: string; entryUuid?: string;
      metrics?: { preTokens: number; postTokens: number; durationMs: number; trigger?: string } }
  | { kind: 'error'; id: string; text: string };

type State = {
  entries: UiEntry[];
  toolById: Map<string, UiEntry & { kind: 'tool' }>;
  // Per-assistant-message accumulation key — for streaming partials we want to
  // append onto the same entry, not push a new one.
  assistantById: Map<string, UiEntry & { kind: 'assistant' }>;
  // Same for thinking blocks — coalesce streaming chunks
  thinkingById: Map<string, UiEntry & { kind: 'thinking' }>;
  // Pending compact metrics from a `system:compact_boundary` record, waiting
  // to attach to the NEXT compact-summary user-record. JSONL ordering
  // guarantees boundary → summary adjacency (same as desktop logic).
  pendingCompactMetrics: { preTokens: number; postTokens: number; durationMs: number; trigger?: string } | null;
};

// Canonical phrase that SDK prepends to a compact-summary user-record.
// Fallback for old sessions where isCompactSummary flag is absent.
const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

// XML wrappers the SDK injects into user-record text that should NOT show up
// as a user bubble. Either dropped entirely (stdout/caveat/system-reminder)
// or transformed into a slash-chip (command-name).
const SLASH_COMMAND_RE = /<command-name>([^<]+)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([^<]*)/;

export function createMessageReducer() {
  const state: State = { entries: [], toolById: new Map(), assistantById: new Map(), thinkingById: new Map(), pendingCompactMetrics: null };
  let counter = 0;
  const nextId = () => `m-${++counter}-${Date.now()}`;

  function reset() {
    state.entries = [];
    state.toolById.clear();
    state.assistantById.clear();
    state.thinkingById.clear();
    state.pendingCompactMetrics = null;
  }

  // Swap last two entries if they are [compact-summary, slash(/compact)] —
  // JSONL order is summary BEFORE the chip, but visually the chip should sit
  // ABOVE (user typed /compact, then SDK produced summary). Called after each
  // apply that might have pushed the second of the pair. Mirrors the
  // post-load swap in desktop ClaudeSDKTab loadHistory().
  function maybeSwapCompactPair() {
    const len = state.entries.length;
    if (len < 2) return;
    const a = state.entries[len - 2];
    const b = state.entries[len - 1];
    if (a.kind === 'compact-summary' && b.kind === 'slash' && b.text.trim().startsWith('/compact')) {
      state.entries[len - 2] = b;
      state.entries[len - 1] = a;
    }
  }

  // Apply one SDK message; mutates `state.entries` and returns a snapshot.
  function apply(raw: any): UiEntry[] {
    if (!raw || typeof raw !== 'object') return state.entries.slice();
    // Drop synthetic user messages — main.js broadcasts them ahead of the
    // real JSONL record so DESKTOP renderer can show its own bubble on
    // mobile-initiated prompts. Phone doesn't need them: the real JSONL
    // record arrives shortly after via the same WS, and ALSO via the next
    // history fetch on remount. Without this skip both arrive as separate
    // entries → duplicate user-bubble in the chat.
    if (raw.__webSynthetic) return state.entries.slice();
    const t = raw.type;

    // Compact boundary — stash metrics for the next compact-summary record.
    // We render NOTHING here; the SDK emits a system:compact_boundary right
    // before a user-record whose text starts with the canonical phrase.
    if (t === 'system' && raw.subtype === 'compact_boundary') {
      const cm = raw.compactMetadata || raw.compact_metadata;
      if (cm) {
        state.pendingCompactMetrics = {
          preTokens: cm.preTokens ?? cm.pre_tokens ?? 0,
          postTokens: cm.postTokens ?? cm.post_tokens ?? 0,
          durationMs: cm.durationMs ?? cm.duration_ms ?? 0,
          trigger: cm.trigger,
        };
      }
      return state.entries.slice();
    }

    if (t === 'user') {
      const content = raw.message?.content;
      // Classify a piece of user text. Returns the entry to push (or null to
      // drop). Branches mirror desktop ClaudeSDKTab loadHistory user-section:
      //   <command-name>X</command-name>          → slash-chip
      //   <local-command-stdout>…                 → drop (CLI artefact)
      //   <local-command-caveat>…                 → drop (CLI artefact)
      //   <system-reminder>…                       → drop (CLI artefact)
      //   <tool_result>… / [tool_result]          → drop (handled by tool_use match)
      //   isCompactSummary | canonical-phrase     → compact-summary card
      //   else                                     → normal user bubble
      const classifyUserText = (text: string, uuid: string | undefined): UiEntry | null => {
        const trimmed = text.trim();
        if (!trimmed) return null;

        if (trimmed.startsWith('<command-name>')) {
          const cmdMatch = trimmed.match(SLASH_COMMAND_RE);
          const argsMatch = trimmed.match(COMMAND_ARGS_RE);
          const rawName = (cmdMatch?.[1] || '').trim().replace(/^\/+/, '');
          const cmdArgs = (argsMatch?.[1] || '').trim();
          const chipText = '/' + rawName + (cmdArgs ? ' ' + cmdArgs : '');
          return { kind: 'slash', id: uuid || nextId(), text: chipText, entryUuid: uuid };
        }
        if (
          trimmed.startsWith('<local-command-stdout>') ||
          trimmed.startsWith('<local-command-caveat>') ||
          trimmed.startsWith('<system-reminder>') ||
          trimmed === '[tool_result]' ||
          trimmed.startsWith('<tool_result>')
        ) {
          return null;
        }

        // Compact summary — authoritative flag from SDK, fallback to phrase.
        const isSummary = raw.isCompactSummary === true || trimmed.startsWith(COMPACT_SUMMARY_PREFIX);
        if (isSummary) {
          const metrics = state.pendingCompactMetrics || undefined;
          state.pendingCompactMetrics = null;
          return { kind: 'compact-summary', id: uuid || nextId(), text: trimmed, entryUuid: uuid, metrics };
        }

        // wasQueued прокинут через WS-payload из main (`__wasQueued`) — это
        // ТОЛЬКО для synthetic-broadcast'ов от desktop'а (когда desktop отправил
        // prompt из type-ahead очереди). Real Anthropic records этот флаг не
        // несут (JSONL не хранит наши UI-метаданные), поэтому после reload
        // флаг теряется естественно.
        const wasQueued = raw.__wasQueued === true;
        return { kind: 'user', id: nextId(), text, entryUuid: uuid, ...(wasQueued ? { wasQueued: true } : {}) };
      };

      // Dedupe + adopt-or-push for normal user bubbles. For slash/compact
      // entries we don't dedupe — they have stable uuids from JSONL.
      const adoptOrPushUserEntry = (entry: UiEntry | null) => {
        if (!entry) return;
        if (entry.kind === 'user') {
          const last = state.entries[state.entries.length - 1] as any;
          if (last && last.kind === 'user' && last.text === entry.text && !last.entryUuid && entry.entryUuid) {
            last.entryUuid = entry.entryUuid;
            // Inherit wasQueued from the incoming (broadcast) entry. The local
            // optimistic bubble didn't have it; the synthetic broadcast does.
            if (entry.wasQueued) last.wasQueued = true;
            return;
          }
        } else if (entry.kind === 'slash' || entry.kind === 'compact-summary') {
          // Avoid duplicate slash/summary entries when WS replays JSONL after
          // an optimistic local apply — match by entryUuid.
          if (entry.entryUuid) {
            const dup = state.entries.find((e: any) => e.entryUuid === entry.entryUuid);
            if (dup) return;
          }
        }
        state.entries.push(entry);
        if (entry.kind === 'compact-summary') maybeSwapCompactPair();
        if (entry.kind === 'slash') maybeSwapCompactPair();
      };

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
            adoptOrPushUserEntry(classifyUserText(block.text, raw.uuid));
            pushedUserText = true;
          }
        }
      } else if (typeof content === 'string') {
        adoptOrPushUserEntry(classifyUserText(content, raw.uuid));
      }
      return state.entries.slice();
    }

    if (t === 'assistant') {
      const msgId: string = raw.message?.id || raw.uuid || nextId();
      const content = raw.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'thinking' && typeof block.thinking === 'string') {
            // Adaptive thinking on Opus often sends thinking-blocks with empty
            // `.thinking` (just a signature). Empty body == "didn't actually
            // think" — desktop ReasoningPart filters these out by falsy-ing on
            // m.thinking; we do the same here. Without this filter the user
            // sees an empty grey "thinking…" card in the mobile chat for every
            // assistant turn, which is just noise.
            const thinkingText = block.thinking;
            if (!thinkingText || !thinkingText.trim()) {
              continue; // skip empty thinking — no entry created
            }
            // Thinking is its OWN entry — sits before the matching assistant
            // text in the flow so the user sees process → answer in order.
            let tEntry = state.thinkingById.get(msgId);
            if (!tEntry) {
              tEntry = { kind: 'thinking', id: 'thinking-' + msgId, text: '' };
              state.thinkingById.set(msgId, tEntry);
              state.entries.push(tEntry);
            }
            tEntry.text = thinkingText;
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
    state.pendingCompactMetrics = null;
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
