import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useUIStore } from '../../../store/useUIStore';
import { usePromptsStore, type AIPrompt } from '../../../store/usePromptsStore';
import MarkdownRenderer from '../../Research/MarkdownRenderer';
import { useResearchStore, ChatType } from '../../../store/useResearchStore';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { ChevronDown, ClipboardPaste, Search, FileText } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

interface HistoryItem {
  id: number;
  selected_text: string;
  prompt: string;
  response: string;
  timestamp: number;
}

interface GeminiPanelProps {
  projectPath: string;
  geminiPrompt?: string;
}

export default function GeminiPanel({ projectPath, geminiPrompt }: GeminiPanelProps) {
  const { showToast, terminalSelection } = useUIStore();
  const { getPromptById, prompts: aiPrompts } = usePromptsStore();
  const { createConversation, addMessage, openResearch, getProjectConversations, setActiveConversation, deleteConversation, isLoading, setLoading, setAbortController, pendingResearch, pendingChatType, clearPendingResearch, loadFromDB, activeConversationId } = useResearchStore();
  const { activeProjectId } = useWorkspaceStore();
  const conversations = activeProjectId ? getProjectConversations(activeProjectId) : [];
  const currentActiveConvId = activeProjectId ? activeConversationId[activeProjectId] : null;
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [expandedItem, setExpandedItem] = useState<HistoryItem | null>(null);
  const [apiCalls, setApiCalls] = useState<any[]>([]);
  const [expandedApiCallId, setExpandedApiCallId] = useState<number | null>(null);
  const [pendingAdopts, setPendingAdopts] = useState<string[]>([]); // taskIds in progress

  // Ref to store handleResearch for event listener (with chatType parameter)
  const handleResearchRef = useRef<(chatType: ChatType) => void>(() => {});

  useEffect(() => {
    loadHistory();
    loadApiCalls();
    // Load full conversations from DB for this project
    if (activeProjectId && projectPath) {
      loadFromDB(activeProjectId, projectPath);
    }
  }, [projectPath, activeProjectId]);

  // Track adopt lifecycle: summarizing → ready
  useEffect(() => {
    const handler = (_: any, data: { taskId: string; status: string }) => {
      if (data.status === 'summarizing') {
        setPendingAdopts(prev => [...prev, data.taskId]);
      } else if (data.status === 'ready') {
        setPendingAdopts(prev => prev.filter(id => id !== data.taskId));
        setTimeout(loadApiCalls, 500);
      }
    };
    ipcRenderer.on('mcp:agent-adopted', handler);
    const interval = setInterval(loadApiCalls, 30000);
    return () => {
      ipcRenderer.removeListener('mcp:agent-adopted', handler);
      clearInterval(interval);
    };
  }, []);

  // Check for pending research from store (survives panel mount/unmount)
  useEffect(() => {
    if (pendingResearch) {
      console.log('[GeminiPanel] Found pending research, type:', pendingChatType);
      clearPendingResearch();
      handleResearchRef.current(pendingChatType);
    }
  }, [pendingResearch, pendingChatType, clearPendingResearch]);

  const loadHistory = async () => {
    try {
      const result = await ipcRenderer.invoke('gemini:get-history', { dirPath: projectPath, limit: 50 });
      if (result.success && result.data) {
        setHistory(result.data);
      }
    } catch (err) {
      console.error('[Gemini] Error loading history:', err);
    }
  };

  const loadApiCalls = async () => {
    try {
      const result = await ipcRenderer.invoke('api-calls:list', { limit: 30 });
      if (result.success && result.data) {
        setApiCalls(result.data);
      }
    } catch (err) {
      console.error('[GeminiPanel] Error loading API calls:', err);
    }
  };

  const getTimeAgo = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const handleResearch = async (chatType: ChatType = 'research') => {
    console.log('[Research] Starting, type:', chatType);
    console.log('[Research] Selection:', terminalSelection ? `"${terminalSelection.slice(0, 50)}..."` : 'EMPTY');

    if (!terminalSelection) {
      console.log('[Research] ERROR: No selection');
      showToast('Select text in terminal first!', 'error');
      return;
    }

    const selectedText = terminalSelection;

    // Get settings from dynamic AI prompt
    const promptConfig = getPromptById(chatType);
    const selectedModel = promptConfig?.model || 'gemini-3-flash-preview';
    const thinkingLevel = promptConfig?.thinkingLevel || 'HIGH';
    const systemPrompt = promptConfig?.content || '';

    // Use project prompt for research if available, otherwise use type's system prompt
    const prompt = (chatType === 'research' && geminiPrompt) ? geminiPrompt : systemPrompt;
    console.log('[Research] Type:', chatType, 'Model:', selectedModel, 'Thinking:', thinkingLevel);
    console.log('[Research] Prompt:', `"${prompt.slice(0, 50)}..."`);

    // Wrap in pasted block (same as handleClipboardResearch)
    const displayText = `:::pasted\n${selectedText}\n:::`;

    // IMMEDIATELY create conversation and open panel
    // Put prompt first as requested
    const userMessage = `_Prompt: ${prompt}_\n\n---\n\n${displayText}`;
    if (activeProjectId) {
      createConversation(activeProjectId, projectPath, userMessage, chatType);
      openResearch();
      console.log('[Research] Panel opened, loading...');
    }

    setLoading(true);

    // Get API key from environment
    const apiKey = process.env.GEMINI_API_KEY || 'REDACTED_GEMINI_KEY';
    console.log('[Research] API Key:', apiKey ? `${apiKey.slice(0, 10)}...` : 'MISSING');

    const fullPrompt = prompt + selectedText;
    console.log('[Research] Full prompt length:', fullPrompt.length);
    console.log('[Research] Sending request to Gemini API...');

    // Create AbortController for cancellation
    const controller = new AbortController();
    setAbortController(controller);

    try {
      // Build request body
      const requestBody: any = {
        contents: [{ parts: [{ text: fullPrompt }] }],
        // Tools (search) only supported on gemini-3/2.5 models
        ...(selectedModel.includes('gemini-3') || selectedModel.includes('gemini-2.5') ? {
          tools: [
            { googleSearch: {} }
          ]
        } : {})
      };

      // Add thinking config for gemini-3 models
      if (selectedModel.includes('gemini-3') && thinkingLevel !== 'NONE') {
        requestBody.generationConfig = {
          thinkingConfig: {
            thinkingLevel: thinkingLevel
          }
        };
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        }
      );

      console.log('[Research] Response status:', response.status);
      const data = await response.json();
      console.log('[Research] Response data:', data.error ? 'ERROR' : 'OK');

      if (data.error) {
        console.error('[Research] API Error:', data.error);
        throw new Error(data.error.message || 'Unknown API Error');
      }

      if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
        console.error('[Research] Empty response:', JSON.stringify(data).slice(0, 200));
        throw new Error('API returned empty or blocked response');
      }

      const responseText = data.candidates[0].content.parts[0].text;
      console.log('[Research] Response length:', responseText.length);
      console.log('[Research] Response preview:', `"${responseText.slice(0, 100)}..."`);

      // Save to database
      await ipcRenderer.invoke('gemini:save-history', {
        dirPath: projectPath,
        selectedText,
        prompt,
        response: responseText
      });

      // Add assistant response to the conversation
      if (activeProjectId) {
        addMessage(activeProjectId, projectPath, 'assistant', responseText);
        console.log('[Research] Added assistant response');
      }

      console.log('[Research] Saved to history');
      showToast(chatType === 'compact' ? 'Compact completed!' : 'Research completed!', 'success');
      loadHistory();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[Research] Request cancelled');
        showToast('Запрос отменён', 'info');
      } else {
        console.error('[Research] ERROR:', err.message);
        showToast(err.message, 'error');
      }
    } finally {
      setAbortController(null);
      setLoading(false);
      console.log('[Research] Done');
    }
  };

  // Keep ref updated for event listener
  handleResearchRef.current = handleResearch;

  // Handle research from clipboard (for "Apply from Clipboard" dropdown)
  const handleClipboardResearch = async (chatType: ChatType) => {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText.trim()) {
        showToast('Буфер обмена пуст', 'warning');
        return;
      }

      console.log('[ClipboardResearch] Starting, type:', chatType);
      console.log('[ClipboardResearch] Clipboard:', `"${clipboardText.slice(0, 50)}..."`);

      // Get settings from dynamic AI prompt
      const promptConfig = getPromptById(chatType);
      const selectedModel = promptConfig?.model || 'gemini-3-flash-preview';
      const thinkingLevel = promptConfig?.thinkingLevel || 'HIGH';
      const systemPrompt = promptConfig?.content || '';

      // Use project prompt for research if available
      const prompt = (chatType === 'research' && geminiPrompt) ? geminiPrompt : systemPrompt;

      // Wrap clipboard content in special pasted block (using ::: syntax to avoid markdown conflicts)
      const wrappedContent = `:::pasted\n${clipboardText}\n:::`;

      // User message: prompt first, then wrapped content
      const userMessage = `_Prompt: ${prompt}_\n\n---\n\n${wrappedContent}`;

      if (activeProjectId) {
        createConversation(activeProjectId, projectPath, userMessage, chatType);
        openResearch();
      }

      setLoading(true);

      const apiKey = process.env.GEMINI_API_KEY || 'REDACTED_GEMINI_KEY';
      const fullPrompt = prompt + clipboardText;

      const controller = new AbortController();
      setAbortController(controller);

      const requestBody: any = {
        contents: [{ parts: [{ text: fullPrompt }] }],
        ...(selectedModel.includes('gemini-3') || selectedModel.includes('gemini-2.5') ? {
          tools: [{ googleSearch: {} }]
        } : {})
      };

      if (selectedModel.includes('gemini-3') && thinkingLevel !== 'NONE') {
        requestBody.generationConfig = {
          thinkingConfig: { thinkingLevel }
        };
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        }
      );

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message || 'Unknown API Error');
      }

      if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
        throw new Error('API returned empty response');
      }

      const responseText = data.candidates[0].content.parts[0].text;

      await ipcRenderer.invoke('gemini:save-history', {
        dirPath: projectPath,
        selectedText: clipboardText,
        prompt,
        response: responseText
      });

      if (activeProjectId) {
        addMessage(activeProjectId, projectPath, 'assistant', responseText);
      }

      showToast(chatType === 'compact' ? 'Compact готов!' : 'Research готов!', 'success');
      loadHistory();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        showToast('Запрос отменён', 'info');
      } else {
        showToast(err.message, 'error');
      }
    } finally {
      setAbortController(null);
      setLoading(false);
    }
  };

  // Dropdown state for clipboard actions
  const [clipboardDropdownOpen, setClipboardDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setClipboardDropdownOpen(false);
      }
    };
    if (clipboardDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [clipboardDropdownOpen]);

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this search from history?')) return;

    await ipcRenderer.invoke('gemini:delete-history', id);
    setHistory(history.filter(h => h.id !== id));
    showToast('Deleted', 'success');
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (expandedItem) {
    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="px-3 py-2 bg-[#333] flex items-center justify-between shrink-0">
          <span className="text-[11px] text-accent uppercase font-bold">AI Response</span>
          <button
            className="text-[#888] hover:text-white text-lg"
            onClick={() => setExpandedItem(null)}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-3 p-2 bg-[#2d2d2d] rounded">
            <p className="text-[10px] text-[#666] uppercase mb-1">Selected Text ({expandedItem.selected_text.length} chars)</p>
            <p className="text-xs text-[#aaa] line-clamp-3">{expandedItem.selected_text}</p>
          </div>

          <div className="p-2 bg-[#2d2d2d] rounded border border-accent">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-accent uppercase font-bold">Response</p>
              <button
                className="text-[10px] text-[#666] hover:text-accent"
                onClick={() => handleCopy(expandedItem.response)}
              >
                Copy
              </button>
            </div>
            <div className="text-sm text-[#eee] leading-relaxed">
              <MarkdownRenderer content={expandedItem.response} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Get total chars in conversation
  const getConversationChars = (conv: { messages?: { content?: string }[] }) => {
    if (!conv.messages) return 0;
    return conv.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  };

  // Get last assistant response
  const getLastResponse = (conv: { messages?: { role: string; content?: string }[] }) => {
    if (!conv.messages) return '';
    const assistantMsgs = conv.messages.filter(m => m.role === 'assistant');
    return assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content || '' : '';
  };

  // Copy last response
  const copyLastResponse = async (conv: { messages: { role: string; content: string }[] }) => {
    const lastResp = getLastResponse(conv);
    if (lastResp) {
      await navigator.clipboard.writeText(lastResp);
      showToast('Скопирован последний ответ', 'success');
    }
  };

  // Open conversation in Research panel
  const openConversation = (convId: string) => {
    if (activeProjectId) {
      setActiveConversation(activeProjectId, convId);
      openResearch();
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 bg-[#333] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          {/* Clipboard Actions Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setClipboardDropdownOpen(!clipboardDropdownOpen)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${
                clipboardDropdownOpen
                  ? 'bg-accent/20 text-accent'
                  : 'text-[#888] hover:text-white hover:bg-[#444]'
              }`}
              title="Применить из буфера"
            >
              <ClipboardPaste size={12} />
              <span>Буфер</span>
              <ChevronDown size={10} className={`transition-transform ${clipboardDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {clipboardDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-[#252525] border border-[#444] rounded-lg shadow-xl min-w-[140px] py-1">
                <button
                  onClick={() => {
                    handleClipboardResearch('research');
                    setClipboardDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-[#ccc] hover:bg-accent/20 hover:text-accent transition-colors"
                >
                  <Search size={12} />
                  <span>Research</span>
                </button>
                <button
                  onClick={() => {
                    handleClipboardResearch('compact');
                    setClipboardDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-[#ccc] hover:bg-purple-500/20 hover:text-purple-400 transition-colors"
                >
                  <FileText size={12} />
                  <span>Compact</span>
                </button>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="w-px h-4 bg-[#444]" />

          <span className="text-[11px] uppercase text-[#aaa]">Чаты</span>
          <span className="text-[10px] text-accent">{conversations.length}</span>
          {terminalSelection && (
            <span className="text-[9px] text-green-500">● {terminalSelection.length}</span>
          )}
        </div>
      </div>

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <div className="text-center mt-5 px-3">
            <p className="text-[#555] text-xs mb-4">
              Нет чатов. Выдели текст и нажми Research.
            </p>
            <div className="text-[10px] text-[#444] bg-[#252525] rounded-lg p-3">
              <kbd className="bg-[#333] px-1.5 py-0.5 rounded text-[#888]">Cmd+Shift+E</kbd>
              <span className="text-[#666] ml-2">Research Panel</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {conversations.map((conv) => {
              // Default to 'research' for backward compatibility
              const convType = conv.type || 'research';
              const convPrompt = getPromptById(convType);
              const borderColor = convPrompt?.color || '#0ea5e9';
              const isActive = conv.id === currentActiveConvId;
              const isLoadingThis = isActive && isLoading;

              return (
              <div
                key={conv.id}
                className={`group rounded p-2 transition-all cursor-pointer`}
                style={{
                  backgroundColor: isActive ? '#3a3a3a' : '#2d2d2d',
                  borderLeft: `2px solid ${isActive ? '#fff' : borderColor}`
                }}
                onClick={() => openConversation(conv.id)}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    {/* Type badge or loader */}
                    {isLoadingThis ? (
                      <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                        <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      </span>
                    ) : (
                      <span
                        className="text-[8px] px-1 py-0.5 rounded shrink-0"
                        style={{ backgroundColor: `${borderColor}33`, color: borderColor }}
                      >
                        {(convPrompt?.name || convType).charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className={`text-[10px] truncate ${isActive ? 'text-white font-medium' : 'text-[#ccc]'}`}>
                      {conv.title}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      className="text-[#666] hover:text-[#cc3333] text-xs px-1 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (activeProjectId) deleteConversation(activeProjectId, projectPath, conv.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-[#666]">{conv.messages.length} сообщ.</span>
                  <span className="text-[#555]">{getConversationChars(conv)} симв.</span>
                </div>
              </div>
              );
            })}
          </div>
        )}

        {/* API Call Log */}
        {(apiCalls.length > 0 || pendingAdopts.length > 0) && (
          <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid #333' }}>
            <div className="text-[10px] text-[#666] mb-2 px-1" style={{ fontWeight: 600 }}>
              API Calls ({apiCalls.length + pendingAdopts.length})
            </div>

            {/* Pending adopt loaders */}
            {pendingAdopts.map((taskId) => (
              <div key={taskId} className="bg-[#2a2a2a] rounded mb-1 flex items-center gap-2 p-1.5 px-2">
                <span style={{ fontSize: '9px', color: '#6366f1', backgroundColor: 'rgba(99,102,241,0.12)', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 }}>
                  adopt
                </span>
                <span style={{
                  display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                  border: '1.5px solid rgba(99,102,241,0.2)', borderTopColor: '#6366f1',
                  boxSizing: 'border-box', animation: 'tab-dot-spin 0.8s linear infinite',
                }} />
                <span className="text-[10px] text-[#666] italic">summarizing...</span>
              </div>
            ))}

            {apiCalls.map((call: any) => {
              const isExpanded = expandedApiCallId === call.id;
              const typeColors: Record<string, string> = { adopt: '#6366f1', update_docs: '#f59e0b', research: '#0ea5e9' };
              const color = typeColors[call.call_type] || '#888888';
              const tokensIn = call.input_tokens > 1000 ? (call.input_tokens / 1000).toFixed(1) + 'K' : String(call.input_tokens);
              const tokensOut = call.output_tokens > 1000 ? (call.output_tokens / 1000).toFixed(1) + 'K' : String(call.output_tokens);
              const payloadKB = call.payload_size > 0 ? Math.round(call.payload_size / 1024) + 'KB' : null;

              // Parse session meta for mini-timeline
              let meta: { turns?: number; compacts?: number; planModes?: number; forks?: number; segments?: { type: string; count: number }[] } | null = null;
              try { if (call.session_meta) meta = JSON.parse(call.session_meta); } catch {}

              return (
                <div
                  key={call.id}
                  className="bg-[#2a2a2a] rounded cursor-pointer hover:bg-[#333] transition-colors mb-1"
                  onClick={() => setExpandedApiCallId(isExpanded ? null : call.id)}
                >
                  <div className="flex items-center gap-2 p-1.5 px-2">
                    <span style={{ fontSize: '9px', color, backgroundColor: color + '20', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 }}>
                      {call.call_type}
                    </span>
                    <span className="text-[10px] text-[#888] flex-1 truncate">{call.model || '—'}</span>
                    <span className="text-[10px] text-[#666]">{tokensIn}/{tokensOut}</span>
                    <span className="text-[10px] text-[#555]">{getTimeAgo(call.created_at)}</span>
                  </div>
                  {/* Mini-timeline: [N msg] for turns, thin markers for compact/plan/fork */}
                  {meta?.segments && meta.segments.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '2px', padding: '0 8px 4px' }}>
                      {meta.segments.map((seg, si) => {
                        if (seg.type === 'turns') {
                          return <span key={si} style={{
                            fontSize: '9px', color: color,
                            backgroundColor: color + '12',
                            padding: '0 4px', borderRadius: '2px', border: `1px solid ${color}33`,
                          }}>{seg.count} msg</span>;
                        } else if (seg.type === 'compact') {
                          return <div key={si} style={{
                            width: '2px', height: '10px', borderRadius: '1px',
                            backgroundColor: '#a67c1a',
                          }} title="compact" />;
                        } else if (seg.type === 'plan') {
                          return <div key={si} style={{
                            width: '2px', height: '10px', borderRadius: '1px',
                            backgroundColor: '#3d7a72',
                          }} title="plan mode" />;
                        } else if (seg.type === 'fork') {
                          return <div key={si} style={{
                            width: '2px', height: '10px', borderRadius: '1px',
                            backgroundColor: '#3b82f6',
                          }} title="fork point" />;
                        }
                        return null;
                      })}
                    </div>
                  )}
                  {isExpanded && call.result_text && (
                    <div style={{ padding: '6px 8px', borderTop: '1px solid #333', fontSize: '10px', color: '#aaa', maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
                      {payloadKB && <div style={{ color: '#666', marginBottom: '4px' }}>Payload: {payloadKB} | Tokens: {tokensIn} in / {tokensOut} out</div>}
                      {call.result_text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
