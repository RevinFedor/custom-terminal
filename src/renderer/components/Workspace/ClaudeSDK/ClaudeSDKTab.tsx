import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import {
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { AssistantProviderBase } from '@assistant-ui/core/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Loader2, FileEdit, Terminal as TerminalIcon, FolderSearch, Search, FileText, Globe } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

// ============================================================
// Internal message type — accumulated from IPC stream
// ============================================================
interface SDKChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, any>; result?: any; status: 'running' | 'done' | 'error' }>;
  thinking: string | null;
  timestamp: number;
}

// ============================================================
// Convert our internal messages to assistant-ui ThreadMessageLike
// ============================================================
function convertMessage(msg: SDKChatMessage): ThreadMessageLike {
  if (msg.role === 'system') {
    return { role: 'system' as const, content: [{ type: 'text' as const, text: msg.text }], id: msg.id, createdAt: new Date(msg.timestamp) };
  }

  if (msg.role === 'user') {
    return { role: 'user' as const, content: [{ type: 'text' as const, text: msg.text }], id: msg.id, createdAt: new Date(msg.timestamp) };
  }

  // Assistant message — supports status, reasoning, tool calls
  const parts: ThreadMessageLike['content'] = [];

  if (msg.thinking) {
    parts.push({ type: 'reasoning' as const, text: msg.thinking });
  }

  if (msg.text) {
    parts.push({ type: 'text' as const, text: msg.text });
  }

  for (const tc of msg.toolCalls) {
    parts.push({
      type: 'tool-call' as const,
      toolName: tc.name,
      toolCallId: tc.id,
      args: tc.args,
      result: tc.result,
    });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text' as const, text: '' });
  }

  return {
    role: 'assistant' as const,
    content: parts,
    id: msg.id,
    createdAt: new Date(msg.timestamp),
    status: msg.toolCalls.some(t => t.status === 'running')
      ? { type: 'running' as const }
      : { type: 'complete' as const, reason: 'stop' as const },
  };
}

// ============================================================
// Tool icon mapping
// ============================================================
const TOOL_ICON: Record<string, React.ReactNode> = {
  Edit: <FileEdit size={12} />, Write: <FileEdit size={12} />, Read: <FileText size={12} />,
  Bash: <TerminalIcon size={12} />, Glob: <FolderSearch size={12} />, Grep: <Search size={12} />,
  WebSearch: <Globe size={12} />, WebFetch: <Globe size={12} />,
};

// ============================================================
// Props
// ============================================================
interface ClaudeSDKTabProps {
  tabId: string;
  active: boolean;
  isActiveProject: boolean;
  cwd: string;
}

// ============================================================
// Main component
// ============================================================
function ClaudeSDKTab({ tabId, active, isActiveProject, cwd }: ClaudeSDKTabProps) {
  const [messages, setMessages] = useState<SDKChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const updateSDKState = useWorkspaceStore((s) => s.updateSDKState);

  // DEBUG: mount/render tracking
  useEffect(() => {
    console.warn('[ClaudeSDKTab:MOUNT] tabId=' + tabId + ' active=' + active + ' cwd=' + cwd);
    return () => console.warn('[ClaudeSDKTab:UNMOUNT] tabId=' + tabId);
  }, []);
  console.warn('[ClaudeSDKTab:RENDER] tabId=' + tabId + ' msgs=' + messages.length + ' sessionId=' + sessionIdRef.current + ' visible=' + (active && isActiveProject));

  // Load history from JSONL via SDK getSessionMessages
  const loadHistory = useCallback(async (sid: string) => {
    const state = useWorkspaceStore.getState();
    let tabCwd = cwd;
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) { tabCwd = t.cwd || cwd; break; }
    }
    const result = await ipcRenderer.invoke('claude-sdk:load-history', { sessionId: sid, cwd: tabCwd });
    console.warn('[ClaudeSDKTab:loadHistory] sid=' + sid.slice(0, 8) + ' success=' + result.success + ' rawCount=' + (result.messages?.length || 0));
    if (!result.success || !result.messages?.length) return;
    const loaded: SDKChatMessage[] = result.messages.map((m: any, i: number) => {
      const textParts = Array.isArray(m.message?.content)
        ? m.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof m.message?.content === 'string' ? m.message.content : '';
      const toolParts = Array.isArray(m.message?.content)
        ? m.message.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({
            id: b.id || 'tool-' + i, name: b.name || 'unknown',
            args: typeof b.input === 'object' ? b.input : {}, status: 'done' as const,
          }))
        : [];
      const thinkingParts = Array.isArray(m.message?.content)
        ? m.message.content.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('\n')
        : '';

      // Classify system commands as 'system' role
      let role = m.type as 'user' | 'assistant' | 'system';
      let text = textParts;
      if (role === 'user') {
        const trimmed = text.trim();
        // Slash commands: /effort, /model, etc.
        if (trimmed.startsWith('<command-name>')) {
          const cmdMatch = trimmed.match(/<command-name>([^<]+)<\/command-name>/);
          const argsMatch = trimmed.match(/<command-args>([^<]*)/);
          role = 'system';
          text = (cmdMatch?.[1] || '') + ' ' + (argsMatch?.[1] || '').trim();
        }
        // Command stdout responses
        else if (trimmed.startsWith('<local-command-stdout>')) {
          role = 'system';
          text = trimmed.replace(/<\/?local-command-stdout>/g, '').trim();
        }
        // Tool results (internal)
        else if (trimmed === '[tool_result]' || trimmed.startsWith('<tool_result>')) {
          return null; // Filter out
        }
        // System reminders
        else if (trimmed.startsWith('<system-reminder>')) {
          return null; // Filter out
        }
      }

      return {
        id: m.uuid || ('hist-' + i),
        role,
        text,
        toolCalls: toolParts,
        thinking: thinkingParts || null,
        timestamp: Date.now() - (result.messages.length - i) * 1000,
      };
    }).filter((m: SDKChatMessage | null): m is SDKChatMessage => {
      if (!m) return false;
      if (m.role === 'user' && !m.text.trim()) return false;
      return true;
    });

    // Merge consecutive assistant messages into single turns
    // Claude JSONL stores one "turn" as multiple records (thinking, text, tool_use)
    const merged: SDKChatMessage[] = [];
    for (const m of loaded) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === 'assistant' && m.role === 'assistant') {
        // Merge into previous
        if (m.text.trim()) prev.text = prev.text ? prev.text + '\n' + m.text : m.text;
        if (m.thinking) prev.thinking = prev.thinking ? prev.thinking + '\n' + m.thinking : m.thinking;
        prev.toolCalls = [...prev.toolCalls, ...m.toolCalls];
      } else {
        merged.push({ ...m });
      }
    }

    // Final filter: remove empty assistant messages after merge
    const final = merged.filter(m => {
      if (m.role === 'assistant' && !m.text.trim() && m.toolCalls.length === 0 && !m.thinking) return false;
      return true;
    });

    // Diagnostic: count tool calls across all messages
    const totalTools = final.reduce((sum, m) => sum + m.toolCalls.length, 0);
    const toolNames = final.flatMap(m => m.toolCalls.map(t => t.name));
    const uniqueTools = [...new Set(toolNames)];
    console.warn('[ClaudeSDKTab:loadHistory] loaded=' + loaded.length + ' merged=' + merged.length + ' final=' + final.length + ' totalTools=' + totalTools + ' uniqueTools=' + uniqueTools.join(','));

    setMessages(final);
  }, [tabId, cwd]);

  // Watch store for claudeSessionId changes — handles both mount and late assignment (SDK-Fork)
  const storeSessionId = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.claudeSessionId || null;
    }
    return null;
  });

  useEffect(() => {
    if (!storeSessionId || sessionIdRef.current === storeSessionId) return;
    console.warn('[ClaudeSDKTab:SessionSync] tabId=' + tabId + ' new sessionId=' + storeSessionId);
    sessionIdRef.current = storeSessionId;
    setSessionId(storeSessionId);
    loadHistory(storeSessionId);
  }, [tabId, storeSessionId, loadHistory]);

  // Reload handler — triggered from InfoPanel ⟳ button
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail;
      if (tid !== tabId) return;
      const sid = sessionIdRef.current;
      if (sid) {
        setMessages([]);
        setIsRunning(false);
        loadHistory(sid);
      }
    };
    window.addEventListener('claude-sdk:reload', handler);
    return () => window.removeEventListener('claude-sdk:reload', handler);
  }, [tabId, loadHistory]);

  // Emit busy state for TabBar spinner + cleanup on unmount
  useEffect(() => {
    ipcRenderer.send('claude-sdk:busy-state', { tabId, busy: isRunning });
    return () => { ipcRenderer.send('claude-sdk:busy-state', { tabId, busy: false }); };
  }, [isRunning, tabId]);

  // ---- Timeline click → scroll to matching message ----
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid, content } = (e as CustomEvent).detail;
      if (tid !== tabId || !viewportRef.current) return;
      // Find the message element that contains this content
      const contentSnippet = (content || '').slice(0, 40);
      const els = viewportRef.current.querySelectorAll('[data-msg-role]');
      for (const el of els) {
        if (el.textContent?.includes(contentSnippet)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Brief highlight
          (el as HTMLElement).style.outline = '1px solid rgba(218,119,86,0.4)';
          setTimeout(() => { (el as HTMLElement).style.outline = ''; }, 1500);
          return;
        }
      }
    };
    window.addEventListener('claude-sdk:scroll-to-entry', handler);
    return () => window.removeEventListener('claude-sdk:scroll-to-entry', handler);
  }, [tabId]);

  // ---- IPC listener: accumulate SDK messages ----
  useEffect(() => {
    const handleMessage = (_: any, data: { tabId: string; message: any; sessionId: string }) => {
      if (data.tabId !== tabId) return;

      if (data.sessionId && !sessionIdRef.current) {
        sessionIdRef.current = data.sessionId;
        setSessionId(data.sessionId);
        updateSDKState(tabId, { claudeSessionId: data.sessionId });
      }

      const msg = data.message;

      // Assistant message with content blocks
      if (msg.type === 'assistant' && msg.message?.content) {
        const textBlocks = msg.message.content.filter((b: any) => b.type === 'text');
        const toolBlocks = msg.message.content.filter((b: any) => b.type === 'tool_use');
        const thinkingBlocks = msg.message.content.filter((b: any) => b.type === 'thinking');

        setMessages(prev => {
          const last = prev[prev.length - 1];
          const text = textBlocks.map((b: any) => b.text).join('\n');
          const thinking = thinkingBlocks.map((b: any) => b.thinking).join('\n') || null;

          // Accumulate tool calls
          const newTools = toolBlocks.map((t: any) => ({
            id: t.id, name: t.name,
            args: typeof t.input === 'object' ? t.input : {},
            status: 'running' as const,
          }));

          if (last?.role === 'assistant' && last.id === 'streaming-' + tabId) {
            return [...prev.slice(0, -1), {
              ...last,
              text: text || last.text,
              thinking: thinking || last.thinking,
              toolCalls: [...last.toolCalls, ...newTools],
            }];
          }

          return [...prev, {
            id: 'streaming-' + tabId,
            role: 'assistant' as const,
            text,
            thinking,
            toolCalls: newTools,
            timestamp: Date.now(),
          }];
        });
      }

      // Result — finalize
      if (msg.type === 'result') {
        setIsRunning(false);
        updateSDKState(tabId, { sdkState: msg.is_error ? 'error' : 'idle' });
        setMessages(prev => prev.map(m => {
          if (m.id === 'streaming-' + tabId) {
            return { ...m, id: 'msg-' + Date.now(), toolCalls: m.toolCalls.map(t => ({ ...t, status: 'done' as const })) };
          }
          return m;
        }));
      }

      // System init
      if (msg.type === 'system' && msg.subtype === 'init') {
        setMessages(prev => [...prev, {
          id: 'init-' + Date.now(), role: 'system' as const,
          text: `Claude Code v${msg.claude_code_version}`,
          toolCalls: [], thinking: null, timestamp: Date.now(),
        }]);
      }
    };

    const handleDone = (_: any, data: { tabId: string }) => {
      if (data.tabId !== tabId) return;
      setIsRunning(false);
      updateSDKState(tabId, { sdkState: 'idle' });
    };

    ipcRenderer.on('claude-sdk:message', handleMessage);
    ipcRenderer.on('claude-sdk:done', handleDone);
    return () => {
      ipcRenderer.removeListener('claude-sdk:message', handleMessage);
      ipcRenderer.removeListener('claude-sdk:done', handleDone);
    };
  }, [tabId, updateSDKState]);

  // ---- Send handler for external store ----
  const onNew = useCallback(async (message: AppendMessage) => {
    // Block sending while running — SDK doesn't queue, it would interrupt
    // Use getState() to avoid stale closure (isRunning not in deps)
    const currentlyRunning = (() => {
      const s = useWorkspaceStore.getState();
      for (const [, ws] of s.openProjects) {
        const t = ws.tabs.get(tabId);
        if (t) return t.sdkState === 'thinking' || t.sdkState === 'tool_use';
      }
      return false;
    })();
    if (currentlyRunning) return;

    const textPart = message.content.find((p: any) => p.type === 'text');
    const inputText = (textPart?.type === 'text' ? textPart.text : '').trim();

    // Gather paste chips
    const pasteChips: Array<{ text: string }> = (window as any).__sdkPasteChips || [];
    const chipTexts = pasteChips.map(c => c.text);

    // Build full prompt: chips + text
    const parts: string[] = [];
    for (const ct of chipTexts) {
      parts.push('<pasted_content>\n' + ct + '\n</pasted_content>');
    }
    if (inputText) parts.push(inputText);
    else if (parts.length > 0) parts.push('Analyze this content');

    const text = parts.join('\n\n');
    if (!text.trim()) return;

    // Clear chips
    window.dispatchEvent(new Event('claude-sdk:chips-clear'));
    setIsRunning(true);
    updateSDKState(tabId, { sdkState: 'thinking' });

    // Add user message
    setMessages(prev => [...prev, {
      id: 'user-' + Date.now(), role: 'user' as const,
      text, toolCalls: [], thinking: null, timestamp: Date.now(),
    }]);

    // Read SDK settings
    const state = useWorkspaceStore.getState();
    let sdkModel: string | undefined;
    let sdkEffort: string | undefined;
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) {
        const modelMap: Record<string, string | undefined> = { default: undefined, sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6', haiku: 'claude-haiku-4-5-20251001' };
        sdkModel = modelMap[t.sdkModel || 'default'];
        sdkEffort = t.sdkEffort || 'high';
        break;
      }
    }

    const ipcChannel = sessionIdRef.current ? 'claude-sdk:send-message' : 'claude-sdk:create-session';
    const result = await ipcRenderer.invoke(ipcChannel, { tabId, cwd, prompt: text, model: sdkModel, effort: sdkEffort });

    if (!result.success) {
      setIsRunning(false);
      updateSDKState(tabId, { sdkState: 'error' });
      setMessages(prev => [...prev, {
        id: 'error-' + Date.now(), role: 'system' as const,
        text: 'Error: ' + result.error, toolCalls: [], thinking: null, timestamp: Date.now(),
      }]);
    }
  }, [tabId, cwd, updateSDKState]);

  const onCancel = useCallback(async () => {
    ipcRenderer.invoke('claude-sdk:stop', { tabId });
    setIsRunning(false);
    updateSDKState(tabId, { sdkState: 'idle' });
  }, [tabId, updateSDKState]);

  const isVisible = active && isActiveProject;

  // Escape to cancel running query
  useEffect(() => {
    if (!isRunning || !isVisible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRunning, isVisible, onCancel]);

  // ---- External store runtime ----
  // Filter out empty assistant messages (no text, no tools, no thinking)
  const filteredMessages = useMemo(() =>
    messages.filter(m => {
      if (m.role === 'assistant' && !m.text.trim() && m.toolCalls.length === 0 && !m.thinking) return false;
      return true;
    }),
  [messages]);

  const runtime = useExternalStoreRuntime({
    messages: filteredMessages,
    convertMessage,
    isRunning,
    onNew,
    onCancel,
  });

  // Scroll-to-bottom state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowScrollDown(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  // Auto-scroll on new messages when already at bottom
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="absolute inset-0 flex flex-col" style={{ display: isVisible ? 'flex' : 'none' }}>
      <AssistantProviderBase runtime={runtime}>
        <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
          <ThreadPrimitive.Viewport
            ref={scrollContainerRef as any}
            onScroll={handleScroll}
            className="flex flex-1 flex-col overflow-y-auto"
          >
            {/* Empty state */}
            <ThreadPrimitive.Empty>
              <div className="flex flex-1 items-center justify-center h-full">
                <div className="text-center text-[#555] select-none">
                  <div className="mb-3 opacity-40" style={{ color: '#DA7756' }}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto' }}>
                      <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                    </svg>
                  </div>
                  <p className="text-[13px]">Claude SDK</p>
                  <p className="text-[11px] text-[#444] mt-1">Type a message to start</p>
                </div>
              </div>
            </ThreadPrimitive.Empty>

            {/* Messages */}
            <div ref={viewportRef} className="flex-1 px-4 py-3">
              <ThreadPrimitive.Messages
                components={{ UserMessage: UserMsg, AssistantMessage: AssistantMsg, SystemMessage: SystemMsg }}
              />
            </div>

            {/* Composer — inside Viewport (required by ComposerPrimitive.Input) */}
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 border-t border-[#2a2a2a] bg-[#0e0e0e]">
              <SDKComposer isRunning={isRunning} sessionId={sessionId} />
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>

          {/* Scroll-to-bottom button */}
          {showScrollDown && (
            <button
              onClick={scrollToBottom}
              className="absolute z-10 flex items-center justify-center w-8 h-8 rounded-full bg-[#2a2a2a] border border-[#444] text-[#888] hover:text-white hover:bg-[#3a3a3a] transition-all cursor-pointer shadow-lg"
              style={{ bottom: '70px', right: '52px' }}
              title="Scroll to bottom"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          )}
        </ThreadPrimitive.Root>
      </AssistantProviderBase>
    </div>
  );
}

// ============================================================
// User message
// ============================================================
const UserMsg = () => (
  <MessagePrimitive.Root className="flex justify-end py-1.5 px-1" data-msg-role="user">
    <div className="max-w-[80%] bg-[#DA7756]/12 border border-[#DA7756]/20 rounded-xl rounded-br-sm px-3 py-2">
      <MessagePrimitive.Content
        components={{ Text: UserTextPart }}
      />
    </div>
  </MessagePrimitive.Root>
);

// User text part — parses <pasted_content> blocks into chips
const UserTextPart = ({ text }: { text: string }) => {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (!text.includes('<pasted_content>')) {
    return <p className="text-[13px] text-[#e0e0e0] whitespace-pre-wrap">{text}</p>;
  }

  // Split into regular text and pasted blocks
  const parts: Array<{ type: 'text' | 'paste'; content: string }> = [];
  let remaining = text;
  while (remaining.includes('<pasted_content>')) {
    const start = remaining.indexOf('<pasted_content>');
    const end = remaining.indexOf('</pasted_content>');
    if (end === -1) break;
    if (start > 0) parts.push({ type: 'text', content: remaining.slice(0, start).trim() });
    parts.push({ type: 'paste', content: remaining.slice(start + 16, end).trim() });
    remaining = remaining.slice(end + 17).trim();
  }
  if (remaining) parts.push({ type: 'text', content: remaining });

  return (
    <div className="space-y-1.5">
      {parts.map((p, i) => {
        if (p.type === 'text' && p.content) {
          return <p key={i} className="text-[13px] text-[#e0e0e0] whitespace-pre-wrap">{p.content}</p>;
        }
        if (p.type === 'paste') {
          const preview = p.content.slice(0, 60).replace(/\n/g, ' ') + (p.content.length > 60 ? '...' : '');
          const isExpanded = expandedId === i;
          return (
            <div key={i}>
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-[#6B8AFF]/15 text-[#8ba4ff] border border-[#6B8AFF]/20 cursor-pointer hover:bg-[#6B8AFF]/25 max-w-[250px]"
                onClick={() => setExpandedId(isExpanded ? null : i)}
              >
                <span className="truncate">{preview}</span>
                <span className="text-[9px] text-[#666] shrink-0">{p.content.length.toLocaleString()}</span>
              </span>
              {isExpanded && (
                <pre className="mt-1 px-3 py-2 text-[11px] text-[#aaa] bg-[#1a1a1a] border border-[#333] rounded-lg max-h-[200px] overflow-y-auto whitespace-pre-wrap">{p.content}</pre>
              )}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
};

// ============================================================
// System message
// ============================================================
const SystemMsg = () => (
  <MessagePrimitive.Root className="py-1">
    <div className="text-center text-[11px] text-[#555]">
      <MessagePrimitive.Content
        components={{ Text: ({ text }) => <span>{text}</span> }}
      />
    </div>
  </MessagePrimitive.Root>
);

// ============================================================
// Assistant message — markdown + tool calls + thinking
// ============================================================
const AssistantMsg = () => (
  <MessagePrimitive.Root className="py-2 px-1 relative group" data-msg-role="assistant">
    <MessagePrimitive.Content
      components={{
        Text: AssistantTextPart,
        Reasoning: ReasoningPart,
        tools: { Fallback: ToolCallPart },
      }}
    />
    {/* Action bar — absolute, non-blocking */}
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <CopyButton />
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>
);

// ---- Text part: markdown rendering (skip empty) ----
const AssistantTextPart = ({ text }: { text: string }) => {
  if (!text.trim()) return null;
  return (
    <div className="prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed" style={{ color: '#d4d4d4' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark as any} language={match[1]} PreTag="div"
                  customStyle={{ margin: '8px 0', borderRadius: '8px', fontSize: '12px', padding: '12px', backgroundColor: '#1a1a1a' }}
                >
                  {codeString}
                </SyntaxHighlighter>
              );
            }
            return <code className="bg-[#1a1a1a] px-1.5 py-0.5 rounded text-[12px] text-[#e0e0e0]" {...props}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};

// ---- Reasoning/thinking part ----
const ReasoningPart = ({ text }: { text: string }) => (
  <details className="my-2 rounded-lg border border-[#333] overflow-hidden">
    <summary className="cursor-pointer text-[11px] text-[#888] px-3 py-1.5 bg-[#1a1a1a] hover:bg-[#222] select-none">
      Thinking...
    </summary>
    <pre className="px-3 py-2 text-[11px] text-[#666] whitespace-pre-wrap bg-[#111] max-h-[200px] overflow-y-auto">{text}</pre>
  </details>
);

// ---- Tool call part ----
const ToolCallPart = ({ toolName, args, result }: { toolName: string; args: Record<string, any>; argsText: string; toolCallId: string; result?: any }) => {
  const icon = TOOL_ICON[toolName] || <TerminalIcon size={12} />;
  const hasResult = result !== undefined && result !== null;
  const label = getToolLabel(toolName, args);

  return (
    <div className="my-1.5 flex items-center gap-1.5 text-[11px]">
      <span className="flex items-center gap-1 px-2 py-0.5 rounded-md" style={{ backgroundColor: 'rgba(255,255,255,0.04)', color: hasResult ? '#666' : '#DA7756' }}>
        {icon}
        <span className="font-medium">{toolName}</span>
        {!hasResult && <Loader2 size={10} className="animate-spin" />}
      </span>
      {label && <span className="text-[#555] truncate max-w-[300px]">{label}</span>}
    </div>
  );
};

function getToolLabel(name: string, args: Record<string, any>): string {
  if (name === 'Read' || name === 'Write' || name === 'Edit') return args.file_path || args.path || '';
  if (name === 'Bash') return (args.command || '').slice(0, 60);
  if (name === 'Glob') return args.pattern || '';
  if (name === 'Grep') return args.pattern || '';
  return '';
}

// ============================================================
// Copy button with checkmark feedback
// ============================================================
function CopyButton() {
  const [copied, setCopied] = useState(false);
  return (
    <ActionBarPrimitive.Copy
      className="text-[10px] px-1.5 py-0.5 rounded bg-[#1a1a1a] hover:bg-[#2a2a2a] cursor-pointer border border-[#333] transition-colors"
      style={{ color: copied ? '#4ade80' : '#555' }}
      onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }}
    >
      {copied ? '✓' : 'Copy'}
    </ActionBarPrimitive.Copy>
  );
}

// ============================================================
// Paste chip type
// ============================================================
interface PasteChip {
  id: string;
  text: string;
  preview: string; // first 60 chars
}

const PASTE_THRESHOLD = 500; // chars — above this, create a chip instead of inline paste

// ============================================================
// Composer with paste chips
// ============================================================
function SDKComposer({ isRunning, sessionId }: { isRunning: boolean; sessionId: string | null }) {
  const [chips, setChips] = useState<PasteChip[]>([]);
  const [previewChip, setPreviewChip] = useState<PasteChip | null>(null);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (text.length >= PASTE_THRESHOLD) {
      e.preventDefault();
      setChips(prev => [...prev, {
        id: 'chip-' + Date.now(),
        text,
        preview: text.slice(0, 60).replace(/\n/g, ' ') + '...',
      }]);
    }
    // Short pastes go through normally to ComposerPrimitive.Input
  }, []);

  const removeChip = useCallback((id: string) => {
    setChips(prev => prev.filter(c => c.id !== id));
    if (previewChip?.id === id) setPreviewChip(null);
  }, [previewChip]);

  // Expose chips to parent via custom event so onNew can read them
  useEffect(() => {
    (window as any).__sdkPasteChips = chips;
    return () => { delete (window as any).__sdkPasteChips; };
  }, [chips]);

  // Clear chips after send
  useEffect(() => {
    const handler = () => setChips([]);
    window.addEventListener('claude-sdk:chips-clear', handler);
    return () => window.removeEventListener('claude-sdk:chips-clear', handler);
  }, []);

  return (
    <div className="relative">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-4 py-1 text-[10px] text-[#555]">
        {isRunning && <span className="flex items-center gap-1 text-[#DA7756]"><Loader2 size={10} className="animate-spin" />Thinking...</span>}
        {sessionId && <span className="truncate max-w-[200px]">Session: {sessionId.slice(0, 8)}...</span>}
      </div>

      {/* Paste chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-1.5">
          {chips.map(chip => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-[#6B8AFF]/15 text-[#8ba4ff] border border-[#6B8AFF]/20 cursor-pointer hover:bg-[#6B8AFF]/25 max-w-[200px]"
              onClick={() => setPreviewChip(previewChip?.id === chip.id ? null : chip)}
              title="Click to preview"
            >
              <span className="truncate">{chip.preview}</span>
              <span
                className="text-[#666] hover:text-white ml-0.5 shrink-0"
                onClick={(e) => { e.stopPropagation(); removeChip(chip.id); }}
              >×</span>
            </span>
          ))}
        </div>
      )}

      {/* Chip preview overlay */}
      {previewChip && (
        <div className="mx-4 mb-2 bg-[#1a1a1a] border border-[#333] rounded-lg max-h-[200px] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#333]">
            <span className="text-[10px] text-[#888]">Pasted content ({previewChip.text.length.toLocaleString()} chars)</span>
            <button className="text-[#666] hover:text-white text-[12px] cursor-pointer" onClick={() => setPreviewChip(null)}>×</button>
          </div>
          <pre className="px-3 py-2 text-[11px] text-[#aaa] whitespace-pre-wrap">{previewChip.text}</pre>
        </div>
      )}

      <ComposerPrimitive.Root className="flex items-end gap-2 px-4 pb-3">
        <ComposerPrimitive.Input
          autoFocus
          placeholder={chips.length > 0 ? 'Add a message or press Enter to send...' : 'Message Claude...'}
          className="flex-1 bg-[#1a1a1a] text-[#e0e0e0] text-[13px] rounded-lg px-3 py-2 resize-none outline-none border border-[#333] focus:border-[#555] placeholder-[#555] min-h-[36px] max-h-[120px]"
          rows={1}
          onPaste={handlePaste}
        />

        {isRunning ? (
          <ComposerPrimitive.Cancel
            data-sdk-cancel
            className="flex items-center justify-center w-[36px] h-[36px] rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="flex items-center justify-center w-[36px] h-[36px] rounded-lg bg-[#DA7756]/20 hover:bg-[#DA7756]/30 text-[#DA7756] transition-colors disabled:opacity-30 disabled:cursor-default cursor-pointer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
          </ComposerPrimitive.Send>
        )}
      </ComposerPrimitive.Root>
    </div>
  );
}

export default memo(ClaudeSDKTab);
