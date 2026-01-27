import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useUIStore } from '../../../store/useUIStore';
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
  const { showToast, chatSettings, terminalSelection } = useUIStore();
  const { createConversation, addMessage, openResearch, getProjectConversations, setActiveConversation, deleteConversation, isLoading, setLoading, setAbortController, pendingResearch, pendingChatType, clearPendingResearch, loadFromDB, activeConversationId } = useResearchStore();
  const { activeProjectId } = useWorkspaceStore();
  const conversations = activeProjectId ? getProjectConversations(activeProjectId) : [];
  const currentActiveConvId = activeProjectId ? activeConversationId[activeProjectId] : null;
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [expandedItem, setExpandedItem] = useState<HistoryItem | null>(null);

  // Ref to store handleResearch for event listener (with chatType parameter)
  const handleResearchRef = useRef<(chatType: ChatType) => void>(() => {});

  useEffect(() => {
    loadHistory();
    // Load full conversations from DB for this project
    if (activeProjectId && projectPath) {
      loadFromDB(activeProjectId, projectPath);
    }
  }, [projectPath, activeProjectId]);

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

  const handleResearch = async (chatType: ChatType = 'research') => {
    console.log('[Research] Starting, type:', chatType);
    console.log('[Research] Selection:', terminalSelection ? `"${terminalSelection.slice(0, 50)}..."` : 'EMPTY');

    if (!terminalSelection) {
      console.log('[Research] ERROR: No selection');
      showToast('Select text in terminal first!', 'error');
      return;
    }

    const selectedText = terminalSelection;

    // Get settings for the chat type
    const settings = chatSettings[chatType];
    const { model: selectedModel, thinkingLevel, prompt: systemPrompt } = settings;

    // Use project prompt for research if available, otherwise use type's system prompt
    const prompt = (chatType === 'research' && geminiPrompt) ? geminiPrompt : systemPrompt;
    console.log('[Research] Type:', chatType, 'Model:', selectedModel, 'Thinking:', thinkingLevel);
    console.log('[Research] Prompt:', `"${prompt.slice(0, 50)}..."`);

    // IMMEDIATELY create conversation and open panel
    // Put prompt first as requested
    const userMessage = `_Prompt: ${prompt}_\n\n---\n\n${selectedText}`;
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

      // Get settings for the chat type
      const settings = chatSettings[chatType];
      const { model: selectedModel, thinkingLevel, prompt: systemPrompt } = settings;

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
              <kbd className="bg-[#333] px-1.5 py-0.5 rounded text-[#888]">Cmd+Shift+R</kbd>
              <span className="text-[#666] ml-2">Research Panel</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {conversations.map((conv) => {
              // Default to 'research' for backward compatibility
              const convType = conv.type || 'research';
              const isActive = conv.id === currentActiveConvId;
              const isLoadingThis = isActive && isLoading;

              return (
              <div
                key={conv.id}
                className={`group rounded p-2 transition-all cursor-pointer border-l-2 ${
                  isActive
                    ? 'bg-[#3a3a3a] border-l-white'
                    : 'bg-[#2d2d2d] hover:bg-[#333]'
                } ${
                  convType === 'compact' && !isActive ? 'border-l-purple-500' : ''
                } ${
                  convType === 'research' && !isActive ? 'border-l-accent' : ''
                }`}
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
                      <span className={`text-[8px] px-1 py-0.5 rounded shrink-0 ${
                        convType === 'compact'
                          ? 'bg-purple-500/20 text-purple-400'
                          : 'bg-accent/20 text-accent'
                      }`}>
                        {convType === 'compact' ? 'C' : 'R'}
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
      </div>
    </div>
  );
}
