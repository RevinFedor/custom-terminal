import React from 'react';

// Shared visual row for microphone recording and background history operations.
// Navigation belongs to the supplied owner callback, never to the active tab.
export default function BackgroundTabOperationChip({ label, tabName, pending = true,
  failed = false, completed = false, details, onOpen, onDismiss }: {
  label: string;
  tabName: string;
  pending?: boolean;
  failed?: boolean;
  completed?: boolean;
  details?: string;
  onOpen: (event: React.MouseEvent) => void;
  onDismiss?: () => void;
}) {
  const color = completed ? '#4ade80' : failed ? '#f87171' : '#FF9466';
  const shortName = tabName.length > 15 ? tabName.slice(0, 14) + '…' : tabName;
  return <div className="pointer-events-auto flex items-center gap-2 rounded-lg shadow-lg backdrop-blur-sm animate-slide-in"
    data-background-tab-operation={label}
    data-background-tab-operation-state={completed ? 'completed' : failed ? 'failed' : pending ? 'pending' : 'idle'}
    title={details}
    style={{ minHeight: 30, padding: '6px 10px', background: 'rgba(20,20,20,0.94)',
      border: `1px solid ${completed ? 'rgba(74,222,128,0.50)' : failed ? 'rgba(248,113,113,0.45)' : 'rgba(218,119,86,0.45)'}`,
      color: '#e8e8e8', fontSize: 12 }}>
    {pending ? <span aria-hidden className="noted-infinite-animation" style={{ width: 12, height: 12, borderRadius: '50%',
      border: '2px solid rgba(218,119,86,0.25)', borderTopColor: '#DA7756',
      animation: 'background-tab-operation-spin 0.9s linear infinite', flexShrink: 0 }} />
      : <span aria-hidden style={{ color }}>{failed ? '!' : '✓'}</span>}
    <span style={{ color, fontWeight: 700, letterSpacing: 0.4, fontSize: 10 }}>{label}</span>
    <button onClick={onOpen} title={tabName} style={{ maxWidth: 128, overflow: 'hidden',
      textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'transparent', border: 'none',
      color: '#fff', padding: 0, fontSize: 12, fontWeight: 650, cursor: 'pointer',
      textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.35)', textUnderlineOffset: 3 }}>
      {shortName}
    </button>
    {onDismiss && <button aria-label="Скрыть результат операции" onClick={event => {
      event.stopPropagation(); onDismiss();
    }} style={{ border: 0, background: 'transparent', color: '#aaa', cursor: 'pointer', padding: '0 3px' }}>×</button>}
    <style>{'@keyframes background-tab-operation-spin { to { transform: rotate(360deg); } }'}</style>
  </div>;
}
