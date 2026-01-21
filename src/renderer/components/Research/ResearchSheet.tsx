import React, { useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useResearchStore } from '../../store/useResearchStore';
import { useUIStore } from '../../store/useUIStore';
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

export default function ResearchSheet({ projectId }: ResearchSheetProps) {
  const { isOpen, closeResearch, getActiveConversation, deleteConversation } = useResearchStore();
  const { selectedModel, setSelectedModel } = useUIStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
