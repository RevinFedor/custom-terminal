import React from 'react';

/** Absolute launch time: opening/reopening the Inspector never becomes a start. */
function HistoryAgentLaunchTimestamp({ startedAt }: { startedAt: number }) {
  const date = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0
    ? new Date(startedAt) : null;
  const known = date && Number.isFinite(date.getTime());
  const pad = (value: number) => String(value).padStart(2, '0');
  const label = known
    ? `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : '';
  const style: React.CSSProperties = {
    color: '#888', fontSize: '0.9em', fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap', flexShrink: 0,
  };
  return known ? <time data-history-agent-started-at dateTime={date.toISOString()}
    aria-label={`Запущен ${label}, местное время`}
    title={`Время запуска: ${date.toLocaleString()} (местное время)`} style={style}>
    Старт {label}
  </time> : <span data-history-agent-started-at="unknown"
    aria-label="Время запуска неизвестно" style={style}>Старт —</span>;
}

export default React.memo(HistoryAgentLaunchTimestamp);
