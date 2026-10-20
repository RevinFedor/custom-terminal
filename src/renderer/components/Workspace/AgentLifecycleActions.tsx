import React from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { AgentLifecycleSummary } from './agentLifecycleSummary';

// Controls share the caption's baseline and colour, without nested warning
// boxes or button text that can wrap below a small composer annotation.
export default function AgentLifecycleActions({ lifecycle }: { lifecycle: AgentLifecycleSummary | null }) {
  if (!lifecycle || !['error', 'warning', 'info'].includes(lifecycle.kind)) return null;
  const style: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, padding: 0, margin: 0, flexShrink: 0,
    border: 0, background: 'transparent', color: lifecycle.kind === 'info' ? '#60a5fa' : lifecycle.kind === 'warning' ? '#fbbf24' : '#ef4444', lineHeight: 0,
    cursor: 'pointer', pointerEvents: 'auto',
  };
  return <>
    {lifecycle.goalActions && (['resume', 'leave-paused'] as const).map(action => {
      const goal = lifecycle.goalActions!;
      const allowed = !!goal.onChoose && goal.availableActions.includes(action);
      const label = action === 'resume' ? 'Resume Goal' : 'Leave paused';
      return <button key={action} type="button" data-codex-goal-action={action}
        disabled={!allowed} aria-label={label}
        title={allowed ? label : 'Main пока не разрешает этот выбор'}
        style={{ ...style, width: 'auto', padding: '0 3px', lineHeight: 'inherit',
          font: 'inherit', whiteSpace: 'nowrap', opacity: allowed ? 1 : 0.5,
          cursor: allowed ? 'pointer' : 'default' }}
        onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); if (allowed) goal.onChoose?.(action); }}
      >{label}</button>;
    })}
    {lifecycle.goalActions?.onRefresh && <button type="button" data-codex-goal-read
      aria-label="Проверить статус Goal" title="Проверить статус Goal" style={style}
      onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
      onClick={event => { event.preventDefault(); event.stopPropagation(); lifecycle.goalActions?.onRefresh?.(); }}
    ><RefreshCw size={12} aria-hidden style={{ display: 'block' }} /></button>}
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
