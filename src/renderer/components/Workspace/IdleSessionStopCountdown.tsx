import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { hydrateIdleSessionStopStore, useIdleSessionStopStore } from '../../store/useIdleSessionStopStore';
import { CONTEXT_MENU_ROW_STYLE } from '../UI/contextMenuMetrics.mjs';

// Mounted only inside an open menu. This clock paints seconds; Main owns the
// actual deadline and process Stop regardless of menus, focus or renderer.
export function IdleSessionStopCountdown({ tabId }: { tabId: string }) {
  const state = useIdleSessionStopStore(store => store.states[tabId]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { void hydrateIdleSessionStopStore(); }, []);
  useEffect(() => {
    if (!state?.deadline) return;
    setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.deadline]);
  if (!state) return null;
  const seconds = Math.max(0, Math.ceil(((state.deadline || now) - now) / 1000));
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const label = state.phase === 'scheduled' ? remaining : state.phase === 'busy' ? 'после ответа'
    : state.phase === 'inactive' ? 'остановлен' : state.phase === 'checking' ? 'проверка…'
      : state.error === 'idle_stop_draft_pending' ? 'есть черновик'
        : state.error === 'idle_stop_continuation_pending' ? 'ожидает очередь' : 'ожидание';
  return <div data-idle-stop-countdown={tabId}
    style={{ ...CONTEXT_MENU_ROW_STYLE, display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #39393c',
      color: '#999', fontSize: 11, cursor: 'default' }}><Timer size={13} />
    <span>Auto-stop</span><span style={{ marginLeft: 'auto', color: '#b7a3e7', fontVariantNumeric: 'tabular-nums' }}>{label}</span>
  </div>;
}
