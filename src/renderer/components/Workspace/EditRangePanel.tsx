import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, ChevronRight, X, Check, Pencil, Copy } from 'lucide-react';
import MarkdownRenderer from '../Research/MarkdownRenderer';
import { usePromptsStore } from '../../store/usePromptsStore';
import { useUIStore, ThinkingLevel, AIModel } from '../../store/useUIStore';

const AI_MODELS = [
  { value: 'gemini-3-flash-preview', label: 'Flash' },
  { value: 'gemini-3-pro-preview', label: 'Pro' }
] as const;

const THINKING_LEVELS = [
  { value: 'NONE', label: 'Off' },
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Med' },
  { value: 'HIGH', label: 'High' }
] as const;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ApplyStep {
  label: string;
  status: 'pending' | 'active' | 'done';
}

interface EditRangePanelProps {
  sourceContent: string;
  initialCompact: string;
  anchorTop: number;
  anchorHeight: number;
  rightOffset: number;
  onApply: (compactText: string) => Promise<{ removedCount: number; removedUsers?: number; removedAssistants?: number }>;
  onClose: () => void;
}

export default function EditRangePanel({
  sourceContent,
  initialCompact,
  anchorTop,
  anchorHeight,
  rightOffset,
  onApply,
  onClose,
}: EditRangePanelProps) {
  const { getPromptById, rewindPromptId, savePrompt } = usePromptsStore();
  const { showToast } = useUIStore();
  const panelSize = useUIStore(state => state.editRangePanelSize);
  const setPanelSize = useUIStore(state => state.setEditRangePanelSize);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<Message[]>(() => [
    { id: 'source', role: 'user', content: sourceContent },
    { id: 'initial', role: 'assistant', content: initialCompact },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Apply flow state
  const [applyPhase, setApplyPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [applySteps, setApplySteps] = useState<ApplyStep[]>([]);
  const [applyResult, setApplyResult] = useState<{ removedCount: number; removedUsers?: number; removedAssistants?: number } | null>(null);
  // Frozen position — captured when "Применить" is clicked, used for running/done
  const [frozenPos, setFrozenPos] = useState<{ top: number; right: number } | null>(null);

  // Prompt settings (model, thinking)
  const promptConfig = getPromptById(rewindPromptId);
  const selectedModel = promptConfig?.model || 'gemini-3-flash-preview';
  const thinkingLevel = promptConfig?.thinkingLevel || 'HIGH';

  const setSelectedModel = (model: AIModel) => {
    if (promptConfig) savePrompt({ ...promptConfig, model });
  };
  const setThinkingLevel = (level: ThinkingLevel) => {
    if (promptConfig) savePrompt({ ...promptConfig, thinkingLevel: level });
  };

  // Last assistant response for OK button
  const lastAssistant = useMemo(() => {
    const assistants = messages.filter(m => m.role === 'assistant');
    return assistants.length > 0 ? assistants[assistants.length - 1].content : '';
  }, [messages]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 200);
  }, []);

  // Escape to close (only when idle or done)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && applyPhase !== 'running') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, applyPhase]);


  const handleApply = useCallback(async () => {
    if (!lastAssistant || isLoading || applyPhase !== 'idle') return;

    // Freeze position from current panel rect
    const panelRect = panelRef.current?.getBoundingClientRect();
    if (panelRect) {
      const centerY = panelRect.top + panelRect.height / 2;
      setFrozenPos({ top: centerY - 50, right: rightOffset });
    }

    setApplyPhase('running');
    setApplySteps([
      { label: 'Остановка сессии', status: 'active' },
      { label: 'Редактирование JSONL', status: 'pending' },
      { label: 'Перезапуск Claude', status: 'pending' },
    ]);

    try {
      // Step 1 → 2 → 3 happen inside onApply
      const result = await onApply(lastAssistant);

      setApplyResult(result);
      setApplyPhase('done');
    } catch (err: any) {
      console.error('[EditRange] Apply failed:', err);
      setApplyPhase('idle');
      setApplySteps([]);
    }
  }, [lastAssistant, isLoading, applyPhase, onApply, onClose]);

  const handleSend = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isLoading) return;

    const userMsg: Message = { id: `user-${Date.now()}`, role: 'user', content: trimmed };
    setMessages(prev => [...prev, userMsg]);
    setInputValue('');
    setIsLoading(true);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      const apiKey = process.env.GEMINI_API_KEY;

      // Build conversation history for API
      const contents = [...messages, userMsg].map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }));

      const requestBody: any = {
        contents,
        systemInstruction: {
          parts: [{ text: 'Отвечай максимально кратко и по делу. Ты редактируешь сводку сессии AI-агента.' }]
        }
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

      if (data.error) throw new Error(data.error.message || 'API Error');
      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) throw new Error('Empty response');

      const responseText = data.candidates[0].content.parts[0].text;
      setMessages(prev => [...prev, { id: `assistant-${Date.now()}`, role: 'assistant', content: responseText }]);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        showToast('Запрос отменён', 'info');
      } else {
        showToast(err.message, 'error');
        setMessages(prev => [...prev, { id: `error-${Date.now()}`, role: 'assistant', content: `Ошибка: ${err.message}` }]);
      }
    } finally {
      setAbortController(null);
      setIsLoading(false);
    }
  }, [inputValue, isLoading, messages, selectedModel, thinkingLevel, showToast]);

  const handleCancel = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  };

  // All limits derived from viewport — no hardcoded min/max
  const MARGIN = 12;
  const MIN_USABLE_H = 180; // header + input + one message
  const MIN_USABLE_W = 220;

  // Center of the selected range — initial anchor for panel position
  const anchorCenterY = anchorTop + anchorHeight / 2;

  // Top override: null = use anchor centering, number = explicit top position (after resize)
  const [topOverride, setTopOverride] = useState<number | null>(null);

  // Independent edge resize: top moves top edge only, bottom moves bottom edge only
  const dragRef = useRef<{
    edge: 'top' | 'bottom' | 'left';
    startY: number; startX: number;
    startH: number; startW: number;
    startTop: number;
  } | null>(null);

  const handleResizeStart = useCallback((edge: 'top' | 'bottom' | 'left', e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Compute current resolved top to use as starting point
    const vh = window.innerHeight;
    const curH = Math.max(MIN_USABLE_H, Math.min(panelSize.height, vh - MARGIN * 2));
    let curTop: number;
    if (topOverride !== null) {
      curTop = topOverride;
    } else {
      curTop = anchorCenterY - curH / 2;
      if (curTop < MARGIN) curTop = MARGIN;
      if (curTop + curH > vh - MARGIN) curTop = vh - curH - MARGIN;
    }

    dragRef.current = {
      edge,
      startY: e.clientY, startX: e.clientX,
      startH: panelSize.height, startW: panelSize.width,
      startTop: curTop,
    };

    const handleMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const vh2 = window.innerHeight;
      const vw = window.innerWidth;
      const dy = ev.clientY - d.startY;
      const dx = ev.clientX - d.startX;

      if (d.edge === 'top') {
        // Top edge moves up/down — height changes inversely, bottom stays
        const bottomEdge = d.startTop + d.startH;
        const newTop = Math.max(MARGIN, Math.min(bottomEdge - MIN_USABLE_H, d.startTop + dy));
        const newH = bottomEdge - newTop;
        setTopOverride(newTop);
        setPanelSize({ width: panelSize.width, height: newH });
      } else if (d.edge === 'bottom') {
        // Bottom edge moves down/up — top stays
        const maxBottom = vh2 - MARGIN;
        const newH = Math.max(MIN_USABLE_H, Math.min(maxBottom - d.startTop, d.startH + dy));
        setTopOverride(d.startTop); // Lock top position
        setPanelSize({ width: panelSize.width, height: newH });
      } else if (d.edge === 'left') {
        const maxW = vw - rightOffset - MARGIN;
        const newW = Math.max(MIN_USABLE_W, Math.min(maxW, d.startW - dx));
        setPanelSize({ width: newW, height: panelSize.height });
      }
    };

    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [panelSize, setPanelSize, rightOffset, anchorCenterY, topOverride]);

  // Compute final position: always centered on anchorCenterY, clamped to viewport
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const maxW = vw - rightOffset - MARGIN;
  const maxH = vh - MARGIN * 2;
  const isCompact = applyPhase === 'running' || applyPhase === 'done';

  let w: number;
  let h: number | undefined;
  let top: number;
  let right: number;

  if (isCompact && frozenPos) {
    // Fixed compact widget at frozen position
    w = 180;
    h = undefined; // auto height
    top = Math.max(MARGIN, Math.min(frozenPos.top, vh - 120));
    right = frozenPos.right;
  } else {
    // Full chat panel — use topOverride if set by resize, otherwise anchor-centered
    w = Math.max(MIN_USABLE_W, Math.min(panelSize.width, maxW));
    h = Math.max(MIN_USABLE_H, Math.min(panelSize.height, maxH));
    if (topOverride !== null) {
      top = Math.max(MARGIN, Math.min(topOverride, vh - h - MARGIN));
    } else {
      top = anchorCenterY - h / 2;
      if (top < MARGIN) top = MARGIN;
      if (top + h > vh - MARGIN) top = vh - h - MARGIN;
    }
    right = rightOffset;
  }

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: top,
        right: right,
        width: w,
        ...(h ? { height: h } : {}),
        zIndex: 10003,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1a1a1a',
        borderRadius: '10px',
        border: '1px solid #333',
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}
      onClick={(e) => {
        e.stopPropagation();
        // Close on backdrop click when done
        if (applyPhase === 'done') onClose();
      }}
    >
      {/* Resize handles — only in idle (chat) mode */}
      {applyPhase === 'idle' && <>
        <div onMouseDown={(e) => handleResizeStart('top', e)} style={{ position: 'absolute', top: -3, left: 8, right: 8, height: 6, cursor: 'ns-resize', zIndex: 1 }} />
        <div onMouseDown={(e) => handleResizeStart('bottom', e)} style={{ position: 'absolute', bottom: -3, left: 8, right: 8, height: 6, cursor: 'ns-resize', zIndex: 1 }} />
        <div onMouseDown={(e) => handleResizeStart('left', e)} style={{ position: 'absolute', top: 8, bottom: 8, left: -3, width: 6, cursor: 'ew-resize', zIndex: 1 }} />
      </>}
      {/* === DONE STATE === */}
      {applyPhase === 'done' && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          backgroundColor: 'rgba(34, 197, 94, 0.08)',
          borderRadius: '10px',
          padding: '24px',
          cursor: 'pointer',
        }}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          <Check size={28} color="#4ade80" />
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#4ade80' }}>Готово</span>
          {applyResult && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '12px', color: '#ddd' }}>
                Сокращено {applyResult.removedUsers || 0} сообщений
              </span>
              <span style={{ fontSize: '10px', color: '#666' }}>
                {applyResult.removedCount} записей всего
              </span>
            </div>
          )}
          <span style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
            Клик чтобы закрыть
          </span>
        </div>
      )}

      {/* === RUNNING STATE === */}
      {applyPhase === 'running' && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '24px',
        }}>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#ec4899', animation: 'bounce 1s infinite', animationDelay: '-0.3s' }} />
            <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#ec4899', animation: 'bounce 1s infinite', animationDelay: '-0.15s' }} />
            <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#ec4899', animation: 'bounce 1s infinite' }} />
          </div>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#ec4899' }}>Применение...</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
            {applySteps.map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {step.status === 'done' ? (
                  <Check size={12} color="#4ade80" />
                ) : step.status === 'active' ? (
                  <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #ec4899', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
                ) : (
                  <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #444' }} />
                )}
                <span style={{ fontSize: '11px', color: step.status === 'done' ? '#4ade80' : step.status === 'active' ? '#ec4899' : '#555' }}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* === IDLE STATE (chat) === */}
      {applyPhase === 'idle' && <>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid #333',
        backgroundColor: '#222',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#ec4899' }}>✂️ Edit Range</span>

          {/* Model select */}
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as AIModel)}
            style={{
              fontSize: '10px',
              backgroundColor: '#333',
              border: '1px solid #444',
              borderRadius: '4px',
              padding: '2px 4px',
              color: '#ccc',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {AI_MODELS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>

          {/* Thinking level */}
          {selectedModel.includes('gemini-3') && (
            <select
              value={thinkingLevel}
              onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
              style={{
                fontSize: '10px',
                backgroundColor: '#333',
                border: '1px solid #444',
                borderRadius: '4px',
                padding: '2px 4px',
                color: '#ccc',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              {THINKING_LEVELS.map(l => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          )}
        </div>

        <button
          onClick={onClose}
          style={{
            width: '22px', height: '22px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', color: '#666',
            cursor: 'pointer', borderRadius: '4px',
          }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Chat messages */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '8px' }}>
        {/* Collapsible source */}
        <div style={{
          marginBottom: '8px',
          borderRadius: '6px',
          border: '1px solid #333',
          overflow: 'hidden',
        }}>
          <button
            onClick={() => setSourceExpanded(!sourceExpanded)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 10px',
              backgroundColor: '#252525',
              border: 'none',
              cursor: 'pointer',
              color: '#888',
              fontSize: '11px',
            }}
          >
            <ChevronRight
              size={12}
              style={{
                transform: sourceExpanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s ease',
              }}
            />
            <span>Источник ({Math.round(sourceContent.length / 1024)}K)</span>
          </button>
          {sourceExpanded && (
            <div style={{
              padding: '8px 10px',
              backgroundColor: '#1e1e1e',
              maxHeight: '200px',
              overflowY: 'auto',
              fontSize: '11px',
              color: '#999',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {sourceContent.substring(0, 5000)}
              {sourceContent.length > 5000 && <span style={{ color: '#555' }}>... ({sourceContent.length} chars total)</span>}
            </div>
          )}
        </div>

        {/* Messages (skip first user = source) */}
        {messages.slice(1).map((msg) => (
          <div key={msg.id} style={{ marginBottom: '8px' }}>
            {msg.role === 'user' ? (
              <div style={{
                padding: '8px 10px',
                backgroundColor: '#2a2a2a',
                borderRadius: '6px',
                border: '1px solid #333',
                fontSize: '12px',
                color: '#ddd',
              }}>
                <span style={{ fontSize: '10px', color: '#888', fontWeight: 600 }}>You</span>
                <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap' }}>{msg.content}</div>
              </div>
            ) : (
              <div>
                <div style={{
                  padding: '8px 10px',
                  backgroundColor: '#1e1e1e',
                  borderRadius: '6px',
                  border: '1px solid rgba(168, 199, 250, 0.15)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                    <Sparkles size={10} color="#a8c7fa" />
                    <span style={{ fontSize: '10px', color: '#a8c7fa', fontWeight: 600 }}>Gemini</span>
                  </div>
                  {editingMsgId === msg.id ? (
                    <div>
                      <textarea
                        ref={editTextareaRef}
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { setEditingMsgId(null); }
                        }}
                        style={{
                          width: '100%',
                          minHeight: '80px',
                          backgroundColor: '#252525',
                          border: '1px solid #444',
                          borderRadius: '4px',
                          padding: '6px 8px',
                          fontSize: '12px',
                          color: '#ddd',
                          lineHeight: 1.5,
                          resize: 'vertical',
                          fontFamily: 'monospace',
                          outline: 'none',
                        }}
                      />
                      <div style={{ display: 'flex', gap: '4px', marginTop: '4px', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => setEditingMsgId(null)}
                          style={{ padding: '2px 8px', fontSize: '10px', backgroundColor: '#333', border: '1px solid #444', borderRadius: '3px', color: '#aaa', cursor: 'pointer' }}
                        >Отмена</button>
                        <button
                          onClick={() => {
                            setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, content: editingText } : m));
                            setEditingMsgId(null);
                          }}
                          style={{ padding: '2px 8px', fontSize: '10px', backgroundColor: 'rgba(168, 199, 250, 0.15)', border: '1px solid rgba(168, 199, 250, 0.3)', borderRadius: '3px', color: '#a8c7fa', cursor: 'pointer' }}
                        >Сохранить</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: '#ddd', lineHeight: 1.5 }}>
                      {msg.content ? <MarkdownRenderer content={msg.content} /> : <span style={{ color: '#555', fontStyle: 'italic' }}>Пустой ответ — нажмите ✏ чтобы написать свой текст</span>}
                    </div>
                  )}
                </div>
                {/* Edit/Copy buttons under Gemini response */}
                {editingMsgId !== msg.id && (
                  <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end', marginTop: '3px' }}>
                    <button
                      onClick={() => {
                        const { clipboard } = window.require('electron');
                        clipboard.writeText(msg.content);
                        showToast('Скопировано', 'info', 1500);
                      }}
                      style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px', color: '#666', background: 'none', border: 'none', cursor: 'pointer', borderRadius: '3px' }}
                      title="Копировать"
                      className="hover:bg-white/5 hover:text-white/60"
                    >
                      <Copy size={10} />
                    </button>
                    <button
                      onClick={() => {
                        setEditingMsgId(msg.id);
                        setEditingText(msg.content);
                        setTimeout(() => editTextareaRef.current?.focus(), 50);
                      }}
                      style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px', color: '#666', background: 'none', border: 'none', cursor: 'pointer', borderRadius: '3px' }}
                      title="Редактировать ответ"
                      className="hover:bg-white/5 hover:text-white/60"
                    >
                      <Pencil size={10} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Loading */}
        {isLoading && (
          <div style={{
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: 'rgba(59, 130, 246, 0.05)',
            borderTop: '1px solid rgba(59, 130, 246, 0.1)',
            borderBottom: '1px solid rgba(59, 130, 246, 0.1)',
          }}>
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-glow-blue" />
            <span style={{ fontSize: '11px', color: '#a8c7fa', fontWeight: 'bold', letterSpacing: '0.05em' }}>THINKING...</span>
            <div style={{ display: 'flex', gap: '3px', marginLeft: 'auto' }}>
              <div style={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: '#a8c7fa', animation: 'bounce 1s infinite', animationDelay: '-0.3s' }} />
              <div style={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: '#a8c7fa', animation: 'bounce 1s infinite', animationDelay: '-0.15s' }} />
              <div style={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: '#a8c7fa', animation: 'bounce 1s infinite' }} />
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input + actions */}
      <div style={{
        borderTop: '1px solid #333',
        backgroundColor: '#222',
        flexShrink: 0,
        padding: '8px',
      }}>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Поправить..."
            disabled={isLoading}
            rows={1}
            style={{
              flex: 1,
              backgroundColor: '#2a2a2a',
              border: '1px solid #444',
              borderRadius: '6px',
              padding: '6px 10px',
              fontSize: '12px',
              color: '#ddd',
              resize: 'none',
              outline: 'none',
              minHeight: '32px',
              maxHeight: '120px',
            }}
          />

          {isLoading ? (
            <button
              onClick={handleCancel}
              style={{
                height: '32px', padding: '0 10px',
                backgroundColor: '#dc2626',
                border: 'none', borderRadius: '6px',
                fontSize: '11px', fontWeight: 600,
                color: '#fff', cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              style={{
                height: '32px', padding: '0 10px',
                backgroundColor: inputValue.trim() ? '#3b82f6' : '#444',
                border: 'none', borderRadius: '6px',
                fontSize: '11px', fontWeight: 600,
                color: '#fff',
                cursor: inputValue.trim() ? 'pointer' : 'not-allowed',
                flexShrink: 0,
                opacity: inputValue.trim() ? 1 : 0.5,
              }}
            >
              Send
            </button>
          )}
        </div>

        {/* OK button */}
        <button
          onClick={handleApply}
          disabled={!lastAssistant || isLoading}
          style={{
            width: '100%',
            marginTop: '6px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            backgroundColor: lastAssistant && !isLoading ? 'rgba(34, 197, 94, 0.15)' : '#333',
            border: `1px solid ${lastAssistant && !isLoading ? 'rgba(34, 197, 94, 0.4)' : '#444'}`,
            borderRadius: '6px',
            color: lastAssistant && !isLoading ? '#4ade80' : '#666',
            fontSize: '12px',
            fontWeight: 600,
            cursor: lastAssistant && !isLoading ? 'pointer' : 'not-allowed',
            transition: 'all 0.15s ease',
          }}
        >
          <Check size={14} />
          Применить
        </button>
      </div>
      </>}
    </div>,
    document.body
  );
}
