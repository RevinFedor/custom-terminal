import React from 'react';
import { Zap } from 'lucide-react';

export interface SubagentLaunchSettings {
  version: 1;
  provider: 'claude' | 'codex';
  sessionId: string | null;
  source: 'subagent-started' | 'own-turn-context' | 'own-assistant';
  model: string | null;
  effort: string | null;
  timestamp: string | null;
  callId?: string;
}

export interface SubagentLaunchServiceTier {
  version: 1;
  provider: 'codex';
  sessionId: string;
  source: 'own-thread-settings';
  serviceTier: 'priority' | 'default' | null;
  timestamp: string | null;
}

export default function HistoryAgentLaunchParameters({ settings, taskLabel, provider = settings?.provider, serviceTier = null, loading = false }: {
  settings: SubagentLaunchSettings | null;
  taskLabel: string;
  provider?: string;
  serviceTier?: SubagentLaunchServiceTier | null;
  loading?: boolean;
}) {
  const model = settings?.model || null;
  const effort = settings?.effort || null;
  const showFast = provider === 'codex';
  const tier = showFast && serviceTier?.version === 1 && serviceTier.provider === 'codex'
    && serviceTier.source === 'own-thread-settings'
    && (!settings?.sessionId || settings.sessionId === serviceTier.sessionId)
      ? serviceTier.serviceTier : null;
  const fastLabel = tier === 'priority' ? 'Fast' : tier === 'default' ? 'Fast выкл.' : 'Fast —';
  const modelLoading = loading && !model;
  const effortLoading = loading && !effort;
  const fastLoading = loading && showFast && tier === null;
  const skeleton = (field: string, label: string, width: number) => <span
    data-history-agent-launch-loading={field} role="status" aria-label={label}
    style={{ display: 'inline-block', width, height: 8, borderRadius: 2,
      background: '#343434', verticalAlign: 'middle', flexShrink: 0 }} />;
  const title = [taskLabel, 'Параметры запуска',
    modelLoading ? 'Модель загружается' : !model ? 'Модель не подтверждена' : model,
    effortLoading ? 'Effort загружается' : !effort ? 'Effort не подтверждён' : effort,
    ...(showFast ? [fastLoading ? 'Fast загружается' : tier ? fastLabel : 'Fast при запуске не подтверждён'] : [])].join(' · ');
  return <span data-history-agent-launch-parameters title={title}
    aria-busy={modelLoading || effortLoading || fastLoading || undefined}
    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto' }}>
    <span data-history-agent-launch-model className="truncate" style={{ color: model ? '#bdbdbd' : '#777' }}>
      {modelLoading ? skeleton('model', 'Модель загружается', 68) : model || 'Модель —'}
    </span>
    <span aria-hidden="true" style={{ color: '#555' }}>·</span>
    <span data-history-agent-launch-effort style={{ color: effort ? '#999' : '#777', whiteSpace: 'nowrap' }}>
      {effortLoading ? skeleton('effort', 'Effort загружается', 24) : effort || 'effort —'}
    </span>
    {showFast && <>
      <span aria-hidden="true" style={{ color: '#555' }}>·</span>
      <span data-history-agent-launch-fast={fastLoading ? 'loading' : tier || 'unknown'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap',
          color: tier === 'priority' ? '#f59e0b' : tier === 'default' ? '#999' : '#777' }}>
        {tier === 'priority' && <Zap size={11} aria-hidden="true" style={{ flexShrink: 0 }} />}
        {fastLoading ? <>Fast {skeleton('fast', 'Fast загружается', 14)}</> : fastLabel}
      </span>
    </>}
  </span>;
}
