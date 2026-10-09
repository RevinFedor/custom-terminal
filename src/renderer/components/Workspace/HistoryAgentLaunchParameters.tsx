import React from 'react';

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

export default function HistoryAgentLaunchParameters({ settings, taskLabel }: {
  settings: SubagentLaunchSettings | null;
  taskLabel: string;
}) {
  const model = settings?.model || null;
  const effort = settings?.effort || null;
  const title = [taskLabel, 'Параметры запуска',
    !model ? 'Модель не подтверждена' : model,
    !effort ? 'Effort не подтверждён' : effort].join(' · ');
  return <span data-history-agent-launch-parameters title={title}
    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
    <span data-history-agent-launch-model className="truncate" style={{ color: model ? '#bdbdbd' : '#777' }}>
      {model || 'Модель —'}
    </span>
    <span aria-hidden="true" style={{ color: '#555' }}>·</span>
    <span data-history-agent-launch-effort style={{ color: effort ? '#999' : '#777', whiteSpace: 'nowrap' }}>
      {effort || 'effort —'}
    </span>
  </span>;
}
