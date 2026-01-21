import React, { useState, RefObject, useCallback } from 'react';
import { useResearchStore } from '../../store/useResearchStore';
import { useUIStore } from '../../store/useUIStore';

interface ResearchInputProps {
  projectId: string;
  inputRef: RefObject<HTMLTextAreaElement>;
}

export default function ResearchInput({ projectId, inputRef }: ResearchInputProps) {
  const [value, setValue] = useState('');
  const { addMessage, createConversation, getActiveConversation, isLoading, setLoading } = useResearchStore();
  const { selectedModel, showToast } = useUIStore();

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;

    console.log('[ResearchInput] Sending message...');
    console.log('[ResearchInput] Model:', selectedModel);
    console.log('[ResearchInput] Message:', trimmed.slice(0, 50));

    // Check if there's an active conversation
    const activeConv = getActiveConversation(projectId);

    if (activeConv) {
      // Add to existing conversation
      addMessage(projectId, 'user', trimmed);
    } else {
      // Create new conversation
      createConversation(projectId, trimmed);
    }

    setValue('');
    setLoading(true);

    // Get API key
    const apiKey = process.env.GEMINI_API_KEY || 'REDACTED_GEMINI_KEY';

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: trimmed }] }]
          })
        }
      );

      console.log('[ResearchInput] Response status:', response.status);
      const data = await response.json();

      if (data.error) {
        console.error('[ResearchInput] API Error:', data.error);
        throw new Error(data.error.message || 'API Error');
      }

      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error('Empty or blocked response');
      }

      const responseText = data.candidates[0].content.parts[0].text;
      console.log('[ResearchInput] Response length:', responseText.length);
      addMessage(projectId, 'assistant', responseText);
    } catch (err: any) {
      console.error('[ResearchInput] ERROR:', err.message);
      showToast(err.message, 'error');
      addMessage(projectId, 'assistant', `Ошибка: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [value, projectId, addMessage, createConversation, getActiveConversation, isLoading, setLoading, selectedModel, showToast]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Auto-resize textarea
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);

    // Reset height to auto to get proper scrollHeight
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };

  return (
    <div className="p-4">
      <div className="flex gap-3 items-end">
        <div className="flex-1 relative">
          <textarea
            ref={inputRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything... (Enter to send, Shift+Enter for new line)"
            disabled={isLoading}
            rows={1}
            className="w-full bg-[#333] border border-white/10 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-500 resize-none focus:outline-none focus:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ minHeight: '44px', maxHeight: '200px' }}
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={!value.trim() || isLoading}
          className="h-11 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition flex items-center gap-2 shrink-0"
        >
          {isLoading ? (
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          Send
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>Model: {selectedModel}</span>
        <span className="opacity-50">Cmd+Shift+R to toggle</span>
      </div>
    </div>
  );
}
