import React, { useState, RefObject, useCallback } from 'react';
import { useResearchStore, ChatType } from '../../store/useResearchStore';
import { useUIStore } from '../../store/useUIStore';
import { usePromptsStore } from '../../store/usePromptsStore';

interface ResearchInputProps {
  projectId: string;
  projectPath: string;
  inputRef: RefObject<HTMLTextAreaElement>;
  chatType: ChatType;
}

export default function ResearchInput({ projectId, projectPath, inputRef, chatType }: ResearchInputProps) {
  const [value, setValue] = useState('');
  const { addMessage, createConversation, getActiveConversation, isLoading, setLoading, setAbortController, cancelRequest } = useResearchStore();
  const { showToast } = useUIStore();
  const { getPromptById } = usePromptsStore();

  // Get settings from dynamic AI prompt
  const currentPrompt = getPromptById(chatType);
  const selectedModel = currentPrompt?.model || 'gemini-3-flash-preview';
  const thinkingLevel = currentPrompt?.thinkingLevel || 'HIGH';

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;

    console.log('[ResearchInput] Sending message...');
    console.log('[ResearchInput] Model:', selectedModel);
    console.log('[ResearchInput] Thinking:', thinkingLevel);

    // Check if there's an active conversation
    const activeConv = getActiveConversation(projectId);

    if (activeConv) {
      addMessage(projectId, projectPath, 'user', trimmed);
    } else {
      // Create new conversation with the current chat type
      createConversation(projectId, projectPath, trimmed, chatType);
    }

    setValue('');
    setLoading(true);

    // Create AbortController
    const controller = new AbortController();
    setAbortController(controller);

    try {
      const apiKey = process.env.GEMINI_API_KEY;

      // Build conversation history
      const currentConv = getActiveConversation(projectId);
      const contents = currentConv
        ? currentConv.messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
          }))
        : [{ role: 'user', parts: [{ text: trimmed }] }];

      console.log('[ResearchInput] Sending', contents.length, 'messages');

      // Build request body with thinking config
      const requestBody: any = {
        contents,
        systemInstruction: {
          parts: [{ text: 'Отвечай максимально кратко и по делу.' }]
        }
      };

      // Add thinking config for gemini-3
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

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message || 'API Error');
      }

      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error('Empty or blocked response');
      }

      const responseText = data.candidates[0].content.parts[0].text;
      console.log('[ResearchInput] Response length:', responseText.length);
      addMessage(projectId, projectPath, 'assistant', responseText);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[ResearchInput] Request cancelled');
        showToast('Запрос отменён', 'info');
      } else {
        console.error('[ResearchInput] ERROR:', err.message);
        showToast(err.message, 'error');
        addMessage(projectId, projectPath, 'assistant', `Ошибка: ${err.message}`);
      }
    } finally {
      setAbortController(null);
      setLoading(false);
    }
  }, [value, projectId, projectPath, addMessage, createConversation, getActiveConversation, isLoading, setLoading, setAbortController, selectedModel, thinkingLevel, showToast, chatType]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
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
            placeholder="Введите запрос..."
            disabled={isLoading}
            rows={1}
            className="w-full bg-[#2a2a2a] border border-[#444] rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-[#555] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ minHeight: '44px', maxHeight: '200px' }}
          />
        </div>

        {isLoading ? (
          <button
            onClick={cancelRequest}
            className="h-11 px-4 bg-red-600 hover:bg-red-500 cursor-pointer rounded-lg text-sm font-medium text-white transition flex items-center gap-2 shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />
            </svg>
            Отмена
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="h-11 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 cursor-pointer disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition flex items-center gap-2 shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
