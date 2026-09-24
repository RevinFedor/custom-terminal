import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { historyPreparationStatus, selectHistoryPreparation } from '../../utils/historyPreparationStatus.mjs';

// Kept below HistoryPanel: progress must not rebuild the large transcript or
// subscribe retained rows. This component exists only while its loader does.
export default function HistoryLoadingStatus({ toolType, sessionId, cwd, children }: {
  toolType: string; sessionId?: string | null; cwd?: string | null; children: React.ReactNode;
}) {
  const store = historyPreparationStatus();
  const getSnapshot = useCallback(() => selectHistoryPreparation(store.getSnapshot(), {
    toolType, sessionId, cwd,
  }), [store, toolType, sessionId, cwd]);
  const operation = useSyncExternalStore(store.subscribe, getSnapshot);
  const owner = JSON.stringify([toolType, sessionId, cwd || '']);
  const seen = useRef<{ owner: string; operation: string | null }>({ owner, operation: null });
  if (seen.current.owner !== owner) seen.current = { owner, operation: null };
  if (operation) seen.current.operation = operation.id;
  const [slowOwner, setSlowOwner] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSlowOwner(owner), 1000);
    return () => clearTimeout(timer);
  }, [owner]);
  const detailed = slowOwner === owner || (operation && Date.now() - operation.startedAt >= 1000);
  const reading = detailed && operation?.phase === 'reading';
  const preparing = detailed && (operation?.phase === 'preparing' || (!operation && seen.current.operation));
  const percent = reading ? Math.floor(operation.completedBytes * 100 / operation.totalBytes) : null;
  return (
    <div data-history-loading-status style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {children}
        <span>{reading ? `Чтение истории · ${percent}%` : preparing ? 'Подготовка отображения…' : 'Loading...'}</span>
      </div>
      {reading && <>
        <div role="progressbar" aria-label="Чтение истории" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={percent!} style={{ width: 200, maxWidth: '100%', height: 3, borderRadius: 2, background: '#333345', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${percent}%`, background: '#818cf8' }} />
        </div>
        <span style={{ fontSize: 11, color: '#8888a0', fontVariantNumeric: 'tabular-nums' }}>
          {Math.floor(operation.completedBytes / 1048576)} / {Math.ceil(operation.totalBytes / 1048576)} МБ
        </span>
      </>}
    </div>
  );
}
