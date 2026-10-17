import './workspaceControlStyles.css';
import Tooltip from '../UI/Tooltip';
import { CONTEXT_MENU_COMPACT_ROW_STYLE, CONTEXT_MENU_TOP_DIVIDER_STYLE } from '../UI/contextMenuMetrics.mjs';
import { TabCompletionNotificationIcon } from './TabSignals';

export default function TabNotificationControls({ armed, fired, persistent, onOnce, onPersistent, onAction }: {
  armed: boolean;
  fired: boolean;
  persistent: boolean;
  onOnce: (enabled: boolean) => void;
  onPersistent: (enabled: boolean) => void;
  onAction: () => void;
}) {
  const oneShotActive = armed || fired;
  const tint = fired ? '#ef4444' : oneShotActive ? '#f87171' : '#888';
  const notificationTitle = fired ? 'Уведомление готово' : oneShotActive ? 'Уведомление включено' : 'Активировать уведомления';
  return <div className="flex items-stretch w-full" data-tab-notification-controls style={CONTEXT_MENU_TOP_DIVIDER_STYLE}>

    <Tooltip content={notificationTitle}>
      <button type="button" data-context-menu-row="compact" data-tab-context-action="notify-once"
        aria-label={notificationTitle} aria-pressed={oneShotActive}
        className="tab-notification-control flex-1 basis-0 min-w-0 text-[13px] cursor-pointer flex items-center justify-center"
        style={{ ...CONTEXT_MENU_COMPACT_ROW_STYLE, color: oneShotActive ? '#fecaca' : '#ccc',
          backgroundColor: oneShotActive ? 'rgba(239, 68, 68, 0.10)' : 'transparent' }}
        onClick={event => { event.stopPropagation(); onOnce(!oneShotActive); onAction(); }}>
        <TabCompletionNotificationIcon color={tint} />
      </button>
    </Tooltip>
    <Tooltip content={persistent ? 'Постоянные уведомления включены' : 'Включать уведомление для каждого нового запроса'}>
      <button type="button" data-context-menu-row="compact" data-tab-context-action="notify-persistent"
        aria-label="Уведомления для каждого нового запроса" aria-pressed={persistent}
        className="tab-notification-control flex-1 basis-0 min-w-0 text-[12px] cursor-pointer flex items-center justify-center border-l border-[#444]"
        style={{ ...CONTEXT_MENU_COMPACT_ROW_STYLE, color: persistent ? '#f87171' : '#777',
          backgroundColor: persistent ? 'rgba(239, 68, 68, 0.16)' : 'transparent' }}
        onClick={event => { event.stopPropagation(); onPersistent(!persistent); onAction(); }}>
        <TabCompletionNotificationIcon persistent />
      </button>
    </Tooltip>
  </div>;
}
