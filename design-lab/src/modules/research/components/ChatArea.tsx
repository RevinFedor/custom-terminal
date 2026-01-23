import { useRef, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useResearchStore, Message } from '../store/useResearchStore';
import MarkdownRenderer from './MarkdownRenderer';
import { Bot, User, Sparkles, Copy, Check, ArrowDown, RefreshCw } from 'lucide-react';

// ============================================================================
// MESSAGE BUBBLE
// ============================================================================
function MessageBubble({
  message,
  isLast,
  onRegenerate,
}: {
  message: Message;
  isLast: boolean;
  onRegenerate?: () => void;
}) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`group mx-4 my-4 rounded-xl border border-transparent transition-all ${
        isUser ? 'bg-[#1e1f20] border-[#333]' : 'bg-[#131314] border-[#333]/50'
      }`}
    >
      <div className="px-5 py-5">
        <div className="flex gap-5 max-w-5xl mx-auto relative">
          {/* Avatar */}
          <div
            className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center border shadow-sm ${
              isUser
                ? 'bg-[#2a2a2a] border-[#444] text-gray-400'
                : 'bg-[#a8c7fa]/10 border-[#a8c7fa]/20 text-[#a8c7fa]'
            }`}
          >
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
                    minute: '2-digit',
                  })}
                </span>
              </div>
            </div>

            <div className="relative group/content">
              <MarkdownRenderer content={message.content} />

              {/* Footer Actions (Bot Only) */}
              {!isUser && (
                <div className="flex items-center gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-2 py-1 text-gray-500 hover:text-white hover:bg-[#333] rounded text-[11px] transition-colors"
                    title="Copy response"
                  >
                    {copied ? (
                      <Check size={14} className="text-green-400" />
                    ) : (
                      <Copy size={14} />
                    )}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>

                  {isLast && onRegenerate && (
                    <button
                      onClick={onRegenerate}
                      className="flex items-center gap-1.5 px-2 py-1 text-gray-500 hover:text-[#a8c7fa] hover:bg-[#333] rounded text-[11px] transition-colors"
                      title="Regenerate response"
                    >
                      <RefreshCw size={14} />
                      <span>Retry</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================
function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-[#131314]">
      <div className="w-16 h-16 bg-[#1e1f20] rounded-[24px] flex items-center justify-center mb-8 border border-[#333] shadow-2xl">
        <Sparkles size={32} className="text-[#a8c7fa]" />
      </div>
      <h3 className="text-xl font-semibold text-white mb-3 tracking-tight">
        Design Lab - Research Chat
      </h3>
      <p className="text-sm text-gray-500 max-w-sm leading-relaxed mb-10">
        Тестовая среда для отладки AI чата. Введи API ключ и начни диалог.
      </p>
    </div>
  );
}

// ============================================================================
// LOADING INDICATOR
// ============================================================================
function LoadingIndicator() {
  return (
    <div className="px-6 py-8 border-b border-transparent">
      <div className="flex gap-6 max-w-5xl mx-auto">
        <div className="shrink-0 w-8 h-8 rounded-full bg-[#a8c7fa]/10 border border-[#a8c7fa]/20 flex items-center justify-center text-[#a8c7fa]">
          <Sparkles size={16} className="animate-pulse" />
        </div>
        <div className="flex-1 py-1">
          <div className="flex items-center gap-3 h-6">
            <span className="text-[13px] text-[#a8c7fa] font-semibold">
              Gemini is thinking...
            </span>
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

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export default function ChatArea({ onRegenerate }: { onRegenerate?: () => void }) {
  const { messages, isLoading } = useResearchStore();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

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
            isLast={index === messages.length - 1 && message.role === 'assistant'}
            onRegenerate={onRegenerate}
          />
        )}
        components={{
          Footer: () => (isLoading ? <LoadingIndicator /> : <div className="h-10" />),
        }}
      />

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <button
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end' })
          }
          className="absolute bottom-10 right-10 p-3 bg-[#1e1f20] hover:bg-[#333] text-[#a8c7fa] rounded-full shadow-2xl border border-[#333] transition-all z-10 scale-110 active:scale-95"
        >
          <ArrowDown size={20} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}
