import React, { useState, useRef } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useResearchStore, Message } from '../../store/useResearchStore';
import MarkdownRenderer from './MarkdownRenderer';
import { User, Sparkles, Pencil, Copy, Check, ArrowDown, RotateCcw, RefreshCw, Trash2 } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';

// Google AI Studio Inspired Colors
const COLORS = {
  bg: '#131314',
  surface: '#1e1f20',
  border: '#333333',
  text: '#e3e3e3',
  textMuted: '#9aa0a6',
  accent: '#a8c7fa', // Light blue accent
  userBg: 'transparent',
  botBg: 'rgba(255, 255, 255, 0.02)'
};

function MessageBubble({
  message,
  projectId,
  projectPath,
  onEdit,
  onRetry,
  onDelete
}: {
  message: Message,
  projectId: string,
  projectPath: string,
  onEdit: (msg: Message, newContent: string) => void,
  onRetry: (messageId: string) => void,
  onDelete: (messageId: string) => void
}) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveEdit = () => {
    onEdit(message, editContent);
    setIsEditing(false);
  };

  return (
    <div className={`group mx-4 my-4 rounded-xl border border-transparent transition-all ${
      isUser 
        ? 'bg-[#1e1f20] border-[#333]' 
        : 'bg-[#131314] border-[#333]/50' // Darker for bot, subtle border
    }`}>
      <div className="px-5 py-5">
        <div className="flex gap-5 max-w-5xl mx-auto relative">
        {/* Avatar */}
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center border shadow-sm ${
          isUser 
            ? 'bg-[#2a2a2a] border-[#444] text-gray-400' 
            : 'bg-[#a8c7fa]/10 border-[#a8c7fa]/20 text-[#a8c7fa]'
        }`}>
          {isUser ? <User size={16} /> : <Sparkles size={16} />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-3">
              <span className="text-[13px] font-semibold text-white tracking-tight">
                {isUser ? 'You' : 'Gemini'}
              </span>
              <span className="text-[10px] text-gray-500 font-mono">
                {new Date(message.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </div>
            
            {/* User Edit Action (Top Right) */}
            {isUser && (
              <button 
                onClick={() => setIsEditing(true)}
                className="p-1.5 text-gray-500 hover:text-white hover:bg-[#333] rounded transition-colors opacity-0 group-hover:opacity-100"
                title="Edit & Resend"
              >
                <Pencil size={14} />
              </button>
            )}
          </div>
          
          {isEditing ? (
            <div className="mt-2">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full min-h-[300px] bg-[#0c0c0c] border border-[#333] rounded-lg p-4 text-[13px] text-gray-200 focus:outline-none focus:border-[#a8c7fa]/50 font-mono resize-y leading-relaxed"
              />
              <div className="flex justify-end gap-3 mt-3">
                <button 
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-1.5 text-[11px] font-medium text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleSaveEdit}
                  className="px-4 py-1.5 bg-[#a8c7fa] hover:bg-[#c2d7f8] text-[#000] text-[11px] font-bold rounded-full transition-colors flex items-center gap-2"
                >
                  <RotateCcw size={13} />
                  Save & Resend
                </button>
              </div>
            </div>
          ) : (
            <div className="relative">
              {/* Sticky Actions - правый верхний угол */}
              <div className="sticky top-4 float-right ml-4 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-[#1a1a1a] border border-[#333] rounded-lg p-1">
                <button
                  onClick={handleCopy}
                  className="p-1.5 text-gray-500 hover:text-white hover:bg-[#333] rounded transition-colors cursor-pointer"
                  title="Copy"
                >
                  {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                </button>

                {/* Retry - только для assistant */}
                {!isUser && (
                  <button
                    onClick={() => onRetry(message.id)}
                    className="p-1.5 text-gray-500 hover:text-[#a8c7fa] hover:bg-[#333] rounded transition-colors cursor-pointer"
                    title="Retry (regenerate from this point)"
                  >
                    <RefreshCw size={14} />
                  </button>
                )}

                {/* Delete */}
                <button
                  onClick={() => onDelete(message.id)}
                  className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-[#333] rounded transition-colors cursor-pointer"
                  title="Delete message"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <MarkdownRenderer content={message.content} />
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-[#131314]">
      <div className="w-16 h-16 bg-[#1e1f20] rounded-[24px] flex items-center justify-center mb-8 border border-[#333] shadow-2xl">
        <Sparkles size={32} className="text-[#a8c7fa]" />
      </div>
      <h3 className="text-xl font-semibold text-white mb-3 tracking-tight">AI Research Assistant</h3>
      <p className="text-sm text-gray-500 max-w-sm leading-relaxed mb-10">
        Choose a model and select code in the terminal to start an analysis or ask any question.
      </p>
      
      <div className="flex gap-4">
        <div className="flex flex-col items-center gap-2">
          <div className="px-4 py-2 bg-[#1e1f20] border border-[#333] rounded-xl text-[11px] text-[#a8c7fa] font-bold shadow-sm">
            CMD + SHIFT + E
          </div>
          <span className="text-[10px] text-gray-600 uppercase font-bold tracking-widest font-mono">Open Panel</span>
        </div>
      </div>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div className="px-6 py-8 border-b border-transparent">
      <div className="flex gap-6 max-w-5xl mx-auto">
        <div className="shrink-0 w-8 h-8 rounded-full bg-[#a8c7fa]/10 border border-[#a8c7fa]/20 flex items-center justify-center text-[#a8c7fa]">
          <Sparkles size={16} className="text-blue-400 animate-glow-blue" />
          <span className="text-blue-400 font-bold uppercase tracking-widest">AI is thinking...</span>
        </div>
        <div className="flex-1 py-1">
          <div className="flex items-center gap-3 h-6">
            <span className="text-[13px] text-[#a8c7fa] font-semibold">Gemini is thinking...</span>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-[#a8c7fa] rounded-full animate-bounce [animation-delay:-0.3s]"></div>
              <div className="w-1.5 h-1.5 bg-[#a8c7fa] rounded-full animate-bounce [animation-delay:-0.15s]"></div>
              <div className="w-1.5 h-1.5 bg-[#a8c7fa] rounded-full animate-bounce"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ChatAreaProps {
  projectId: string;
  projectPath: string;
  onRetry?: (messageId: string) => void;
}

export default function ChatArea({ projectId, projectPath, onRetry }: ChatAreaProps) {
  const { getActiveConversation, isLoading, editMessage, deleteMessage, truncateFromMessage } = useResearchStore();
  const conversation = getActiveConversation(projectId);
  const messages = conversation?.messages || [];
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const handleEdit = (message: Message, newContent: string) => {
    editMessage(projectId, projectPath, message.id, newContent);
    // After edit, parent should handle the API call via onRetry
    if (onRetry) {
      // Find the message that was just edited (it's the last one now after truncation)
      setTimeout(() => {
        const updatedConv = getActiveConversation(projectId);
        const lastMsg = updatedConv?.messages[updatedConv.messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          onRetry(lastMsg.id);
        }
      }, 50);
    }
  };

  const handleRetry = (messageId: string) => {
    // Truncate from this assistant message (removes it and everything after)
    truncateFromMessage(projectId, projectPath, messageId);
    // Then call parent's retry handler
    if (onRetry) {
      onRetry(messageId);
    }
  };

  const handleDelete = (messageId: string) => {
    deleteMessage(projectId, projectPath, messageId);
  };

  if (messages.length === 0 && !isLoading) {
    return <EmptyState />;
  }

  return (
    <div className="h-full bg-[#131314] relative group/chat overflow-hidden">
      <Virtuoso
        ref={virtuosoRef}
        style={{ height: '100%' }}
        data={messages}
        initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
        followOutput="auto"
        atBottomStateChange={(atBottom) => setShowScrollButton(!atBottom)}
        itemContent={(index, message) => (
          <MessageBubble
            message={message}
            projectId={projectId}
            projectPath={projectPath}
            onEdit={handleEdit}
            onRetry={handleRetry}
            onDelete={handleDelete}
          />
        )}
        components={{
          Footer: () => (isLoading ? <LoadingIndicator /> : <div className="h-10" />)
        }}
      />
      
      {/* Scroll to bottom button */}
      {showScrollButton && (
        <button
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end' })}
          className="absolute bottom-10 right-10 p-3 bg-[#1e1f20] hover:bg-[#333] text-[#a8c7fa] rounded-full shadow-2xl border border-[#333] transition-all z-10 scale-110 active:scale-95"
        >
          <ArrowDown size={20} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}