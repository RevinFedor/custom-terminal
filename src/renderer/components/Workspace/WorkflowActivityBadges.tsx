import React from 'react';
import { useTabCompletionNotificationDismissing } from './TabSignals';

export default function WorkflowActivityBadges({
  activeCount,
  busyCount,
  awaitingCount,
  completionNotificationCount,
  active,
}: {
  activeCount: number;
  busyCount: number;
  awaitingCount: number;
  completionNotificationCount: number;
  active: boolean;
}) {
  const hasCompletionNotification = completionNotificationCount > 0;
  const completionDismissing = useTabCompletionNotificationDismissing(hasCompletionNotification);
  return (
    <>
      {awaitingCount > 0 && (
        <span
          data-workflow-awaiting-ring
          className="tab-awaiting-input absolute inset-0 rounded"
          style={{ zIndex: 3 }}
          aria-hidden
        />
      )}
      {(hasCompletionNotification || completionDismissing) && (
        <span
          data-workflow-completion-ring
          className={`tab-completion-notification-alert absolute inset-0 rounded ${
            completionDismissing && !hasCompletionNotification
              ? 'tab-completion-notification-alert--dismiss'
              : ''
          }`}
          style={{ zIndex: 4 }}
          aria-hidden
        />
      )}
      {activeCount > 0 && (
        <span
          data-workflow-active-count
          title={`Запущено вкладок: ${activeCount}`}
          className="relative flex items-center justify-center text-[10px] font-semibold rounded-full"
          style={{
            flexShrink: 0,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 999,
            backgroundColor: active ? 'rgba(74, 222, 128, 0.30)' : 'rgba(74, 222, 128, 0.20)',
            color: active ? '#86efac' : '#4ade80',
            boxSizing: 'border-box',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {activeCount}
        </span>
      )}
      {busyCount > 0 && (
        <span
          data-workflow-busy-count
          title={`Сейчас работают: ${busyCount}`}
          className="relative flex items-center justify-center text-[10px] font-semibold rounded-full"
          style={{
            flexShrink: 0,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 999,
            backgroundColor: active ? 'rgba(245, 158, 11, 0.28)' : 'rgba(245, 158, 11, 0.18)',
            color: active ? '#fbbf24' : '#f59e0b',
            boxShadow: 'inset 0 0 0 1.5px #f59e0b',
            boxSizing: 'border-box',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {busyCount}
        </span>
      )}
      {completionNotificationCount > 0 && (
        <span
          data-workflow-completion-count
          title={`Готовых уведомлений: ${completionNotificationCount}`}
          className="relative flex items-center justify-center text-[10px] font-semibold rounded-full"
          style={{
            zIndex: 5,
            flexShrink: 0,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 999,
            backgroundColor: active ? 'rgba(239, 68, 68, 0.30)' : 'rgba(239, 68, 68, 0.20)',
            color: active ? '#fecaca' : '#f87171',
            boxSizing: 'border-box',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {completionNotificationCount}
        </span>
      )}
    </>
  );
}
