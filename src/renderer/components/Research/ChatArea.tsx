import React from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useResearchStore, Message } from '../../store/useResearchStore';

interface ChatAreaProps {
  projectId: string;
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      padding: '12px 20px',
      backgroundColor: isUser ? 'rgba(255,255,255,0.03)' : 'transparent'
    }}>
      <div style={{ display: 'flex', gap: '12px' }}>
        {/* Avatar */}
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          fontWeight: 500,
          flexShrink: 0,
          backgroundColor: isUser ? 'rgba(59,130,246,0.2)' : 'rgba(34,197,94,0.2)',
          color: isUser ? '#60a5fa' : '#4ade80'
        }}>
          {isUser ? 'U' : 'AI'}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>
            {isUser ? 'You' : 'Assistant'}
            <span style={{ marginLeft: '8px', opacity: 0.5 }}>
              {new Date(message.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          </div>
          <div style={{
            fontSize: '13px',
            color: '#e5e5e5',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.5
          }}>
            {message.content}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#666',
      padding: '0 32px'
    }}>
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>Нет сообщений</div>
      <div style={{ fontSize: '12px', textAlign: 'center', maxWidth: '280px' }}>
        Напиши что-нибудь или выдели текст в терминале и нажми Research.
      </div>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div style={{ padding: '12px 20px' }}>
      <div style={{ display: 'flex', gap: '12px' }}>
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          backgroundColor: 'rgba(34,197,94,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          fontWeight: 500,
          color: '#4ade80'
        }}>
          AI
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>Assistant</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '6px', height: '6px', backgroundColor: '#666', borderRadius: '50%', animation: 'bounce 1s infinite', animationDelay: '0ms' }} />
            <span style={{ width: '6px', height: '6px', backgroundColor: '#666', borderRadius: '50%', animation: 'bounce 1s infinite', animationDelay: '150ms' }} />
            <span style={{ width: '6px', height: '6px', backgroundColor: '#666', borderRadius: '50%', animation: 'bounce 1s infinite', animationDelay: '300ms' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatArea({ projectId }: ChatAreaProps) {
  const { getActiveConversation, isLoading } = useResearchStore();
  const conversation = getActiveConversation(projectId);
  const messages = conversation?.messages || [];

  if (messages.length === 0 && !isLoading) {
    return <EmptyState />;
  }

  return (
    <Virtuoso
      style={{ height: '100%' }}
      data={messages}
      initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
      followOutput="auto"
      itemContent={(_, message) => <MessageBubble message={message} />}
      components={{
        Footer: () => (isLoading ? <LoadingIndicator /> : null)
      }}
    />
  );
}
