import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useUIStore } from '../../../store/useUIStore';
import { useResearchStore } from '../../../store/useResearchStore';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';

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
  const { showToast, researchPrompt, selectedModel, terminalSelection } = useUIStore();
  const { createConversation, addMessage, openResearch, getProjectConversations, setActiveConversation, deleteConversation } = useResearchStore();
  const { activeProjectId } = useWorkspaceStore();
  const conversations = activeProjectId ? getProjectConversations(activeProjectId) : [];
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedItem, setExpandedItem] = useState<HistoryItem | null>(null);

  // Ref to store handleResearch for event listener
  const handleResearchRef = useRef<() => void>(() => {});

  useEffect(() => {
    loadHistory();
  }, [projectPath]);

  // Listen for trigger-research event from context menu
  useEffect(() => {
    const handleTriggerResearch = () => {
      console.log('[GeminiPanel] Received trigger-research event');
      handleResearchRef.current();
    };
    window.addEventListener('trigger-research', handleTriggerResearch);
    return () => window.removeEventListener('trigger-research', handleTriggerResearch);
  }, []);

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

  const handleResearch = async () => {
    console.log('[Research] Starting research...');
    console.log('[Research] Selection:', terminalSelection ? `"${terminalSelection.slice(0, 50)}..."` : 'EMPTY');

    if (!terminalSelection) {
      console.log('[Research] ERROR: No selection');
      showToast('Select text in terminal first!', 'error');
      return;
    }

    const selectedText = terminalSelection;

    setLoading(true);

    // Use prompt from settings, fallback to project prompt, then system default
    const prompt = geminiPrompt || researchPrompt;
    console.log('[Research] Prompt:', `"${prompt.slice(0, 50)}..."`);
    console.log('[Research] Model:', selectedModel);

    // Get API key from environment
    const apiKey = process.env.GEMINI_API_KEY || 'REDACTED_GEMINI_KEY';
    console.log('[Research] API Key:', apiKey ? `${apiKey.slice(0, 10)}...` : 'MISSING');

    const fullPrompt = prompt + selectedText;
    console.log('[Research] Full prompt length:', fullPrompt.length);
    console.log('[Research] Sending request to Gemini API...');

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }]
          })
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

      // Create new conversation in Research panel
      if (activeProjectId) {
        // Create new conversation with user message
        const userMessage = `${prompt}\n\n---\n${selectedText}`;
        createConversation(activeProjectId, userMessage);
        // Add assistant response to the new conversation
        addMessage(activeProjectId, 'assistant', responseText);
        // Open Research panel to show result
        openResearch();
        console.log('[Research] Created new conversation');
      }

      console.log('[Research] Saved to history');
      showToast('Research completed!', 'success');
      loadHistory();
    } catch (err: any) {
      console.error('[Research] ERROR:', err.message);
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
      console.log('[Research] Done');
    }
  };

  // Keep ref updated for event listener
  handleResearchRef.current = handleResearch;

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
            <p className="text-sm text-[#eee] whitespace-pre-wrap leading-relaxed">
              {expandedItem.response}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Get total chars in conversation
  const getConversationChars = (conv: { messages: { content: string }[] }) => {
    return conv.messages.reduce((sum, m) => sum + m.content.length, 0);
  };

  // Get last assistant response
  const getLastResponse = (conv: { messages: { role: string; content: string }[] }) => {
    const assistantMsgs = conv.messages.filter(m => m.role === 'assistant');
    return assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content : '';
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
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase text-[#aaa]">Чаты</span>
          <span className="text-[10px] text-accent">{conversations.length}</span>
          {terminalSelection && (
            <span className="text-[9px] text-green-500">● {terminalSelection.length}</span>
          )}
        </div>
        <button
          className={`text-[10px] px-2 py-1 rounded ${
            loading || !terminalSelection
              ? 'bg-[#444] text-[#666] cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent/80'
          }`}
          onClick={handleResearch}
          disabled={loading || !terminalSelection}
        >
          {loading ? 'Поиск...' : 'Research'}
        </button>
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
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className="group bg-[#2d2d2d] border-l-2 border-l-accent rounded p-2 transition-all hover:bg-[#333] cursor-pointer"
                onClick={() => openConversation(conv.id)}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="text-[10px] text-[#ccc] truncate flex-1">
                    {conv.title}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      className="text-[#666] hover:text-accent text-xs px-1"
                      onClick={(e) => { e.stopPropagation(); copyLastResponse(conv); }}
                    >
                      Copy
                    </button>
                    <button
                      className="text-[#666] hover:text-[#cc3333] text-xs px-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (activeProjectId) deleteConversation(activeProjectId, conv.id);
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
