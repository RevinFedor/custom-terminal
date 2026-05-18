import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useResearchStore, ChatType } from '../../store/useResearchStore';
import { useUIStore, ThinkingLevel, AIModel } from '../../store/useUIStore';
import { usePromptsStore } from '../../store/usePromptsStore';
import ChatArea from './ChatArea';
import ResearchInput from './ResearchInput';
import Tooltip from '../UI/Tooltip';

const { ipcRenderer } = window.require('electron');

// AI Sessions history — flat list of API call records persisted in main process.
// Used to live as a separate "AI Sessions" tab in the right sidebar; moved here
// when the user collapsed the right sidebar down to a single Info tab.
// Каждая запись — один вызов update_docs / research / adopt с моделью и токенами.
interface ApiCallEntry {
  id: number;
  call_type: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  result_text: string | null;
  source_tab_id: string | null;
  target_tab_id: string | null;
  payload_size: number;
  created_at: number;
}

interface ResearchSheetProps {
  projectId: string;
  projectPath: string;
}

const AI_MODELS = [
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' }
] as const;

const THINKING_LEVELS = [
  { value: 'NONE', label: 'Off' },
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Med' },
  { value: 'HIGH', label: 'High' }
] as const;

export default function ResearchSheet({ projectId, projectPath }: ResearchSheetProps) {
  const { isOpen, closeResearch, getActiveConversation, deleteConversation, pendingChatType, addMessage, setLoading, setAbortController, isLoading } = useResearchStore();
  const { showToast } = useUIStore();
  const { getPromptById, savePrompt } = usePromptsStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  // AI Sessions history — fetched lazily when popover opens. We don't subscribe
  // to live updates because the list is for inspection, not for streaming work.
  const [showHistory, setShowHistory] = useState(false);
  const [apiCalls, setApiCalls] = useState<ApiCallEntry[]>([]);
  const [expandedApiCallId, setExpandedApiCallId] = useState<number | null>(null);
  useEffect(() => {
    if (!showHistory) return;
    ipcRenderer.invoke('api-calls:list', { limit: 50 }).then((r: any) => {
      if (r?.success && r.data) setApiCalls(r.data);
    }).catch(() => {});
  }, [showHistory]);
  const getTimeAgo = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const conversation = getActiveConversation(projectId);
  const messages = conversation?.messages || [];

  // Determine current chat type: from active conversation or from pending trigger
  const currentChatType: ChatType = conversation?.type || pendingChatType || 'research';
  const currentPrompt = getPromptById(currentChatType);

  // Model and thinking level from prompt settings
  const selectedModel = currentPrompt?.model || 'gemini-3-flash-preview';
  const thinkingLevel = currentPrompt?.thinkingLevel || 'HIGH';

  const setSelectedModel = (model: AIModel) => {
    if (currentPrompt) {
      savePrompt({ ...currentPrompt, model });
    }
  };

  // Get last assistant response for copy button
  const lastAssistantResponse = useMemo(() => {
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    return assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : '';
  }, [messages]);

  // Copy last response to clipboard
  const copyLastResponse = async () => {
    if (!lastAssistantResponse) {
      showToast('Нет ответа для копирования', 'warning');
      return;
    }
    await navigator.clipboard.writeText(lastAssistantResponse);
    showToast('Ответ скопирован', 'success');
  };

  const setThinkingLevel = (level: ThinkingLevel) => {
    if (currentPrompt) {
      savePrompt({ ...currentPrompt, thinkingLevel: level });
    }
  };

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        closeResearch();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeResearch]);

  // Retry handler - resends the conversation to API
  const handleRetry = useCallback(async (messageId: string) => {
    // Get updated conversation (after truncation)
    const conv = getActiveConversation(projectId);
    if (!conv || conv.messages.length === 0) {
      showToast('No messages to retry', 'warning');
      return;
    }

    // The last message should be a user message (after truncation removed the assistant)
    const lastUserMsg = conv.messages[conv.messages.length - 1];
    if (lastUserMsg.role !== 'user') {
      showToast('Cannot retry: last message is not from user', 'warning');
      return;
    }

    setLoading(true);

    // Create AbortController
    const controller = new AbortController();
    setAbortController(controller);

    try {
      const apiKey = process.env.GEMINI_API_KEY;

      // Build conversation history
      const contents = conv.messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }));

      // Build request body
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
      addMessage(projectId, projectPath, 'assistant', responseText);
      showToast('Response regenerated', 'success');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        showToast('Request cancelled', 'info');
      } else {
        console.error('[Retry] ERROR:', err.message);
        showToast(err.message, 'error');
        addMessage(projectId, projectPath, 'assistant', `Error: ${err.message}`);
      }
    } finally {
      setAbortController(null);
      setLoading(false);
    }
  }, [projectId, projectPath, getActiveConversation, addMessage, setLoading, setAbortController, selectedModel, thinkingLevel, showToast]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={closeResearch}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 40,
              backgroundColor: 'rgba(0,0,0,0.75)'
            }}
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              top: '16px',
              left: '16px',
              right: '16px',
              bottom: '16px',
              zIndex: 50,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#1a1a1a',
              borderRadius: '12px',
              border: '1px solid #333',
              overflow: 'hidden',
              boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)'
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: '1px solid #333',
              backgroundColor: '#222',
              flexShrink: 0
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 500, color: currentPrompt?.color || '#fff' }}>{currentPrompt?.name || currentChatType}</span>

                {/* Model select */}
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value as typeof selectedModel)}
                  style={{
                    fontSize: '12px',
                    backgroundColor: '#333',
                    border: '1px solid #444',
                    borderRadius: '6px',
                    padding: '4px 8px',
                    color: '#ccc',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  {AI_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>

                {/* Thinking level select (only for gemini-3) */}
                {selectedModel.includes('gemini-3') && (
                  <select
                    value={thinkingLevel}
                    onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
                    style={{
                      fontSize: '12px',
                      backgroundColor: '#333',
                      border: '1px solid #444',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      color: '#ccc',
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    {THINKING_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>
                        🧠 {level.label}
                      </option>
                    ))}
                  </select>
                )}

                {/* Settings genie tooltip */}
                <span
                  className="relative group/settings"
                  onMouseEnter={() => { console.log('[Settings] Mouse ENTER'); setShowSettings(true); }}
                  onMouseLeave={() => { console.log('[Settings] Mouse LEAVE'); setShowSettings(false); }}
                  style={{ cursor: 'help', fontSize: '14px', color: '#666' }}
                >
                  ⚙️
                  <div
                    className="absolute top-full left-0 pt-1 pointer-events-none z-50"
                    style={{
                      opacity: showSettings ? 1 : 0,
                      transform: showSettings ? 'translateY(0) scaleY(1) scaleX(1)' : 'translateY(-4px) scaleY(0) scaleX(0.85)',
                      transformOrigin: 'top left',
                      transition: 'all 0.2s ease-out'
                    }}
                  >
                    <div style={{
                      backgroundColor: '#222',
                      border: '1px solid #444',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      fontSize: '11px',
                      whiteSpace: 'nowrap',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
                    }}>
                      <div style={{ color: '#888', marginBottom: '4px' }}>API Settings:</div>
                      <div style={{ color: '#666', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div>• Google Search: <span style={{ color: '#4ade80' }}>вкл</span></div>
                        <div>• URL Context: <span style={{ color: '#4ade80' }}>вкл</span></div>
                        <div>• Safety: <span style={{ color: '#facc15' }}>минимум</span></div>
                      </div>
                    </div>
                  </div>
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {/* AI Sessions history popover trigger — был отдельной вкладкой
                    в правом сайдбаре («AI Sessions» / GeminiPanel). После
                    upstream-cleanup'а sidebar остался один Info-таб, история
                    переехала сюда — рядом с другими AI-контролями. */}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setShowHistory(v => !v)}
                    title="История вызовов AI"
                    style={{
                      fontSize: '11px',
                      color: showHistory ? '#fff' : '#888',
                      background: showHistory ? 'rgba(255,255,255,0.06)' : 'transparent',
                      border: '1px solid ' + (showHistory ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.10)'),
                      borderRadius: '6px',
                      padding: '4px 10px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <span style={{ fontSize: 12, lineHeight: 1 }}>⌃</span>
                    <span>History</span>
                    {apiCalls.length > 0 && (
                      <span style={{ fontSize: 10, color: '#666', marginLeft: 4 }}>{apiCalls.length}</span>
                    )}
                  </button>
                  {showHistory && (
                    <>
                      {/* Click-outside catcher */}
                      <div
                        onClick={() => setShowHistory(false)}
                        style={{ position: 'fixed', inset: 0, zIndex: 60 }}
                      />
                      <div
                        style={{
                          position: 'absolute',
                          top: 'calc(100% + 6px)',
                          right: 0,
                          width: 420,
                          maxHeight: 480,
                          overflowY: 'auto',
                          backgroundColor: '#222',
                          border: '1px solid #444',
                          borderRadius: 8,
                          padding: 8,
                          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                          zIndex: 70,
                        }}
                      >
                        {apiCalls.length === 0 ? (
                          <div style={{ fontSize: 11, color: '#666', textAlign: 'center', padding: 16 }}>
                            История пуста
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {apiCalls.map((call) => {
                              const isExpanded = expandedApiCallId === call.id;
                              const typeColors: Record<string, string> = {
                                adopt: '#6366f1',
                                update_docs: '#f59e0b',
                                research: '#0ea5e9',
                              };
                              const color = typeColors[call.call_type] || '#888';
                              const tokensIn = call.input_tokens > 1000 ? (call.input_tokens / 1000).toFixed(1) + 'K' : call.input_tokens;
                              const tokensOut = call.output_tokens > 1000 ? (call.output_tokens / 1000).toFixed(1) + 'K' : call.output_tokens;
                              const payloadKB = call.payload_size > 0 ? Math.round(call.payload_size / 1024) + 'KB' : null;
                              return (
                                <div
                                  key={call.id}
                                  onClick={() => setExpandedApiCallId(isExpanded ? null : call.id)}
                                  style={{
                                    backgroundColor: '#2a2a2a',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
                                    <span style={{
                                      fontSize: 9,
                                      color,
                                      backgroundColor: color + '20',
                                      padding: '1px 5px',
                                      borderRadius: 3,
                                      fontWeight: 600,
                                    }}>
                                      {call.call_type}
                                    </span>
                                    <span style={{ fontSize: 10, color: '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {call.model || '—'}
                                    </span>
                                    <span style={{ fontSize: 10, color: '#666' }}>{tokensIn}/{tokensOut}</span>
                                    <span style={{ fontSize: 10, color: '#555' }}>{getTimeAgo(call.created_at)}</span>
                                  </div>
                                  {isExpanded && call.result_text && (
                                    <div style={{
                                      padding: '6px 10px',
                                      borderTop: '1px solid #333',
                                      fontSize: 10,
                                      color: '#aaa',
                                      maxHeight: 220,
                                      overflow: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      lineHeight: 1.4,
                                    }}>
                                      {payloadKB && (
                                        <div style={{ color: '#666', marginBottom: 4 }}>
                                          Payload: {payloadKB} | Tokens: {tokensIn} in / {tokensOut} out
                                        </div>
                                      )}
                                      {call.result_text}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {/* Copy last response button */}
                {lastAssistantResponse && (
                  <Tooltip content="Скопировать последний ответ">
                    <button
                      onClick={copyLastResponse}
                      style={{
                        fontSize: '11px',
                        color: '#4ade80',
                        background: 'rgba(34,197,94,0.1)',
                        border: '1px solid rgba(34,197,94,0.3)',
                        borderRadius: '6px',
                        padding: '4px 10px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        transition: 'all 0.15s ease'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(34,197,94,0.2)';
                        e.currentTarget.style.borderColor = 'rgba(34,197,94,0.5)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(34,197,94,0.1)';
                        e.currentTarget.style.borderColor = 'rgba(34,197,94,0.3)';
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                        <path d="M11 5V3C11 2.44772 10.5523 2 10 2H3C2.44772 2 2 2.44772 2 3V10C2 10.5523 2.44772 11 3 11H5" stroke="currentColor" strokeWidth="1.5"/>
                      </svg>
                      Copy
                    </button>
                  </Tooltip>
                )}
                {conversation && (
                  <button
                    onClick={() => deleteConversation(projectId, projectPath, conversation.id)}
                    style={{
                      fontSize: '11px',
                      color: '#666',
                      background: 'none',
                      border: 'none',
                      padding: '4px 8px',
                      cursor: 'pointer'
                    }}
                  >
                    Удалить чат
                  </button>
                )}
                <button
                  onClick={closeResearch}
                  style={{
                    width: '28px',
                    height: '28px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'none',
                    border: 'none',
                    color: '#666',
                    cursor: 'pointer',
                    borderRadius: '6px'
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Chat Area */}
            <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
              <ChatArea projectId={projectId} projectPath={projectPath} onRetry={handleRetry} />
            </div>

            {/* Input Area */}
            <div style={{ borderTop: '1px solid #333', backgroundColor: '#222', flexShrink: 0 }}>
              <ResearchInput projectId={projectId} projectPath={projectPath} inputRef={inputRef} chatType={currentChatType} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
