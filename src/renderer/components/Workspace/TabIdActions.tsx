import React, { useRef } from 'react';
import { Clock3, Copy, Plus } from 'lucide-react';
import voiceRecordIcon from '../../assets/icons/voice-record.svg';
import { CONTEXT_MENU_COMPACT_ROW_STYLE } from '../UI/contextMenuMetrics.mjs';

export function TabIdActions({ tabIds, onClose, showToast }: {
  tabIds: string[];
  onClose: () => void;
  showToast: (message: string, type: 'error' | 'success') => void;
}) {
  const inFlight = useRef(false);
  const enabled = tabIds.length > 0;
  const base = 'min-w-0 text-[12px] flex items-center justify-center text-[#ccc] hover:bg-white/10 cursor-pointer disabled:text-[#555] disabled:cursor-not-allowed';
  const insert = async (event: React.MouseEvent, withTime = false) => {
    event.stopPropagation();
    if (inFlight.current) return;
    inFlight.current = true;
    const payload = { tabIds: [...tabIds], ...(withTime ? { timestamp: Date.now() } : {}) };
    onClose();
    try {
      const result = await window.require('electron').ipcRenderer.invoke('voice-record:insert-tab-ids', payload);
      if (!result?.ok) showToast(result?.error || 'Не удалось вставить ID в Voice Record', 'error');
    } catch (error: any) { showToast(error?.message || 'Voice Record недоступен', 'error'); }
    finally { inFlight.current = false; }
  };
  return <div className="flex items-stretch" style={{ flex: '1.2 1 0', minWidth: 112 }} data-tab-id-actions>
    <button type="button" data-context-menu-row="compact" data-tab-context-action="insert-tab-id-voice"
      className={base} style={{ ...CONTEXT_MENU_COMPACT_ROW_STYLE, flex: '0 0 30px', paddingLeft: 0, paddingRight: 0 }}
      title="Вставить ID в Voice Record · начать запись, если её нет" aria-label="Вставить ID в Voice Record" disabled={!enabled}
      onClick={event => { void insert(event); }}>
      <img src={voiceRecordIcon} width="18" height="18" alt="" draggable={false} />
    </button>
    <button type="button" data-context-menu-row="compact" data-tab-context-action="insert-tab-id-voice-time"
      className={base + ' border-l border-[#444]'}
      style={{ ...CONTEXT_MENU_COMPACT_ROW_STYLE, flex: '0 0 38px', gap: 2, paddingLeft: 0, paddingRight: 0 }}
      title="Вставить ID и текущее время UTC до минуты в Voice Record · начать запись, если её нет"
      aria-label="Вставить ID и время UTC в Voice Record" disabled={!enabled}
      onClick={event => { void insert(event, true); }}>
      <Plus size={10} /><Clock3 size={14} />
    </button>
    <button type="button" data-context-menu-row="compact" data-tab-context-action="copy-tab-id"
      className={base + ' border-l border-[#444]'} style={{ ...CONTEXT_MENU_COMPACT_ROW_STYLE, flex: '1 1 0', paddingLeft: 0, paddingRight: 0 }}
      title={tabIds.length > 1 ? `Скопировать ID: ${tabIds.length}` : 'Скопировать ID вкладки'} disabled={!enabled}
      onClick={event => {
        event.stopPropagation();
        window.require('electron').clipboard.writeText(tabIds.join('\n'));
        showToast(tabIds.length > 1 ? `Скопировано ID: ${tabIds.length}` : 'ID скопирован', 'success');
        onClose();
      }}>
      <Copy size={12} className="flex-shrink-0" /><span>ID</span>
    </button>
  </div>;
}
