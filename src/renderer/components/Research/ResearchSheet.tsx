import React, { useRef, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useResearchStore } from '../../store/useResearchStore';
import { useUIStore, ThinkingLevel } from '../../store/useUIStore';
import ChatArea from './ChatArea';
import ResearchInput from './ResearchInput';

interface ResearchSheetProps {
  projectId: string;
}

const AI_MODELS = [
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' }
] as const;

const THINKING_LEVELS = [
  { value: 'NONE', label: 'Off' },
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Med' },
  { value: 'HIGH', label: 'High' }
] as const;

export default function ResearchSheet({ projectId }: ResearchSheetProps) {
  const { isOpen, closeResearch, getActiveConversation, deleteConversation } = useResearchStore();
  const { selectedModel, setSelectedModel, thinkingLevel, setThinkingLevel } = useUIStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [showSettings, setShowSettings] = useState(false);

  const conversation = getActiveConversation(projectId);
  const messages = conversation?.messages || [];

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
                <span style={{ fontSize: '14px', fontWeight: 500, color: '#fff' }}>Research</span>

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
                {conversation && (
                  <button
                    onClick={() => deleteConversation(projectId, conversation.id)}
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
              <ChatArea projectId={projectId} />
            </div>

            {/* Input Area */}
            <div style={{ borderTop: '1px solid #333', backgroundColor: '#222', flexShrink: 0 }}>
              <ResearchInput projectId={projectId} inputRef={inputRef} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
