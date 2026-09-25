import React from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { AgentLifecycleSummary } from './agentLifecycleSummary';

// Controls share the caption's baseline and colour, without nested warning
// boxes or button text that can wrap below a small composer annotation.
export default function AgentLifecycleActions({ lifecycle }: { lifecycle: AgentLifecycleSummary | null }) {
  if (!lifecycle || !['error', 'warning'].includes(lifecycle.kind)) return null;
  const style: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, padding: 0, margin: 0, flexShrink: 0,
    border: 0, background: 'transparent', color: lifecycle.kind === 'warning' ? '#fbbf24' : '#ef4444', lineHeight: 0,
    cursor: 'pointer', pointerEvents: 'auto',
  };
  return <>
    {lifecycle.kind === 'error' && lifecycle.onRetry && <button
      type="button" data-agent-lifecycle-retry
      aria-label={lifecycle.retryLabel || 'Retry settings'}
      title={lifecycle.retryLabel || 'Retry settings'} style={style}
      onMouseDown={event => event.preventDefault()}
      onClick={event => { event.preventDefault(); event.stopPropagation(); lifecycle.onRetry?.(); }}
    ><RefreshCw size={12} aria-hidden style={{ display: 'block' }} /></button>}
    {lifecycle.onDismiss && <button
      type="button" data-agent-lifecycle-dismiss
      aria-label={lifecycle.dismissLabel || 'Dismiss'}
      title={lifecycle.dismissLabel || 'Dismiss'} style={style}
      onMouseDown={event => event.preventDefault()}
      onClick={event => { event.preventDefault(); event.stopPropagation(); lifecycle.onDismiss?.(); }}
    ><X size={12} aria-hidden style={{ display: 'block' }} /></button>}
  </>;
}
